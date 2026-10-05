import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { RandomAccessReader } from 'yauzl';
import {
  FOOTER_BYTES,
  HEADER_FIXED_BYTES,
  INDEX_ENTRY_SIZE,
  TAG_BYTES,
  blockDataOffset,
  decodeFooter,
  decodeHeader,
  decodeIndex,
  headerByteLength,
  type ArtifactFooter,
  type ArtifactHeader,
  type IndexEntry,
} from '../crypto/artifact-format.js';
import { ChunkDecipher } from '../crypto/chunk-decipher.js';
import type { KeyRing } from '../crypto/key-ring.js';
import type { ArtifactStore } from './artifact-store.port.js';
/**
 * 明文坐标 → 块坐标的映射（每条索引记录一项）。
 *
 * 三个字段都是**读取端自己算出来的**：`plaintextStart` 是前缀和，`artifactStart` 来自索引的
 * `offset`（已校验落在块数据区内），`length` 是索引声明的明文长度。
 * 明文长度之和等于尾部自称的 `plaintextLength`，这一条由读取端的校验保证（见 `open`）。
 */
interface BlockSpan {
  plaintextStart: number;
  length: number;
  artifactStart: number;
}

/**
 * 加密制品的随机访问读取器（P1 / Task 3）：把**密文制品**呈现为**明文视图**。
 *
 * ## 为什么需要它（D1 的结构性理由）
 *
 * zip 的中央目录在文件**末尾**，单趟前向流读不到。校验器（Task 4）用
 * `yauzl.fromRandomAccessReader(reader, totalSize)` 按任意区间取字节，因此需要一个
 * 「要哪段给哪段、且只解密与之相交的块」的读取器。密文制品是
 * `[头][块数据][索引][尾部 24]`，**头 / 索引 / 尾部都是明文**，只有块数据是密文。
 *
 * **修复轮 1 补的一格 memo**（`recent`，见该字段）：只解密密文块这一条还不够——
 * yauzl 每个条目发两次读，而每次读都解密整块 ⇒ 成本 ≈ 条目数 × 块大小（量化见 `recent`）。
 * 现在**最近读过的**那一块会被记住，命中时既不读存储也不解密。
 *
 * ## 依赖登记的历史（K2/K6：本任务实测到的一次「依赖已装」是假的）
 *
 * 本任务的说明是「`yauzl` 3.4.0 已安装」。实测**为假**：`pnpm-lock.yaml` 里 `yauzl`
 * 匹配数为 0、`pnpm why -r yauzl` 无输出、`require.resolve('yauzl', { paths: ['apps/api/src'] })`
 * 直接 `MODULE_NOT_FOUND`。`node_modules/.pnpm/` 下确实躺着 `yauzl@3.4.0` 与
 * `@types+yauzl@3.4.0`，但它们是**预检探针的残留**：未被链接、不在 lockfile 中，
 * 因此 `pnpm install --frozen-lockfile` 不会提供它们。教训写在预检笔记 §8：
 * 判据是 **`require.resolve`（从实际使用方出发）**，不是 `node_modules/` 下存在同名目录
 * ——pnpm 的隔离链接还意味着**传递依赖不可从应用代码 import**（`file-type` / `tar` 正是
 * 这种形态，Task 4 必须自己登记）。
 *
 * 本文件第一版因此把接口**手抄**成了本地声明（当时的约束是「不新增依赖」）。控制器裁定
 * 改为**登记依赖并使用真实类型**：手抄副本没有任何机制发现漂移，而本项目已经为
 * 「声明了但未强制」付过多次代价。于是本任务登记了 `yauzl@3.4.0` 与 `@types/yauzl@3.4.0`
 * （都在 `apps/api`），本类 `implements RandomAccessReader`。
 *
 * **一处「类型定义 ≠ 运行期」的缺口（据实记载）**：`@types/yauzl@3.4.0` 的
 * `RandomAccessReader` 只声明了 `_readStreamForRange` / `createReadStream` / `read` / `close`，
 * **没有** `ref` / `unref`；而运行期 `index.js` 第 945-961 行确实会调用它们
 * （`refCount` 归零时 `close()` 并派发 `'close'`）。本类因此**额外**实现了这两个方法
 * ——少了它们，yauzl 在 `fromRandomAccessReader` 的第一次 `reader.ref()` 就会崩。
 * `implements` **不会**发现这个缺口（多实现的方法不在检查范围内），
 * 因此它由 `random-access-reader.test.ts` 的生命周期用例与 yauzl 接缝用例**从行为上**钉住。
 *
 * ## 区间语义：`end` 是**独占**的，而 `ArtifactStore.getRange` 是**闭**区间
 *
 * yauzl 的基类里 `read(buffer, offset, length, position)` 调的是
 * `createReadStream({ start: position, end: position + length })`，并用
 * `AssertByteCountStream(end - start)` 断言字节数 ⇒ `end` **独占**。
 * 本仓库的存储端口是闭区间（`getRange(key, start, endInclusive)`），因此每次请求都要做一次
 * `end - 1` 的换算。**这是本文件最容易差一位的地方**：变异探针 `inclusive-to-exclusive`
 * （少减 1）实测让 10 条用例变红。
 *
 * ## 定位索引的代价：一次 24 字节的读，**不解密任何块**
 *
 * `open()` 的第一步是 `getRange(key, size-24, size-1)` 取尾部，拿到 `indexOffset` /
 * `chunkCount` / `plaintextLength`；第二步取头部（31 + keyId 字节）；第三步取索引
 * （`indexOffset` 起、`chunkCount * 24` 字节——实际条数由文件几何推导，见下）。
 * 三步都落在**明文区**，因此 `open()` 一个块都不解密。
 *
 * 这不是微优化：生产块大小 8 MiB、上限 1 GiB，「先把整份制品读进来再找尾部」的代价是
 * 1 GiB 的读取 + 128 次解密。`random-access-reader.test.ts` 用**存储请求的字节总数**
 * 断言这条：`open()` 期间请求的总量恰好是 `头部 + 索引 + 24`，且没有一次请求落在块区间内。
 *
 * ## 读取端必须校验的东西（写入端的 `decodeIndex` 有意不做）
 *
 * 制品里的一切都是不可信输入：**头与尾部都不在任何 AAD 里**，`offset` / `ciphertextLength`
 * 同样未被认证。因此 `open()` 必须做三组校验：
 *
 * 1. **索引区几何**：`indexOffset` 不早于块数据区、索引区长度非负且是 `24` 的整数倍；
 * 2. **三条完整性校验**：`chunkCount === 索引区实际记录数`、
 *    `chunkCount === ceil(plaintextLength / chunkSize)`、`Σ ciphertextLength === plaintextLength`；
 * 3. **索引自身**：`offset` 严格递增、第 0 条从块数据区起点开始、块之间连续、
 *    每条记录的区间落在块数据区内。
 *
 * **一处据实记载**：这三条**挡不住「整块截断 + 尾部改得完全自洽」**——把一个 3 块制品
 * 截成 2 块、删掉对应的索引记录、把尾部改小，三条全部满足。挡住它的是末块的 `isLast`
 * AAD 标记：那一块当初是用 `more` 建的，而读取端会把它当末块（`last`）认证 ⇒ 拒绝。
 * 这条边界有专门用例（`random-access-reader.test.ts` 的「整块截断」）。
 */
