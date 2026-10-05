import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  FOOTER_BYTES,
  INDEX_ENTRY_SIZE,
  TAG_BYTES,
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
import type { KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import type { ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';

/**
 * 加密制品读取端的**共享夹具**（P1 / Task 3 修复轮 1）。
 *
 * ## 为什么这些辅助函数不在测试文件里
 *
 * 它们原先住在 `tests/unit/asset/random-access-reader.test.ts`。修复轮 1 的裁定要求
 * **C20 调换与三条完整性校验的断言也进入 `security` 门**，而同时明令
 * 「**复用同一批辅助函数，不要把同一条用例复制到两个文件里**」。两条要求合起来只有
 * 一个落点：夹具必须**独立成模块**，两个 project 各自 import。
 *
 * 因此这里放的是**构造与观察**（怎么拼制品、怎么伪造、怎么记请求），
 * 不是断言：`it(...)` 一律留在各自 project 的测试文件里。
 *
 * ## 两个 project 各自断言什么（刻意不重叠）
 *
 * | 文件 | 它独有的断言 |
 * |---|---|
 * | `tests/unit/asset/random-access-reader.test.ts` | 区间语义 / 效率 / 生命周期 / 几何 / 各条校验的**孤立**伪造与精确错误信息 |
 * | `tests/security/asset-artifact-integrity.test.ts` | 三类伪造（调换记录、三条总量校验各自的违反、自洽整块截断）**必须被拒**，且拒绝理由落在安全控制上 |
 *
 * 这**不是**「同一条用例写两遍」：两个 project 问的是不同的问题
 * （unit 问「这条判据的判别力与错误信息对不对」，security 问「这条控制还在不在」），
 * 共享的只是制品构造。
 *
 * ## 依赖自检（K6）
 *
 * 只 import 本仓库自己的模块与 node 内建模块——没有新增任何依赖。
 */

/** 固定密钥（与 Task 2/3 的其它用例同款）。导出它是为了让「已退役但仍在环中」这类用例
 * 用**同一个** keyId 的字节，而不是就地再写一份十六进制字面量。 */
export const KEY_BYTES = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

/** 测试替身：固定密钥、固定 keyId。 */
export function fakeRing(keyId = 'v1', key: Buffer = KEY_BYTES): KeyRing {
  return {
    activeKeyId: () => keyId,
    keyFor: (asked: string): Buffer => {
      if (asked !== keyId) throw new Error(`未知的制品 keyId：${JSON.stringify(asked)}`);
      return Buffer.from(key);
    },
  };
}

/** 确定性明文：第 i 字节 = (seed + i) % 251。 */
export function pattern(bytes: number, seed = 0): Buffer {
  const buffer = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buffer[i] = (seed + i) % 251;
  return buffer;
}

/** 索引取值器（`noUncheckedIndexedAccess` 下越界应当响亮）。 */
export function at<T>(items: readonly T[], position: number): T {
  const item = items[position];
  if (item === undefined) throw new Error(`测试期望第 ${position} 项存在`);
  return item;
}

/** 一次 `getRange` 请求（含键、闭区间），供「解密了多少块」这类断言使用。 */
export interface RangeRequest {
  key: string;
  start: number;
  endInclusive: number;
}

/**
 * 内存制品存储：`ArtifactStore` 的测试替身，**记录每一次区间请求**。
 *
 * 「只解密所需块」这条验收只能从**请求了哪些区间**上看出来（解密发生在读取器内部）。
 * 请求区间与块范围的对应关系由测试按索引算，而不是由实现自报——否则就是自我对照。
 */
export class MemoryStore implements ArtifactStore {
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

export interface SeededArtifact {
  key: string;
  artifact: Buffer;
  header: ArtifactHeader;
  entries: IndexEntry[];
  plaintext: Buffer;
}

/** 加密 → 按 R3 的顺序拼出制品 → 放进内存存储。 */
export async function seedArtifact(
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
export function recordRange(entry: IndexEntry): { start: number; endInclusive: number } {
  const start = Number(entry.offset);
  return { start, endInclusive: start + entry.ciphertextLength + TAG_BYTES - 1 };
}

/** 把一段流收成 Buffer。 */
export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** 制品的各段位置（**按实际字节**算，不用任何自称值——自称值正是被测对象）。 */
export function sectionsOf(artifact: Buffer): { headerBytes: number; indexOffset: number; indexBytes: number } {
  const { keyIdLength } = decodeHeader(artifact);
  const footer = decodeFooter(artifact.subarray(artifact.length - FOOTER_BYTES));
  return {
    headerBytes: headerByteLength(keyIdLength),
    indexOffset: Number(footer.indexOffset),
    indexBytes: Number(footer.chunkCount) * INDEX_ENTRY_SIZE,
  };
}

/** 从制品里解出索引记录（按**文件几何**算长度，不信尾部自称的块数）。 */
export function entriesOf(artifact: Buffer): IndexEntry[] {
  const { indexOffset } = sectionsOf(artifact);
  const indexBytes = artifact.length - FOOTER_BYTES - indexOffset;
  return decodeIndex(artifact.subarray(indexOffset, indexOffset + indexBytes));
}

/** 复制一份制品并重写尾部（其余字节不动）。 */
export function withFooter(
  artifact: Buffer,
  patch: Partial<{ indexOffset: bigint; chunkCount: bigint; plaintextLength: bigint }>,
): Buffer {
  const out = Buffer.from(artifact);
  const current = decodeFooter(artifact.subarray(artifact.length - FOOTER_BYTES));
  encodeFooter({ ...current, ...patch }).copy(out, artifact.length - FOOTER_BYTES);
  return out;
}

/** 复制一份制品并重写头部里的 `chunkSize`（头部未被认证 ⇒ 它可以被单独篡改）。 */
export function withChunkSize(artifact: Buffer, chunkSize: number): Buffer {
  const { header, keyIdLength } = decodeHeader(artifact);
  const out = Buffer.from(artifact);
  encodeHeader({ ...header, chunkSize }).copy(out, 0, 0, headerByteLength(keyIdLength));
  return out;
}

/** 复制一份制品并只改写第 `position` 条索引记录（24 字节）。 */
export function withIndexEntry(artifact: Buffer, position: number, entry: IndexEntry): Buffer {
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
export function swapRecords(artifact: Buffer, left: number, right: number): Buffer {
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
  // ——`a = b; b = a` 会把两处写成同一个值（本夹具第一版就是这么错的）。
  const selfOf = (position: number): bigint => at(entries, position).index;
  const swapped = entries.map((entry) => ({ ...entry }));
  at(swapped, left).index = selfOf(right);
  at(swapped, right).index = selfOf(left);
  const { indexOffset } = sectionsOf(artifact);
  encodeIndex(swapped).copy(out, indexOffset);
  return out;
}

/**
 * **整块截断**：删掉末尾 `drop` 整块**连同它们的索引记录**，并把尾部改得完全自洽
 * （`indexOffset` 前移、`chunkCount` 减 `drop`、`plaintextLength` 减掉那些块的长度）。
 *
 * @param drop 删掉几块；**默认 1**（被删的那一块当初是用 `more` 建的，于是留下的
 *   最后一块会被读取端按 `last` 去认证 ⇒ 拒绝）。
 */
export function truncateLastBlocks(artifact: Buffer, drop = 1): Buffer {
  if (drop < 1) throw new Error('至少要删掉一块，否则不是截断');
  const { indexOffset } = sectionsOf(artifact);
  const entries = entriesOf(artifact);
  if (drop >= entries.length) throw new Error(`只删得动 ${entries.length - 1} 块（制品一共 ${entries.length} 块）`);
  const kept = entries.slice(0, entries.length - drop);
  const droppedBytes = entries.slice(entries.length - drop).reduce((sum, entry) => sum + entry.ciphertextLength + TAG_BYTES, 0);
  const newIndexOffset = indexOffset - droppedBytes;
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

/** 打开一份「被改过」的制品；**没抛**就把读取器还回去（调用方接着断言「读的时候才响」）。 */
export async function openForgedReader(
  artifact: Buffer,
  ring: KeyRing = fakeRing(),
): Promise<{ key: string; store: MemoryStore; reader: EncryptedArtifactReader | null; message: string }> {
  const store = new MemoryStore();
  const key = store.seed(artifact);
  try {
    return { key, store, reader: await EncryptedArtifactReader.open(store, key, ring), message: '' };
  } catch (error) {
    return { key, store, reader: null, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 打开一份「被改过」的制品，返回它抛出的那句话（没抛就返回空串）。 */
export async function openForged(artifact: Buffer): Promise<string> {
  return (await openForgedReader(artifact)).message;
}

/** 读一个明文区间的**结果**：要么拿到字节，要么拿到那句话（两者必有其一）。 */
export async function readRange(
  reader: EncryptedArtifactReader,
  start: number,
  end: number,
): Promise<{ bytes: Buffer | null; message: string }> {
  try {
    return { bytes: await collect(reader._readStreamForRange(start, end)), message: '' };
  } catch (error) {
    return { bytes: null, message: error instanceof Error ? error.message : String(error) };
  }
}
