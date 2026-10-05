import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_MAGIC,
  CHUNK_SIZE,
  FORMAT_VERSION,
  HEADER_FIXED_BYTES,
  INDEX_ENTRY_SIZE,
  NONCE_BYTES,
  NONCE_PREFIX_BYTES,
  TAG_BYTES,
  buildAad,
  decodeHeader,
  decodeIndex,
  deriveNonce,
  encodeHeader,
  encodeIndex,
  headerByteLength,
  type ArtifactHeader,
  type IndexEntry,
} from '@vca/api/modules/asset/crypto/artifact-format.js';

/**
 * 制品格式（P1 / Task 2）的**字节级**契约。
 *
 * ## 为什么这里必须有「黄金字节」用例，而不只是编解码往返
 *
 * 往返用例（`decode(encode(h))` 等于 `h`）对**对称**的错误是盲的：把两个字段的
 * 宽度或顺序一起改错，往返照样通过，而 Task 3 的读取器与真实制品会对不上。
 * 因此每个结构都钉一份手算出来的十六进制期望值——它是**独立于实现**的判据。
 * （变异实测：把 `plaintextLength` 与 `chunkCount` 的写入顺序对调后，
 * 往返用例仍绿，只有黄金用例变红，见 `evidence/t2-mutation-short-*`。）
 *
 * ## 这份文件钉住的三个跨模块契约
 *
 * 1. **头布局**：`magic(4) | formatVersion(2) | keyIdLen(1) | keyId(N) | fileId(16) |
 *    chunkSize(4) | plaintextLength(8) | chunkCount(8) | noncePrefix(4)`，
 *    定长部分 **47** 字节（不是 47+1，见下）。
 * 2. **nonce 推导**：`noncePrefix(4) || 块序号(8, 大端)`。序号写的是 **64 位**——
 *    只写低 32 位在 position < 2^32 时完全看不出来（那是 8 TiB 以内的每一个真实文件），
 *    所以此处专门用 2^32+1 这种序号把宽度钉死。
 * 3. **AAD 推导**：`` `${fileId 十六进制}:${position}:${isLast ? 'last' : 'more'}` ``（UTF-8）。
 *    末块标记是 Task 3 截断检测的依据，因此 `more`/`last` 两个值都要逐字断言。
 *
 * ## 与 brief 的一处算术不一致（据实记载，已回填预检报告）
 *
 * brief 写「文件头（定长 **48** + keyId）」，但它同段列的字段宽度之和是 **47**：
 * `4+2+1+16+4+8+8+4 = 47`。索引那一段的算术是自洽的（`8+4+12 = 24`），
 * 说明 48 是笔误而不是「少写了一个保留字节」。字段清单是**可枚举、逐字指定**的那一份，
 * 因此实现按 47 走（`headerByteLength(2) === 49` 即 `47 + keyId`），
 * 并把 47 做成导出常量，谁改都会撞上这个用例。
 */
