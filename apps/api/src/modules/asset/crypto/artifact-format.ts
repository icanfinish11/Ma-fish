/**
 * 制品存储格式的常量与头/索引编解码（P1 / Task 2，**契约文件**）。
 *
 * 纯函数、无 I/O、无随机数：本文件只描述「字节长什么样」。
 * Task 3 的读取器按这里的布局解析，因此**任何一处改动都是跨模块改动**。
 *
 * ## 布局（逐字取自计划 Task 2 的契约段与规格 D2）
 *
 * ```
 * [ 文件头 ]  magic(4)="VCA1" | formatVersion(2)=1 | keyIdLen(1) | keyId(N)
 *             fileId(16) | chunkSize(4) | plaintextLength(8) | chunkCount(8) | noncePrefix(4)
 * [ 块索引 ]  每块定长 24 字节：offset(8) | ciphertextLength(4) | 保留(12)
 * [ 块数据 ]  逐块 ciphertext || tag(16)
 * ```
 *
 * ### 三处必须由 Task 3 一起遵守的解释（brief 未逐字写明，但格式必须唯一）
 *
 * 1. **`offset` 是「相对制品文件起始的绝对字节偏移」**，不是「相对块数据区起点的偏移」。
 *    第一条块数据的 offset 因此等于 `headerByteLength(keyIdLength) + 24 * chunkCount`。
 *    选绝对偏移的理由：索引本身就是一份文件级目录，读取器拿到 offset 就能直接
 *    `getRange(key, offset, offset + ciphertextLength + TAG_BYTES - 1)`，
 *    不需要再记住「块数据区从哪开始」这个隐含状态。
 * 2. **`ciphertextLength` **不含** 16 字节 tag**：它就是该块的明文长度，
 *    因此 `tagOffset = offset + ciphertextLength`（brief 写的正是「tagOffset 由
 *    ciphertextLength 推出」），整块记录的字节长度是 `ciphertextLength + TAG_BYTES`。
 *    这条解释还带来一个读取器可以零成本校验的不变式：`Σ ciphertextLength === plaintextLength`。
 * 3. **`chunkCount === 0` 表示空文件**（0 字节明文 ⇒ 0 块、空索引），不是「一块 0 字节的密文」。
 *    `chunkCount === ceil(plaintextLength / chunkSize)`；读取器必须自己校验这条一致性，
 *    而不是信任头里自称的计数（同 C20 的道理：头也是不可信输入）。
 *
 * ### 与 brief 的一处算术不一致：定长是 47，不是 48
 *
 * brief 写「文件头（定长 **48** + keyId）」，但同一段列出的字段宽度之和是 **47**
 * （`4+2+1+16+4+8+8+4`）。索引那段的算术是自洽的（`8+4+12=24`），说明 48 是笔误。
 * 可枚举的字段清单是更精确的那一份，故实现按 47 走并把它做成导出常量
 * （`headerByteLength`），同时回填了预检报告。**若将来要让定长变 48，那是一次格式版本变更
 * （`formatVersion` 递增），不是把某个字段悄悄加宽 1 字节。**
 *
 * ### 为什么索引里**没有**块序号 / nonceSuffix
 *
 * 规格 D2 的草稿里出现过 `nonceSuffix(8)`。它被刻意去掉了：nonce 必须由**读取位置**推导
 * （C20），把序号存进记录等于给读取器一个「可以信任自称序号」的诱惑——预检实测，
 * 信任自称序号时攻击者整体调换两条记录，认证会**通过**且明文被静默重排。
 * 索引里只留位置事实（offset / 长度），序号是位置本身。
 */

/** 块大小：8 MiB（设计文档威胁 #3）。生产值，测试也要在真实值下跑（见预检 §2.3）。 */
export const CHUNK_SIZE = 8 * 1024 * 1024;

/** 文件头 magic：4 字节 ASCII，用来在解析前拒掉「这根本不是我们的制品」。 */
export const ARTIFACT_MAGIC = 'VCA1';

/** 格式版本。读取器遇到不认识的版本必须拒绝，而不是尽力解析。 */
export const FORMAT_VERSION = 1;

/** 每块密文尾部的 GCM tag 长度。 */
export const TAG_BYTES = 16;

/** noncePrefix：每文件随机的 4 字节（跨文件 nonce 唯一性靠它）。 */
export const NONCE_PREFIX_BYTES = 4;

/** AES-256-GCM 的 nonce 长度：4 字节前缀 + 8 字节块序号。 */
export const NONCE_BYTES = 12;

