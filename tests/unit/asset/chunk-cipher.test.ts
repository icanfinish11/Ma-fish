import { describe, expect, it } from 'vitest';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CHUNK_SIZE,
  HEADER_FIXED_BYTES,
  INDEX_ENTRY_SIZE,
  TAG_BYTES,
  encodeHeader,
  type ArtifactHeader,
  type IndexEntry,
} from '@vca/api/modules/asset/crypto/artifact-format.js';
import { ChunkEncryptor } from '@vca/api/modules/asset/crypto/chunk-cipher.js';
import type { KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';

/**
 * 流式分块加密器（P1 / Task 2）。
 *
 * ## 验收口径：**未完成字节数**，不是 RSS
 *
 * 预检 §2.3 已经写明 RSS 不可用作判据（含 GC 未归还页），本次 8 MiB 重测再次确认：
 * 同一段代码三次运行的 RSS 增量分别是 **+32.7 / +8.0 / −33.9 MiB**（符号都不同），
 * 而「源已产出明文 − 目标已收到的明文当量」三次都恰好是 `2 × CHUNK_SIZE + 64 KiB`
 * （`evidence/t2-probe-crypto-8mib.txt`）。因此本文件的「内存与输入无关」用例
 * 只用未完成字节数断言。
 *
 * ## 判据为什么是「独立解密器」而不是「往返」
 *
 * 用同一套 `deriveNonce`/`buildAad` 去解密只能证明「自己跟自己一致」。这里的解密器
 * 按**契约字面**重写 nonce 与 AAD 的拼装（`noncePrefix(4) || BE64(position)`、
 * `` `${fileId 十六进制}:${position}:${last|more}` ``），并且**不 import** 那三个函数：
 * 写入端与判据端各自独立地实现契约，任一侧理解错了都会红。
 *
 * 这是 Task 3 的读取器**之前**能做到的最强验证；真正的读取器（含位置序号契约 C20）
 * 由 Task 3 建立，本文件不复刻它。
 */
const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

/** 测试替身：固定密钥、固定 keyId，可让 keyFor 失败（模拟「环里没有这个键」）。 */
function fakeRing(keyId = 'v1', key: Buffer = KEY, opts: { missing?: boolean } = {}): KeyRing {
  return {
    activeKeyId: () => keyId,
    keyFor: (asked: string): Buffer => {
      if (opts.missing) throw new Error(`未知的制品 keyId：${JSON.stringify(asked)}（测试替身刻意失败）`);
      if (asked !== keyId) throw new Error(`未知的制品 keyId：${JSON.stringify(asked)}`);
      return Buffer.from(key);
    },
  };
}

/** 确定性明文：第 i 字节 = (seed + i) % 251（可逐字节比对，且不因压缩/重复而「碰巧相等」）。 */
function pattern(bytes: number, seed = 0): Buffer {
  const buffer = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buffer[i] = (seed + i) % 251;
  return buffer;
}

/**
 * 测试内的独立解密器。**只接受 4 字节前缀**：前缀长度错了必须响亮，
 * 否则 `prefix.copy(nonce, 0)` 会静默截断/留零，把判据本身变成假的。
 */
function decryptBlock(
  key: Buffer,
  header: ArtifactHeader,
  position: number,
  isLast: boolean,
  ciphertext: Buffer,
  tag: Buffer,
): Buffer {
  if (header.noncePrefix.length !== 4) throw new Error('测试判据要求 4 字节 noncePrefix');
  const nonce = Buffer.alloc(12);
  header.noncePrefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(position), 4);
  const aad = Buffer.from(`${header.fileId.toString('hex')}:${position}:${isLast ? 'last' : 'more'}`, 'utf8');

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 块记录（密文 + tag + 在制品里的绝对偏移）。 */
interface BlockRecord {
  offset: number;
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * 索引条目 / 块记录的取值器。
 *
 * `tsconfig.base.json` 开了 `noUncheckedIndexedAccess`，因此 `arr[i]` 的类型是
 * `T | undefined`——直接 `.ciphertext` 过不了 `pnpm typecheck`（K14：vitest 绿不等于类型对）。
 * 测试里越界本就应该响亮失败，所以统一走这两个取值器，而不是到处写非空断言。
 */
function entryAt(entries: readonly IndexEntry[], position: number): IndexEntry {
  const entry = entries[position];
  if (entry === undefined) throw new Error(`测试期望第 ${position} 条索引存在`);
  return entry;
}

function recordAt(records: readonly BlockRecord[], position: number): BlockRecord {
  const record = records[position];
  if (record === undefined) throw new Error(`测试期望第 ${position} 条块记录存在`);
  return record;
}

/**
 * 把 `transform()` 的块数据与 `result()` 给的头/索引拼成**完整制品**
 * （`[头][索引][块数据]`，规格 D2 的顺序）。
 *
 * 这一步是**必须**的：索引里的 `offset` 是相对**制品文件起始**的绝对偏移，
 * 因此拿块数据那一小段去按 offset 切片会切到界外（本文件第一版就是这么错的，
 * 报 `Invalid authentication tag length: 0`——tag 被切成了 0 字节）。
 * 拼装本身也是 Task 5 写入方要做的同一件事，这里顺手把它钉住。
 */
function assemble(encrypted: Encrypted): Buffer {
  return Buffer.concat([encodeHeader(encrypted.header), encrypted.index, encrypted.ciphertext]);
}

/** 把制品按索引切成「块记录」（密文 + tag），供独立解密器逐块消费。 */
function recordsOf(artifact: Buffer, entries: readonly IndexEntry[]): BlockRecord[] {
  return entries.map((entry) => {
    const offset = Number(entry.offset);
    const end = offset + entry.ciphertextLength;
    return {
      offset,
      ciphertext: artifact.subarray(offset, end),
      tag: artifact.subarray(end, end + TAG_BYTES),
    };
  });
}

interface Encrypted {
  header: ArtifactHeader;
  index: Buffer;
  entries: IndexEntry[];
  ciphertext: Buffer;
}

/** 跑一遍加密器：明文 → transform() → 收集密文，再取 result()。 */
async function encrypt(
  plaintext: Buffer,
  opts: { chunkSize?: number; ring?: KeyRing; sourceChunk?: number } = {},
): Promise<Encrypted> {
  const encryptor = new ChunkEncryptor(opts.ring ?? fakeRing(), opts.chunkSize ? { chunkSize: opts.chunkSize } : {});
  const collected: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      collected.push(Buffer.from(chunk));
      callback();
    },
  });

  const source =
    opts.sourceChunk === undefined
      ? Readable.from([plaintext])
      : new Readable({
          read(): void {
            if (this.readableEnded) return;
            this.push(plaintext); // 单块输入，由 transform 自己按 chunkSize 切片
            this.push(null);
          },
        });

  await pipeline(source, encryptor.transform(), sink);
  const { header, index } = encryptor.result();
  const ciphertext = Buffer.concat(collected);
  const entries: IndexEntry[] = [];
  // 刻意**不**用 decodeIndex：索引是自己按契约解析的（24 字节/条，大端）
  for (let at = 0; at < index.length; at += INDEX_ENTRY_SIZE) {
    entries.push({ offset: index.readBigUInt64BE(at), ciphertextLength: index.readUInt32BE(at + 8) });
  }
  return { header, index, entries, ciphertext };
}