export class EncryptedArtifactReader extends EventEmitter implements RandomAccessReader {
  /** 明文总字节数（尾部自称、且已与实际块长度之和核对过）。调用方拿它作 zip 的 `totalSize`。 */
  readonly plaintextLength: number;

  /**
   * 制品头里的 `fileId`（**十六进制**，与 `asset_versions.file_id` 同一表示）。
   *
   * ## 为什么它必须被暴露出来（I1：最终全分支审查的 Important 项）
   *
   * `fileId` 出现在**每一个块的 AAD** 里（见 `artifact-format.ts` 的 `buildAad`），
   * 因此它就是「这份制品」的**身份**：换一份别的制品，AAD 就对不上、认证必然失败。
   * 但这条绑定只在**加密层**成立——**盘上那份制品究竟是不是这条版本记录指向的那一份**，
   * 此前没有任何一层比对过：下载路径只核对了带外明文长度，而长度**不是身份**
   * （另一份明文长度相同的合法制品完全可以通过全部检查）。
   *
   * 因此读取器把已经解出来的这个值**交出去**（`open()` 里本来就解了它，只是没有出口），
   * 由下载路径与版本行里的 `file_id` 比对——那个比对在 `DownloadService.readVerified`。
   *
   * **一处据实记载**：头本身**不在任何 AAD 里**，所以这里的值也来自不可信输入；
   * 但它要能骗过认证，就必须与所有块 AAD 里用的那个 `fileId` 一致——也就是说，
   * 它只能等于**这份制品真实的身份**。比对因此是有效的（不是「信头里那个自称值」）。
   */
  readonly fileId: string;