/** fileId：每文件随机 16 字节，AAD 里以十六进制表示。 */
export const FILE_ID_BYTES = 16;

/** 块索引每条记录的定长尺寸：offset(8) + ciphertextLength(4) + 保留(12)。 */
export const INDEX_ENTRY_SIZE = 24;

/**
 * 索引记录内的字段偏移（相对该记录起点）。写成常量而不是散落的字面量：`8` 与 `12` 有一处写错
 * 时，黄金字节用例会红，但报的是「字节不等」——这些名字能直接指出错的是哪一段。
 */
const INDEX_FIELD_OFFSET = 0;
const INDEX_FIELD_LENGTH = 8;
const INDEX_FIELD_RESERVED = 12;

/** 索引记录里保留区的字节数（写入恒为 0，读取忽略）。 */
export const INDEX_RESERVED_BYTES = INDEX_ENTRY_SIZE - INDEX_FIELD_RESERVED;

/** 头里 keyIdLen 只有 1 字节 ⇒ keyId 的 UTF-8 字节长度上限。 */
export const KEY_ID_MAX_BYTES = 255;

/**
 * 文件头**定长部分**的字节数：magic(4) + formatVersion(2) + keyIdLen(1) +
 * fileId(16) + chunkSize(4) + plaintextLength(8) + chunkCount(8) + noncePrefix(4) = **47**。
 *
 * 导出成常量而不是散落的字面量：它是「索引从第几个字节开始」的唯一来源。
 */
export const HEADER_FIXED_BYTES = 47;

/** 制品头（解码后的形态）。 */
export interface ArtifactHeader {
  formatVersion: number;
  keyId: string;
  /** 16 字节随机文件标识；AAD 里用它的十六进制表示。 */
  fileId: Buffer;
  chunkSize: number;
  plaintextLength: bigint;
  chunkCount: bigint;
  noncePrefix: Buffer;
}

/**
 * 块索引的一条记录。
 *
 * - `offset`：该块密文在**制品文件里**的绝对起始偏移（见文件头的解释 1）；
 * - `ciphertextLength`：**不含** tag 的密文长度 = 该块明文长度（见解释 2）；
 *   因此 `tagOffset === offset + ciphertextLength`，整块记录长度再加 {@link TAG_BYTES}。
 */
export interface IndexEntry {
  offset: bigint;
  ciphertextLength: number;
}

/** 头部（含 keyId）占用的总字节数：`47 + keyIdLength`。 */
export function headerByteLength(keyIdLength: number): number {
  if (!Number.isInteger(keyIdLength) || keyIdLength < 0 || keyIdLength > KEY_ID_MAX_BYTES) {
    throw new RangeError(`keyIdLength 必须是 0..${KEY_ID_MAX_BYTES} 的整数：${keyIdLength}`);
  }
  return HEADER_FIXED_BYTES + keyIdLength;
}

/**
 * 把文件头编码成字节。
 *
 * 全部数值字段都是**大端**（网络序）：格式里不该混用两种字节序，
 * 而大端是十六进制肉眼可读的那一种（黄金用例就是靠这一点做独立判据）。
 */
export function encodeHeader(header: ArtifactHeader): Buffer {
  const keyIdBytes = Buffer.from(header.keyId, 'utf8');
  assertUint(keyIdBytes.length, 1, KEY_ID_MAX_BYTES, 'keyId');
  assertUint(header.formatVersion, 1, 0xffff, 'formatVersion');
  assertBufferLength(header.fileId, FILE_ID_BYTES, 'fileId');
  assertUint(header.chunkSize, 1, 0xffffffff, 'chunkSize');
  assertUint64(header.plaintextLength, 'plaintextLength');
  assertUint64(header.chunkCount, 'chunkCount');
  assertBufferLength(header.noncePrefix, NONCE_PREFIX_BYTES, 'noncePrefix');

  const buffer = Buffer.alloc(headerByteLength(keyIdBytes.length));
  buffer.write(ARTIFACT_MAGIC, 0, 'utf8');
  buffer.writeUInt16BE(header.formatVersion, 4);
  buffer.writeUInt8(keyIdBytes.length, 6);
  keyIdBytes.copy(buffer, 7);
  header.fileId.copy(buffer, 7 + keyIdBytes.length);
  const afterFileId = 7 + keyIdBytes.length + FILE_ID_BYTES;
  buffer.writeUInt32BE(header.chunkSize, afterFileId);
  buffer.writeBigUInt64BE(header.plaintextLength, afterFileId + 4);
  buffer.writeBigUInt64BE(header.chunkCount, afterFileId + 12);
  header.noncePrefix.copy(buffer, afterFileId + 20);
  return buffer;
}

