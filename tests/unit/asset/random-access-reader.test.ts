import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import {
  FOOTER_BYTES,
  INDEX_ENTRY_SIZE,
  blockDataOffset,
  decodeFooter,
  headerByteLength,
  type IndexEntry,
} from '@vca/api/modules/asset/crypto/artifact-format.js';
import { createKeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
// 制品的构造与伪造（含 C20 调换、整块截断）住在共享夹具里：`security` 门要**复用**
// 同一批辅助函数来断言「这些伪造必须被拒」，而不是把同一条用例复制成两份。
// 见 `tests/helpers/craft-encrypted-artifact.ts` 的文件头。
import {
  KEY_BYTES,
  MemoryStore,
  at,
  collect,
  countDecryptions,
  entriesOf,
  fakeRing,
  openForged,
  openForgedReader,
  pattern,
  readRange,
  recordRange,
  sectionsOf,
  seedArtifact,
  swapRecords,
  truncateLastBlocks,
  withChunkSize,
  withFooter,
  withIndexEntry,
  type SeededArtifact,
} from '../../helpers/craft-encrypted-artifact.js';

/**
 * 加密制品的随机访问读取器（P1 / Task 3 的读取端）。
 *
 * ## 它在整条链路里的位置
 *
 * zip 的中央目录在文件**末尾**，所以 `yauzl.fromRandomAccessReader(reader, totalSize)`
 * 需要一个能按任意区间取字节的读取器。本类把**加密制品**呈现为**明文视图**：
 * yauzl 要明文的 `[start, end)`，读取器按索引定位与之相交的块，**只解密那些块**。
 *
 * ## 两组判据
 *
 * 1. **效率与语义**（「只解密所需块」）：定位索引要读的是制品**最后 24 字节**（尾部），
 *    它不属于任何块；真正解密的块数只与请求区间覆盖的块有关。生产块大小 8 MiB，
 *    每次 push 的量级就是一块 —— 一次「读尾部 22 字节」若解密整份制品，代价是 1 GiB。
 * 2. **完整性**（三条校验 + 索引自身校验 + C20）：制品的头部与尾部**都不在任何 AAD 里**，
 *    因此总量字段是不可信输入；`offset` / `ciphertextLength` 同样未被认证。
 *    **写入端的 `decodeIndex` 有意不做这些检查**（它只负责「24 字节 → 记录」），
 *    它们是读取端的责任。安全门（`tests/security/asset-artifact-integrity.test.ts`）
 *    用同一批夹具断言这些伪造**必须被拒**——本文件负责判据的**判别力**（每条校验都有一条
 *    孤立用例 + 变异探针），安全门负责「控制还在不在」。
 *
 * ## 一处据实记载：三条完整性校验**挡不住整块截断**
 *
 * 攻击者删掉末尾整块、连同它的索引记录，并把尾部改写得**完全自洽**时，三条校验
 * 全部满足（见本文件那条用例的算术）。挡住它的是末块的 `isLast` AAD 标记：被删块之后
 * 的那一块当初是用 `more` 建的，而读取端会把它当末块（`last`）去认证 ⇒ 拒绝。
 * 这条边界必须写清楚，否则「三条校验 = 充分」这句话会让人以为整块截断在 open 阶段就被拦下。
 *
 * **修复轮 1 的补强（复审的精确化）**：这条防线是**完整**的——截断到 n 块必然逼着读取端
 * 把真实的第 n-1 块当末块去认证，而那块的标记是 `more` ⇒ 必拒。唯一的条件是
 * **读取必须走到自称的末尾**。因此本文件与安全门都直接断言这件事：
 * 「走到自称末尾的那次读**确实认证了最后一块**」（见 `最后一块` 那两条用例），
 * 而不是把这条义务留在注释里。
 */

/** 明文偏移 → 落在哪一块（本文件自己算，不问实现）。 */
function blockOf(entries: readonly IndexEntry[], offset: number): number {
  let cursor = 0;
  for (let position = 0; position < entries.length; position++) {
    const length = at(entries, position).ciphertextLength;
    if (offset < cursor + length) return position;
    cursor += length;
  }
  throw new Error(`明文偏移 ${offset} 不在任何块里`);
}

/**
 * 手工造一个只含**一个 stored（不压缩）条目**的最小 zip。
 *
 * 为什么手搓而不是引入压缩库：本任务不新增依赖，而 zip 的**尾部结构**正是这里要考的
 * ——中央目录与 EOCD 都在文件末尾，因此读取器必须能从最后一块取到它们。
 * 用 stored（不压缩）可以让字节完全可预测，避免把「解压实现」混进判据里。
 */
function buildStoredZip(name: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(content);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // compression = stored
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18); // compressed size
  local.writeUInt32LE(content.length, 22); // uncompressed size
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const localSize = local.length + nameBytes.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(0, 10); // compression = stored
  central.writeUInt16LE(0, 12); // mod time
  central.writeUInt16LE(0, 14); // mod date
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // 本地文件头的相对偏移（唯一的条目 ⇒ 0）

  const centralSize = central.length + nameBytes.length;
  // 中央目录的偏移 = 本地头 + 文件名 + **数据**（第一版漏了数据那一段，
  // yauzl 因此在「hello zip」这几个字节上找中央目录，报
  // `invalid central directory file header signature: 0x6c6c6568`）
  const centralOffset = localSize + content.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  end.writeUInt16LE(0, 4); // 本磁盘号
  end.writeUInt16LE(0, 6); // 中央目录所在磁盘号
  end.writeUInt16LE(1, 8); // 本磁盘条目数
  end.writeUInt16LE(1, 10); // 总条目数
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([local, nameBytes, content, central, nameBytes, end]);
}