  /**
   * 制品头里的 `keyId`（选密钥用的那个）。
   *
   * 暴露它是为了同一处的一致性核对：`keyId` **不在** AAD 里，因此改它不会带来
   * 「换一份制品而不被发现」的能力（改了就选错密钥 ⇒ 解密直接失败），
   * 它挡的是**记录与对象对不上**这一类运维错误（例如对象被换成了用另一把键加密的那一份）。
   */
  readonly keyId: string;

  private readonly store: ArtifactStore;
  private readonly key: string;
  private readonly decipher: ChunkDecipher;
  private readonly blocks: readonly BlockSpan[];
  private refCount = 0;

  /**
   * **最近一块的 memo**（修复轮 1 / Ruling 1）：命中时不碰存储、也不解密。
   *
   * 为什么必须有它（量化过的 DoS，见报告 §9.2 与本轮 §F1）：yauzl 读 zip 的中央目录时
   * **每个条目发两次 `read`**（46 字节定长部分 + 名字），而改写之前每一次 `read` 都会
   * 重新 `getRange` **整块**记录并**解密整块**。于是一份 1.9 MB / 20,001 条目的上传
   * （正是会被 D6 条目数上限拒掉的那一类）在**生产块大小 8 MiB** 下要走
   * **40,003 次解密**、取回 75.9 GB、烧掉 **82 秒 CPU**——D6 的条目数上限
   * 本来就是为了给恶意上传的代价封顶，这个成本曲线让它**封不住任何东西**。
   * 有了一格 memo，同一份制品变成 **1 次解密 / 1 次存储请求 / 数十毫秒**。
   *
   * ## 为什么只有一格（C16：刻意**不做**通用缓存）
   *
   * zip 的中央目录是**顺序**读的（读完一条紧接写一条），tar.gz 是一条顺序流，
   * 因此「上一次读的那一块」命中率接近 100%，再加淘汰策略只是把内存与失效逻辑
   * 变成新的风险面。代价明说：内存里最多多留**一块明文**（生产块大小 8 MiB），
   * 且**任何换块的读都会让它失效**——`countDecryptions` 的用例把这条语义钉住了
   * （A→B→A 的三次读必须解密 3 次）。
   *
   * ## 为什么它不改变任何判据
   *
   * 只缓存**成功解密**的结果，且键是**位置**（C20：位置是块序号的唯一事实来源）。
   * 同一个位置上，明文是那段记录的纯函数，因此命中与重算逐字节等价；
   * 认证失败的块**不入 memo**（失败照旧抛错，不会把一次拒绝变成一次命中）。
   *
   * 交出去的切片是这块明文的**视图**：与 Node 流的一般约定一致——消费方不得改写
   * 收到的 chunk（本仓库的消费方只有 `copyInto`（只读源）与 yauzl / gunzip）。
   */
  private recent: { position: number; plaintext: Buffer } | null = null;

