import { fromRandomAccessReader, type RandomAccessReader, type ZipFile } from 'yauzl';
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
 * zip 归档的校验（P1 / Task 4；设计 D6）。
 *
 * ## 为什么 zip 可以「不解压一个字节」
 *
 * zip 的**中央目录**在文件末尾，里面有每个条目的名字、未压缩大小、压缩后大小与外部属性
 * ——威胁 #2 的五条判据（路径、链接、条目数、累计大小、压缩比）**全部只需要这些元数据**。
 * 因此 `lazyEntries: true` 只走中央目录：`openReadStream` 一次都不会被调用。
 * 这条不是「小心别读」而是**验收判据**：用例在 `ZipFile.prototype.openReadStream` 上打桩，
 * 断言八个样本走完一次都没被调用（C19）。
 *
 * ## 解析器抛错必须计为**拒绝**，不是异常（D6 的第 1 条实现约束）
 *
 * `yauzl` 自带 zip-slip 防护（`validateFileName`）：遇到绝对路径、`..` 段、反斜杠分隔符时
 * 它在**读中央目录**的阶段就抛 `invalid relative path` / `absolute path`。
 * 一次恶意上传绝不该变成一次未处理异常（那既是 500 也是进程级的风险面），
 * 因此本函数的**任何**解析异常都收敛成 `{ ok: false, reason }`。
 *
 * ## 但**不能只依赖**解析器自带的防护（D6 的第 2 条）
 *
 * 它不覆盖 symlink（mode `0o120xxx` 它照收），也不覆盖三条聚合限制。
 * 这两类由 `limits.ts` 的同一条判据链负责——与 tar.gz 共用同一份阈值与文案。
 *
 * ## 一条据实记载：压缩比是**累积的、逐条目**判定的
 *
 * 与 tar.gz 侧一致（那边是必需的：D8 要求仅凭头部就在第一个条目处中止）。代价是
 * 「一个 1000:1 的零字节大文件 + 一个不可压缩的大文件」这种**混合**归档会在读到第一个条目时
 * 就被拒，尽管它的**最终**合计比可能只有 2:1。这是刻意fail-closed 的一侧：
 * 判别力留给「是不是炸弹」，而不是「最终合计好不好看」。八样本里的 `bomb.zip`
 * 在两种口径下都被拒。
 */
export async function inspectZip(
  reader: RandomAccessReader,
  totalSize: number,
  limits: ArchiveLimits,
): Promise<InspectionResult> {
  let zipfile: ZipFile | null = null;
  try {
    zipfile = await openZip(reader, totalSize);
    return await walkCentralDirectory(zipfile, limits);
  } catch (error) {
    // 「解析失败」也是一种判定：恶意归档的失效形态之一就是**结构本身不合法**
    // （`fake-mime.zip` 那种连中央目录都没有的字节）。这里绝不把异常抛给调用方。
    return { ok: false, reason: `zip 解析失败：${sanitizeReason(errorMessageOf(error))}` };
  } finally {
    // 释放：yauzl 的 `close()` 会 `reader.unref()`，读取器的引用计数随之归零。
    // 失败路径也要走这里——错误事件在 autoClose 下会自己关一次，重复关闭是幂等的。
    zipfile?.close();
  }
}

/**
 * `fromRandomAccessReader` 的回调包装。
 *
 * - `lazyEntries: true` 是「只读中央目录」的开关；
 * - **`strictFileNames: true` 是必须显式打开的**（探针实测，见
 *   evidence/t4-probe-yauzl-names.txt）：默认值 `false` 下 yauzl 会把条目名里的
 *   反斜杠**规范化成 `/`**（`a\b.txt` 读出来是 `a/b.txt`，既不报错也不拒绝），
 *   于是 D6 的「拒绝反斜杠分隔符穿越」在**解析器这一层根本没被执行**——
 *   而 `..\..\evil.txt` 恰好会被规范化成 `../../evil.txt` 才被拦下，看起来「也拦住了」。
 *   打开它之后反斜杠名直接从解析器抛错 ⇒ 计为拒绝，规则变得显式。
 */
function openZip(reader: RandomAccessReader, totalSize: number): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromRandomAccessReader(reader, totalSize, { lazyEntries: true, strictFileNames: true }, (error, zipfile) => {
      if (error !== null) reject(error);
      else if (zipfile === undefined) reject(new Error('yauzl 回调既没有错误也没有 ZipFile'));
      else resolve(zipfile);
    });
  });
}

/**
 * 逐条读中央目录并套用 D6 的判据链，顺序与设计一致：
 * **路径/链接 → 条目数 → 累计大小 → 压缩比**。
 *
 * 任何一条命中就**立刻返回**（不再 `readEntry`）：剩下的中央目录没人读，
 * 更不会有任何条目数据被解压。所有拒绝都走 resolve，不走 reject——`inspectZip` 的
 * catch 只该接住**解析器**的异常，用异常传播判定会让「拒绝」与「崩溃」长得一样。
 */
function walkCentralDirectory(zipfile: ZipFile, limits: ArchiveLimits): Promise<InspectionResult> {
  return new Promise((resolve) => {
    let settled = false;
    let entryCount = 0;
    let totalUncompressed = 0;
    let totalCompressed = 0;

    const settle = (result: InspectionResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    zipfile.on('entry', (entry) => {
      entryCount += 1;
      totalUncompressed += entry.uncompressedSize;
      totalCompressed += entry.compressedSize;
      const rejection =
        checkEntry({ name: entry.fileName, externalFileAttributes: entry.externalFileAttributes }) ??
        checkEntryCount(entryCount, limits) ??
        checkTotalUncompressedBytes(totalUncompressed, limits) ??
        checkCompressionRatio(totalUncompressed, totalCompressed, limits);
      if (rejection !== null) {
        settle({ ok: false, reason: rejection });
        return;
      }
      // 只在这一个地方推进解析器：推进 = 读下一条中央目录记录，**不是**读条目数据。
      readEntry(zipfile);
    });

    zipfile.on('end', () => settle({ ok: true }));
    // 解析器抛出的错误（zip-slip、结构不合法……）在这里变成一次**拒绝**。
    zipfile.on('error', (error) => settle({ ok: false, reason: `zip 解析失败：${sanitizeReason(errorMessageOf(error))}` }));

    readEntry(zipfile);
  });
}

/**
 * 推进一次中央目录读取。**必须异步**：yauzl 的 `readEntry → emit('entry') → readEntry`
 * 在读取器的 `read` 回调同步时是一段**真递归**，20,001 条的 `flood.zip` 会直接
 * `RangeError: Maximum call stack size exceeded`（探针实测，见 evidence/t4-probe-archive-api.txt）。
 * Task 3 的 `EncryptedArtifactReader.read` 走的是 `copyInto(...).then(callback)`，天然异步；
 * 这里的 `queueMicrotask` 是**第二道**保险——它让「读取器换成一个同步实现」也炸不出栈溢出。
 */
function readEntry(zipfile: ZipFile): void {
  queueMicrotask(() => zipfile.readEntry());
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
