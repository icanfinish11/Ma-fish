/**
 * 制品存储格式的常量与头/索引/尾编解码（P1 / Task 2，**契约文件**）。
 *
 * 纯函数、无 I/O、无随机数：本文件只描述「字节长什么样」。
 * Task 3 的读取器按这里的布局解析，因此**任何一处改动都是跨模块改动**。
 *
 * ## 布局（逐字取自计划 Task 2 的契约段 + 控制器裁定 R3）
 *
 * ```
 * [ 文件头 31+N ]  magic(4)="VCA1" | formatVersion(2)=1 | keyIdLen(1) | keyId(N) |
 *                  fileId(16) | chunkSize(4) | noncePrefix(4)
 * [ 块数据 ... ]   逐块 ciphertext || tag(16)，顺序追加
 * [ 块索引 ... ]   每块定长 24 字节：
 *                  offset(8, **文件绝对偏移**) | ciphertextLength(4, **不含 tag**) |
 *                  记录自称序号(8, 大端) | 保留(4, 全零)
 * [ 尾部 24 字节 ] indexOffset(8) | chunkCount(8) | plaintextLength(8) ← **恒为文件最后 24 字节**
 * ```
 *
 * ### 为什么是「头 / 数据 / 索引 / 尾」，而不是初稿的「头 / 索引 / 数据」（R3）
 *
 * 初稿把 `plaintextLength` / `chunkCount` 放在头里、索引紧跟在头之后。**那个排布单趟前向写不出来**：
 * 两个总量字段要等流结束才知道，而格式要求头排在块数据之前；索引又必须排在块数据之前才「紧随头部」。
 * 存储端口（Task 1 的 `putStream`）只能从 0 顺序追加，没有按偏移回填的能力 ⇒ 初稿的排布**物理上
 * 不可产出**，而不是「难写」。
 *
 * R3 的排布把「流结束前已知的」留在头里（`fileId` / `chunkSize` / `noncePrefix` 全都在构造期就有），
 * 把「流结束后才知道的」放进**恒为最后 24 字节**的尾部。于是写入端是**真正的一趟顺序写**：
 * 头 → 逐块密文 → 索引 → 尾。读取端则从**末尾 24 字节**一路往前定位（先读尾拿 `indexOffset`，
 * 再读索引，再按需取块），这也正是 Task 3 的随机访问读取器与 Task 4 的 zip 中央目录读取所需要的方向。
 *
 * ### 必须由 Task 3 一起遵守的五处解释（brief 未逐字写明，但格式必须唯一）
 *
 * 1. **`offset` 是「相对制品文件起始的绝对字节偏移」**。块数据区紧随头，因此第一条记录的
 *    `offset === headerByteLength(keyIdLength)`（见 {@link blockDataOffset}）。选绝对偏移的理由：
 *    索引本身就是一份文件级目录，读取器拿到 offset 就能直接
 *    `getRange(key, offset, offset + ciphertextLength + TAG_BYTES - 1)`，
 *    不必再记住「块数据区从哪开始」这个隐含状态。
 * 2. **`ciphertextLength` **不含** 16 字节 tag**：它就是该块的明文长度，因此
 *    `tagOffset = offset + ciphertextLength`（brief 写的正是「tagOffset 由 ciphertextLength 推出」），
 *    整块记录的字节长度是 `ciphertextLength + TAG_BYTES`。这条解释还带来一个读取器可以零成本
 *    校验的不变式：`Σ ciphertextLength === plaintextLength`。
 * 3. **`chunkCount === 0` 表示空文件**（0 字节明文 ⇒ 0 块、空索引），不是「一块 0 字节的密文」。
 *    `chunkCount === ceil(plaintextLength / chunkSize)`；读取器必须自己校验这条一致性，
 *    而不是信任尾部的自称值（同 C20 的道理：制品里的一切都是不可信输入）。
 * 4. **索引记录里的「自称序号」（字节 12..19）只用于比对，绝不用来推导 nonce 或 AAD**（R2）。
 *    预检 §2.1 实测：一旦读取端用记录自称的序号去推导 nonce/AAD，攻击者把两条记录整体调换，
 *    认证会**通过**、明文被静默重排。因此序号的事实来源永远是**读取位置**；这个字段存在，
 *    只是为了给「位置 P 处的记录自称序号 Q」这条校验与它的错误信息**一个数据来源**。
 * 5. **尾部恒为文件最后 24 字节**（{@link FOOTER_BYTES}）。`indexOffset` 指向索引起点，
 *    索引长度 = `chunkCount * INDEX_ENTRY_SIZE`；读取器的第一步是读最后 24 字节。
 *
 * ### 与初稿 brief 的一处算术不一致：定长头是 31，不是 47、更不是 48
 *
 * 初稿的字段清单（`4+2+1+16+4+8+8+4`）相加是 **47**，初稿文字却写「定长 48」⇒ 48 是笔误。
 * R3 把 `plaintextLength` / `chunkCount` 移入尾部后，头里只剩流结束前已知的字段：
 * `4+2+1+16+4+4 = 31`，即 {@link HEADER_FIXED_BYTES}。**若将来要让定长头变宽，
 * 那是一次格式版本变更（`formatVersion` 递增），不是把某个字段悄悄加宽。**
 *
 * ### 为什么索引里的「自称序号」不叫 `nonceSuffix`
 *
 * 规格 D2 的草稿里出现过 `nonceSuffix(8)`。这个名字会诱导实现把序号当成 nonce 的一部分去**信任**，
 * 而那正是预检发现的漏洞（上面第 4 条）。字段名因此取 `index`（记录自称的位置），
 * 并在接口注释里逐字写明它**不参与** nonce/AAD 推导。
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

/**
 * 块索引每条记录的定长尺寸：
 * `offset(8) + ciphertextLength(4) + 自称序号(8) + 保留(4) === 24`。
 */