describe('制品头编解码（字节级契约）', () => {
  /** 用于黄金用例的头：每个字段的宽度都取一个「一眼能看出错位」的值。 */
  const sample: ArtifactHeader = {
    formatVersion: FORMAT_VERSION,
    keyId: 'v1',
    fileId: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'),
    chunkSize: CHUNK_SIZE,
    // 0x0102030405060708：8 字节每个字节都不同 ⇒ 大端/小端、字段错位都会露馅
    plaintextLength: 0x0102030405060708n,
    chunkCount: 4n,
    noncePrefix: Buffer.from('deadbeef', 'hex'),
  };

  it('编码结果逐字节等于手算的期望值（含定长 47 + keyId）', () => {
    const encoded = encodeHeader(sample);

    expect(encoded.toString('hex')).toBe(
      // magic          版本    idLen keyId  fileId(16)                        chunkSize(0x00800000)  plaintextLength(8)     chunkCount(8)          noncePrefix
      '564341310001' + '02' + '7631' + '000102030405060708090a0b0c0d0e0f' + '00800000' + '0102030405060708' + '0000000000000004' + 'deadbeef',
    );
    expect(encoded).toHaveLength(49);
    expect(encoded).toHaveLength(headerByteLength(2));
  });

  it('定长部分是 47 字节：4+2+1+16+4+8+8+4', () => {
    expect(HEADER_FIXED_BYTES).toBe(47);
    expect(headerByteLength(0)).toBe(47);
    expect(headerByteLength(255)).toBe(302);
  });

  it('编解码往返一致，并回报 keyId 的字节长度', () => {
    const { header, keyIdLength } = decodeHeader(encodeHeader(sample));

    expect(header).toEqual(sample);
    expect(keyIdLength).toBe(2);
  });

  it('容忍头后面跟着的其它字节（解码只看头部）', () => {
    const withIndex = Buffer.concat([encodeHeader(sample), Buffer.alloc(INDEX_ENTRY_SIZE, 0xaa)]);

    const { header, keyIdLength } = decodeHeader(withIndex);

    expect(header).toEqual(sample);
    expect(keyIdLength).toBe(2);
  });

  it('keyId 支持多字节 UTF-8，长度按字节计（不是字符数）', () => {
    const keyId = '轮换-2026';
    const encoded = encodeHeader({ ...sample, keyId });

    // '轮换-2026' = 2 个汉字(3 字节) + '-' + 4 位数字 = 6 + 1 + 4 = 11 字节
    expect(encoded).toHaveLength(HEADER_FIXED_BYTES + 11);
    expect(decodeHeader(encoded).header.keyId).toBe(keyId);
  });

  it('magic 与格式版本被逐字校验（未知版本必须响亮）', () => {
    const encoded = encodeHeader(sample);
    const badMagic = Buffer.from(encoded);
    badMagic.write('VCA2', 0, 'utf8');
    expect(() => decodeHeader(badMagic)).toThrow(/magic/);

    const badVersion = Buffer.from(encoded);
    badVersion.writeUInt16BE(FORMAT_VERSION + 1, 4);
    expect(() => decodeHeader(badVersion)).toThrow(/formatVersion|版本/);
  });

  it('截断的头必须抛错，而不是回一个字段为 0 的头', () => {
    const encoded = encodeHeader(sample);
    // 连定长部分都不够：一律拒绝
    expect(() => decodeHeader(encoded.subarray(0, HEADER_FIXED_BYTES - 1))).toThrow();

    /**
     * 「定长部分齐了、但声明的 keyId 把整颗头撑出缓冲之外」这一条要靠**几何**构造出来，
     * 不能随手截断（本用例前两版都写错了，实测两次报 `expected [Function] to throw`，
     * 第三次改成 67 字节则暴露出实现的一个真实缺口：它只校验了 keyId 装得下、
     * 没校验**整颗头**装得下，于是漏到 `readBigUInt64BE` 抛出一句
     * `The value of "offset" is out of range … Received 73`）。
     *
     * 几何：keyId 从第 7 字节开始、定长部分 47 字节 ⇒ offset 7 之后至少有 40 字节，
     * 因此 keyIdLen ≤ 40 时任何「长度 ≥ 47」的缓冲都容得下 keyId。
     * 要进那条分支必须 keyIdLen > 40 且 `47 + keyIdLen > buf.length`。
     */
    const longKeyId = encodeHeader({ ...sample, keyId: 'v'.repeat(50) });
    expect(longKeyId).toHaveLength(HEADER_FIXED_BYTES + 50);
    expect(longKeyId).toHaveLength(97);
    expect(() => decodeHeader(longKeyId.subarray(0, 50))).toThrow(/keyId/);

    /**
     * 上面那条还不够：`subarray(0, 50)` 在**两种判据**下都会抛。
     * 判据是「keyId 装得下」还是「**整颗头**装得下」，只有缓冲长度落在
     * `[7 + keyIdLen, 47 + keyIdLen)` 时才区分得出来——此时 keyId 完整、而定长字段已越界。
     * keyIdLen = 50 ⇒ 取 80 字节（57 ≤ 80 < 97）：错误实现会让 `readBigUInt64BE` 抛出一句
     * `The value of "offset" is out of range`，那句话里没有 `keyId`，用例因此变红。
     * **变异实测（MP24）**：删掉这一条，把判据换回「只看 keyId」，本文件 23 条用例**全绿**
     * ——即那条回归当时无人看守（`evidence/t2-mutation-mp24-header-completeness-narrow-red.txt`）。
     */
    expect(() => decodeHeader(longKeyId.subarray(0, 80))).toThrow(/keyId/);
  });

  it('拒绝自相矛盾的字段：keyIdLen=0、chunkSize=0、fileId 长度不对', () => {
    const zeroKeyId = Buffer.from(encodeHeader(sample));
    zeroKeyId.writeUInt8(0, 6);
    expect(() => decodeHeader(zeroKeyId)).toThrow(/keyId/);

    const zeroChunk = Buffer.from(encodeHeader(sample));
    zeroChunk.writeUInt32BE(0, 25);
    expect(() => decodeHeader(zeroChunk)).toThrow(/chunkSize/);

    expect(() => encodeHeader({ ...sample, fileId: Buffer.alloc(15) })).toThrow(/fileId/);
    expect(() => encodeHeader({ ...sample, fileId: Buffer.alloc(17) })).toThrow(/fileId/);
    expect(() => encodeHeader({ ...sample, noncePrefix: Buffer.alloc(3) })).toThrow(/noncePrefix/);

    // keyId 的字节不是合法 UTF-8：解出来的字符串 re-encode 长度对不上 ⇒ 必须拒绝。
    // （放行它等于承认一个「不可能对应任何真实密钥」的 keyId 是合法的。）
    const badUtf8 = Buffer.from(encodeHeader({ ...sample, keyId: '轮换' }));
    badUtf8.writeUInt8(0xff, 7);
    expect(() => decodeHeader(badUtf8)).toThrow(/keyId/);
  });

  it('拒绝越界的数值（宽度是契约的一部分）', () => {
    expect(() => encodeHeader({ ...sample, chunkSize: 0 })).toThrow(/chunkSize/);
    expect(() => encodeHeader({ ...sample, chunkSize: 0x1_0000_0000 })).toThrow(/chunkSize/);
    expect(() => encodeHeader({ ...sample, chunkSize: 1.5 })).toThrow(/chunkSize/);
    expect(() => encodeHeader({ ...sample, plaintextLength: -1n })).toThrow(/plaintextLength/);
    expect(() => encodeHeader({ ...sample, plaintextLength: 1n << 64n })).toThrow(/plaintextLength/);
    expect(() => encodeHeader({ ...sample, chunkCount: -1n })).toThrow(/chunkCount/);
    expect(() => encodeHeader({ ...sample, chunkCount: 1n << 64n })).toThrow(/chunkCount/);
    expect(() => encodeHeader({ ...sample, formatVersion: 0x1_0000 })).toThrow(/formatVersion/);
    // keyId 长度写在 1 字节里：> 255 字节必须拒绝，而不是截断
    expect(() => encodeHeader({ ...sample, keyId: 'k'.repeat(256) })).toThrow(/keyId/);
    expect(() => encodeHeader({ ...sample, keyId: '' })).toThrow(/keyId/);
  });

  it('包级常量就是设计文档的数值（单一来源）', () => {
    expect(CHUNK_SIZE).toBe(8 * 1024 * 1024);
    expect(ARTIFACT_MAGIC).toBe('VCA1');
    expect(FORMAT_VERSION).toBe(1);
    expect(TAG_BYTES).toBe(16);
    expect(NONCE_PREFIX_BYTES).toBe(4);
    expect(NONCE_BYTES).toBe(12);
  });
});

