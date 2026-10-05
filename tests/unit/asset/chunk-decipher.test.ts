import { describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CHUNK_SIZE,
  FOOTER_BYTES,
  TAG_BYTES,
  decodeIndex,
  encodeHeader,
  headerByteLength,
  type ArtifactFooter,
  type ArtifactHeader,
  type IndexEntry,
} from '@vca/api/modules/asset/crypto/artifact-format.js';
import { ChunkEncryptor } from '@vca/api/modules/asset/crypto/chunk-cipher.js';
import { ChunkDecipher } from '@vca/api/modules/asset/crypto/chunk-decipher.js';
import { createKeyRing, type KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';

/**
 * 分块解密（P1 / Task 3 的**核心用例**）。
 *
 * ## 这一组用例在防什么
 *
 * 1. **C20 块序号契约**：解密时块序号必须取自**读取位置**，并显式校验
 *    `record.index === position`。预检实测：一旦读取端信任记录里**自称**的序号，
 *    攻击者把两条存储记录整体调换，AAD 输入随之调换 ⇒ **认证通过、明文被静默重排**。
 *    这条必须有一个专门用例（「调换两条记录必须被拒」），否则它会悄悄退化。
 * 2. **三条完整性校验**（在 `random-access-reader.test.ts` 里，因为只有读取端同时掌握
 *    头部 / 索引 / 尾部 / 文件长度）：头部与尾部**都不在任何 AAD 里**，因此总量字段是
 *    不可信输入。
 * 3. **密钥选择**：未知 `keyId` ⇒ 拒绝且**绝不回退**；已退役但仍在环中的 `keyId`
 *    ⇒ 正常解密（R5 让「轮换」在部署层可达）。
 *
 * ## 判据的独立性与自我对照的分界
 *
 * 本文件用**生产加密器**产出制品、用**生产解密器**读回，逐字节比对明文。这**不是**
 * 「自己跟自己一致」的同义反复：写入端的 nonce/AAD/`isLast` 标记已由
 * `chunk-cipher.test.ts` 用一个**不 import 这两个函数**的独立解密器（按契约字面重写
 * nonce 与 AAD 拼装）钉住，因此两侧各自与契约对齐，而不是互相对齐。
 * 本文件的职责是读取端**自己的**契约：位置推导、序号校验、篡改/截断拒绝、密钥选择。
 */

/** 固定密钥（与 `chunk-cipher.test.ts` 同款，便于两侧互相印证）。 */
const KEY_BYTES = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

/**
 * 测试替身：固定密钥、固定 keyId。
 *
 * `missing: true` 让 `keyFor` 对**任何** keyId 都失败（模拟「环里没有这个键」）；
 * `retired` 用来表达「环里有多个键，其中 v1 已退役但仍在环中」（R5）。
 */
function fakeRing(keyId = 'v1', key: Buffer = KEY_BYTES, opts: { missing?: boolean } = {}): KeyRing {
  return {
    activeKeyId: () => keyId,
    keyFor: (asked: string): Buffer => {
      if (opts.missing) throw new Error(`未知的制品 keyId：${JSON.stringify(asked)}（测试替身刻意失败）`);
      if (asked !== keyId) throw new Error(`未知的制品 keyId：${JSON.stringify(asked)}`);
      return Buffer.from(key);
    },
  };
}

/** 确定性明文：第 i 字节 = (seed + i) % 251（逐字节可校验，且不与密文「碰巧相等」）。 */
function pattern(bytes: number, seed = 0): Buffer {
  const buffer = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buffer[i] = (seed + i) % 251;
  return buffer;
}

/** 一块的完整记录字节（**密文 ‖ tag(16)**）在制品里的切片。 */
interface EncryptedArtifact {
  artifact: Buffer;
  header: ArtifactHeader;
  entries: IndexEntry[];
  footerFields: ArtifactFooter;
  /** 逐块的完整记录（密文 ‖ tag），下标 = 块序号。`decryptAt` 吃的就是它。 */
  records: Buffer[];
  plaintext: Buffer;
}

/**
 * 跑一遍生产加密器并**按 R3 的顺序**拼出完整制品：`[头][块数据][索引][尾部]`。
 *
 * 索引里的 `offset` 是**制品内的绝对偏移**，所以记录必须从拼好的制品上切，
 * 而不是从 `transform()` 的输出上切（后者缺了头部那 35+N 字节的位移）。
 */
async function encryptArtifact(
  plaintext: Buffer,
  opts: { chunkSize?: number; ring?: KeyRing } = {},
): Promise<EncryptedArtifact> {
  const encryptor = new ChunkEncryptor(opts.ring ?? fakeRing(), opts.chunkSize ? { chunkSize: opts.chunkSize } : {});
  const collected: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      collected.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(Readable.from([plaintext]), encryptor.transform(), sink);

  const { header, index, footer, footerFields } = encryptor.result();
  const artifact = Buffer.concat([encodeHeader(header), Buffer.concat(collected), index, footer]);
  const entries = decodeIndex(index);
  const records = entries.map((entry) => {
    const start = Number(entry.offset);
    return Buffer.from(artifact.subarray(start, start + entry.ciphertextLength + TAG_BYTES));
  });
  return { artifact, header, entries, footerFields, records, plaintext };
}

/** 索引取值器（`noUncheckedIndexedAccess` 下 `arr[i]` 是 `T | undefined`；越界应当响亮）。 */
function at<T>(items: readonly T[], position: number): T {
  const item = items[position];
  if (item === undefined) throw new Error(`测试期望第 ${position} 项存在`);
  return item;
}

/**
 * 逐字节比对两段明文，失败时指出**第一个**不同的字节。
 *
 * 为什么不用 `expect(actual).toEqual(expected)`：vitest 的深度相等会逐元素遍历，
 * 在 8 MiB 的 Buffer 上实测**让用例超时 5s**（第一次跑本文件时就是这样红的：
 * `2 failed | 6 passed`、`Duration 54.26s`，转记在
 * `evidence/t3-step2a-decipher-timeout.txt`）。`compare` 是原生实现，
 * 只有失败时才走 JS 循环找下标——失败信息因此比一行 `expected false to be true` 有用得多。
 */
function expectBytesEqual(actual: Buffer, expected: Buffer, label = '明文'): void {
  expect(actual.length, `${label}长度不符：实际 ${actual.length}，期望 ${expected.length}`).toBe(expected.length);
  if (actual.compare(expected) === 0) return;
  let at = 0;
  while (actual[at] === expected[at]) at++;
  throw new Error(`${label}第 ${at} 字节起不一致：实际 ${String(actual[at])}，期望 ${String(expected[at])}`);
}

/** `decryptAll` 的读取回调：从已经拼好的记录表里按位置取。 */
function readerOf(records: readonly Buffer[]): (position: number) => Promise<Buffer> {
  return async (position: number) => Buffer.from(at(records, position));
}

describe('ChunkDecipher 往返（0 字节 / 跨块 / 恰好整数块 / 末块不满）', () => {
  it('0 字节 ⇒ chunkCount=0、空索引；decryptAll 返回 0 字节且**一个块都不读**（R4）', async () => {
    const encrypted = await encryptArtifact(Buffer.alloc(0));

    expect(encrypted.footerFields.chunkCount).toBe(0n);
    expect(encrypted.footerFields.plaintextLength).toBe(0n);
    expect(encrypted.entries).toHaveLength(0);
    // 空文件的制品 = 头 + 空索引 + 尾部（0 块 ⇒ 索引 0 字节）
    expect(encrypted.artifact).toHaveLength(headerByteLength(Buffer.byteLength('v1', 'utf8')) + FOOTER_BYTES);

    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);
    const asked: number[] = [];
    const out = await decipher.decryptAll(async (position) => {
      asked.push(position);
      return Buffer.alloc(0);
    });

    expect(out).toHaveLength(0);
    expect(asked).toEqual([]); // 没有块 ⇒ 不调用读取回调
  });

  it('小于一块（真实 8 MiB 块大小下 1000 字节）⇒ 单块往返一致', async () => {
    const plaintext = pattern(1000, 1);
    const encrypted = await encryptArtifact(plaintext);

    expect(encrypted.footerFields.chunkCount).toBe(1n);
    expect(encrypted.header.chunkSize).toBe(CHUNK_SIZE);

    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);
    expectBytesEqual(await decipher.decryptAll(readerOf(encrypted.records)), plaintext);
  });

  it('恰好一块（8 MiB）⇒ 单块往返一致（末块标记落在唯一的块上）', async () => {
    const plaintext = pattern(CHUNK_SIZE, 2);
    const encrypted = await encryptArtifact(plaintext);

    expect(encrypted.footerFields.chunkCount).toBe(1n);
    expect(at(encrypted.records, 0)).toHaveLength(CHUNK_SIZE + TAG_BYTES);

    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);
    expectBytesEqual(await decipher.decryptAll(readerOf(encrypted.records)), plaintext);
  });

  it('1 块 + 1 字节（真实 8 MiB 块大小）⇒ 两块往返一致，末块只有 1 字节', async () => {
    const plaintext = pattern(CHUNK_SIZE + 1, 3);
    const encrypted = await encryptArtifact(plaintext);

    expect(encrypted.footerFields.chunkCount).toBe(2n);
    expect(encrypted.entries.map((e) => e.ciphertextLength)).toEqual([CHUNK_SIZE, 1]);

    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);
    expectBytesEqual(await decipher.decryptAll(readerOf(encrypted.records)), plaintext);
  });

  it('恰好整数块（chunkSize=64、128 字节 ⇒ 2 个**满**块）⇒ 往返一致', async () => {
    // 这是 `isLast` 最容易写错的边界：末块是**满**块，急切发射的实现会把它标成 `more`，
    // 于是读取端按 `last` 去认证就会失败——写入端的 hold-back 与读取端的
    // `position === chunkCount - 1` 必须同时成立。
    const plaintext = pattern(128, 4);
    const encrypted = await encryptArtifact(plaintext, { chunkSize: 64 });

    expect(encrypted.footerFields.chunkCount).toBe(2n);
    expect(encrypted.entries.map((e) => e.ciphertextLength)).toEqual([64, 64]);

    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);
    expectBytesEqual(await decipher.decryptAll(readerOf(encrypted.records)), plaintext);
  });

  it('多块且末块不满（chunkSize=64、3 块 + 5 字节）⇒ 往返一致', async () => {
    const plaintext = pattern(3 * 64 + 5, 5);
    const encrypted = await encryptArtifact(plaintext, { chunkSize: 64 });

    expect(encrypted.footerFields.chunkCount).toBe(4n);
    expect(encrypted.entries.map((e) => e.ciphertextLength)).toEqual([64, 64, 64, 5]);

    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);
    expectBytesEqual(await decipher.decryptAll(readerOf(encrypted.records)), plaintext);
  });
});

