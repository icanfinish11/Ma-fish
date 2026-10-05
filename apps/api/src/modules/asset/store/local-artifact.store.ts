import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { uuidv7 } from '@vca/shared';
import { ArtifactTooLargeError, type ArtifactStore } from './artifact-store.port.js';

/**
 * 键的形状：**只接受 UUIDv7**（C4）。
 *
 * 这不是「格式洁癖」，而是本类唯一的注入面。`getRange` / `stat` / `delete` 直接吃字符串键，
 * 而键将来会来自 URL（Task 8 的下载路径）。`..` 或绝对路径一旦被拼进 `join(root, key)`，
 * 存储端口就变成了任意文件读写的原语——**在进入 fs 之前**拒绝，比在调用方逐个记得校验可靠。
 *
 * 版本位固定为 7、变体位为 `8|9|a|b`：`uuidv7()`（`@vca/shared`）的输出恒满足，
 * 其它 UUID 版本（v4 等）不满足——它们不是本存储的键。
 */
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 本地加密卷上的制品存储（P1 / Task 1）。
 *
 * ## 键与目录布局
 *
 * 键是 UUIDv7，路径是 `<root>/<前2位>/<次2位>/<完整键>`。分片是为了避免「单目录十万文件」：
 * 两级各 256 个目录，天然把写入摊开，且 UUIDv7 前缀含时间戳 ⇒ 同一时刻的写入落在同一小目录，
 * 对文件系统与将来的备份都友好。
 *
 * ## 这一层**不加密**
 *
 * 加密是 Task 2/3 的事，通过 `putStream` 的 `Readable` 串一个 `Transform` 接入
 * （设计文档 D1「加密即入库」）。因此本类今天写下去的是**调用方给的字节**——
 * Task 1 的调用方是上传管线，Task 5 起会是分块加密器。这里不替调用方做任何假设：
 * 它不解析内容、不看 magic bytes、不生成文件名（键与内容无关）。
 *
 * ## 为什么不写临时文件
 *
 * 「先写 `.tmp` 再 `rename`」是原子落盘的常见做法，但它**违反 C21 的结构性要求**：
 * 在那个窗口里，明文以第二个文件的形式存在于文件系统上。这里的取舍是
 * 「对象可能写到一半就中止」——由「中止即删除」+「超限即拒绝」两条不变式兜住，
 * 而不是靠 rename 的原子性。`flags: 'wx'` 让键碰撞响亮地失败，而不是静默覆盖一个已有对象。
 */
export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string) {}

  async putStream(source: Readable, opts: { maxBytes: number }): Promise<{ key: string; bytes: number }> {
    const key = uuidv7();
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });

    let bytes = 0;
    // 计量与限额放在同一个 Transform 里：既数得准（每个字节只经过一次），
    // 又能在超限的那一刻**中止上游**（pipeline 会 destroy source），
    // 而不是「先把剩下的读完再判断」——那等于把超限上传完整接收一遍。
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        bytes += chunk.length;
        if (bytes > opts.maxBytes) {
          callback(new ArtifactTooLargeError(opts.maxBytes));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, counter, createWriteStream(target, { flags: 'wx' }));
    } catch (error) {
      // 中止即删除：不留半个对象，也不留任何临时文件（本实现从不创建临时文件）。
      //
      // **但 `EEXIST` 例外**：那个错误说明目标键的位置上**已经有别人的对象**
      // （`flags: 'wx'` 的全部意义就是把键碰撞变成响亮失败，而不是静默覆盖）。
      // 此时删掉「已写入的部分」等于删掉那个已有对象——一次写入失败会升级成丢一份制品。
      // 概率上可忽略（UUIDv7 有 62 位随机位），但失败形态太贵，因此按错误类型放行。
      // 其它错误（源流出错、磁盘写满…）下这个文件要么是我们建的、要么压根没建成，
      // `force: true` 让两种情况都不掩盖原始错误。
      if ((error as { code?: unknown }).code !== 'EEXIST') {
        await rm(target, { force: true });
      }
      throw error;
    }

    return { key, bytes };
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    const target = this.pathFor(key);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endInclusive) ||
      start < 0 ||
      endInclusive < start
    ) {
      throw new RangeError(`非法区间：[${start}, ${endInclusive}]`);
    }

    const length = endInclusive - start + 1;
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead !== length) {
        // 短读 = 密文被截断（或键指向了别的东西）。此处**必须**响亮：
        // Task 3 的读取器按块长度算区间，静默回短缓冲会把截断读成合法数据。
        throw new Error(`制品读取不足：区间 [${start}, ${endInclusive}] 期望 ${length} 字节，实际 ${bytesRead}`);
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async stat(key: string): Promise<{ bytes: number }> {
    const info = await stat(this.pathFor(key));
    return { bytes: info.size };
  }

  async delete(key: string): Promise<void> {
    // `force: true` 让「对象不存在」不是错误——`putStream` 自己会删一次，
    // multer 的 `_removeFile` 可能再删一次（实测会发生），幂等是这里的契约。
    await rm(this.pathFor(key), { force: true });
  }

  /** 键 → 绝对路径。**唯一**把键拼进路径的地方，因此也是唯一做键校验的地方。 */
  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`非法的制品键（只接受 UUIDv7）：${key}`);
    }
    return join(this.rootDir, key.slice(0, 2), key.slice(2, 4), key);
  }
}
