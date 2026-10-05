import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { Parser, type ReadEntry } from 'tar';
import { fromRandomAccessReader, type Entry, type RandomAccessReader, type ZipFile } from 'yauzl';
import type { EncryptedArtifactReader } from '../store/random-access-reader.js';

/**
 * 静态元数据解析（P1 / Task 6；设计 D9）。
 *
 * ## 这个模块只做读取（C2 的落点）
 *
 * 全部输入都来自**已经通过 `validateArchive` 的**制品明文视图，取法只有三种：
 * 读中央目录 / 读 tar 头部、读**限长**的条目内容、按扩展名与名字做纯字符串判断。
 * 这里**没有**任何执行面：不 eval、不 require 条目、不跑 `npm install`、
 * 不跟随链接、不解析需要执行的格式（`.pyc` / 二进制一律只看扩展名）。
 * 「不执行」由 `tests/unit/asset/parse-metadata.test.ts` 的 Step 1 用**副作用探针**证明
 * （哨兵文件 + `node_modules` + 两条子进程打点），而不是靠这句话。
 *
 * ## 读法：zip 随机访问，tar.gz 顺序流（一处据实记载）
 *
 * zip 的中央目录在末尾，条目内容按需解压 ⇒ 只有真正要读的那几个文件所在块会被解密
 * （读取器的「最近一块」memo 让同一块的多次读只解一次；实测见报告 §「只读需要的块」）。
 * **tar.gz 没有中央目录**：条目之间就是数据，要枚举条目就必须把整条流解压一遍。
 * 因此 tar.gz 这一侧的「按需」只体现在**内存**上（只留限长的内容），
 * 不体现在「解压了多少」上——这一条写在这里，免得被读成「两种容器一样省」。
 *
 * ## 出错就抛（不伪造一份「看起来正常」的元数据）
 *
 * 归档的结构问题在 Task 4 已经判过；这里再遇到的失败只有一类：**读不出来**
 * （条目数据损坏、制品在静止状态下被改动）。这时抛错由调用方按「制品读不回来」处置
 * ——与 Task 5 对 `validateArchive` 抛错的处理同一条理由：把「不知道」写成
 * 「没有 README / 没有依赖」，会让一份不完整的资料看起来像一份完整的资料。
 *
 * ## 与 brief 的一处分歧（据实记载）
 *
 * brief 的契约写 `parseMetadata(reader: RandomAccessReader, kind)`。本仓库里那个名字有
 * **两个**所指（yauzl 的抽象类 / `random-access-reader.ts` 的 `EncryptedArtifactReader`），
 * 这里取**具体类**——tar.gz 侧需要 `plaintextLength` 作为流的上界，而那个属性只有它提供。
 * 与 Task 4 §4.1 对 `validateArchive` 的同一取舍。
 */

/** 元数据解析的结果（brief 的契约 + 一个截断标记，见下）。 */
export interface ParsedMetadata {
  /** README 的截断摘录；没有 README 时为 `null`。 */
  readmeExcerpt: string | null;
  /** 文件树摘要（**只有文件**，目录条目不计）：路径 + 未压缩字节数。深度与条目数都受限。 */
  fileTree: { path: string; bytes: number }[];
  /** 语言分布：按扩展名归类、按字节降序；占比的分母是**所有文件**的字节合计。 */
  languages: { name: string; bytes: number; ratio: number }[];
  /** 依赖清单（纯文本解析）：`package.json` / `requirements.txt` / `go.mod`。 */
  dependencies: { ecosystem: string; name: string; version: string }[];
  /** 完整度评分 0–100（设计 §6.2）。 */
  completeness: number;
  /**
   * 文件树**是否被截断**（深度或条目数上限）。
   *
   * brief 的接口里没有这个字段，而 Step 3 要求「超限时截断并**标记**」——两者只能这样调和：
   * 数组本身放不下这个事实（放个哨兵条目会污染数据），因此加一个显式布尔。
   * 判据只有在**真的丢掉了文件**时才为真（恰好等于上限不算截断）。
   */
  fileTreeTruncated: boolean;
}

/**
 * 解析一份（已校验的）归档的元数据。
 *
 * @param reader 明文随机访问读取器（Task 3）。**绝不写入、绝不执行**其中的任何内容。
 * @param kind 已经过嗅探确认的归档类型（D7）。本函数不重新判定类型。
 */