describe('ChunkDecipher.decryptAt：位置由调用方给出', () => {
  it('逐块解密：每块的结果等于明文对应切片（含末块），且只用位置推导 nonce/AAD', async () => {
    const plaintext = pattern(3 * 64 + 5, 6);
    const encrypted = await encryptArtifact(plaintext, { chunkSize: 64 });
    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);

    let cursor = 0;
    for (let position = 0; position < encrypted.entries.length; position++) {
      const length = at(encrypted.entries, position).ciphertextLength;
      // `decryptAt` 的第二个参数是**整条记录**（密文 ‖ tag），不是裸密文
      const block = decipher.decryptAt(position, at(encrypted.records, position));

      expect(block).toHaveLength(length);
      expectBytesEqual(block, plaintext.subarray(cursor, cursor + length), `第 ${position} 块`);
      cursor += length;
    }
    expect(cursor).toBe(plaintext.length);
  });

  it('decryptAll 按 0..n-1 顺序逐块读，顺序与位置一致', async () => {
    const plaintext = pattern(3 * 64 + 5, 7);
    const encrypted = await encryptArtifact(plaintext, { chunkSize: 64 });
    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);
    const asked: number[] = [];

    const out = await decipher.decryptAll(async (position) => {
      asked.push(position);
      return Buffer.from(at(encrypted.records, position));
    });

    expect(asked).toEqual([0, 1, 2, 3]);
    expectBytesEqual(out, plaintext);
  });
});