describe('EncryptedArtifactReader 的区间语义（明文视图）', () => {
  it('读整段明文与原文逐字节一致（跨块 + 末块不满）', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(3 * 64 + 5, 1);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });

    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    expect(reader.plaintextLength).toBe(plaintext.length);
    const out = await collect(reader._readStreamForRange(0, plaintext.length));
    expect(out.equals(plaintext), '整段明文不一致').toBe(true);
  });

  it('`_readStreamForRange(start, end)` 的 end 是**独占**的（yauzl 的约定）', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(200, 2);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    expect((await collect(reader._readStreamForRange(10, 20))).equals(plaintext.subarray(10, 20))).toBe(true);
    // 空区间（start === end）⇒ 0 字节，且**不碰存储**
    store.reset();
    expect(await collect(reader._readStreamForRange(5, 5))).toHaveLength(0);
    expect(store.requests).toEqual([]);
    // 末字节：闭区间写法下最容易差一位的地方
    expect((await collect(reader._readStreamForRange(199, 200))).equals(plaintext.subarray(199, 200))).toBe(true);
  });

  it('`createReadStream({start, end})` 与 `_readStreamForRange` 同语义，且短读会报错', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(3 * 64, 3);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    const out = await collect(reader.createReadStream({ start: 60, end: 130 }));
    expect(out.equals(plaintext.subarray(60, 130))).toBe(true);
    expect(await collect(reader.createReadStream({ start: 7, end: 7 }))).toHaveLength(0);
  });

  it('`read(buffer, offset, length, position, callback)`：填满调用方的缓冲区（yauzl 的抽象方法）', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(3 * 64 + 5, 4);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    // 跨两块地读：区间 [60, 140) 覆盖块 0/1/2
    const buffer = Buffer.alloc(80);
    await new Promise<void>((resolve, reject) => {
      reader.read(buffer, 0, 80, 60, (error) => (error === null ? resolve() : reject(error)));
    });
    expect(buffer.equals(plaintext.subarray(60, 140))).toBe(true);

    // 写到缓冲区的**中间**（offset 参数），其余字节保持原样
    const padded = Buffer.alloc(40, 0xaa);
    await new Promise<void>((resolve, reject) => {
      reader.read(padded, 8, 20, 100, (error) => (error === null ? resolve() : reject(error)));
    });
    expect(padded.subarray(0, 8).equals(Buffer.alloc(8, 0xaa))).toBe(true);
    expect(padded.subarray(8, 28).equals(plaintext.subarray(100, 120))).toBe(true);
    expect(padded.subarray(28).equals(Buffer.alloc(12, 0xaa))).toBe(true);
  });
});