/** 用独立解密器把整份制品解回来。 */
function decryptAll(key: Buffer, encrypted: Encrypted): Buffer {
  const records = recordsOf(assemble(encrypted), encrypted.entries);
  return Buffer.concat(
    records.map((record, position) =>
      decryptBlock(key, encrypted.header, position, position === records.length - 1, record.ciphertext, record.tag),
    ),
  );
}

describe('ChunkEncryptor：分块计数与长度（真实 8 MiB 块）', () => {
  it('0 字节 ⇒ chunkCount=0、空索引、一个字节都不产出', async () => {
    const encrypted = await encrypt(Buffer.alloc(0));

    expect(encrypted.header.plaintextLength).toBe(0n);
    expect(encrypted.header.chunkCount).toBe(0n);
    expect(encrypted.index).toHaveLength(0);
    expect(encrypted.ciphertext).toHaveLength(0);
    expect(encrypted.header.chunkSize).toBe(CHUNK_SIZE);
    // 空文件也必须能被「解回来」（0 块 ⇒ 0 字节）
    expect(decryptAll(KEY, encrypted)).toHaveLength(0);
  });

  it('恰好 1 块（8 MiB）⇒ chunkCount=1，且末块标记打在唯一的块上', async () => {
    const plaintext = pattern(CHUNK_SIZE, 1);
    const encrypted = await encrypt(plaintext);

    expect(encrypted.header.plaintextLength).toBe(BigInt(CHUNK_SIZE));
    expect(encrypted.header.chunkCount).toBe(1n);
    expect(encrypted.index).toHaveLength(INDEX_ENTRY_SIZE);
    expect(entryAt(encrypted.entries, 0).ciphertextLength).toBe(CHUNK_SIZE);
    expect(encrypted.ciphertext).toHaveLength(CHUNK_SIZE + TAG_BYTES);
    expect(decryptAll(KEY, encrypted).equals(plaintext)).toBe(true);

    // 「正好整数块」是 hold-back（见实现注释）唯一无法靠长度区分的边界：
    // 急切发射的实现会把这一块标成 `more`，于是它作为末块解不开。
    const record = recordAt(recordsOf(assemble(encrypted), encrypted.entries), 0);
    expect(() => decryptBlock(KEY, encrypted.header, 0, false, record.ciphertext, record.tag)).toThrow();
  });

  it('1 块 + 1 字节 ⇒ chunkCount=2，末块密文 17 字节', async () => {
    const plaintext = pattern(CHUNK_SIZE + 1, 2);
    const encrypted = await encrypt(plaintext);

    expect(encrypted.header.plaintextLength).toBe(BigInt(CHUNK_SIZE + 1));
    expect(encrypted.header.chunkCount).toBe(2n);
    expect(encrypted.entries.map((e) => e.ciphertextLength)).toEqual([CHUNK_SIZE, 1]);
    expect(encrypted.ciphertext).toHaveLength(CHUNK_SIZE + 1 + 2 * TAG_BYTES);
    expect(decryptAll(KEY, encrypted).equals(plaintext)).toBe(true);
  });

  it('3 块 + 1234 字节 ⇒ chunkCount=4，跨块与末块不满都往返一致', async () => {
    const plaintext = pattern(3 * CHUNK_SIZE + 1234, 3);
    const encrypted = await encrypt(plaintext);

    expect(encrypted.header.plaintextLength).toBe(BigInt(3 * CHUNK_SIZE + 1234));
    expect(encrypted.header.chunkCount).toBe(4n);
    expect(encrypted.entries.map((e) => e.ciphertextLength)).toEqual([
      CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, 1234,
    ]);
    expect(encrypted.index).toHaveLength(4 * INDEX_ENTRY_SIZE);
    expect(encrypted.ciphertext).toHaveLength(3 * CHUNK_SIZE + 1234 + 4 * TAG_BYTES);
    expect(decryptAll(KEY, encrypted).equals(plaintext)).toBe(true);
  });

  it('chunkSize 可注入（自描述地写进头），小块下同样成立', async () => {
    const plaintext = pattern(1000, 4);
    const encrypted = await encrypt(plaintext, { chunkSize: 64 });

    expect(encrypted.header.chunkSize).toBe(64);
    expect(encrypted.header.chunkCount).toBe(16n); // ceil(1000 / 64)
    expect(encrypted.entries.map((e) => e.ciphertextLength)).toEqual([
      ...Array.from({ length: 15 }, () => 64), 40,
    ]);
    expect(decryptAll(KEY, encrypted).equals(plaintext)).toBe(true);
  });

  it('拒绝非法的 chunkSize（宽度与语义都要守住）', () => {
    expect(() => new ChunkEncryptor(fakeRing(), { chunkSize: 0 })).toThrow(/chunkSize/);
    expect(() => new ChunkEncryptor(fakeRing(), { chunkSize: -1 })).toThrow(/chunkSize/);
    expect(() => new ChunkEncryptor(fakeRing(), { chunkSize: 1.5 })).toThrow(/chunkSize/);
    expect(() => new ChunkEncryptor(fakeRing(), { chunkSize: 0x1_0000_0000 })).toThrow(/chunkSize/);
  });
});

