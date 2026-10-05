import { fileTypeFromBuffer } from 'file-type';
import type { EncryptedArtifactReader } from '../store/random-access-reader.js';

/**
 * 归档类型嗅探（P1 / Task 4；设计文档 D7）。
 *
 * ## 判定条件逐字来自设计：`ext === 'tar.gz' || mime === 'application/gzip'`
 *
 * 预检实测 `file-type` 对 gzip 压缩的 tar 返回 `{ ext: 'tar.gz', mime: 'application/gzip' }`，
 * **不是** `'gz'`。写成 `=== 'gz'` 的后果不是「偶尔误拒」，而是：
 *
 * 1. **100% 的合法 tar.gz 上传被拒**（生产上立刻炸）；
 * 2. 两个 tar.gz 样本都在嗅探处短路 ⇒ **整条 tar.gz 校验路径一次都不执行**，
 *    而「恶意样本期望拒绝」的用例**照样全绿**——测试给出的是虚假的信心。
 *
 * 因此本条件的判别力由**两条**用例共同承担：依赖契约用例（直接断言 `file-type` 的返回值）
 * 与合法 tar.gz 的**接受**用例。缺任何一条，这个错误都能在绿灯下存活。
 *
 * ## 只读前 4100 字节
 *
 * `file-type` 的官方建议是至少给它 4100 字节；而 zip 的判定其实只看前 4 字节
 * （探针实测：给 4 字节也返回 `zip`）。因此这里读 `min(4100, 明文长度)`，
 * 既不整份读进内存，也不因为「前缀太短」把类型判成未知。
 *
 * ## C11
 *
 * 结果里只出现**类型名**（`ext / mime`），不出现任何归档内容字节。
 */

/** 嗅探读取的字节数上限（`file-type` 的官方建议值）。 */
export const SNIFF_BYTES = 4100;

/** 本平台接受的归档类型（设计 D6：仅 zip 与 tar.gz）。 */
export type ArchiveKind = 'zip' | 'tar.gz';

export interface SniffResult {
  readonly kind: ArchiveKind | 'unknown';
  /** 给拒绝理由用的「认出了什么」：`ext / mime`，或空制品 / 未识别。 */
  readonly detected: string;
}

/**
 * 读制品的头部若干字节，用 magic bytes 判定归档类型。
 *
 * **不抛错**：类型不认识是一种**判定结果**（调用方据此拒绝），不是异常路径。
 * 只有「读制品本身失败」才会把错误抛出去——那属于存储/解密层的问题。
 */
export async function sniffArchive(reader: EncryptedArtifactReader): Promise<SniffResult> {
  const length = Math.min(SNIFF_BYTES, reader.plaintextLength);
  // 0 字节制品：没有 magic bytes 可看，也没有「末块」可认证（几何允许 0 块制品，见 Step 0b 第 4 条）。
  // 这里直接给结论、**一个字节都不读**。
  if (length === 0) return { kind: 'unknown', detected: '空制品（0 字节）' };

  const detected = await fileTypeFromBuffer(await readHead(reader, length));
  if (detected === undefined) return { kind: 'unknown', detected: 'file-type 未识别' };

  const description = `${detected.ext} / ${detected.mime}`;
  if (detected.ext === 'tar.gz' || detected.mime === 'application/gzip') {
    return { kind: 'tar.gz', detected: description };
  }
  if (detected.ext === 'zip' || detected.mime === 'application/zip') {
    return { kind: 'zip', detected: description };
  }
  return { kind: 'unknown', detected: description };
}

/** 用 yauzl 的 `read` 契约把明文 `[0, length)` 填进一个预分配的缓冲区（不做整段拼接）。 */
async function readHead(reader: EncryptedArtifactReader, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  await new Promise<void>((resolve, reject) => {
    reader.read(buffer, 0, length, 0, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
  return buffer;
}