describe('块索引编解码（每块定长 24 字节）', () => {
  const entries: IndexEntry[] = [
    { offset: 200n, ciphertextLength: 64 },
    { offset: 264n, ciphertextLength: 0x01020304 },
  ];

  it('编码结果逐字节等于手算的期望值，且每块恰好 24 字节', () => {
    const encoded = encodeIndex(entries);

    expect(INDEX_ENTRY_SIZE).toBe(24);
    expect(encoded).toHaveLength(entries.length * INDEX_ENTRY_SIZE);
    expect(encoded.toString('hex')).toBe(
      // offset(8)                 ciphertextLength(4)  保留(12)
      '00000000000000c8' + '00000040' + '000000000000000000000000' +
        '0000000000000108' + '01020304' + '000000000000000000000000',
    );
  });

  it('往返一致；保留字节为 0 且解码时被忽略', () => {
    expect(decodeIndex(encodeIndex(entries))).toEqual(entries);

    const withGarbage = Buffer.from(encodeIndex(entries));
    withGarbage.fill(0xff, 12, 24); // 第一条记录的保留区
    expect(decodeIndex(withGarbage)).toEqual(entries);
  });

  it('空索引是合法的（0 字节输入 ⇒ 0 块）', () => {
    expect(encodeIndex([])).toHaveLength(0);
    expect(decodeIndex(Buffer.alloc(0))).toEqual([]);
  });

  it('长度不是 24 的整数倍必须抛错（否则会静默丢弃尾部字节）', () => {
    expect(() => decodeIndex(Buffer.alloc(INDEX_ENTRY_SIZE + 1))).toThrow(/24/);
    expect(() => decodeIndex(Buffer.alloc(INDEX_ENTRY_SIZE - 1))).toThrow(/24/);
  });

  it('拒绝越界数值', () => {
    expect(() => encodeIndex([{ offset: -1n, ciphertextLength: 1 }])).toThrow(/offset/);
    expect(() => encodeIndex([{ offset: 1n << 64n, ciphertextLength: 1 }])).toThrow(/offset/);
    expect(() => encodeIndex([{ offset: 0n, ciphertextLength: -1 }])).toThrow(/ciphertextLength/);
    expect(() => encodeIndex([{ offset: 0n, ciphertextLength: 0x1_0000_0000 }])).toThrow(/ciphertextLength/);
    expect(() => encodeIndex([{ offset: 0n, ciphertextLength: 1.5 }])).toThrow(/ciphertextLength/);
  });
});