describe('只解密所需块（验收：读尾部 N 字节解密的块数 ≤ 2）', () => {
  it('`open` 定位索引时**一个块都不解密**：只读头部 + 索引 + 最后 24 字节', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(5 * 64, 5);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    store.reset();

    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    const headerBytes = headerByteLength(Buffer.byteLength('v1', 'utf8'));
    const indexBytes = seeded.entries.length * INDEX_ENTRY_SIZE;
    // 请求总量恰好是「头部 + 索引 + 尾部」，多一个字节都说明有实现去读了块数据
    expect(store.bytesRequested()).toBe(headerBytes + indexBytes + FOOTER_BYTES);
    // 而且**没有任何一次请求落在块数据区里**
    for (const request of store.requests) {
      for (const entry of seeded.entries) {
        const range = recordRange(entry);
        const overlaps = request.start <= range.endInclusive && request.endInclusive >= range.start;
        expect(overlaps, `open 阶段不该读块数据：请求 [${request.start}, ${request.endInclusive}]`).toBe(false);
      }
    }
    // 尾部那 24 字节必须是被**单独**取出来的（这正是「先读最后 24 字节定位索引」）
    expect(store.requests).toContainEqual({
      key: seeded.key,
      start: seeded.artifact.length - FOOTER_BYTES,
      endInclusive: seeded.artifact.length - 1,
    });
    expect(reader.plaintextLength).toBe(plaintext.length);
  });

  /**
   * 「读到末尾的尾巴」——这条用例是 Task 4 义务的**唯一机械判据**（修复轮 1 / Fix 3）。
   *
   * 三条断言各自钉住一件 Task 4 依赖的事：
   * 1. 区间真的落在**最后一块的后半段**（不是块中间某处）；
   * 2. 末字节在返回的字节里 —— 也就是**读到了制品自称的最后一字节**；
   * 3. 解密的块**恰好是索引的最后一条记录**（`isLast = true` 的那一块）⇒ 它的 GCM
   *    tag 被真实验证过。没有这一条，一次「走到自称末尾但不认证末块」的读
   *    （例如把 `serveRange` 提前 return）会全绿，而 Task 4 的全部截断检测都压在
   *    「末块被认证」这件事上。
   */
  it('读**真正的尾部** 22 字节：落在最后一块内、读到末字节，且只有那一次请求 ⇒ 末块被认证', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(5 * 64, 6);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const lastPosition = seeded.entries.length - 1;
    const lastBlock = at(seeded.entries, lastPosition);

    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());
    // 起点必须落在**最后一块**里（前缀和算，不问实现），而不是块中间
    expect(blockOf(seeded.entries, plaintext.length - 22)).toBe(lastPosition);
    // 而且它确实在最后一块的**后半段**：最后一块从 `plaintext.length - 64` 开始
    // （**注意坐标系统**：`entry.offset` 是**制品内**的密文偏移，不是明文偏移，
    //  两者差着一个头部长度 —— 第一版就是拿它当明文偏移去比才红的）
    const lastBlockPlaintextStart = seeded.entries
      .slice(0, lastPosition)
      .reduce((sum, entry) => sum + entry.ciphertextLength, 0);
    expect(plaintext.length - 22).toBeGreaterThan(lastBlockPlaintextStart);
    expect(lastBlock.ciphertextLength).toBe(64);
    store.reset();

    const out = await collect(reader._readStreamForRange(plaintext.length - 22, plaintext.length));

    expect(out.equals(plaintext.subarray(plaintext.length - 22))).toBe(true);
    // 末字节确实回来了：`_readStreamForRange` 的 end 是独占的，`plaintextLength` 是自称末尾
    expect(reader.plaintextLength).toBe(plaintext.length);
    expect(out.subarray(out.length - 1).equals(plaintext.subarray(plaintext.length - 1))).toBe(true);
    // 恰好一次请求，且它就是**最后一条记录**的区间 ⇒ 解密的块数 = 1，且这一块按 `last` 认证
    expect(store.requests).toEqual([{ key: seeded.key, ...recordRange(lastBlock) }]);
  });

  it('读中间任意区间只解密与之相交的块，且每块最多请求一次', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(5 * 64, 7);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());
    store.reset();

    // [60, 200) 覆盖块 0（尾 4 字节）/ 1 / 2 / 3（前 8 字节）
    const out = await collect(reader._readStreamForRange(60, 200));

    expect(out.equals(plaintext.subarray(60, 200))).toBe(true);
    const expected = [0, 1, 2, 3].map((position) => ({ key: seeded.key, ...recordRange(at(seeded.entries, position)) }));
    expect(store.requests).toEqual(expected);
    expect(blockOf(seeded.entries, 60)).toBe(0);
    expect(blockOf(seeded.entries, 199)).toBe(3);
  });
});