describe('写入端产出的字节能被独立解密器读懂（契约级判据）', () => {
  it('每条记录的密文长度 = 索引里的 ciphertextLength，tag 恰好 16 字节', async () => {
    const encrypted = await encrypt(pattern(300, 5), { chunkSize: 100 });
    const records = recordsOf(assemble(encrypted), encrypted.entries);

    expect(records.map((r) => r.ciphertext.length)).toEqual([100, 100, 100]);
    expect(records.every((r) => r.tag.length === TAG_BYTES)).toBe(true);
  });

  it('索引 offset 是**制品文件内的绝对偏移**：头 + 索引 + 前面所有记录', async () => {
    const encrypted = await encrypt(pattern(300, 6), { chunkSize: 100 });
    const headerBytes = HEADER_FIXED_BYTES + Buffer.byteLength(encrypted.header.keyId, 'utf8');
    const dataStart = headerBytes + 3 * INDEX_ENTRY_SIZE;

    expect(encrypted.entries.map((e) => Number(e.offset))).toEqual([
      dataStart,
      dataStart + 100 + TAG_BYTES,
      dataStart + 2 * (100 + TAG_BYTES),
    ]);
    // ciphertextLength **不含** tag ⇒ tagOffset = offset + ciphertextLength
    expect(Number(entryAt(encrypted.entries, 0).offset) + entryAt(encrypted.entries, 0).ciphertextLength).toBe(
      dataStart + 100,
    );
    // 块数据区之后不应再有字节（比的是**完整制品**的长度：offset 是绝对偏移，
    // 与「只有块数据」的那一段比会差出整颗头 + 整份索引——测试第一版就是这么错的）
    const artifact = assemble(encrypted);
    const last = entryAt(encrypted.entries, 2);
    expect(Number(last.offset) + last.ciphertextLength + TAG_BYTES).toBe(artifact.length);
  });

  it('索引的保留区恒为 0（每条 12 字节）', async () => {
    const encrypted = await encrypt(pattern(300, 7), { chunkSize: 100 });

    for (let i = 0; i < 3; i++) {
      expect(encrypted.index.subarray(i * INDEX_ENTRY_SIZE + 12, (i + 1) * INDEX_ENTRY_SIZE).toString('hex')).toBe(
        '0'.repeat(24),
      );
    }
  });

  it('末块标记真的打在末块上：last 解得开、more 解不开（截断检测的前提）', async () => {
    const plaintext = pattern(300, 8);
    const encrypted = await encrypt(plaintext, { chunkSize: 100 });
    const records = recordsOf(assemble(encrypted), encrypted.entries);

    // 末块（position 2）用 last 解：成功
    expect(
      decryptBlock(KEY, encrypted.header, 2, true, recordAt(records, 2).ciphertext, recordAt(records, 2).tag).equals(
        plaintext.subarray(200),
      ),
    ).toBe(true);
    // 同一个块用 more 解：必须失败（这正是「丢掉末块」后读取器会走到的形态）
    expect(() => decryptBlock(KEY, encrypted.header, 2, false, recordAt(records, 2).ciphertext, recordAt(records, 2).tag)).toThrow();
    // 非末块（position 0）反过来：more 解得开、last 解不开
    expect(
      decryptBlock(KEY, encrypted.header, 0, false, recordAt(records, 0).ciphertext, recordAt(records, 0).tag).equals(
        plaintext.subarray(0, 100),
      ),
    ).toBe(true);
    expect(() => decryptBlock(KEY, encrypted.header, 0, true, recordAt(records, 0).ciphertext, recordAt(records, 0).tag)).toThrow();
  });

  it('「丢掉末块、把头里的计数改小」在后一块上认证失败（末尾块只有 more 的 AAD）', async () => {
    // 这是 Task 3 的截断用例在这条契约上的**写入端**依据：末块的 AAD 是 last，
    // 因此任何「把前一块当末块」的解读都会认证失败。此处只钉住写入端的标记事实。
    const encrypted = await encrypt(pattern(300, 9), { chunkSize: 100 });
    const records = recordsOf(assemble(encrypted), encrypted.entries);

    expect(() => decryptBlock(KEY, encrypted.header, 1, true, recordAt(records, 1).ciphertext, recordAt(records, 1).tag)).toThrow();
  });

  it('篡改任一块密文 ⇒ 认证失败（并指出是哪一块）', async () => {
    const encrypted = await encrypt(pattern(300, 10), { chunkSize: 100 });
    const records = recordsOf(assemble(encrypted), encrypted.entries);

    for (const position of [0, 1, 2]) {
      const tampered = Buffer.from(recordAt(records, position).ciphertext);
      // `noUncheckedIndexedAccess` 同样管到 Buffer 的下标：先取出来再改
      tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);
      let message = '';
      try {
        decryptBlock(KEY, encrypted.header, position, position === 2, tampered, recordAt(records, position).tag);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `position ${position} 的篡改未被发现`).not.toBe('');
      expect(message).toMatch(/authenticate|Unsupported state|unable to/i);
    }
  });

  it('fileId / noncePrefix 逐块进入 nonce 与 AAD：换掉头里的它们就解不开', async () => {
    /**
     * **这条用例的判别力有限，据实记载**：它证明「伪造的头解不开」，但**不能**单独证明
     * 「AAD 里真的带了 fileId」——把 AAD 换成常量 fileId 之后，它也照样通过（因为那时
     * 任何头都解不开）。承重的是上面那几条往返用例（变异 MP4 实测：把 AAD 的 fileId
     * 换成全零，往返用例全红、而这一条不红）。
     * 保留它的理由是**行为**：伪造的头必须失败，这是读取端会依赖的性质。
     */
    const encrypted = await encrypt(pattern(300, 11), { chunkSize: 100 });
    const records = recordsOf(assemble(encrypted), encrypted.entries);
    const forgedHeader: ArtifactHeader = { ...encrypted.header, fileId: randomBytes(16) };

    expect(() =>
      decryptBlock(KEY, forgedHeader, 0, false, recordAt(records, 0).ciphertext, recordAt(records, 0).tag),
    ).toThrow();

    const forgedPrefix: ArtifactHeader = { ...encrypted.header, noncePrefix: randomBytes(4) };
    expect(() =>
      decryptBlock(KEY, forgedPrefix, 0, false, recordAt(records, 0).ciphertext, recordAt(records, 0).tag),
    ).toThrow();
  });

  it('transform() 只产出块数据：头与索引不在流里（组装顺序是写入方的契约）', async () => {
    const plaintext = pattern(300, 12);
    const encrypted = await encrypt(plaintext, { chunkSize: 100 });

    // 流里恰好只有块数据（不是「头 + 索引 + 块数据」）
    expect(encrypted.ciphertext).toHaveLength(300 + 3 * TAG_BYTES);
    expect(encrypted.ciphertext.subarray(0, 4).toString('latin1')).not.toBe('VCA1');
    // 而头里带着**流结束后才知道**的总量，因此头不可能在流开始前产出
    expect(encrypted.header.plaintextLength).toBe(300n);
    expect(encrypted.header.chunkCount).toBe(3n);
  });
});