describe('nonce 推导：noncePrefix(4) || 块序号(8, 大端)', () => {
  const prefix = Buffer.from('deadbeef', 'hex');

  it('前 4 字节等于前缀，后 8 字节是大端序号', () => {
    expect(deriveNonce(prefix, 0).toString('hex')).toBe('deadbeef0000000000000000');
    expect(deriveNonce(prefix, 1).toString('hex')).toBe('deadbeef0000000000000001');
    expect(deriveNonce(prefix, 0x0102030405).toString('hex')).toBe('deadbeef0000000102030405');
  });

  it('序号写满 64 位：第 33 位（2^32）不是「看不见的高位」', () => {
    // 只写低 32 位的实现在 position < 2^32 上完全正确（= 8 TiB 以内的每个真实文件），
    // 因此必须用超过 2^32 的序号才能把宽度钉死。
    expect(deriveNonce(prefix, 0x1_0000_0001).toString('hex')).toBe('deadbeef0000000100000001');
    expect(deriveNonce(prefix, Number.MAX_SAFE_INTEGER).toString('hex')).toBe('deadbeef001fffffffffffff');
  });

  it('总是 12 字节；同文件不同 position 互不相同', () => {
    const nonces = [0, 1, 2, 255, 256, 0xffff, 0x1_0000_0000].map((p) => deriveNonce(prefix, p));

    expect(nonces.every((n) => n.length === NONCE_BYTES)).toBe(true);
    expect(new Set(nonces.map((n) => n.toString('hex'))).size).toBe(nonces.length);
  });

  it('跨文件（不同随机前缀）在相同 position 上不碰撞', () => {
    const other = Buffer.from('cafebabe', 'hex');

    expect(deriveNonce(prefix, 0).equals(deriveNonce(other, 0))).toBe(false);
    // 前缀是唯一的区分手段：序号部分必然相同，碰撞只可能来自前缀相同
    expect(deriveNonce(prefix, 0).subarray(4)).toEqual(deriveNonce(other, 0).subarray(4));
  });

  it('拒绝非法的 position 与前缀长度', () => {
    expect(() => deriveNonce(prefix, -1)).toThrow(/position/);
    expect(() => deriveNonce(prefix, 1.5)).toThrow(/position/);
    expect(() => deriveNonce(prefix, Number.MAX_SAFE_INTEGER + 1)).toThrow(/position/);
    expect(() => deriveNonce(Buffer.alloc(5), 0)).toThrow(/noncePrefix/);
    expect(() => deriveNonce(Buffer.alloc(3), 0)).toThrow(/noncePrefix/);
  });
});

describe('AAD 推导：fileId:position:last|more（UTF-8）', () => {
  const fileId = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

  it('逐字等于契约里的字符串（末块标记是截断检测的依据）', () => {
    expect(buildAad(fileId, 7, true).toString('utf8')).toBe(
      '000102030405060708090a0b0c0d0e0f:7:last',
    );
    expect(buildAad(fileId, 7, false).toString('utf8')).toBe(
      '000102030405060708090a0b0c0d0e0f:7:more',
    );
  });

  it('末块标记改变 AAD，位置改变 AAD，fileId 改变 AAD', () => {
    const other = Buffer.from('ffffffffffffffffffffffffffffffff', 'hex');

    expect(buildAad(fileId, 0, true).equals(buildAad(fileId, 0, false))).toBe(false);
    expect(buildAad(fileId, 0, true).equals(buildAad(fileId, 1, true))).toBe(false);
    expect(buildAad(fileId, 0, true).equals(buildAad(other, 0, true))).toBe(false);
    // 位置与末块标记之间靠 `:` 分界，不是拼接位数：1 与 10 必须是两个不同的 AAD
    expect(buildAad(fileId, 1, false).toString('utf8')).toBe(
      '000102030405060708090a0b0c0d0e0f:1:more',
    );
    expect(buildAad(fileId, 10, false).toString('utf8')).toBe(
      '000102030405060708090a0b0c0d0e0f:10:more',
    );
  });

  it('fileId 必须是 16 字节；position 必须是非负安全整数', () => {
    expect(() => buildAad(Buffer.alloc(15), 0, true)).toThrow(/fileId/);
    expect(() => buildAad(Buffer.alloc(17), 0, true)).toThrow(/fileId/);
    expect(() => buildAad(fileId, -1, true)).toThrow(/position/);
    expect(() => buildAad(fileId, 1.5, true)).toThrow(/position/);
  });
});
