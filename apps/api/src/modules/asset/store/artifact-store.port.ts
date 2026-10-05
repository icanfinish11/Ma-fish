import type { Readable } from 'node:stream';

/**
 * 制品存储端口（P1 / Task 1）。
 *
 * ## 为什么是「端口 + 本地实现」而不是直接写文件
 *
 * 设计文档 §3.2 把 `asset` 模块的对外接口定为 `store / readMetadata / checkAccess /
 * signDownloadUrl`，存储是其中最底部的一层。它今天只有一个实现（本地加密卷），
 * 但**有两个已确知的第二个调用方**，因此接口不是投机抽象：
 *
 * 1. Task 2/3 的加解密层：`putStream` 收一个 `Readable`，因此加密器可以作为一个
 *    `Transform` 直接串在中间——上传管线不需要为「加密」改造一次；
 * 2. Task 3/4 的归档校验：zip 的中央目录在文件**末尾**，校验器需要一个**按字节区间**
 *    的随机访问读取器（`getRange`），而不是把整份制品读进内存。
 *
 * ## `putStream` 的两条硬约束（C21）
 *
 * - **绝不缓冲整份流**：实现必须边收边写。失效形态是「1GB 上传把内存吃光」。
 * - **绝不写临时文件**：语义上「写入的位置就是制品本身」。失效形态是
 *   「明文短暂地以第二个文件的形式存在过」——那正是 C21 要结构性排除的东西。
 *
 * 控制这两条的是 `tests/unit/asset/local-store.test.ts` 的两条直判用例
 * （「写入在源流结束前已落盘」「写入期间目录里至多一个文件」）。
 */
export interface ArtifactStore {
  /**
   * 流式写入，返回存储键与写入字节数。
   *
   * 超过 `maxBytes`、或源流出错时：**中止写入、删掉已写入的部分**，然后抛错
   * （超限时抛 {@link ArtifactTooLargeError}）。中途失败绝不留下半个对象，
   * 也绝不算作写入成功。
   */
  putStream(source: Readable, opts: { maxBytes: number }): Promise<{ key: string; bytes: number }>;

  /**
   * 按字节区间读取（**闭区间**：`[start, endInclusive]`）。
   *
   * 解密读取器需要随机访问（zip 先读尾部中央目录），因此这里不做任何「顺序读」的假设。
   * 区间超出对象末尾时**抛错**而不是回一个短缓冲：短读意味着密文被截断，
   * 静默继续会把一次截断读成一段合法数据。
   */
  getRange(key: string, start: number, endInclusive: number): Promise<Buffer>;

  /** 对象字节数。对象不存在时抛错（调用方据此判定「制品缺失」，而不是「0 字节」）。 */
  stat(key: string): Promise<{ bytes: number }>;

  /** 删除对象。**幂等**：对象不存在时静默返回（multer 的 `_removeFile` 会与自身清理竞争）。 */
  delete(key: string): Promise<void>;
}

/**
 * `ArtifactStore` 的注入令牌。
 *
 * 用 `Symbol` 而不是字符串：Nest 的令牌空间是平的，字符串令牌会与任何同名提供者相撞，
 * 而 `Symbol` 只可能通过 import 同一个常量来共享（与 `db/redis.module.ts` 的 `REDIS` 同款）。
 */
export const ARTIFACT_STORE = Symbol('VCA_ARTIFACT_STORE');

/**
 * 超过 `maxBytes` 时 `putStream` 抛出的错误。
 *
 * ## 这个错误**不要**映射成 413（据实记载：映射写过、删掉了）
 *
 * 413 的**唯一**来源是 HTTP 层的 `limits.fileSize` → `MulterError: LIMIT_FILE_SIZE`
 * → Nest `FileInterceptor` 的 `transformException`。调用方**无法**把本错误变成 413：
 * 存储层中止会 destroy 上游 part 流，multer 在 `process.nextTick` 上先收到那个**流错误**
 * 并置位 `errorOccured`，此后交回去的 `HttpException` 被直接忽略——实测只留存储层上限时
 * 客户端拿到的是 **500**（`evidence/t1-mutation-imp2a-store-cap-only.txt`），
 * 机制详见 `modules/asset/asset.module.ts`。
 *
 * 因此单独一个类型不是为了「回 413」（按消息匹配会把一次文案改动变成一次状态码回归），
 * 而是让**日志与测试**能分辨「超限中止」与「源流出错 / 磁盘写失败」这两种中止原因。
 *
 * 与 multer 的关系：HTTP 层的 `limits.fileSize` 与这里的 `maxBytes` 取**同一个**配置值，
 * 因此超限上传在真实链路上总是先被 multer 拦下（回 413）。这一层仍然必须自己成立
 * ——它是存储端的不变式，不能依赖调用方先拦过一遍（失效形态：绕过 HTTP 层直接调用时留残留）。
 */
export class ArtifactTooLargeError extends Error {
  /** 触发本次中止的上限（字节），便于日志与测试断言。 */
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`制品超过上限：${limitBytes} 字节`);
    this.name = 'ArtifactTooLargeError';
    this.limitBytes = limitBytes;
  }
}