describe('nonce 唯一性（同文件 + 跨文件）', () => {
  it('同一明文两次加密：noncePrefix 不同 ⇒ 密文不同（验收）', async () => {
    const plaintext = pattern(1000, 13);
    const first = await encrypt(plaintext, { chunkSize: 100 });
    const second = await encrypt(plaintext, { chunkSize: 100 });

    expect(first.header.noncePrefix.equals(second.header.noncePrefix)).toBe(false);
    expect(first.header.fileId.equals(second.header.fileId)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    // 明文仍然是同一份：差异只可能来自 nonce/fileId
    expect(decryptAll(KEY, first).equals(plaintext)).toBe(true);
    expect(decryptAll(KEY, second).equals(plaintext)).toBe(true);
  });

  it('两文件的 position 0 nonce 不碰撞（判别「固定前缀 + 从 0 开始计数器」）', async () => {
    const first = await encrypt(pattern(100, 14), { chunkSize: 100 });
    const second = await encrypt(pattern(100, 15), { chunkSize: 100 });

    const nonceOf = (header: ArtifactHeader, position: number): string => {
      const nonce = Buffer.alloc(12);
      header.noncePrefix.copy(nonce, 0);
      nonce.writeBigUInt64BE(BigInt(position), 4);
      return nonce.toString('hex');
    };

    expect(nonceOf(first.header, 0)).not.toBe(nonceOf(second.header, 0));
    // 前缀长度与随机性：4 字节，且两次加密不相等（碰撞概率 2^-32，据实记载）
    expect(first.header.noncePrefix).toHaveLength(4);
    expect(second.header.noncePrefix).toHaveLength(4);
  });

  it('同一文件内各 position 的 nonce 互不相同', async () => {
    const encrypted = await encrypt(pattern(10 * 64, 16), { chunkSize: 64 });
    const nonces = new Set<string>();
    for (let position = 0; position < Number(encrypted.header.chunkCount); position++) {
      const nonce = Buffer.alloc(12);
      encrypted.header.noncePrefix.copy(nonce, 0);
      nonce.writeBigUInt64BE(BigInt(position), 4);
      nonces.add(nonce.toString('hex'));
    }

    expect(nonces.size).toBe(Number(encrypted.header.chunkCount));
  });
});

describe('密钥选择（用环里的键，未知 keyId 不回退）', () => {
  it('构造期就把活动键取出来：环里没有活动键 ⇒ 立刻抛错，而不是等第一个字节', () => {
    expect(() => new ChunkEncryptor(fakeRing('v9', KEY, { missing: true }))).toThrow(/v9/);
  });

  it('头里的 keyId 就是环的活动 keyId（Task 3 靠它选键）', async () => {
    const encrypted = await encrypt(pattern(10, 17), { chunkSize: 10, ring: fakeRing('2026-q4') });

    expect(encrypted.header.keyId).toBe('2026-q4');
  });

  it('真的用环里的键加密：换一把键就解不开', async () => {
    const encrypted = await encrypt(pattern(100, 18), { chunkSize: 100 });
    const otherKey = Buffer.from(
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'hex',
    );
    const records = recordsOf(assemble(encrypted), encrypted.entries);

    expect(decryptAll(KEY, encrypted).equals(pattern(100, 18))).toBe(true);
    expect(() =>
      decryptBlock(otherKey, encrypted.header, 0, true, recordAt(records, 0).ciphertext, recordAt(records, 0).tag),
    ).toThrow();
  });

  it('未知 keyId 的环不会「退化成用别的键」：构造即失败', () => {
    const ring: KeyRing = {
      activeKeyId: () => 'v1',
      keyFor: () => {
        throw new Error('未知的制品 keyId：v1');
      },
    };

    expect(() => new ChunkEncryptor(ring)).toThrow(/v1/);
  });
});

describe('内存上界：未完成字节数（不用 RSS）', () => {
  /** 源每块 64 KiB（真实上传形态），目标让出事件循环模拟慢写盘。 */
  const SOURCE_CHUNK = 64 * 1024;

  async function peakUnfinished(totalBytes: number): Promise<number> {
    const encryptor = new ChunkEncryptor(fakeRing());
    let pushed = 0;
    let received = 0;
    let peak = 0;
    let seed = 0;

    /** 未完成 = 源已产出明文 − 目标已收到的明文当量（密文减掉已完成块的 tag 开销）。 */
    const sample = (): void => {
      const completed = Math.floor(received / (CHUNK_SIZE + TAG_BYTES));
      peak = Math.max(peak, pushed - (received - TAG_BYTES * completed));
    };

    const source = new Readable({
      read(): void {
        if (pushed >= totalBytes) {
          this.push(null);
          return;
        }
        const size = Math.min(SOURCE_CHUNK, totalBytes - pushed);
        pushed += size;
        seed += 1;
        this.push(pattern(size, seed));
        sample();
      },
    });
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        received += chunk.length;
        sample();
        setImmediate(callback);
      },
    });

    await pipeline(source, encryptor.transform(), sink);
    expect(encryptor.result().header.plaintextLength).toBe(BigInt(totalBytes));
    return peak;
  }

  it('64 MiB 输入时峰值未完成字节 ≤ 3 × CHUNK_SIZE（验收）', async () => {
    const peak = await peakUnfinished(64 * 1024 * 1024);

    expect(
      peak,
      `峰值未完成字节=${peak}（3 × CHUNK_SIZE=${3 * CHUNK_SIZE}）——整份缓冲的实现会在这里变红`,
    ).toBeLessThanOrEqual(3 * CHUNK_SIZE);
  }, 60_000);

  it('峰值不随输入增长：16 MiB 与 64 MiB 的峰值相同（差别 ≤ 一个源块）', async () => {
    const small = await peakUnfinished(16 * 1024 * 1024);
    const large = await peakUnfinished(64 * 1024 * 1024);

    expect(small).toBeLessThanOrEqual(3 * CHUNK_SIZE);
    expect(large - small).toBeLessThanOrEqual(SOURCE_CHUNK);
  }, 60_000);
});

