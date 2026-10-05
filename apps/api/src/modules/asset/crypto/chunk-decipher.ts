import { createDecipheriv } from 'node:crypto';
import { TAG_BYTES, buildAad, deriveNonce, type ArtifactHeader, type IndexEntry } from './artifact-format.js';
import type { KeyRing } from './key-ring.js';

/**
 * 分块解密器（P1 / Task 3）。
 *
 * ## C20：块序号的**唯一**事实来源是读取位置
 *
 * `position` 由**调用方按读取顺序**给出，绝不取自记录里自称的序号：
 *
 * - nonce = `noncePrefix(8) || BE32(position)`（规格 D4；I3 把拆分由 `4+8` 改成 `8+4`）；
 * - AAD = `` `${fileId 十六进制}:${position}:${last|more}` ``（规格 D4）；
 * - `isLast` 由读取端判定为 `position === 索引条数 - 1`。
 *
 * 预检实测的失效形态：若改用索引记录里自称的序号，攻击者把两条存储记录**整体调换**，
 * AAD 的输入随之调换 ⇒ **认证通过、明文被静默重排**，而且没有任何一层会报错。
 * 因此位置是承重的输入，索引里的 `entry.index` 只用于**比对**。
 *
 * ## 与 `ChunkEncryptor` 的分工
 *
 * 本类只读。它不解析制品布局（那是 `random-access-reader.ts` 的事）、不做
 * 「尾部自称的总量是否自洽」那三条完整性校验（那需要同时掌握头 / 索引 / 尾部 / 文件长度，
 * 见读取端）。它的输入是**已经解析好的**头与索引，加上一段段记录字节。
 *
 * ## 记录字节的形状（与 brief 的一处命名澄清）
 *
 * `decryptAt` 的第二个参数是**整条记录**：`密文 ‖ tag(16)`。brief 把它写作
 * `ciphertext`，但只有一个 Buffer 参数时，tag 必须包含在内——本实现因此在形参上叫
 * `record`，并在方法注释里逐字写明，免得调用方只交出裸密文（那会让 `setAuthTag`
 * 拿到一个长度不对的切片）。
 *
 * ## 密钥材料（C11）
 *
 * 报错只出现 **keyId、位置、长度、序号** 这些非机密量；密钥字节与明文一个都不出现在
 * 错误消息里。`keyFor` 的返回值是环给的拷贝，本类不改写它。
 */
export class ChunkDecipher {
  private readonly key: Buffer;
  private readonly header: ArtifactHeader;
  private readonly index: readonly IndexEntry[];

  /**
   * @param keyRing 密钥环。构造期就按**头里的 `keyId`**（不可信输入）取键：
   *   取不到 ⇒ `keyFor` 抛错，**绝不回退**到活动键（D5）。fail-fast 在这里与
   *   `ChunkEncryptor` 同款：等第一个块解不开才发现密钥错了，报错会指向「密文被篡改」，
   *   而真实原因是密钥选错。
   * @param header 已解析的制品头（提供 `fileId` / `noncePrefix`）。
   * @param index 已解析的块索引，**顺序即位置**。
   */
  constructor(keyRing: KeyRing, header: ArtifactHeader, index: IndexEntry[]) {
    this.key = keyRing.keyFor(header.keyId);
    this.header = header;
    this.index = index;
  }

  /**
   * 解密**位置 `position`**（由调用方按读取顺序给出）的那一块。
   *
   * @param position 块序号，取自读取顺序。**不是**记录里自称的序号。
   * @param record 该块的**整条记录**：`密文 ‖ tag(16)`。
   */
  decryptAt(position: number, record: Buffer): Buffer {
    const entry = this.index[position];
    if (entry === undefined) {
      throw new Error(`第 ${position} 块不存在：索引里只有 ${this.index.length} 条记录`);
    }
    /**
     * **C20 的核心**：位置是唯一的事实来源，记录里的自称序号只用于**比对**。
     *
     * 少了这一次比对，「整体调换两条记录」就会在下面**认证通过**：在「用记录自称的序号
     * 推导 nonce/AAD」的解读下，位置 0 拿到的记录自称 1，于是用 nonce(1)/AAD(1) 去认证
     * ——认证成功、返回的却是第 1 块的明文，**明文被静默重排且没有任何一层报错**。
     * 这条错误信息被刻意写成「位置 P 处的记录自称序号 Q」：两个数都要在，否则排查时
     * 看不出是「记录放错了位置」还是「位置读错了」。
     */
    if (entry.index !== BigInt(position)) {
      throw new Error(
        `位置 ${position} 处的记录自称序号 ${entry.index}：块序号必须取自读取位置，` +
          '信任记录里自称的序号会让「整体调换两条记录」通过认证并把明文静默重排（C20）',
      );
    }
    /**
     * 记录长度必须与索引声明一致：读取端按索引切片，切错了（或索引被改过）时
     * 必须在这里响亮，而不是把一个长度不对的切片交给 `setAuthTag`
     * ——后者报的是 `Invalid authentication tag length`，看不出与索引有关。
     */
    const expectedBytes = entry.ciphertextLength + TAG_BYTES;
    if (record.length !== expectedBytes) {
      throw new Error(
        `第 ${position} 块的记录长度不符：索引声明 ${entry.ciphertextLength} 字节密文 + ` +
          `${TAG_BYTES} 字节 tag = ${expectedBytes} 字节，实际 ${record.length} 字节`,
      );
    }

    try {
      /** 末块标记由**读取端**按位置判定（写入端在末块上打 `last`，见 `ChunkEncryptor`）。 */
      const isLast = position === this.index.length - 1;
      const cipher = createDecipheriv('aes-256-gcm', this.key, deriveNonce(this.header.noncePrefix, position));
      cipher.setAAD(buildAad(this.header.fileId, position, isLast));
      cipher.setAuthTag(record.subarray(record.length - TAG_BYTES));
      return Buffer.concat([cipher.update(record.subarray(0, record.length - TAG_BYTES)), cipher.final()]);
    } catch (error) {
      // 报错只带**位置**与原因类别：密钥字节与明文一个都不进消息（C11）。
      // `cause` 保留原始错误便于排查（它同样不含密钥材料）。
      throw new Error(`第 ${position} 块认证失败（密文被篡改，或该块被当作别的块/末块解读）`, { cause: error });
    }
  }

  /**
   * 顺序读取全量明文：`readRecord(position)` 由调用方按 0..n-1 **依次**取出记录字节。
   *
   * 0 块（空制品）⇒ 直接返回 0 字节，**一个块都不读**（R4）。
   */
  async decryptAll(readRecord: (position: number) => Promise<Buffer>): Promise<Buffer> {
    const blocks: Buffer[] = [];
    for (let position = 0; position < this.index.length; position++) {
      blocks.push(this.decryptAt(position, await readRecord(position)));
    }
    return Buffer.concat(blocks);
  }
}