describe('最近一块的 memo（修复轮 1 / Ruling 1）：判别力与「只留一格」的边界', () => {
  /**
   * 每条用例自己 `restore`，同时登记到 `afterEach`：断言失败时也要还原。
   * 用的是 `countDecryptions` 而不是 `vi.spyOn`，因为 spy 会**保留每一次调用的实参**
   * ——这里那些实参是整块明文（见该辅助函数的注释：8 MiB × 4 万次会把 worker 撑爆）。
   */
  let restoreDecryptions: (() => void) | null = null;

  afterEach(() => {
    // 第二道保险：断言中途失败时也必须还原替换掉的 `ChunkDecipher.prototype.decryptAt`，
    // 否则会污染后面的用例（它们也会数解密次数）。
    restoreDecryptions?.();
    restoreDecryptions = null;
  });

  it('同一块连读只解密一次；换块之后**旧块必须重新解密**（刻意只留一格，不做通用缓存）', async () => {
    const counter = countDecryptions();
    restoreDecryptions = counter.restore;
    const store = new MemoryStore();
    const plaintext = pattern(3 * 64, 27);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());
    store.reset();

    // ① 块 0：解密 1 次
    expect((await collect(reader._readStreamForRange(0, 8))).equals(plaintext.subarray(0, 8))).toBe(true);
    expect(counter.calls()).toBe(1);

    // ② 还是块 0 的**另一段**：命中 memo ⇒ 解密次数不变，**而且没有再读存储**
    //    （存储读取与解密在同一侧：命中时两者都不发生）
    const requestsAfterFirst = store.requests.length;
    expect((await collect(reader._readStreamForRange(8, 16))).equals(plaintext.subarray(8, 16))).toBe(true);
    expect(counter.calls()).toBe(1);
    expect(store.requests).toHaveLength(requestsAfterFirst);

    // ③ 换到块 1：memo 失效 ⇒ 2 次
    expect((await collect(reader._readStreamForRange(70, 80))).equals(plaintext.subarray(70, 80))).toBe(true);
    expect(counter.calls()).toBe(2);

    // ④ **回到**块 0：memo 里只剩块 1 ⇒ 必须重新解密（3 次）。
    //    这一条钉住的是**刻意的上限**：只记住最近一块。有人把它换成通用缓存时它会变红
    //    ——那时应当连同 C16 的裁定一起重新审议（缓存的大小、失效与内存上限都是新的风险面），
    //    而不是让缓存悄悄长大。同时它也是一条**字节正确性**检查：memo 若返回了别的块的
    //    明文，上面的相等断言会先红。
    expect((await collect(reader._readStreamForRange(0, 8))).equals(plaintext.subarray(0, 8))).toBe(true);
    expect(counter.calls()).toBe(3);
  });

  it('跨块的一次读：每块各解密一次（memo 不会把跨块读变成重解整段）', async () => {
    const counter = countDecryptions();
    restoreDecryptions = counter.restore;
    const store = new MemoryStore();
    const plaintext = pattern(5 * 64, 28);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());
    store.reset();

    // 区间 [0, 200) 覆盖块 0..3：单调前进 ⇒ 恰好 4 次解密 + 4 次存储请求
    expect((await collect(reader._readStreamForRange(0, 200))).equals(plaintext.subarray(0, 200))).toBe(true);
    expect(counter.calls()).toBe(4);
    expect(store.requests).toHaveLength(4);
  });
});

describe('0 块制品（空文件，R4）', () => {
  it('`chunkCount = 0`、空索引、`indexOffset === 头部长度`；读取器可用且明文长度为 0', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, Buffer.alloc(0));

    // 写入端的几何（§13.10 第 9 条）：尾部自称的 indexOffset 恰好是头部长度
    const footer = decodeFooter(seeded.artifact.subarray(seeded.artifact.length - FOOTER_BYTES));
    expect(footer.chunkCount).toBe(0n);
    expect(footer.plaintextLength).toBe(0n);
    expect(footer.indexOffset).toBe(BigInt(blockDataOffset(Buffer.byteLength('v1', 'utf8'))));
    expect(seeded.artifact).toHaveLength(headerByteLength(2) + FOOTER_BYTES);

    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    expect(reader.plaintextLength).toBe(0);
    expect(await collect(reader._readStreamForRange(0, 0))).toHaveLength(0);
  });
});