  private constructor(
    store: ArtifactStore,
    key: string,
    decipher: ChunkDecipher,
    blocks: readonly BlockSpan[],
    plaintextLength: number,
    header: ArtifactHeader,
  ) {
    super();
    this.store = store;
    this.key = key;
    this.decipher = decipher;
    this.blocks = blocks;
    this.plaintextLength = plaintextLength;
    // 头已经由 `decodeHeader` 校验过（magic / 版本 / 长度），这里只做表示转换。
    this.fileId = header.fileId.toString('hex');
    this.keyId = header.keyId;
  }

  /**
   * 打开一份制品：读尾部 → 头 → 校验索引区几何 → 读索引 → 校验内容 → 建解密器。
   *
   * 构造必须异步（要读制品），因此入口是静态的 `open` 而不是构造函数：
   * 一个「构造好了但还没校验」的读取器是可被误用的中间态。
   *
   * 校验分两段是因为**几何决定要读多少字节**：索引区里实际有多少条记录必须由
   * `indexOffset` 与文件长度推出（`size - 24 - indexOffset` 个 24 字节），
   * 而不是信尾部自称的 `chunkCount`——否则「自称块数 === 实际条数」会退化成同义反复。
   * 几何不合法时**连读都不读**。
   *
   * @throws 制品过短 / magic 或版本不认 / 头截断 / 尾部不完整 / 索引起点越界 /
   *   索引区长度不是 24 的整数倍 / 明文长度超出可安全表示的范围 /
   *   三条完整性校验不通过 / `offset` 不单调或越界 / `keyId` 不在环中（**绝不回退**）。
   */
  static async open(store: ArtifactStore, key: string, keyRing: KeyRing): Promise<EncryptedArtifactReader> {
    const { bytes: artifactSize } = await store.stat(key);
    if (artifactSize < HEADER_FIXED_BYTES + FOOTER_BYTES) {
      throw new Error(
        `制品过短：至少需要 ${HEADER_FIXED_BYTES + FOOTER_BYTES} 字节（定长头 + 尾部），实际 ${artifactSize} 字节`,
      );
    }

    // 第一步：尾部（**恒为最后 24 字节**，R3）。它落在明文区 ⇒ 不解密任何块。
    const footer = decodeFooter(await store.getRange(key, artifactSize - FOOTER_BYTES, artifactSize - 1));

    // 第二步：头部。keyIdLen 在第 7 字节，因此先取定长 31 字节，再按需补齐 keyId。
    const { header, keyIdLength } = await readHeader(store, key, artifactSize);

    // 第三步：索引区几何（读之前先判定「该读多少」）。
    const dataStart = blockDataOffset(keyIdLength);
    validateIndexGeometry({ footer, artifactSize, dataStart });
    const indexStart = Number(footer.indexOffset);
    const indexBytes = artifactSize - FOOTER_BYTES - indexStart;
    const entries =
      indexBytes > 0
        ? decodeIndex(await store.getRange(key, indexStart, indexStart + indexBytes - 1))
        : [];

    // 第四步：索引内容（三条完整性校验 + 索引自身）。
    validateIndexContents({ header, entries, footer });

    const decipher = new ChunkDecipher(keyRing, header, entries);
    const blocks: BlockSpan[] = [];
    let plaintextStart = 0;
    for (const entry of entries) {
      blocks.push({ plaintextStart, length: entry.ciphertextLength, artifactStart: Number(entry.offset) });
      plaintextStart += entry.ciphertextLength;
    }
    return new EncryptedArtifactReader(store, key, decipher, blocks, Number(footer.plaintextLength), header);
  }