export async function parseMetadata(
  reader: EncryptedArtifactReader,
  kind: 'zip' | 'tar.gz',
): Promise<ParsedMetadata> {
  const scanner = new MetadataScanner();
  if (kind === 'zip') await scanZip(reader, reader.plaintextLength, scanner);
  else await scanTarGz(reader, reader.plaintextLength, scanner);
  return scanner.result();
}

// ── 内容读取的上限（**唯一的例外**：只有下面这几类文件会被读进内存）────────────
//
// 每一条都写清「为什么是这个数」；它们都是**模块私有**的（用例里写死了同一批字面量，
// 改这里会让用例红，而不是让判据跟着漂移）。

/**
 * README 的读取上限（字节）。
 *
 * 它必须**大于** `README_EXCERPT_CHARS` 的 UTF-8 上界才不至于把摘录饿死：
 * 2000 个汉字是 6000 字节，8192 留了约 1.36 倍余量。代价：最多 8 KiB 的内存。
 */
const README_READ_BYTES = 8 * 1024;

/** README 摘录的字符上限（设计 D9「截断到上限」）。 */
const README_EXCERPT_CHARS = 2000;

/** 一个条目需要读内容时给出的请求（`cap` 是允许读进内存的字节数）。 */
interface ContentRequest {
  readonly kind: 'readme';
  readonly cap: number;
}

/**
 * 一趟扫描的**唯一**累加器：两个 walker 都只经它记账。
 *
 * 这样「zip 与 tar.gz 对同一个文件给出不同结果」在结构上不可能发生——
 * 与 Task 4 把两份判据收进 `limits.ts` 是同一个理由。
 */
class MetadataScanner {
  private readonly files: { path: string; bytes: number }[] = [];
  /** README 的原始字节；`null` = 到扫描结束都没遇到过 README。 */
  private readme: Buffer | null = null;

  /** 遇到一个**文件**条目（walker 已排除目录）。 */
  addFile(path: string, bytes: number): void {
    this.files.push({ path, bytes });
  }

  /**
   * 这个条目的内容要不要读？返回 `null` = 一个字节都不读。
   *
   * 调用时机是**条目开始处**，且两个 walker 都是**顺序**处理的（读完上一条才处理下一条），
   * 因此这里的判断与 `take` 之间不会插进别的条目。
   */
  need(path: string): ContentRequest | null {
    // 「第一个匹配」按**归档顺序**：先到先得，后面的 README 一律不再读。
    if (this.readme === null && isReadmePath(path)) return { kind: 'readme', cap: README_READ_BYTES };
    return null;
  }

  /** 条目内容到手（**可能被截断到 `request.cap`**）。 */
  take(request: ContentRequest, content: Buffer): void {
    if (request.kind === 'readme') this.readme = content;
  }

  /** 装配结果。 */
  result(): ParsedMetadata {
    return {
      readmeExcerpt: this.readme === null ? null : excerptOf(this.readme),
      fileTree: this.files,
      languages: [],
      dependencies: [],
      completeness: 0,
      fileTreeTruncated: false,
    };
  }
}

/** 路径的最后一段（`a/b/c.md` → `c.md`）。 */
function baseNameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * 是不是 README（设计 D9 写的是 `README*`）。
 *
 * 判据是**路径最后一段**以 `readme` 开头、大小写不敏感：`README` / `README.md` /
 * `ReadMe.txt` / `readme_zh.md` 都算，`docs/Notes.md` 不算。目录条目在 walker 里已被排除。
 */
function isReadmePath(path: string): boolean {
  return /^readme/i.test(baseNameOf(path));
}

/** README 字节 → 摘录（UTF-8 解码 + 按**字符**截断，见 `README_EXCERPT_CHARS`）。 */
function excerptOf(content: Buffer): string {
  return content.toString('utf8').slice(0, README_EXCERPT_CHARS);
}

