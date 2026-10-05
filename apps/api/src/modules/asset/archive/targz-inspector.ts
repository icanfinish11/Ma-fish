import { createGunzip } from 'node:zlib';
import { Parser, type ReadEntry } from 'tar';
import type { RandomAccessReader } from 'yauzl';
import {
  checkCompressionRatio,
  checkEntry,
  checkEntryCount,
  checkTotalUncompressedBytes,
  sanitizeReason,
  type ArchiveLimits,
  type InspectionResult,
} from './limits.js';

/**
 * tar.gz 归档的校验（P1 / Task 4；设计 D8）。
 *
 * ## 为什么必须流式（zip 那条路走不通）
 *
 * tar **没有中央目录**，全部信息都在前向流里的头部。所以判定只能边读边做——
 * 但**判定所需的一切都在 512 字节的头部里**（名字、声明大小、typeflag），
 * 因此「累计大小」与「压缩比」可以仅凭头部得出结论，炸弹在读出头几百字节时就被中止，
 * 而不是把 100 MiB 解完（预检实测：100 MiB 炸弹在解压出 16 KiB 时中止）。
 *
 * ## 三个只有踩过才知道的坑（全部实测，见 evidence/t4-probe-archive-api.txt）
 *
 * 1. **用 `'entry'` 事件，不是 tar-stream 的 `onentry` 回调**。`Parser.prototype.onentry`
 *    根本不存在；写成回调形态**不报错、只是永不 settle**（探针：1 秒内没有任何事件）。
 * 2. **提前中止必须销毁上游 + 立刻 settle 自己的 promise**。仅「不再消费条目」会让解析器
 *    卡死（探针：2 秒内不 settle）；无脑 drain 等于把炸弹完整解一遍。
 *    `Parser` **没有** `destroy()`，能销毁的只有 source / gunzip。
 * 3. **销毁上游会派发错误事件**（`ERR_STREAM_PREMATURE_CLOSE` 之类）。source 与 gunzip 上
 *    都必须挂 `'error'` 监听：一次恶意上传不该变成一次未处理异常。
 *    这也是为什么这里不用 `pipeline()`——目标流在条目回调里被销毁时，`pipeline` 不会 settle。
 *
 * ## 与 zip 侧共用同一份判据
 *
 * 条目数 / 累计大小 / 压缩比 / 路径 / 链接全部来自 `limits.ts`，顺序也与 zip 侧一致：
 * 路径/链接 → 条目数 → 累计大小 → 压缩比。两个格式对同一条控制不可能给出不同结论。
 */

/**
 * 校验一份 tar.gz。
 *
 * @param reader 明文的随机访问读取器（yauzl 的 `RandomAccessReader`：`createReadStream` 的
 *   `end` **独占**，与 Task 3 的读取器一致）。
 * @param archiveBytes 归档**自身**的字节数（`.tar.gz` 的大小）。它同时是流的上界与压缩比的
 *   分母——tar 条目没有「压缩后大小」这一说，压缩发生在整条流上。
 */