describe('越界与生命周期', () => {
  it('请求超出明文长度的区间 ⇒ 流以错误结束（异步、不崩进程）', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(200, 8);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    await expect(collect(reader._readStreamForRange(190, 201))).rejects.toThrow(/明文长度是 200/);
    await expect(collect(reader.createReadStream({ start: 200, end: 260 }))).rejects.toThrow(/越界|明文长度/);
  });

  it('`read` 越界时走**回调**报错，而不是同步抛出（yauzl 的回调风格）', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(64, 9), { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    const error = await new Promise<Error | null>((resolve) => {
      reader.read(Buffer.alloc(10), 0, 10, 900, (err) => resolve(err));
    });
    expect(error).toBeInstanceOf(Error);
  });

  it('`ref` / `unref` 成对 ⇒ 计数归零时关闭并派发 `close`（yauzl 的生命周期）', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(64, 10), { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    let closedCount = 0;
    reader.on('close', () => {
      closedCount += 1;
    });

    reader.ref();
    reader.ref();
    reader.unref();
    await new Promise((resolve) => setImmediate(resolve));
    expect(closedCount, '计数还没归零就不该关闭').toBe(0);

    reader.unref();
    await new Promise((resolve) => setImmediate(resolve));
    expect(closedCount).toBe(1);
  });

  it('`unref` 多于 `ref` ⇒ 抛错（计数不能变负）', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(64, 11), { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());

    expect(() => reader.unref()).toThrow(/unref/);
  });
});