export const INDEX_ENTRY_SIZE = 24;

/**
 * 索引记录内的字段**偏移**（相对该记录起点）。
 *
 * 写成常量而不是散落的字面量：这几段有一处写错时，黄金字节用例会红，但报的是「字节不等」
 * ——这些名字能直接指出错的是哪一段。
 *
 * **只有偏移、没有宽度常量**：宽度由 `writeBigUInt64BE` / `writeUInt32BE` 这些调用
 * **自己**定死（8 / 4）。再写一份 `…_LENGTH = 8` 就是第二个真相来源，而且它没有任何读取方
 * ——lint 的 `no-unused-vars` 会直接报出来（本文件那三个宽度常量就是这么被删掉的）。
 * 实际宽度由黄金字节用例、`INDEX_ENTRY_SIZE` 与读取端的切片共同钉住。
 *
 * **一处命名债的清理（R2）**：上一版这里只有 `INDEX_FIELD_OFFSET` / `INDEX_FIELD_LENGTH`
 * 两个字段名，另加一个叫 `INDEX_FIELD_RESERVED = 12` 的常量——它其实是**字节偏移**却戴着
 * 「字段」的名字，而派生出的 `INDEX_RESERVED_BYTES = INDEX_ENTRY_SIZE - INDEX_FIELD_RESERVED`
 * 更是把两个字段的偏移/宽度混着用（它恰好等于 12，于是「看起来对」）。现在每段的名字
 * 都是 `…_OFFSET`，保留区的起点由**它自己的偏移**给出，不再借用别人的偏移再相减。
 *
 * 保留字节**写入恒为 0**：`Buffer.alloc` 已保证，代码里再显式 `fill` 一次，
 * 让「保留 = 0 是格式的一部分」可见，而不是靠分配方式偶然成立。
 */
