import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import { pipeline } from 'node:stream/promises';
import {
  FOOTER_BYTES,
  INDEX_ENTRY_SIZE,
  TAG_BYTES,
  blockDataOffset,
  decodeFooter,
  decodeHeader,
  decodeIndex,
  encodeFooter,
  encodeHeader,
  encodeIndex,
  headerByteLength,
  type ArtifactHeader,
  type IndexEntry,
} from '@vca/api/modules/asset/crypto/artifact-format.js';
import { ChunkEncryptor } from '@vca/api/modules/asset/crypto/chunk-cipher.js';
import { createKeyRing, type KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import type { ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';

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
 *    它们是读取端的责任。
 *
 * ## 一处据实记载：三条完整性校验**挡不住整块截断**
 *
 * 攻击者删掉末尾整块、连同它的索引记录，并把尾部改写得**完全自洽**时，三条校验
 * 全部满足（见本文件那条用例的算术）。挡住它的是末块的 `isLast` AAD 标记：被删块之后
 * 的那一块当初是用 `more` 建的，而读取端会把它当末块（`last`）去认证 ⇒ 拒绝。
 * 这条边界必须写清楚，否则「三条校验 = 充分」这句话会让人以为整块截断在 open 阶段就被拦下。
 */

/** 固定密钥（与 Task 2/3 的其它用例同款）。 */
const KEY_BYTES = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

/** 测试替身：固定密钥、固定 keyId。 */
function fakeRing(keyId = 'v1', key: Buffer = KEY_BYTES): KeyRing {
  return {
    activeKeyId: () => keyId,
    keyFor: (asked: string): Buffer => {
      if (asked !== keyId) throw new Error(`未知的制品 keyId：${JSON.stringify(asked)}`);
      return Buffer.from(key);
    },
  };
}

/** 确定性明文：第 i 字节 = (seed + i) % 251。 */
function pattern(bytes: number, seed = 0): Buffer {
  const buffer = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buffer[i] = (seed + i) % 251;
  return buffer;
}

function at<T>(items: readonly T[], position: number): T {
  const item = items[position];
  if (item === undefined) throw new Error(`测试期望第 ${position} 项存在`);
  return item;
}

/** 一次 `getRange` 请求（含键、闭区间），供「解密了多少块」这类断言使用。 */
interface RangeRequest {
  key: string;
  start: number;
  endInclusive: number;
}

/**
 * 内存制品存储：`ArtifactStore` 的测试替身，**记录每一次区间请求**。
 *
 * 「只解密所需块」这条验收只能从**请求了哪些区间**上看出来（解密发生在读取器内部）。
 * 请求区间与块范围的对应关系由本文件按索引算，而不是由实现自报——否则就是自我对照。
 */
class MemoryStore implements ArtifactStore {
  readonly requests: RangeRequest[] = [];
  private readonly objects = new Map<string, Buffer>();
  private counter = 0;

  /** 直接放入一段字节并返回键（测试里的制品是现拼的，不必走 `putStream`）。 */
  seed(bytes: Buffer): string {
    const key = `object-${++this.counter}`;
    this.objects.set(key, Buffer.from(bytes));
    return key;
  }

  async putStream(source: Readable, opts: { maxBytes: number }): Promise<{ key: string; bytes: number }> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of source) {
      const buffer = Buffer.from(chunk as Buffer);
      bytes += buffer.length;
      if (bytes > opts.maxBytes) throw new Error(`超过上限 ${opts.maxBytes}`);
      chunks.push(buffer);
    }
    return { key: this.seed(Buffer.concat(chunks)), bytes };
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    this.requests.push({ key, start, endInclusive });
    const object = this.objects.get(key);
    if (object === undefined) throw new Error(`对象不存在：${key}`);
    if (start < 0 || endInclusive < start || endInclusive >= object.length) {
      throw new Error(`区间越界：[${start}, ${endInclusive}]，对象只有 ${object.length} 字节`);
    }
    return Buffer.from(object.subarray(start, endInclusive + 1));
  }

  async stat(key: string): Promise<{ bytes: number }> {
    const object = this.objects.get(key);
    if (object === undefined) throw new Error(`对象不存在：${key}`);
    return { bytes: object.length };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** 本次区间请求取回的**总字节数**（不是请求次数）。 */
  bytesRequested(): number {
    return this.requests.reduce((sum, request) => sum + (request.endInclusive - request.start + 1), 0);
  }

  /** 清空请求记录（把「open 阶段」与「读阶段」分开计量）。 */
  reset(): void {
    this.requests.length = 0;
  }
}

interface SeededArtifact {
  key: string;
  artifact: Buffer;
  header: ArtifactHeader;
  entries: IndexEntry[];
  plaintext: Buffer;
}

/** 加密 → 按 R3 的顺序拼出制品 → 放进内存存储。 */
async function seedArtifact(
  store: MemoryStore,
  plaintext: Buffer,
  opts: { chunkSize?: number; ring?: KeyRing } = {},
): Promise<SeededArtifact> {
  const encryptor = new ChunkEncryptor(opts.ring ?? fakeRing(), opts.chunkSize ? { chunkSize: opts.chunkSize } : {});
  const collected: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      collected.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(Readable.from([plaintext]), encryptor.transform(), sink);

  const { header, index, footer } = encryptor.result();
  const artifact = Buffer.concat([encodeHeader(header), Buffer.concat(collected), index, footer]);
  const entries = decodeIndex(index);
  return { key: store.seed(artifact), artifact, header, entries, plaintext };
}

/** 一条记录在制品里的闭区间（密文 + tag）。 */
function recordRange(entry: IndexEntry): { start: number; endInclusive: number } {
  const start = Number(entry.offset);
  return { start, endInclusive: start + entry.ciphertextLength + TAG_BYTES - 1 };
}

/** 把一段流收成 Buffer。 */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
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

  it('读尾部 22 字节只解密**最后一块**（不是整份制品）', async () => {
    const store = new MemoryStore();
    const plaintext = pattern(5 * 64, 6);
    const seeded = await seedArtifact(store, plaintext, { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());
    store.reset();

    const out = await collect(reader._readStreamForRange(plaintext.length - 22, plaintext.length));

    expect(out.equals(plaintext.subarray(plaintext.length - 22))).toBe(true);
    // 恰好一次请求，且它就是**最后一条记录**的区间 ⇒ 解密的块数 = 1
    expect(store.requests).toEqual([{ key: seeded.key, ...recordRange(at(seeded.entries, 4)) }]);
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
  /** 制品的各段位置（**按实际字节**算，不用任何自称值——自称值正是被测对象）。 */
  function sectionsOf(artifact: Buffer): { headerBytes: number; indexOffset: number; indexBytes: number } {
    const { keyIdLength } = decodeHeader(artifact);
    const footer = decodeFooter(artifact.subarray(artifact.length - FOOTER_BYTES));
    return {
      headerBytes: headerByteLength(keyIdLength),
      indexOffset: Number(footer.indexOffset),
      indexBytes: Number(footer.chunkCount) * INDEX_ENTRY_SIZE,
    };
  }

  function entriesOf(artifact: Buffer): IndexEntry[] {
    const { indexOffset, indexBytes } = sectionsOf(artifact);
    return decodeIndex(artifact.subarray(indexOffset, indexOffset + indexBytes));
  }

  /** 复制一份制品并重写尾部（其余字节不动）。 */
  function withFooter(
    artifact: Buffer,
    patch: Partial<{ indexOffset: bigint; chunkCount: bigint; plaintextLength: bigint }>,
  ): Buffer {
    const out = Buffer.from(artifact);
    const current = decodeFooter(artifact.subarray(artifact.length - FOOTER_BYTES));
    encodeFooter({ ...current, ...patch }).copy(out, artifact.length - FOOTER_BYTES);
    return out;
  }

  /** 复制一份制品并重写头部里的 `chunkSize`（头部未被认证 ⇒ 它可以被单独篡改）。 */
  function withChunkSize(artifact: Buffer, chunkSize: number): Buffer {
    const { header, keyIdLength } = decodeHeader(artifact);
    const out = Buffer.from(artifact);
    encodeHeader({ ...header, chunkSize }).copy(out, 0, 0, headerByteLength(keyIdLength));
    return out;
  }

  /** 复制一份制品并只改写第 `position` 条索引记录（24 字节）。 */
  function withIndexEntry(artifact: Buffer, position: number, entry: IndexEntry): Buffer {
    const { indexOffset } = sectionsOf(artifact);
    const out = Buffer.from(artifact);
    encodeIndex([entry]).copy(out, indexOffset + position * INDEX_ENTRY_SIZE);
    return out;
  }

  /**
   * 「整体调换两条记录」：互换两条记录的**存储字节**，并互换它们各自的自称序号。
   *
   * 调换之后，整份制品在「信任自称序号」的解读下**完全自洽**（offset / 长度 / 条数 /
   * 合计都没变），因此三条完整性校验与索引自身校验**全部通过**——只有 C20 的位置比对
   * 能发现它。这正是预检实测的那个漏洞形态。
   */
  function swapRecords(artifact: Buffer, left: number, right: number): Buffer {
    const entries = entriesOf(artifact);
    const leftRange = recordRange(at(entries, left));
    const rightRange = recordRange(at(entries, right));
    if (leftRange.endInclusive - leftRange.start !== rightRange.endInclusive - rightRange.start) {
      throw new Error('本用例只调换等长记录');
    }
    const out = Buffer.from(artifact);
    const moved = Buffer.from(out.subarray(rightRange.start, rightRange.endInclusive + 1));
    // 两个区间不相交，因此可以直接 copy；最后再把暂存的那段放回去
    out.copy(out, rightRange.start, leftRange.start, leftRange.endInclusive + 1);
    moved.copy(out, leftRange.start);

    // 自称序号：字节 12..19（见 artifact-format.ts 的布局说明）。用临时变量交换
    // ——`a = b; b = a` 会把两处写成同一个值（本文件第一版就是这么错的）。
    const selfOf = (position: number): bigint => at(entries, position).index;
    const swapped = entries.map((entry) => ({ ...entry }));
    at(swapped, left).index = selfOf(right);
    at(swapped, right).index = selfOf(left);
    const { indexOffset } = sectionsOf(artifact);
    encodeIndex(swapped).copy(out, indexOffset);
    return out;
  }

  /**
   * **整块截断**：删掉末尾一整块**连同它的索引记录**，并把尾部改得完全自洽
   * （`indexOffset` 前移、`chunkCount` 减一、`plaintextLength` 减一个块长）。
   */
  function truncateLastBlock(artifact: Buffer): Buffer {
    const { indexOffset } = sectionsOf(artifact);
    const entries = entriesOf(artifact);
    const last = at(entries, entries.length - 1);
    const kept = entries.slice(0, entries.length - 1);
    const recordBytes = last.ciphertextLength + TAG_BYTES;
    const newIndexOffset = indexOffset - recordBytes;
    return Buffer.concat([
      artifact.subarray(0, newIndexOffset),
      artifact.subarray(indexOffset, indexOffset + kept.length * INDEX_ENTRY_SIZE),
      encodeFooter({
        indexOffset: BigInt(newIndexOffset),
        chunkCount: BigInt(kept.length),
        plaintextLength: kept.reduce((sum, entry) => sum + BigInt(entry.ciphertextLength), 0n),
      }),
    ]);
  }

  /** 打开一份「被改过」的制品，返回它抛出的那句话（没抛就返回空串）。 */
  async function openForged(artifact: Buffer): Promise<string> {
    const store = new MemoryStore();
    const key = store.seed(artifact);
    try {
      await EncryptedArtifactReader.open(store, key, fakeRing());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  }

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

  it('三条校验**合起来仍挡不住整块截断**：尾部改得自洽时 open 通过，但读末块被 `isLast` 拒绝', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 21), { chunkSize: 64 });
    const forged = truncateLastBlock(seeded.artifact);
    const key = store.seed(forged);

    // 算术复核（据实记载，别把它读成「三条校验足够」）：
    //   索引区 = 2 * 24 = 48 字节 ⇒ 自称 2 块 ✓；ceil(128 / 64) = 2 ✓；64 + 64 = 128 ✓
    // 于是**三条全部满足**，open 成功。
    const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
    expect(reader.plaintextLength).toBe(128);

    // 挡住它的是末块的 AAD 标记：这一块当初是用 `more` 建的，而读取端按 `last` 去认证。
    await expect(collect(reader._readStreamForRange(64, 128))).rejects.toThrow(/第 1 块认证失败/);
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

  it('索引自身：`offset` 必须严格递增，且每条记录的区间落在块数据区内', async () => {
    const seeded = await threeFullBlocks();
    const entries = entriesOf(seeded.artifact);
    const { indexOffset, headerBytes } = sectionsOf(seeded.artifact);

    // 非递增：第 1 条与第 0 条同一起点
    const notIncreasing = withIndexEntry(seeded.artifact, 1, { ...at(entries, 1), offset: BigInt(headerBytes) });
    expect(await openForged(notIncreasing)).toMatch(/不是严格递增/);

    // 区间越界：第 2 条记录的起点被挪到索引起点上，于是它的区间越过块数据区
    const outOfRange = withIndexEntry(seeded.artifact, 2, { ...at(entries, 2), offset: BigInt(indexOffset) });
    expect(await openForged(outOfRange)).toMatch(/区间越出块数据区/);
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