describe('读取端的校验：三条完整性校验 + 索引自身（写入端的 decodeIndex 有意不做）', () => {
  /**
   * 三条完整性校验各自的**孤立**伪造。
   *
   * 三块满块（`chunkSize=64`、明文 192 字节）是基准；每条伪造只破坏一条校验。
   * 「孤立」这件事是承重的：若某条伪造同时触发别的校验，那么「把该条校验关掉」之后
   * 用例**仍然会红**（别的校验接住了它），变异探针就无法证明这条用例测的是哪条校验。
   */
  async function threeFullBlocks(): Promise<SeededArtifact> {
    const store = new MemoryStore();
    return seedArtifact(store, pattern(192, 20), { chunkSize: 64 });
  }

  it('校验 1：`chunkCount === 索引区实际记录数`（索引区实际有几条由**文件几何**决定）', async () => {
    const seeded = await threeFullBlocks();
    // 伪造：尾部自称 2 块，而索引区里物理上躺着 3 条记录。
    // chunkSize 一并改成 96，好让「块数公式」那条仍然满足（ceil(192/96) = 2）
    // ——否则这条用例会同时踩中校验 2，红的原因就不唯一了。
    const forged = withChunkSize(withFooter(seeded.artifact, { chunkCount: 2n }), 96);

    const message = await openForged(forged);
    expect(message).toMatch(/索引记录数不符/);
    expect(message).toMatch(/自称 2 块/);
    expect(message).toMatch(/实际存在 3 条记录/);
  });

  it('校验 2：`chunkCount === ceil(plaintextLength / chunkSize)`（chunkSize 在未认证的头部里）', async () => {
    const seeded = await threeFullBlocks();
    // 伪造：只改头部里的 chunkSize（100 → 96）⇒ 块数公式给出 2，而自称 3 块。
    // 条数与合计都没动，因此只有这一条校验会响。
    const forged = withChunkSize(seeded.artifact, 96);

    const message = await openForged(forged);
    expect(message).toMatch(/块数公式不符/);
    expect(message).toMatch(/chunkSize=96/);
  });

  it('校验 3：`Σ ciphertextLength === plaintextLength`（唯一约束索引**内容**的一条）', async () => {
    const seeded = await threeFullBlocks();
    // 伪造：把第 2 条记录声明的密文长度从 64 改成 40（offset 不动 ⇒ 单调与区间都仍然成立）。
    // 条数、块数公式都满足，只有「合计 ≠ 自称总量」会响。
    const entries = entriesOf(seeded.artifact);
    const forged = withIndexEntry(seeded.artifact, 2, { ...at(entries, 2), ciphertextLength: 40 });

    const message = await openForged(forged);
    expect(message).toMatch(/密文长度合计不符/);
    expect(message).toMatch(/合计 168/);
    expect(message).toMatch(/plaintextLength=192/);
  });

  /**
   * **整块截断**：三条校验全绿、`open()` 成功，但走到自称末尾的那次读**必须**响。
   *
   * 修复轮 1（Fix 1）把这条用例的判据从「注释里写着 Task 4 要用末块认证」改成**机械判据**：
   * 第四条断言逐条比对 `store.requests`，要求这次读请求的区间**恰好**是索引最后一条记录，
   * 也就是「**末块确实被解密器认证过**」。把 `serveRange` 改成不读末块（或提前 return），
   * 这条断言立刻变红——义务不再只住在注释里。
   */
  it('三条校验**合起来仍挡不住整块截断**：尾部改得自洽时 open 通过，但读末块被 `isLast` 拒绝', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 21), { chunkSize: 64 });
    const forged = truncateLastBlocks(seeded.artifact);
    const key = store.seed(forged);

    // 算术复核（据实记载，别把它读成「三条校验足够」）：
    //   索引区 = 2 * 24 = 48 字节 ⇒ 自称 2 块 ✓；ceil(128 / 64) = 2 ✓；64 + 64 = 128 ✓
    // 于是**三条全部满足**，open 成功。
    const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
    expect(reader.plaintextLength).toBe(128);

    // 挡住它的是末块的 AAD 标记：这一块当初是用 `more` 建的，而读取端按 `last` 去认证。
    store.reset();
    const readToDeclaredEnd = await readRange(reader, 64, reader.plaintextLength);
    expect(readToDeclaredEnd.message).toMatch(/第 1 块认证失败/);
    expect(readToDeclaredEnd.bytes).toBeNull();
    // **Fix 1 的核心断言**：这次读解密的块恰好是**伪造制品**索引的最后一条记录
    // ⇒ 「走到自称末尾 ⇒ 末块被认证」这件事被机械地钉住了。
    // 少了它，把末块从读取路径里去掉（探针 `last-block-not-read`）不会红任何东西。
    const forgedEntries = entriesOf(forged);
    const expectedLastRead = { key, ...recordRange(at(forgedEntries, forgedEntries.length - 1)) };
    expect(store.requests.at(-1)).toEqual(expectedLastRead);
    expect(store.requests.filter((request) => request.start === expectedLastRead.start)).toHaveLength(1);

    // 而它前面的那一块照常可读（说明拒绝来自末块标记，不是实现整体坏掉）
    expect((await collect(reader._readStreamForRange(0, 64))).equals(seeded.plaintext.subarray(0, 64))).toBe(true);
  });

  it('索引区几何：`indexOffset` 早于块数据区、长度不是 24 的整数倍、明文长度超出安全范围 ⇒ 各自拒绝', async () => {
    const seeded = await threeFullBlocks();
    const { indexOffset } = sectionsOf(seeded.artifact);

    expect(await openForged(withFooter(seeded.artifact, { indexOffset: 5n }))).toMatch(/索引起点越界/);
    expect(await openForged(withFooter(seeded.artifact, { indexOffset: BigInt(indexOffset - 8) }))).toMatch(
      /不是 24 的整数倍/,
    );
    expect(await openForged(withFooter(seeded.artifact, { plaintextLength: 2n ** 60n }))).toMatch(/超出可安全表示/);
  });

  /**
   * 索引自身的结构判据。三条断言的**判别力各自孤立**（各自有变异探针）：
   *
   * - 严格递增：第 1 条与第 0 条同一起点；
   * - **第 0 条必须从块数据区起点开始**（修复轮 1 补的判据之一）：把第 0 条往后挪 8 字节；
   * - **块之间必须连续**（修复轮 1 补的另一条）：把第 1 条记录**往前**挪 8 字节
   *   （压到上一块尾部那 8 个字节上）。此时 `previous` 没变 ⇒ **递增仍然成立**、
   *   区间上界仍然成立、条数与合计都没动 ⇒ 三条完整性校验全绿。
   *
   * 少了后两条，一个指向头部区域或与相邻块重叠的伪造索引会被 `open()` **结构性地接受**：
   * 读的时候确实会因 GCM 认证失败而拒（fail closed），但错误信息指向「密文被篡改」，
   * 而真实原因是**索引坐标**不自洽。这两条把坐标本身钉死，属于同一类检查（Step 6）。
   */
  it('索引自身：`offset` 必须严格递增、第 0 条从块数据区起点开始、块之间连续', async () => {
    const seeded = await threeFullBlocks();
    const entries = entriesOf(seeded.artifact);
    const { headerBytes } = sectionsOf(seeded.artifact);

    // 非递增：第 1 条与第 0 条同一起点
    const notIncreasing = withIndexEntry(seeded.artifact, 1, { ...at(entries, 1), offset: BigInt(headerBytes) });
    expect(await openForged(notIncreasing)).toMatch(/不是严格递增/);

    // 第 0 条不从块数据区起点开始 ⇒ 索引与文件几何不自洽
    const notAtDataStart = withIndexEntry(seeded.artifact, 0, {
      ...at(entries, 0),
      offset: BigInt(headerBytes + 8),
    });
    expect(await openForged(notAtDataStart)).toMatch(/第 0 条记录的起点必须是块数据区起点/);

    // 不连续：第 1 条往前挪 8 字节（递增仍成立、上界仍成立、条数与合计都没动）
    const overlapping = withIndexEntry(seeded.artifact, 1, {
      ...at(entries, 1),
      offset: at(entries, 1).offset - 8n,
    });
    expect(await openForged(overlapping)).toMatch(/索引记录不连续/);

    // 原来那条「把第 2 条挪到索引起点上」的伪造，本轮实测**改由连续性报错**
    // （`索引记录不连续：第 2 条记录的 offset=273，而前一条记录的终点…是 193`）：
    // 它同时违反两条判据，因此它的判别力不唯一，不适合断言具体是哪一个。
    //
    // **据实记载（一个反直觉的发现）**：在「递增 + 第 0 条起点 + 连续性 + 校验 3」都成立之后，
    // 「每条记录的区间落在 `[0, indexOffset)` 内」这条上界判据**无法在合法几何下被单独触发**：
    // 连续性把最后一条记录的终点钉在 `indexOffset` 上、校验 3 把各块长度之和钉在
    // `plaintextLength` 上，于是「越界」蕴含「Σ+ciphertextLength > plaintextLength」，
    // 那已经在校验 3 被拒了。（我按这个方向构造了四条伪造、逐条实测，
    // 全部被更早的几何或校验 3 接住。）因此**它没有一条独立的用例与探针**，
    // 实现里那一行是防御性的第二道闸；我没有据此删掉它（那是 Task 3 之外的范围），
    // 也没有为它编造一条「红」——`index-range-in-bounds` 探针因此**没有判别力**。

    // 负向对照：上面几条判据不是「任何制品都拒绝」——原样制品必须照常打开
    expect(await openForged(seeded.artifact)).toBe('');
  });

  it('0 块制品的几何：`chunkCount = 0` 时 `indexOffset` 必须等于头部长度', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, Buffer.alloc(0));
    const { headerBytes } = sectionsOf(seeded.artifact);

    // 伪造：0 块却把索引起点往后挪了 24 字节（文件里其实没有那么多字节）
    const grown = Buffer.concat([seeded.artifact.subarray(0, seeded.artifact.length - FOOTER_BYTES), Buffer.alloc(24), seeded.artifact.subarray(seeded.artifact.length - FOOTER_BYTES)]);
    const forged = withFooter(grown, { indexOffset: BigInt(headerBytes + 24) });
    // 索引区因此变成 0 字节（几何自洽），但 0 块制品的索引起点必须是头部长度
    expect(await openForged(forged)).toMatch(/0 块制品的索引起点/);
  });

  it('读某一块时被 C20 拒绝：调换两条记录后，读该块报「位置 P 处的记录自称序号 Q」，其它块不受影响', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 22), { chunkSize: 64 });
    const key = store.seed(swapRecords(seeded.artifact, 0, 1));

    // 结构上完全自洽 ⇒ open 成功（这正是危险之处：静态校验看不出调换）
    const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
    expect(reader.plaintextLength).toBe(192);

    await expect(collect(reader._readStreamForRange(0, 64))).rejects.toThrow(/位置 0 处的记录自称序号 1/);
    await expect(collect(reader._readStreamForRange(64, 128))).rejects.toThrow(/位置 1 处的记录自称序号 0/);
    // 没被调换的那一块照常可读
    expect((await collect(reader._readStreamForRange(128, 192))).equals(seeded.plaintext.subarray(128, 192))).toBe(true);
  });

  it('`openForgedReader` 的负向对照：没被改过的制品能打开，改过的才返回错误信息', async () => {
    // 这条用例是给安全门的夹具本身做的对照：夹具不能「对什么都报错」，
    // 否则安全门那几条「必须被拒」的断言会变成同义反复。
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 26), { chunkSize: 64 });
    const untouched = await openForgedReader(seeded.artifact);
    expect(untouched.message).toBe('');
    expect(untouched.reader).not.toBeNull();

    const forged = await openForgedReader(withChunkSize(seeded.artifact, 96));
    expect(forged.message).toMatch(/块数公式不符/);
    expect(forged.reader).toBeNull();
  });
});

