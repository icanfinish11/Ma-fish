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
     * **警告也计为拒绝**（据实记载：这条是实测才发现必须有的）。
     *
     * `tar` 把「这压根不是 tar」「头部校验和不符」「条目缺 path」「输入被截断」这类问题
     * 通过 **`'warn'` 事件**报出来，而**不是** `'error'`——不监听它，一个**普通 .gz**
     * （内容不是 tar）会以「0 个条目的合法归档」的身份**通过校验**，
     * 因为「没有任何有效条目」这条信息在 DONE 时只以警告形式出现（`parse.js` 的 DONE 处理器），
     * 而 `'end'` 紧接着就到。
     *
     * 反过来，打开它之后拒绝发生在**第一个 512 字节块**上（`[CONSUMEHEADER]` 里
     * `new Header(...)` 抛出即 warn）⇒ 不是「把整条流走完才发现」。
     *
     * 代价（据实记载）：一个**空 tar.gz**（只有两个全零块）也在这一类里
     * （`SAW_VALID_ENTRY === false` ⇒ 同一条警告）⇒ 被拒。这是刻意 fail-closed 的一侧：
     * 「空归档」与「根本不是归档」在 tar 自己的信号里无法区分，
     * 而放行前者就等于放行后者（任何 .gz 都能冒充 tar.gz）。
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