const INDEX_OFFSET_OFFSET = 0;
const INDEX_LENGTH_OFFSET = 8;
/** 记录**自称**的块序号（R2）。**只用于比对**：绝不参与 nonce / AAD 推导。 */
const INDEX_SELF_INDEX_OFFSET = 12;
const INDEX_RESERVED_OFFSET = 20;

/**
 * 上一版的 `INDEX_RESERVED_BYTES` **已删除**（R2 明令）：它由「字段偏移」错误地派生出来，
 * 且全仓没有任何读取方（真正的写入路径用 `Buffer.alloc` 的零填充）。
 * 与 `key-ring.ts` 里被删掉的 `KEY_BYTES` 同一个理由（C16：不留没有读取方的常量）。
 */

/** 头里 keyIdLen 只有 1 字节 ⇒ keyId 的 UTF-8 字节长度上限。 */
export const KEY_ID_MAX_BYTES = 255;

/**
 * 文件头**定长部分**的字节数：magic(4) + formatVersion(2) + keyIdLen(1) +
 * fileId(16) + chunkSize(4) + noncePrefix(4) = **31**。
 *
 * 导出成常量而不是散落的字面量：它是「块数据从第几个字节开始」的唯一来源
 * （见 {@link blockDataOffset}）。
 */
export const HEADER_FIXED_BYTES = 31;

/** 尾部定长：`indexOffset(8) | chunkCount(8) | plaintextLength(8)` = **24**。 */
export const FOOTER_BYTES = 24;

/** 制品头（编码后的形态）。**它不含任何「流结束后才知道」的字段**——那些在尾部。 */
export interface ArtifactHeader {
  formatVersion: number;
  keyId: string;
  /** 16 字节随机文件标识；AAD 里用它的十六进制表示。 */
  fileId: Buffer;
  chunkSize: number;
  noncePrefix: Buffer;
}

/**
 * 制品尾部（**恒为文件最后 24 字节**）。
 *
 * 三个字段都只在流结束之后才有最终值，因此它们在尾部而不在头里（R3）。
 */
export interface ArtifactFooter {
  /** 块索引在文件里的绝对起始偏移。 */
  indexOffset: bigint;
  /** 块数。空文件为 0（R4）。 */
  chunkCount: bigint;
  /** 明文总字节数。 */
  plaintextLength: bigint;
}

/**
 * 块索引的一条记录。
 *
 * - `offset`：该块密文在**制品文件里**的绝对起始偏移（见格式说明第 1 条）；
 * - `ciphertextLength`：**不含** tag 的密文长度 = 该块明文长度（见第 2 条）；
 *   因此 `tagOffset === offset + ciphertextLength`，整块记录长度再加 {@link TAG_BYTES}；
 * - `index`：该记录**自称**的块序号（见第 4 条）。写入端写的是真实位置；读取端拿它
 *   与**读取位置**比对，不一致即拒绝（C20）。**绝不用于推导 nonce 或 AAD。**
 */
export interface IndexEntry {
  offset: bigint;
  ciphertextLength: number;
  index: bigint;
}

/** 头部（含 keyId）占用的总字节数：`31 + keyIdLength`。 */
export function headerByteLength(keyIdLength: number): number {
  if (!Number.isInteger(keyIdLength) || keyIdLength < 0 || keyIdLength > KEY_ID_MAX_BYTES) {
    throw new RangeError(`keyIdLength 必须是 0..${KEY_ID_MAX_BYTES} 的整数：${keyIdLength}`);
  }
  return HEADER_FIXED_BYTES + keyIdLength;
}

/**
 * 块数据区的绝对起点 = 头长度。
 *
 * R3 的排布把它变成**只依赖 keyId 长度**的量：索引与尾部都排在块数据**之后**，
 * 因此发射第一块密文时就能算出真实绝对偏移——写入端不必等流结束回填。
 * 这是初稿做不到的一点（初稿的 offset 依赖最终块数）。
 */