describe('密钥选择与真实存储的端到端', () => {
  it('未知 keyId ⇒ open 抛错（绝不回退到活动键）', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(64, 23), { chunkSize: 64 });

    // 环里只有 v2，而制品头里写着 v1
    const ring = createKeyRing({
      ARTIFACT_KEYS: JSON.stringify({ v2: KEY_BYTES.toString('base64') }),
      ARTIFACT_ACTIVE_KEY_ID: 'v2',
    });
    await expect(EncryptedArtifactReader.open(store, seeded.key, ring)).rejects.toThrow(/v1/);
  });

  it('已退役但仍在环中的 keyId ⇒ 正常读取（R5 的轮换路径）', async () => {
    const store = new MemoryStore();
    const v2 = Buffer.from('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');
    const writerRing = createKeyRing({
      ARTIFACT_KEYS: JSON.stringify({ v1: KEY_BYTES.toString('base64'), v2: v2.toString('base64') }),
      ARTIFACT_ACTIVE_KEY_ID: 'v1',
    });
    const seeded = await seedArtifact(store, pattern(192, 24), { chunkSize: 64, ring: writerRing });
    expect(seeded.header.keyId).toBe('v1');

    // 活动键已切到 v2（v1 退役但仍在环里）——旧制品必须仍按 v1 可读
    const readerRing = createKeyRing({
      ARTIFACT_KEYS: JSON.stringify({ v1: KEY_BYTES.toString('base64'), v2: v2.toString('base64') }),
      ARTIFACT_ACTIVE_KEY_ID: 'v2',
    });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, readerRing);

    expect((await collect(reader._readStreamForRange(0, 192))).equals(seeded.plaintext)).toBe(true);
  });

  it('真实 `LocalArtifactStore` 上端到端：putStream 写入 → 读取器按区间取回明文', async () => {
    // 前面所有用例用的都是内存替身；这一条证明与**真实存储端口**的接线成立
    // （它的 `getRange` 是闭区间、键必须是 UUIDv7、短读会抛错）。
    //
    // 目录必须**本用例自己造**：`unit` project 没有 `setupFiles`
    // （只有 integration / security 有 `tests/setup/artifact-store.ts`），
    // 因此 `process.env.ARTIFACT_STORE_DIR` 在这里**没有值**——第一版就是直接读它
    // 才把一个相对路径当成了制品根目录。这四个 import 因此是**在用**的，不是死代码。
    const dir = await mkdtemp(join(tmpdir(), 'vca-reader-'));
    const root = dir.split('\\').join('/');
    try {
      const store = new LocalArtifactStore(root);
      const plaintext = pattern(3 * 64 + 5, 25);

      // 先造一份制品（用不落盘的加密器 + 内存拼接），再经真实 putStream 写入
      const scratch = new MemoryStore();
      const seeded = await seedArtifact(scratch, plaintext, { chunkSize: 64 });
      const { key } = await store.putStream(Readable.from([seeded.artifact]), { maxBytes: 1 << 20 });

      const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
      expect(reader.plaintextLength).toBe(plaintext.length);
      expect((await collect(reader._readStreamForRange(0, plaintext.length))).equals(plaintext)).toBe(true);
      // 只读尾部一段：仍然只解密最后一块
      expect((await collect(reader._readStreamForRange(180, 197))).equals(plaintext.subarray(180, 197))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('接缝：真实的 `yauzl.fromRandomAccessReader` 能经本读取器解析 zip（中央目录在最后一块里）', async () => {
    // 这一条是 Task 4 的前置接缝：它证明本类**在运行期真的**是一个 `RandomAccessReader`
    // ——yauzl 会调 `ref()` / `createReadStream()` / `unref()`，并靠 `totalSize` 从**尾部**
    // 找中央目录。`@types/yauzl` 漏了 `ref`/`unref`（见类注释），所以类型检查发现不了
    // 这个缺口，只有真的跑一次才行。块大小取 64 字节 ⇒ zip 的 EOCD 落在**最后一块**里。
    const store = new MemoryStore();
    const zip = buildStoredZip('hello.txt', Buffer.from('hello zip', 'utf8'));
    const seeded = await seedArtifact(store, zip, { chunkSize: 64 });
    expect(seeded.entries.length).toBeGreaterThan(1); // 多块，尾部与中央目录才有意义

    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());
    // `autoClose: false` 是必需的：`lazyEntries` 下读完最后一条条目时 yauzl 会**自动关闭**
    // zipfile（默认 autoClose），此后 `openReadStream` 直接报 `Error: closed`
    // ——本文件第一版就是这样红的。
    const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromRandomAccessReader(
        reader,
        reader.plaintextLength,
        { lazyEntries: true, autoClose: false },
        (error, opened) => (error === null ? resolve(opened) : reject(error)),
      );
    });
    try {
      const entries: yauzl.Entry[] = [];
      for await (const entry of zipfile.eachEntry()) entries.push(entry);
      expect(entries.map((entry) => entry.fileName)).toEqual(['hello.txt']);
      expect(at(entries, 0).uncompressedSize).toBe(9);

      const content = await collect(await zipfile.openReadStreamPromise(at(entries, 0)));
      expect(content.toString('utf8')).toBe('hello zip');
    } finally {
      zipfile.close();
    }
  });
});