/** zip：只读中央目录 + 按需解压**限长**的条目内容。 */
function scanZip(reader: RandomAccessReader, totalSize: number, scanner: MetadataScanner): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let zipfile: ZipFile | null = null;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      zipfile?.close();
      if (error === undefined) resolve();
      else reject(error);
    };

    fromRandomAccessReader(reader, totalSize, { lazyEntries: true, strictFileNames: true }, (error, opened) => {
      if (error !== null || opened === undefined) {
        finish(error ?? new Error('yauzl 回调既没有错误也没有 ZipFile'));
        return;
      }
      zipfile = opened;
      opened.on('entry', (entry: Entry) => {
        // 目录条目（名字以 `/` 结尾）不是文件：不进文件树、不参与语言分布与文件数。
        if (entry.fileName.endsWith('/')) {
          advance(opened);
          return;
        }
        scanner.addFile(entry.fileName, entry.uncompressedSize);
        const request = scanner.need(entry.fileName);
        if (request === null) {
          advance(opened);
          return;
        }
        opened.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            finish(streamError ?? new Error(`zip 条目 ${entry.fileName} 打不开`));
            return;
          }
          void collectUpTo(stream, request.cap).then(
            (content) => {
              scanner.take(request, content);
              advance(opened);
            },
            (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
          );
        });
      });
      opened.on('end', () => finish());
      opened.on('error', (zipError: Error) => finish(zipError));
      advance(opened);
    });
  });
}

/**
 * 收一个 zip 条目流的前 `cap` 字节，**读够就销毁**（剩下的字节连解压都不必做）。
 *
 * 一处据实记载：zlib 是按块吐的（实测 16 KiB 一块），因此实际收进内存的是
 * `cap` 向上取整到下一个块边界的量——上界是 `cap + 16 KiB`，不是 `cap`。
 */
async function collectUpTo(stream: Readable, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    const done = (): void => resolve(Buffer.concat(chunks));
    stream.on('data', (chunk: Buffer) => {
      const remaining = cap - total;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      total += slice.length;
      if (total >= cap) stream.destroy();
    });
    stream.on('end', done);
    stream.on('close', done); // 提前 destroy 之后走的是这一条
    stream.on('error', reject);
  });
}

/**
 * 推进一次中央目录读取。**必须异步**：`readEntry → emit('entry') → readEntry` 在读取器的
 * `read` 回调同步时是一段真递归（Task 4 探针实测 20,001 条样本会 `RangeError`）。
 * Task 3 的读取器天然异步，这里是第二道保险——与 `zip-inspector` 同款。
 */
function advance(zipfile: ZipFile): void {
  queueMicrotask(() => zipfile.readEntry());
}

/** tar.gz：一条前向流（没有中央目录 ⇒ 枚举条目必须把整条流解压一遍）。 */
function scanTarGz(reader: RandomAccessReader, archiveBytes: number, scanner: MetadataScanner): Promise<void> {
  const source = reader.createReadStream({ start: 0, end: archiveBytes });
  const gunzip = createGunzip();
  const parser = new Parser();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      source.destroy();
      gunzip.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };

    parser.on('entry', (entry: ReadEntry) => {
      const isDirectory = entry.header.typeKey === '5' || entry.path.endsWith('/');
      // 不 resume 解析器就不前进（D8 的背压形态）；目录也要 drain 掉。
      if (isDirectory) {
        entry.resume();
        return;
      }
      const bytes = entry.size ?? 0;
      scanner.addFile(entry.path, bytes);
      const request = scanner.need(entry.path);
      if (request === null) {
        entry.resume();
        return;
      }
      void collectEntry(entry, request.cap).then(
        (content) => scanner.take(request, content),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
    parser.on('end', () => finish());
    parser.on('error', (error: Error) => finish(error));
    parser.on('warn', (code: string, message: string) =>
      finish(new Error(`tar.gz 解析失败（${code}）：${message}`)),
    );
    // 销毁上游会派发错误事件；没有监听就是未处理异常（与 targz-inspector 同一条）。
    gunzip.on('error', (error: Error) => finish(error));
    source.on('error', (error: Error) => finish(error));

    source.pipe(gunzip).pipe(parser);
  });
}

/**
 * 收一个 tar 条目的前 `cap` 字节。
 *
 * **不能像 zip 那样 `destroy()` 早退**：tar 是一条前向流，条目流被销毁会让解析器卡住
 * （D8 的背压形态）。因此这里收够 `cap` 之后**继续排水但不再留存**——
 * 内存有界，而解压量与归档本身同阶（这一条在文件头写着，不假装两种容器一样省）。
 */
async function collectEntry(entry: ReadEntry, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    entry.on('data', (chunk: Buffer) => {
      const remaining = cap - total;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      total += slice.length;
    });
    entry.on('end', () => resolve(Buffer.concat(chunks)));
    entry.on('error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    entry.resume();
  });
}