  /**
   * 取明文区间 `[start, end)`（`end` **独占**）。
   *
   * 参数错误（非安全整数、`start > end`）是**调用方**的 bug，同步抛 `RangeError`；
   * 而「区间超出制品自称的明文长度」是**数据**问题（zip 的中央目录可以指向文件之外，
   * 恶意归档必然触发），因此它走**流错误**：yauzl 的回调风格里，同步抛出会穿过它的
   * 解析栈，而流错误会被它当作解析失败处理（D6：解析器抛错必须计为「拒绝」，不能让进程崩掉）。
   */
  _readStreamForRange(start: number, end: number): Readable {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new RangeError(`非法的明文区间：[${start}, ${end})`);
    }
    return Readable.from(this.serveRange(start, end), { objectMode: false });
  }

  /**
   * yauzl 实际调用的入口。与 `_readStreamForRange` 同语义，另加两件事：
   * 空区间直接返回一个立即结束的流（不碰存储），以及**字节数断言**
   * ——yauzl 的基类正是用 `AssertByteCountStream` 做这件事，短读会让它静默解析错位。
   */
  createReadStream(options: { start: number; end: number }): Readable {
    const { start, end } = options;
    if (start === end) return Readable.from([], { objectMode: false });
    return Readable.from(this.guardedRange(start, end), { objectMode: false });
  }

  /**
   * 把明文区间 `[position, position + length)` 填进 `buffer` 的 `offset` 处（yauzl 的抽象方法）。
   *
   * 逐块搬运，**不整段缓冲**：读一个 1 GiB 的归档条目时，多一份整段副本就是多 1 GiB 内存。
   */
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null) => void,
  ): void {
    void this.copyInto(buffer, offset, length, position).then(
      () => callback(null),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  /** 释放读取器。本实现不持有任何句柄（每次 `getRange` 自己开关文件描述符），故只完成契约。 */
  close(callback: (err: Error | null) => void): void {
    setImmediate(() => callback(null));
  }

  ref(): void {
    this.refCount += 1;
  }

  /**
   * 引用计数 -1。归零 ⇒ `close()` 后派发 `'close'`；变成负数 ⇒ 抛错。
   *
   * 与 yauzl 基类逐字同款（`index.js` 第 948-961 行）：负数是**调用方**的 bug，
   * 静默容忍它会让「谁关了读取器」再也查不出来。
   */
  unref(): void {
    this.refCount -= 1;
    if (this.refCount > 0) return;
    if (this.refCount < 0) throw new Error('unref 次数多于 ref：读取器的引用计数不能为负');
    this.close((error) => {
      if (error) this.emit('error', error);
      else this.emit('close');
    });
  }

  /** 逐块产出明文区间 `[start, end)`：只解密与之相交的块，最近一块走 memo（见 `recent`）。 */
  private async *serveRange(start: number, end: number): AsyncGenerator<Buffer> {
    if (end > this.plaintextLength) {
      throw new Error(
        `读取越界：请求明文区间 [${start}, ${end})，而制品自称的明文长度是 ${this.plaintextLength} 字节`,
      );
    }
    if (start === end) return;

    let cursor = start;
    let position = this.blockIndexAt(start);
    while (cursor < end) {
      const block = this.blocks[position];
      if (block === undefined) {
        // 校验之后不该发生（Σ 长度 === plaintextLength）。留着它是为了让「校验被绕过」
        // 表现为一句看得懂的错，而不是一个 undefined 的 TypeError。
        throw new Error(`第 ${position} 块不存在：明文偏移 ${cursor} 落在所有块之外（索引与尾部不自洽）`);
      }
      const plaintext = await this.plaintextOf(position, block);
      const from = cursor - block.plaintextStart;
      const to = Math.min(block.length, end - block.plaintextStart);
      yield plaintext.subarray(from, to);
      cursor = block.plaintextStart + to;
      position += 1;
    }
  }

  /**
   * 第 `position` 块的明文：命中最近一块的 memo 就直接返回，否则读记录并解密。
   *
   * **存储读取与解密在同一侧**：命中时两者都不发生。分开写（先无条件 `getRange` 再看
   * memo）会把「每半条记录读一整块」的成本留下——那正是 Ruling 1 要消掉的东西。
   *
   * 一处据实记载（memo 的边界）：**并发的**同块读会各自解密一次（两个调用都先看到未命中）。
   * 这不是缺陷，因为本类的消费方都是顺序的——yauzl 等每次回调返回后才发下一次读、
   * gunzip 顺序拉取；只是别把「命中」当成并发语义上的保证。
   */
  private async plaintextOf(position: number, block: BlockSpan): Promise<Buffer> {
    const cached = this.recent;
    if (cached !== null && cached.position === position) return cached.plaintext;
    // 存储端口是**闭**区间：记录的末字节 = 起点 + 明文长度 + tag - 1
    const record = await this.store.getRange(
      this.key,
      block.artifactStart,
      block.artifactStart + block.length + TAG_BYTES - 1,
    );
    const plaintext = this.decipher.decryptAt(position, record);
    // 只有**成功**解密才入 memo：抛出（篡改 / 被当成别的块解读）不会被记成一次命中。
    this.recent = { position, plaintext };
    return plaintext;
  }

  /** 带字节数断言的区间读取（短读必须响亮，否则 yauzl 会静默解析错位）。 */
  private async *guardedRange(start: number, end: number): AsyncGenerator<Buffer> {
    let produced = 0;
    for await (const chunk of this.serveRange(start, end)) {
      produced += chunk.length;
      yield chunk;
    }
    if (produced !== end - start) {
      throw new Error(`明文短读：区间 [${start}, ${end}) 期望 ${end - start} 字节，实际 ${produced} 字节`);
    }
  }

  private async copyInto(buffer: Buffer, offset: number, length: number, position: number): Promise<void> {
    let written = 0;
    for await (const chunk of this.serveRange(position, position + length)) {
      chunk.copy(buffer, offset + written);
      written += chunk.length;
    }
    if (written !== length) {
      throw new Error(`明文短读：区间 [${position}, ${position + length}) 期望 ${length} 字节，实际 ${written} 字节`);
    }
  }

  /** 明文偏移落在哪一块（前缀和线性扫描：块数上限是 `ceil(1 GiB / 8 MiB) = 128`）。 */
  private blockIndexAt(offset: number): number {
    for (let position = 0; position < this.blocks.length; position++) {
      const block = this.blocks[position];
      if (block !== undefined && offset < block.plaintextStart + block.length) return position;
    }
    throw new Error(`明文偏移 ${offset} 不在任何块里（索引与尾部不自洽）`);
  }
}

/** 读头部：先取定长 31 字节拿 `keyIdLen`，再按需补齐，最后交给 `decodeHeader` 判合法性。 */
async function readHeader(
  store: ArtifactStore,
  key: string,
  artifactSize: number,
): Promise<{ header: ArtifactHeader; keyIdLength: number }> {
  const fixed = await store.getRange(key, 0, HEADER_FIXED_BYTES - 1);
  // 头被截断时把「文件里真正存在的字节」都交给 `decodeHeader`，让它报出
  // 「整颗头需要 M 字节，实际只有 N 字节」——比在存储层撞一句区间越界清楚得多。
  const wanted = Math.min(headerByteLength(fixed.readUInt8(6)), artifactSize);
  const buffer =
    wanted > fixed.length ? Buffer.concat([fixed, await store.getRange(key, fixed.length, wanted - 1)]) : fixed;
  return decodeHeader(buffer);
}

/**
 * 索引区**几何**校验：在真的去读索引之前，判定「索引区应该有多长」。
 *
 * 三条判据都是「与文件长度自洽」的具体化：
 * 1. `indexOffset` 不早于块数据区（否则索引会与块数据重叠，甚至指进头部）；
 * 2. 索引区长度非负，且是 `INDEX_ENTRY_SIZE` 的整数倍（整数倍这条同时也给
 *    「实际有多少条记录」一个**独立于自称值**的来源）；
 * 3. 0 块制品的索引起点必须**恰好**等于头部长度（R4 / §13.10 第 9 条），
 *    以及明文长度必须能被安全地表示成 `number`（读取器按 `number` 提供区间，
 *    超过 2^53 之后 `Number(...)` 会静默丢精度，区间判断随之失真）。
 *
 * 报错里出现的都是**非机密量**（偏移、长度、块数），密钥与明文一个都不出现（C11）。
 */
function validateIndexGeometry(input: {
  footer: ArtifactFooter;
  artifactSize: number;
  dataStart: number;
}): void {
  const { footer, artifactSize, dataStart } = input;
  const size = BigInt(artifactSize);

  if (footer.indexOffset < BigInt(dataStart)) {
    throw new Error(
      `索引起点越界：尾部自称 indexOffset=${footer.indexOffset}，而块数据区从 ${dataStart} 开始`,
    );
  }
  const indexBytes = size - BigInt(FOOTER_BYTES) - footer.indexOffset;
  if (indexBytes < 0n) {
    throw new Error(
      `索引起点越界：尾部自称 indexOffset=${footer.indexOffset}，而尾部之前只剩 ${size - BigInt(FOOTER_BYTES)} 字节`,
    );
  }
  if (indexBytes % BigInt(INDEX_ENTRY_SIZE) !== 0n) {
    throw new Error(
      `索引区长度不是 ${INDEX_ENTRY_SIZE} 的整数倍：区间 [${footer.indexOffset}, ${size - BigInt(FOOTER_BYTES)}) 共 ${indexBytes} 字节`,
    );
  }
  if (footer.chunkCount === 0n && footer.indexOffset !== BigInt(dataStart)) {
    throw new Error(
      `0 块制品的索引起点必须等于头部长度：尾部自称 indexOffset=${footer.indexOffset}，头部长度是 ${dataStart}`,
    );
  }
  if (footer.plaintextLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`明文长度超出可安全表示的范围：${footer.plaintextLength}`);
  }
}