export function blockDataOffset(keyIdLength: number): number {
  return headerByteLength(keyIdLength);
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
  assertBufferLength(header.noncePrefix, NONCE_PREFIX_BYTES, 'noncePrefix');

  const buffer = Buffer.alloc(headerByteLength(keyIdBytes.length));
  buffer.write(ARTIFACT_MAGIC, 0, 'utf8');
  buffer.writeUInt16BE(header.formatVersion, 4);
  buffer.writeUInt8(keyIdBytes.length, 6);
  keyIdBytes.copy(buffer, 7);
  header.fileId.copy(buffer, 7 + keyIdBytes.length);
  const afterFileId = 7 + keyIdBytes.length + FILE_ID_BYTES;
  buffer.writeUInt32BE(header.chunkSize, afterFileId);
  header.noncePrefix.copy(buffer, afterFileId + 4);
  return buffer;
}

/**
 * 解析文件头。`buf` 允许在头之后跟着块数据（本函数只看头部）。
 *
 * 返回 `keyIdLength` 而不是只返回 header：调用方要据此算「块数据从第几字节开始」
 * （{@link blockDataOffset}），而不是自己去数 `keyId` 的字节数。
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
  // 只校验 keyId 会让一次截断漏到 `readUInt32BE` 那里，抛出一句
  // `The value of "offset" is out of range … Received 73` 这种看不出是制品的错
  // （实现第一版就是这样，由截断用例实测抓到）。
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
    noncePrefix: Buffer.from(
      buf.subarray(7 + keyIdLength + FILE_ID_BYTES + 4, 7 + keyIdLength + FILE_ID_BYTES + 4 + NONCE_PREFIX_BYTES),
    ),
  };
  return { header, keyIdLength };
}

/**
 * 把尾部编码成 24 字节。**它必须是写入端交出的最后一段字节**（格式说明第 5 条）。
 *
 * 与头不同，这里的字段全部只在流结束后才有值，因此本函数在写入端只能被调用一次、
 * 且必须在最后。读取端的第一步则是读制品最后 24 字节并交给 {@link decodeFooter}。
 */
export function encodeFooter(footer: ArtifactFooter): Buffer {
  assertUint64(footer.indexOffset, 'indexOffset');
  assertUint64(footer.chunkCount, 'chunkCount');
  assertUint64(footer.plaintextLength, 'plaintextLength');

  const buffer = Buffer.alloc(FOOTER_BYTES);
  buffer.writeBigUInt64BE(footer.indexOffset, 0);
  buffer.writeBigUInt64BE(footer.chunkCount, 8);
  buffer.writeBigUInt64BE(footer.plaintextLength, 16);
  return buffer;
}

/**
 * 解析尾部。`buf` 必须是**恰好 24 字节**（调用方按 `size-24 .. size-1` 取）。
 *
 * 长度判据写成「恰好」而不是「至少」，是因为调用方多给了字节一定意味着它取错了区间
 * （例如把整份制品传了进来）——那时静默取前 24 字节会把一次调用错误读成一份好数据。
 */
export function decodeFooter(buf: Buffer): ArtifactFooter {
  if (buf.length !== FOOTER_BYTES) {
    throw new Error(`制品尾部必须是恰好 ${FOOTER_BYTES} 字节：实际 ${buf.length} 字节`);
  }
  return {
    indexOffset: buf.readBigUInt64BE(0),
    chunkCount: buf.readBigUInt64BE(8),
    plaintextLength: buf.readBigUInt64BE(16),
  };
}