export async function inspectTarGz(
  reader: RandomAccessReader,
  archiveBytes: number,
  limits: ArchiveLimits,
): Promise<InspectionResult> {
  const source = reader.createReadStream({ start: 0, end: archiveBytes });
  const gunzip = createGunzip();
  const parser = new Parser();

  return await new Promise<InspectionResult>((resolve) => {
    let settled = false;
    let entryCount = 0;
    let totalUncompressed = 0;

    /** 「立刻 settle」的唯一入口：先销毁上游，再 resolve。重复调用是无操作。 */
    const settle = (result: InspectionResult): void => {
      if (settled) return;
      settled = true;
      source.destroy();
      gunzip.destroy();
      resolve(result);
    };

    parser.on('entry', (entry: ReadEntry) => {
      entryCount += 1;
      totalUncompressed += entry.size ?? 0;
      const rejection =
        // tar 的条目类型在 `header.typeKey` 上是**原始 typeflag**（'0'/'1'/'2'/'5'…），
        // 而 `entry.type` 是类型名（'File'/'SymbolicLink'…）。判据要的是前者。
        checkEntry({ name: entry.path, typeflag: entry.header.typeKey }) ??
        checkEntryCount(entryCount, limits) ??
        checkTotalUncompressedBytes(totalUncompressed, limits) ??
        // 分母是整份 .tar.gz：tar 条目没有各自的压缩后大小。
        checkCompressionRatio(totalUncompressed, archiveBytes, limits);
      if (rejection !== null) {
        settle({ ok: false, reason: rejection });
        return;
      }
      // 合法路径才需要继续：不 resume 解析器就不再前进（D8 的背压形态）。
      // 拒绝路径**不走这里**——那正是「不解压任何条目数据」的落点。
      entry.resume();
    });

    parser.on('end', () => settle({ ok: true }));
    parser.on('error', (error) =>
      settle({ ok: false, reason: `tar.gz 解析失败：${sanitizeReason(errorMessageOf(error))}` }),
    );
    /**
     * **在归档结束标记处提前判掉「一个有效条目都没有」**（修复轮 1 / Ruling 2）。
     *
     * ## 为什么必须有这一段（据实记载：原先的注释说错了一件事）
     *
     * 原先这里写着「拒绝发生在**第一个 512 字节块**上（`[CONSUMEHEADER]` 里 `new Header(...)`
     * 抛出即 warn）」。**这句只对一部分载荷成立**，本轮实测（`evidence/t4-fix1-probe-bare-gzip-before.txt`）：
     *
     * | 裸 gzip 的载荷（都是合法 gzip、内容不是 tar） | 首次 warn 时**已解压**的字节数 | 耗时 |
     * |---|---|---|
     * | 8 MiB 随机（校验和不符 ⇒ `TAR_ENTRY_INVALID`） | 4,081 B | 8 ms |
     * | 16 MiB 全 `A`（校验和不符） | 16,384 B | 11 ms |
     * | **16 MiB 全零**（读到两个全零块 = tar 的**结束标记**） | **16,777,216 B（整份载荷）** | **2,851 ms** |
     *
     * 原因是 tar 自己的注释（`parse.js` 第 100 行）：
     * `// these BADARCHIVE errors can't be detected early. listen on DONE.`
     * ——`TAR_BAD_ARCHIVE / Unrecognized archive format` 这条警告**只在输入结束时**发出。
     * 而「零字节载荷」这一类恰好会走到这里：tar 把前 1024 字节认成**空归档的结束标记**
     * （`SAW_EOF`，此后它只是把剩下的输入丢掉），直到输入结束才在 DONE 里发警告。
     * 于是**整份载荷都被解压并喂进解析器**才被拒——而且代价是**超线性**的
     * （64 MiB 的同类载荷实测 43 秒 / 4,112 次写入，见同一份证据的 C 行）。
     * D7 的 `mime === 'application/gzip'` 这一半会放行**任何** `.gz`（见文件头与报告 §F2），
     * 因此这一类没有上限的成本就是一条真实的 DoS 面。
     *
     * ## 这一段做了什么
     *
     * 监听 `'eof'`（tar 读到**结束标记**时就发，实测在第一个 16 KiB 数据块上就发出来了），
     * 若此时**一个有效条目都没有**，立刻以**同一条判据、同一个代号**拒掉，
     * 只是不必把整条流解完。**阈值没有变、八样本的期望没有变**：变的是「这条判断什么时候给出」。
     *
     * ## ⚠️ 它与 node-tar 自己的判断**不是逐字等价**（M3：上一版这句话是错的）
     *
     * 上一版写着「这正是 tar 自己在 DONE 时做的判断（`SAW_VALID_ENTRY === false`）」。**那句话不成立**，
     * 按 `tar@7.5.22` 的源码（`dist/commonjs/parse.js`）逐段核对如下：
     *
     * - tar 的判据是 `STATE === 'begin' || SAW_VALID_ENTRY === false`（第 101–105 行），
     *   而不是 `SAW_VALID_ENTRY === false` 单独一条；
     * - `SAW_VALID_ENTRY` 在 **meta 条目上也置位**：置位发生在第 207–219 行，
     *   位置在 `if (entry.meta)`（第 221 行）**之前**，注释原文是
     *   「we do this for meta & ignored entries as well, because they are still valid tar」；
     * - 而 `'entry'` 事件**只对非 meta 条目**发出：meta 走第 221 行那一支、从入队（第 252/256 行），
     *   而发事件的是 `PROCESSENTRY`（第 279 行），它只消费队列。
     *
     * ⇒ 本段用的 `entryCount`（= `'entry'` 事件的条数）**比 tar 的判据更严**：
     * 一份**只含 meta 条目**的 tar.gz（例如只有一个 pax 全局扩展头的归档）会被我们拒掉
     * （`eof` 时 `entryCount === 0`），而 tar 自己认为它是合法归档
     * （`SAW_VALID_ENTRY` 已置位 ⇒ DONE 不发 `TAR_BAD_ARCHIVE`）。
     *
     * **这是刻意的 fail-closed 一侧，据实记载**：D7 的 `mime === 'application/gzip'` 那一半会放行
     * **任何** `.gz`，而「空归档」与「根本不是归档」在 tar 自己的信号里本就不易区分
     * （两者在 DONE 时可能都只有一句警告）。放行前者等于给后者开一条路。
     * 若将来确实需要与 node-tar 逐字对齐，改法是把这个判据从「`'entry'` 条数为 0」换成
     * 「**解析出的头**为 0」（在 `'entry'` 之外另记一个「看到过任何被接受的头」的标志，
     * meta 与 ignored 条目都算）——**不是**把这一段删掉。
     *
     * 反过来，**有**有效条目的归档照旧走 `'end'`：`entryCount > 0` 时这里直接返回。
     */
    parser.on('eof', () => {
      if (entryCount > 0) return;
      settle({
        ok: false,
        reason:
          'tar.gz 归档不合法（TAR_BAD_ARCHIVE）：读到归档结束标记时一个有效条目都没有' +
          '（空归档与「根本不是 tar」在 tar 的信号里无法区分，两者都拒）' +
          '——本条判断在结束标记处提前给出，不把整条流解完',
      });
    });
    /**
     * **警告也计为拒绝**（据实记载：这条是实测才发现必须有的）。
     *
     * `tar` 把「这压根不是 tar」「头部校验和不符」「条目缺 path」「输入被截断」这类问题
     * 通过 **`'warn'` 事件**报出来，而**不是** `'error'`——不监听它，一个**普通 .gz**
     * （内容不是 tar）会以「0 个条目的合法归档」的身份**通过校验**，
     * 因为「没有任何有效条目」这条信息在 DONE 时只以警告形式出现（`parse.js` 的 DONE 处理器），
     * 而 `'end'` 紧接着就到。
     *
     * 上面那条 `'eof'` 处理器负责这一类里**走到结束标记**的那一半（零字节载荷：整份解压
     * 才拒 ⇒ 提前到 16 KiB 量级）；这一条负责**第一个头部就校验和不符**的另一半
     * （实测 4–16 KiB 就拒）。两者共用同一个 `settle`，先到的结论说了算。
     *
     * 代价（据实记载）：一个**空 tar.gz**（只有两个全零块）也在这一类里
     * （tar 的 DONE 判据 `STATE === 'begin' || SAW_VALID_ENTRY === false` 同样会拒它）⇒ 被拒。
     * 这是刻意 fail-closed 的一侧：
     * 「空归档」与「根本不是归档」在 tar 自己的信号里无法区分，
     * 而放行前者就等于放行后者（任何 .gz 都能冒充 tar.gz）。
     * （**不**等价的那一类——只含 meta 条目的 tar.gz——见上面 `'eof'` 那一段的 M3 记载。）
     */
    parser.on('warn', (code: string, message: string) =>
      settle({ ok: false, reason: `tar.gz 归档不合法（${code}）：${sanitizeReason(message)}` }),
    );
    // 销毁上游时这两个流会派发错误；没有监听就是未处理异常（见文件头的第 3 条）。
    // 它们同样走 settle：先到的结论说了算，settled 之后的一律丢弃。
    gunzip.on('error', (error) =>
      settle({ ok: false, reason: `tar.gz 解压失败：${sanitizeReason(errorMessageOf(error))}` }),
    );
    source.on('error', (error) =>
      settle({ ok: false, reason: `读取制品失败：${sanitizeReason(errorMessageOf(error))}` }),
    );

    source.pipe(gunzip).pipe(parser);
  });
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