/**
 * 解析文件头。`buf` 允许在头之后跟着索引/块数据（本函数只看头部）。
 *
 * 返回 `keyIdLength` 而不是只返回 header：调用方要据此算「索引从第几字节开始」
 * （`headerByteLength(keyIdLength)`），而不是自己去数 `keyId` 的字节数。
 *
 * **拒绝**任何自相矛盾的输入（magic/版本不认、头被截断、keyIdLen=0、
 * keyId 不是合法 UTF-8、chunkSize=0）——静默解析出一个字段全 0 的头，
 * 会让 Task 3 在「制品损坏」时报出一个看不出原因的错。
 *
 * 返回的 Buffer 字段是**拷贝**，不是 `buf` 的视图：读取器会把整个制品缓冲复用，
 * 视图会让头字段在别处被改写后莫名其妙地变值。
 */
export function decodeHeader(buf: Buffer): { header: ArtifactHeader; keyIdLength: number } {
  if (buf.length < HEADER_FIXED_BYTES) {
    throw new Error(`制品头不完整：至少需要 ${HEADER_FIXED_BYTES} 字节，实际 ${buf.length} 字节`);
  }
  if (buf.toString('latin1', 0, 4) !== ARTIFACT_MAGIC) {
    throw new Error(`制品 magic 不匹配：期望 ${ARTIFACT_MAGIC}，实际 ${JSON.stringify(buf.toString('latin1', 0, 4))}`);
  }
  const formatVersion = buf.readUInt16BE(4);
  if (formatVersion !== FORMAT_VERSION) {
    throw new Error(`不支持的制品 formatVersion：${formatVersion}（本实现支持 ${FORMAT_VERSION}）`);
  }

  const keyIdLength = buf.readUInt8(6);
  if (keyIdLength < 1) {
    throw new Error('制品头的 keyId 长度为 0：keyId 必须非空（轮换靠它选密钥）');
  }
  // 判据是「**整颗头**是否装得下」，而不是「keyId 是否装得下」：定长字段排在 keyId 之后，
  // 只校验 keyId 会让一次截断漏到 `readBigUInt64BE` 那里，抛出一句
  // `The value of "offset" is out of range … Received 73` 这种看不出是制品的错
  // （实现第一版就是这样，由下面的截断用例实测抓到）。
  if (headerByteLength(keyIdLength) > buf.length) {
    throw new Error(
      `制品头不完整：keyId 声明 ${keyIdLength} 字节 ⇒ 整颗头需要 ${headerByteLength(keyIdLength)} 字节，实际只有 ${buf.length} 字节`,
    );
  }
  const keyId = buf.toString('utf8', 7, 7 + keyIdLength);
  if (Buffer.byteLength(keyId, 'utf8') !== keyIdLength) {
    // 非法 UTF-8（或把多字节字符截断）会解出 U+FFFD，re-encode 长度就对不上。
    // 这样的 keyId 绝不可能对应任何真实密钥，必须在解析层拒掉。
    throw new Error(`制品头的 keyId 不是合法的 UTF-8 序列（声明 ${keyIdLength} 字节）`);
  }

  const chunkSize = buf.readUInt32BE(7 + keyIdLength + FILE_ID_BYTES);
  if (chunkSize === 0) {
    throw new Error('制品头的 chunkSize 为 0：块大小必须为正数');
  }

  const header: ArtifactHeader = {
    formatVersion,
    keyId,
    fileId: Buffer.from(buf.subarray(7 + keyIdLength, 7 + keyIdLength + FILE_ID_BYTES)),
    chunkSize,
    plaintextLength: buf.readBigUInt64BE(7 + keyIdLength + FILE_ID_BYTES + 4),
    chunkCount: buf.readBigUInt64BE(7 + keyIdLength + FILE_ID_BYTES + 12),
    noncePrefix: Buffer.from(
      buf.subarray(7 + keyIdLength + FILE_ID_BYTES + 20, 7 + keyIdLength + FILE_ID_BYTES + 24),
    ),
  };
  return { header, keyIdLength };
}