describe('C20 块序号契约：位置是唯一的事实来源', () => {
  /**
   * 「整体调换两条记录」的攻击：把第 0、1 块的**存储字节**互换，并把索引里两条记录的
   * **自称序号**也互换（于是整份制品在「信任自称序号」的解读下**完全自洽**）。
   *
   * 预检 §2.1 实测的失效形态：读取端若用自称序号推导 nonce/AAD，位置 0 会读到「自称 1」
   * 的那条记录 ⇒ 用 nonce(1)/AAD(1) 去认证 ⇒ **认证通过**，返回的却是第 1 块的明文
   * ——明文被静默重排，没有任何一层报错。
   */
  async function swappedArtifact(): Promise<EncryptedArtifact & { swappedRecords: Buffer[] }> {
    const encrypted = await encryptArtifact(pattern(3 * 64, 8), { chunkSize: 64 });
    const swappedEntries = encrypted.entries.map((entry) => ({ ...entry }));
    const [first, second] = [at(swappedEntries, 0), at(swappedEntries, 1)];
    // 交换两条记录的自称序号（offset 与长度留在原位：offset 必须保持单调递增）。
    // 这里必须用临时变量：`a.index = b.index; b.index = a.index` 会把两处写成同一个值
    // ——第一版就是这么错的，被下面「位置 1 处的记录自称序号 0」那条断言当场抓住
    // （那时它收到的是 GCM 认证失败，说明位置 1 的自称序号仍然是 1）。
    const selfIndex = first.index;
    first.index = second.index;
    second.index = selfIndex;
    const swappedRecords = encrypted.records.map((record) => Buffer.from(record));
    const keep = at(swappedRecords, 0);
    swappedRecords[0] = at(swappedRecords, 1);
    swappedRecords[1] = keep;
    return { ...encrypted, entries: swappedEntries, swappedRecords };
  }

  it('调换两条记录（含各自的 nonce 与 tag）⇒ 必须被拒，且点名「位置 P 处的记录自称序号 Q」', async () => {
    const swapped = await swappedArtifact();
    const decipher = new ChunkDecipher(fakeRing(), swapped.header, swapped.entries);

    /**
     * 位置 0 拿到的是「自称序号 1」的那条记录。
     *
     * 这里**刻意接住返回值**而不是只写 `expect(...).toThrow(...)`：变异探针
     * （把位置改回「取自记录自称序号」）下这一句不会抛错，而是**返回第 1 块的明文**
     * ——把返回值写进断言消息，探针输出里因此能直接看到「静默重排」这件事本身，
     * 而不是只看到一句「没有抛错」。
     */
    let returned: Buffer | null = null;
    let message = '';
    try {
      returned = decipher.decryptAt(0, at(swapped.swappedRecords, 0));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const reordered = returned !== null && returned.equals(swapped.plaintext.subarray(64, 128));
    expect(
      message,
      returned === null
        ? ''
        : `调换被静默接受：位置 0 返回了 ${returned.length} 字节，` +
            (reordered ? '且正是**第 1 块**的明文（明文被重排、认证通过）' : '但不是第 1 块的明文'),
    ).toMatch(/位置 0 处的记录自称序号 1/);
    expect(returned, '调换后位置 0 绝不能返回任何明文').toBeNull();

    // 反向同理：位置 1 拿到的是「自称序号 0」的那条
    expect(() => decipher.decryptAt(1, at(swapped.swappedRecords, 1))).toThrow(/位置 1 处的记录自称序号 0/);
    // `decryptAll` 走同一条路径（它是逐块调用 `decryptAt` 的）
    await expect(decipher.decryptAll(readerOf(swapped.swappedRecords))).rejects.toThrow(
      /位置 0 处的记录自称序号 1/,
    );
  });

  it('序号校验发生在**任何解密之前**：交换后报的是序号错，而不是 GCM 认证错', async () => {
    // 这条用例的判别力：它把「序号错」与「认证失败」两种红区分开。若实现只在 GCM 失败时
    // 才报错，本用例会红（消息不含「自称序号」），而上一条用例也可能因为 GCM 恰好失败而
    // 「看起来通过」——那正是「用例没有真正覆盖 C20」的形态。
    const swapped = await swappedArtifact();
    const decipher = new ChunkDecipher(fakeRing(), swapped.header, swapped.entries);

    let message = '';
    try {
      decipher.decryptAt(0, at(swapped.swappedRecords, 0));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/位置 0 处的记录自称序号 1/);
    expect(message).not.toMatch(/authenticate|Unsupported state|unable to/i);
  });

  it('记录长度与索引不符 ⇒ 抛错（读取端切错区间时不能静默）', async () => {
    const encrypted = await encryptArtifact(pattern(128, 9), { chunkSize: 64 });
    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);

    // 太短（少了 1 字节 tag 也不够）：不能拿一段长度不对的字节去当 tag
    expect(() => decipher.decryptAt(0, at(encrypted.records, 0).subarray(0, 64))).toThrow(/记录长度/);
    // 太长（多带了下一个字节）
    expect(() =>
      decipher.decryptAt(0, Buffer.concat([at(encrypted.records, 0), Buffer.from([1])])),
    ).toThrow(/记录长度/);
    // 正例仍然通过（这条断言是为了防止「一律抛错」也能骗过上面两条）
    expectBytesEqual(decipher.decryptAt(0, at(encrypted.records, 0)), encrypted.plaintext.subarray(0, 64));
  });

  it('位置越界 ⇒ 抛错，且不读出任何字节', async () => {
    const encrypted = await encryptArtifact(pattern(128, 10), { chunkSize: 64 });
    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);

    expect(() => decipher.decryptAt(2, at(encrypted.records, 0))).toThrow(/第 2 块不存在/);
    expect(() => decipher.decryptAt(-1, at(encrypted.records, 0))).toThrow(/第 -1 块不存在/);
  });
});