describe('生命周期与失败路径', () => {
  it('流结束前调用 result() ⇒ 抛错（不许报出一份「还没结束」的头）', async () => {
    const encryptor = new ChunkEncryptor(fakeRing(), { chunkSize: 100 });

    expect(() => encryptor.result()).toThrow(/结束/);

    const transform = encryptor.transform();
    transform.write(pattern(150, 19));
    expect(() => encryptor.result()).toThrow();

    // 必须**消费**可读侧：不消费时 Transform 的 'end' 永远不会触发（第一版在此超时 5s）。
    const drained = new Promise<void>((resolve) => {
      transform.on('data', () => {});
      transform.on('end', () => resolve());
    });
    transform.end();
    await drained;

    expect(encryptor.result().header.chunkCount).toBe(2n);
  });

  it('transform() 只能取一次（同一次加密不能有两个出口）', () => {
    const encryptor = new ChunkEncryptor(fakeRing(), { chunkSize: 100 });
    encryptor.transform();

    expect(() => encryptor.transform()).toThrow(/transform/);
  });

  it('result() 可重复调用且返回一致', async () => {
    const encrypted = await encrypt(pattern(100, 20), { chunkSize: 100 });
    const encryptor = new ChunkEncryptor(fakeRing(), { chunkSize: 100 });
    const sink = new Writable({ write(_c, _e, cb): void { cb(); } });
    await pipeline(Readable.from([pattern(100, 20)]), encryptor.transform(), sink);

    const first = encryptor.result();
    const second = encryptor.result();

    expect(second.header).toEqual(first.header);
    expect(second.index.equals(first.index)).toBe(true);
    expect(first.header.chunkCount).toBe(encrypted.header.chunkCount);
  });

  it('输入流出错 ⇒ result() 仍然拒绝给出一份「完整」的头', async () => {
    const encryptor = new ChunkEncryptor(fakeRing(), { chunkSize: 100 });
    const failing = new Readable({
      read(): void {
        this.destroy(new Error('源流出错（模拟上传中断）'));
      },
    });
    const sink = new Writable({ write(_c, _e, cb): void { cb(); } });

    await expect(pipeline(failing, encryptor.transform(), sink)).rejects.toThrow(/源流出错/);
    expect(() => encryptor.result()).toThrow();
  });
});