/**
 * 推导某一块的 nonce：`noncePrefix(4) || 块序号(8, 大端)`（规格 D4）。
 *
 * **序号必须来自读取位置**，绝不能来自记录里自称的序号（C20）。跨文件唯一性靠
 * 每文件随机的 4 字节前缀——「固定前缀 + 从 0 开始的计数器」在 GCM 下会因 nonce 重用
 * 泄露明文异或，是明确禁止的方案。
 *
 * 序号写满 64 位：只写低 32 位在 8 TiB 以内的每个真实文件上都**看不出区别**，
 * 因此这里不做「够用就行」的宽窄取舍。
 */
export function deriveNonce(prefix: Buffer, position: number): Buffer {
  assertBufferLength(prefix, NONCE_PREFIX_BYTES, 'noncePrefix');
  assertPosition(position);
  const nonce = Buffer.alloc(NONCE_BYTES);
  prefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(position), NONCE_PREFIX_BYTES);
  return nonce;
}

/**
 * 推导某一块的 AAD：`` `${fileId 十六进制}:${position}:${isLast ? 'last' : 'more'}` ``（UTF-8）。
 *
 * 末块标记是**截断检测**的依据：攻击者丢掉末块、并把头里的 `chunkCount` 改小之后，
 * 新的「末块」会带着 `more` 的 AAD 去认证，而它当初是用 `last` 建的 ⇒ 认证失败。
 * 反过来，把非末块当末块认证同样失败。位置进 AAD 则挡住了「整体调换两条记录」。
 *
 * 因此写入端**必须**在末块上打 `last`——这不是可选的元数据，而是整条链路的承重件
 * （写入端的钉法见 `tests/unit/asset/chunk-cipher.test.ts` 的「末块标记」用例）。
 */
export function buildAad(fileId: Buffer, position: number, isLast: boolean): Buffer {
  assertBufferLength(fileId, FILE_ID_BYTES, 'fileId');
  assertPosition(position);
  return Buffer.from(`${fileId.toString('hex')}:${position}:${isLast ? 'last' : 'more'}`, 'utf8');
}

/** 编码块索引。空数组 ⇒ 空 Buffer（0 块）。 */
export function encodeIndex(entries: readonly IndexEntry[]): Buffer {
  const buffer = Buffer.alloc(entries.length * INDEX_ENTRY_SIZE);
  entries.forEach((entry, i) => {
    assertUint64(entry.offset, 'offset');
    assertUint(entry.ciphertextLength, 0, 0xffffffff, 'ciphertextLength');
    const at = i * INDEX_ENTRY_SIZE;
    buffer.writeBigUInt64BE(entry.offset, at + INDEX_FIELD_OFFSET);
    buffer.writeUInt32BE(entry.ciphertextLength, at + INDEX_FIELD_LENGTH);
    // 保留区保持全 0。`Buffer.alloc` 已经保证了这一点，这里写出来是为了让
    // 「保留 = 0 是格式的一部分」在代码里可见，而不是靠分配方式偶然成立。
    buffer.fill(0, at + INDEX_FIELD_RESERVED, at + INDEX_ENTRY_SIZE);
  });
  return buffer;
}

/**
 * 解析块索引。
 *
 * `buf` 的长度**必须**是 {@link INDEX_ENTRY_SIZE} 的整数倍：多出来的尾巴意味着
 * 调用方读错了区间（或制品被截断），静默忽略会把一次结构损坏读成一份好数据。
 */
export function decodeIndex(buf: Buffer): IndexEntry[] {
  if (buf.length % INDEX_ENTRY_SIZE !== 0) {
    throw new Error(`块索引长度必须是 ${INDEX_ENTRY_SIZE} 的整数倍：实际 ${buf.length} 字节`);
  }
  const entries: IndexEntry[] = [];
  for (let at = 0; at < buf.length; at += INDEX_ENTRY_SIZE) {
    entries.push({
      offset: buf.readBigUInt64BE(at + INDEX_FIELD_OFFSET),
      ciphertextLength: buf.readUInt32BE(at + INDEX_FIELD_LENGTH),
    });
  }
  return entries;
}

/** `position` 必须是非负安全整数：它要按 8 字节大端写进 nonce 与 AAD。 */
function assertPosition(position: number): void {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new RangeError(`position 必须是非负安全整数：${position}`);
  }
}

function assertBufferLength(value: Buffer, expected: number, name: string): void {
  if (value.length !== expected) {
    throw new RangeError(`${name} 必须是 ${expected} 字节，实际 ${value.length}`);
  }
}

function assertUint(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} 必须是 ${min}..${max} 的整数：${value}`);
  }
}

function assertUint64(value: bigint, name: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${name} 必须是 0..2^64-1 的整数：${String(value)}`);
  }
}