describe('篡改与截断：读取端必须响亮地拒绝', () => {
  it('篡改任一块密文 ⇒ 认证失败，且错误**点名是哪一块**', async () => {
    const encrypted = await encryptArtifact(pattern(3 * 64 + 5, 11), { chunkSize: 64 });
    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);

    for (let position = 0; position < encrypted.entries.length; position++) {
      const tampered = Buffer.from(at(encrypted.records, position));
      tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);

      expect(() => decipher.decryptAt(position, tampered)).toThrow(new RegExp(`第 ${position} 块`));
      // 其它块不受影响（防止「一律抛错」骗过上面那条）
      if (position !== 0) {
        expectBytesEqual(decipher.decryptAt(0, at(encrypted.records, 0)), encrypted.plaintext.subarray(0, 64));
      }
    }
  });

  it('尾部总量被改小、末块被丢掉 ⇒ 原本的倒数第二块按「末块」解读时认证失败', async () => {
    // 这正是「删掉末尾整块」那一类截断在**解密层**的形态：制品被截短、索引少一条记录，
    // 于是读取端把第 n-2 块当成末块（AAD 用 `last`），而它当初是用 `more` 建的 ⇒ 拒绝。
    const encrypted = await encryptArtifact(pattern(3 * 64, 12), { chunkSize: 64 });
    const truncatedEntries = encrypted.entries.slice(0, encrypted.entries.length - 1);
    const decipher = new ChunkDecipher(fakeRing(), encrypted.header, truncatedEntries);

    expect(() => decipher.decryptAt(1, at(encrypted.records, 1))).toThrow(/第 1 块认证失败/);
    // 而用它**原本**的位置（末块）去解就是对的 —— 说明上面那条红来自 `isLast` 标记，
    // 不是来自一个恒错的实现
    const full = new ChunkDecipher(fakeRing(), encrypted.header, encrypted.entries);
    expectBytesEqual(full.decryptAt(2, at(encrypted.records, 2)), encrypted.plaintext.subarray(128, 192));
  });
});