/**
 * 索引**内容**校验：三条完整性校验 + 索引自身的结构。
 *
 * 三条校验缺一不可，而且它们挡的是**不同**的伪造（各自有孤立用例与变异探针）：
 *
 * 1. `chunkCount === 索引区实际记录数` —— 事实来源是**文件几何**（`entries.length` 来自
 *    `size - 24 - indexOffset`），不是自称的 `chunkCount`；
 * 2. `chunkCount === ceil(plaintextLength / chunkSize)` —— `chunkSize` 在**未认证的头部**里，
 *    因此它可以被单独篡改；
 * 3. `Σ ciphertextLength === plaintextLength` —— 唯一约束索引**内容**（各块长度）的一条。
 *
 * **据实记载**：这三条合起来**仍不足以**挡住「整块截断 + 尾部改得完全自洽」——
 * 删掉末尾整块连同它的索引记录、把尾部三个字段一并改小之后，三条全部满足。
 * 挡住那一类的是末块的 `isLast` AAD 标记（见 `ChunkDecipher`），读取端把被删块之后的
 * 那一块当末块认证时失败。用例见 `random-access-reader.test.ts` 的「整块截断」。
 */
function validateIndexContents(input: {
  header: ArtifactHeader;
  entries: readonly IndexEntry[];
  footer: ArtifactFooter;
}): void {
  const { header, entries, footer } = input;
  /**
   * 块数据区的起点：头部长度（`31 + keyId` 字节）。**不是**索引里任何自称值，
   * 因此它可以用来校验「第 0 条记录从哪儿开始」。
   */
  const dataStart = BigInt(blockDataOffset(header.keyId.length));

  // ---- 校验 1：尾部自称的块数 === 索引区里实际存在的记录数 ----
  if (footer.chunkCount !== BigInt(entries.length)) {
    throw new Error(
      `索引记录数不符：尾部自称 ${footer.chunkCount} 块，索引区实际存在 ${entries.length} 条记录`,
    );
  }

  // ---- 校验 2：块数公式 ----
  const expectedChunks = chunkCountOf(footer.plaintextLength, header.chunkSize);
  if (footer.chunkCount !== expectedChunks) {
    throw new Error(
      `块数公式不符：尾部自称 plaintextLength=${footer.plaintextLength}、头部 chunkSize=${header.chunkSize}` +
        ` ⇒ 应有 ${expectedChunks} 块，实际自称 ${footer.chunkCount} 块`,
    );
  }

  // ---- 校验 3：Σ ciphertextLength === plaintextLength ----
  const totalCiphertext = entries.reduce((sum, entry) => sum + BigInt(entry.ciphertextLength), 0n);
  if (totalCiphertext !== footer.plaintextLength) {
    throw new Error(
      `密文长度合计不符：索引各块的 ciphertextLength 合计 ${totalCiphertext}，尾部自称 plaintextLength=${footer.plaintextLength}`,
    );
  }

  // ---- 索引自身：offset 严格递增、从块数据区起点开始、块之间连续、每条记录的区间落在块数据区内 ----
  // 「严格」而不是「非递减」：写入端从不产出 0 字节的块，因此两条记录同一起点只可能是伪造。
  let previous = -1;
  let expectedStart = dataStart;
  for (let position = 0; position < entries.length; position++) {
    const entry = entries[position];
    if (entry === undefined) break; // 不可达（上面的循环界就是 entries.length）；让类型收窄
    const start = Number(entry.offset);
    const end = entry.offset + BigInt(entry.ciphertextLength) + BigInt(TAG_BYTES);
    if (start <= previous) {
      throw new Error(
        `索引 offset 不是严格递增：第 ${position} 条记录的 offset=${entry.offset}，前一条是 ${previous}`,
      );
    }
    /**
     * 块数据区是**连续**的：第 0 条记录从头部末尾开始，此后每条紧接上一条。
     *
     * 只校验「递增 + 区间上界」是**只从上界卡**：一个把中段记录往前挪几字节的伪造索引
     * 仍然满足递增与上界（`previous` 是上一条记录的起点，不受影响），于是坐标会被
     * 结构性地接受——payload 在**读的时候**因认证失败而拒，但错误信息指向「密文被篡改」，
     * 而真实原因是索引坐标不连续。这一条把坐标本身钉死。
     *
     * 它**不是**新的安全边界（篡改仍然在第一次读该块时被拒），而是给同一类拒绝
     * 一个指向**坐标**的诊断：与 Step 6 的其它判据同一类，成本是一行。
     */
    if (entry.offset !== expectedStart) {
      throw new Error(
        position === 0
          ? `第 0 条记录的起点必须是块数据区起点：offset=${entry.offset}，而头部之后从 ${dataStart} 开始`
          : `索引记录不连续：第 ${position} 条记录的 offset=${entry.offset}，` +
              `而前一条记录的终点（含 ${TAG_BYTES} 字节 tag）是 ${expectedStart}`,
      );
    }
    if (end > footer.indexOffset) {
      throw new Error(
        `第 ${position} 条记录的区间越出块数据区：[${entry.offset}, ${end})，而索引起点是 ${footer.indexOffset}`,
      );
    }
    previous = start;
    expectedStart = end;
  }
}

/** `ceil(plaintextLength / chunkSize)`，全程 bigint（不经过 number，免得在边界上丢精度）。 */
function chunkCountOf(plaintextLength: bigint, chunkSize: number): bigint {
  const chunk = BigInt(chunkSize);
  return plaintextLength === 0n ? 0n : (plaintextLength + chunk - 1n) / chunk;
}