/**
 * 推导某一块的 nonce：`noncePrefix(4) || 块序号(8, 大端)`（规格 D4）。
 *
 * **序号必须来自读取位置**，绝不能来自记录里自称的序号（C20 / R2）。跨文件唯一性靠
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
 * 末块标记是**截断检测**的依据：攻击者丢掉末块、并把尾部里的 `chunkCount` 改小之后，
 * 新的「末块」会带着 `more` 的 AAD 去认证，而它当初是用 `last` 建的 ⇒ 认证失败。
 * 反过来，把非末块当末块认证同样失败。位置进 AAD 则挡住了「整体调换两条记录」。
 *
 * 因此写入端**必须**在末块上打 `last`——这不是可选的元数据，而是整条链路的承重件
 * （写入端的钉法见 `tests/unit/asset/chunk-cipher.test.ts` 的「末块标记」用例）。
 *
 * **注意**：AAD 的地位与索引里的「自称序号」无关。位置来自**调用方按读取顺序给出的**
 * 序号，不是从记录里读出来的（R2 第 4 条）。
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
    assertUint64(entry.index, 'index');
    const at = i * INDEX_ENTRY_SIZE;
    buffer.writeBigUInt64BE(entry.offset, at + INDEX_OFFSET_OFFSET);
    buffer.writeUInt32BE(entry.ciphertextLength, at + INDEX_LENGTH_OFFSET);
    buffer.writeBigUInt64BE(entry.index, at + INDEX_SELF_INDEX_OFFSET);
    // 保留区（字节 20..23）保持全 0。`Buffer.alloc` 已经保证了这一点，这里写出来是为了让
    // 「保留 = 0 是格式的一部分」在代码里可见，而不是靠分配方式偶然成立。
    // 终点的写法是 `at + INDEX_ENTRY_SIZE`（= 这条记录的末尾），而不是「起点 + 一个宽度常量」：
    // 保留区**到记录末尾为止**，这个事实由 `INDEX_ENTRY_SIZE` 表达，不需要第二个数字。
    buffer.fill(0, at + INDEX_RESERVED_OFFSET, at + INDEX_ENTRY_SIZE);
  });
  return buffer;
}

/**
 * 解析块索引。
 *
 * `buf` 的长度**必须**是 {@link INDEX_ENTRY_SIZE} 的整数倍：多出来的尾巴意味着
 * 调用方读错了区间（或制品被截断），静默忽略会把一次结构损坏读成一份好数据。
 *
 * ### 这是**写入端/编解码层**的解析器，它有意**不做**这些校验（属于 Task 3 的读取端）
 *
 * - **不校验 `offset` 单调递增、不校验各区间落在 `[0, indexOffset)` 内**。本函数只负责
 *   「24 字节 → 记录」，一份自相矛盾的索引在这里仍然是「结构合法」的；拒绝它是读取端的
 *   责任（Task 3 的 Step 6 逐字写着这条），因为只有读取端同时掌握文件长度与尾部。
 * - **不校验 `entry.index === 该记录在数组里的位置`**。理由完全相同：位置是**读取顺序**
 *   的事实，而不是解码顺序的事实——`decodeIndex` 拿到的可能只是索引的一段。C20 的
 *   `record.index === position` 校验（以及「位置 P 处的记录自称序号 Q」这条错误信息）
 *   在读取端做，本函数只保证那个字段**被解出来**（R2）。
 *
 * 把这两条写在这里，是为了让「谁负责校验什么」不含混：解码层越权校验，读取端就会
 * 以为自己不必校验。
 */
export function decodeIndex(buf: Buffer): IndexEntry[] {
  if (buf.length % INDEX_ENTRY_SIZE !== 0) {
    throw new Error(`块索引长度必须是 ${INDEX_ENTRY_SIZE} 的整数倍：实际 ${buf.length} 字节`);
  }
  const entries: IndexEntry[] = [];
  for (let at = 0; at < buf.length; at += INDEX_ENTRY_SIZE) {
    entries.push({
      offset: buf.readBigUInt64BE(at + INDEX_OFFSET_OFFSET),
      ciphertextLength: buf.readUInt32BE(at + INDEX_LENGTH_OFFSET),
      index: buf.readBigUInt64BE(at + INDEX_SELF_INDEX_OFFSET),
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