describe('密钥选择：按头里的 keyId 取键，未知即拒、绝不回退', () => {
  it('未知 keyId ⇒ 构造期就抛错（不是等到第一个块）', async () => {
    const encrypted = await encryptArtifact(pattern(64, 13), { chunkSize: 64 });

    // 环里没有 v1：构造必须失败。**注意方向**：不能回退到「活动键」——
    // 回退会让轮换静默失效（头里写着 v1、实际用 v2 解），失败形态是数据永久读不回来。
    expect(() => new ChunkDecipher(fakeRing('v2', KEY_BYTES, { missing: true }), encrypted.header, encrypted.entries)).toThrow(
      /v1/,
    );
  });

  it('已退役但仍在环中的 keyId ⇒ 正常解密（R5 的轮换路径）', async () => {
    // 真实键环：v1 与 v2 同时在环里，写入时活动键是 v1；随后活动键切成 v2（v1 退役）。
    // 旧制品（头里写着 v1）必须**仍按 v1 可读**，而**不是**回退到 v2。
    const v1 = KEY_BYTES;
    const v2 = Buffer.from('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');
    const writerRing = createKeyRing({
      ARTIFACT_KEYS: JSON.stringify({ v1: v1.toString('base64'), v2: v2.toString('base64') }),
      ARTIFACT_ACTIVE_KEY_ID: 'v1',
    });
    const encrypted = await encryptArtifact(pattern(3 * 64 + 5, 14), { chunkSize: 64, ring: writerRing });
    expect(encrypted.header.keyId).toBe('v1');

    const readerRing = createKeyRing({
      ARTIFACT_KEYS: JSON.stringify({ v1: v1.toString('base64'), v2: v2.toString('base64') }),
      ARTIFACT_ACTIVE_KEY_ID: 'v2',
    });
    const decipher = new ChunkDecipher(readerRing, encrypted.header, encrypted.entries);

    expectBytesEqual(await decipher.decryptAll(readerOf(encrypted.records)), encrypted.plaintext);
    // 环取的是 v1 的字节（不是活动键 v2）
    expect(readerRing.keyFor(encrypted.header.keyId).equals(v1)).toBe(true);
    // 反向确认：把**同一把** v1 keyId 映射到 v2 的字节（而不是让 keyFor 直接失败——
    // 那测的是「未知 keyId 会被拒」，是上一条用例的事），解不开才说明用的是 v1 的字节。
    const wrongKey = new ChunkDecipher(fakeRing('v1', v2), encrypted.header, encrypted.entries);
    expect(() => wrongKey.decryptAt(0, at(encrypted.records, 0))).toThrow();
  });
});
