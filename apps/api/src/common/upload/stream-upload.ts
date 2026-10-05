import type { Readable } from 'node:stream';

/**
 * 把 multipart 的一个 part **直接**流给写入端（P1 / Task 1）。
 *
 * ## 这个文件解决什么问题
 *
 * 实测（`.superpowers/.../evidence/t1-probe-multipart.txt`）：
 *
 * - `FileInterceptor('file')` 的默认存储（multer `memoryStorage`）会把**整份文件**攒进
 *   `req.file.buffer` —— 16 MiB 的上传，处理器拿到的 buffer 就是 16 MiB，
 *   `arrayBuffers` 峰值增量是 body 的 1.49~2.0 倍。1 GB 的上传因此不可能。
 * - 换成**自定义 storage engine** 后，multer 把 busboy 的 part 流原样交给
 *   `_handleFile(req, file, cb)` 的 `file.stream`：实测 engine 在客户端发出请求后 44ms
 *   就收到了第一块，而客户端还在继续发。这条路径既不落临时文件，也不整份进内存，
 *   正是 C21 要的形状。
 *
 * 于是这里提供的就是那个 storage engine：**把 `file.stream` 交给 sink**，
 * 由 sink 决定写到哪儿（Task 1 是本地制品卷，Task 2 起会是分块加密器）。
 *
 * ## 为什么 sink 是一个**本地**接口，而不是直接 import `ArtifactStore`
 *
 * 架构约束（C5 / `.dependency-cruiser.cjs` 的 `no-cross-module-internals`）禁止平台层
 * （`common/`）import 功能模块（`modules/asset/`）的内部文件。本文件的职责是
 * 「multipart → 流式写入」这件事本身，与「制品」无关；把 sink 声明成本地接口，
 * 依赖方向就正过来了：`modules/asset` → `common/upload`（允许），反向不允许。
 * 结构类型让 `ArtifactStore` 天然满足 `UploadSink`，不需要任何适配代码。
 *
 * ## 上限在哪一层生效（实测，两条都在，但**只有一条能决定状态码**）
 *
 * - HTTP 层：模块配置把 `limits.fileSize` 设成同一个上限值。multer 的实测行为是
 *   返回 `MulterError: LIMIT_FILE_SIZE`，Nest 的 `FileInterceptor` 把它翻成
 *   **413**（`PayloadTooLargeException`），此时**处理器不会被调用**。
 * - 存储层：`sink.putStream(..., { maxBytes })` 自己也会中止并删除已写入的部分
 *   （`ArtifactStore` 的契约）。它保证的是**无残留**，不是状态码：实测把它单独留下
 *   （去掉 HTTP 层限制）时客户端拿到的是 **500**，因为存储层中止会 destroy 上游 part 流，
 *   而 multer 先看到的是那个流错误（详见 `asset.module.ts` 的说明与
 *   `evidence/t1-mutation-imp2a-store-cap-only.txt`）。
 *
 * 结论：两个上限取**同一个**配置值，413 由 HTTP 层负责，存储层负责「绝不留残留」。
 *
 * ## 超限时已写入的部分由谁清理（实测两种情形都无残留，但机制不同）
 *
 * 实测（`t1-probe-cap.txt` / `t1-probe-cap-sequence.txt`）：
 *
 * - 引擎回调**报告成功**时，multer 会调用 `_removeFile`（带上引擎返回的键）——
 *   因此 `_removeFile` 是**必须实现**的：它的空实现在探针里留下了残留对象；
 * - 引擎回调**报告失败**时，multer 不会再调 `_removeFile`，此时清理由写入端自己负责
 *   （`putStream` 的中止即删除）。
 *
 * 两条都实现，所以「无残留」不依赖任何一条单独成立。
 */
export interface UploadSink {
  /** 流式写入；超过 `maxBytes` 或源流出错时抛错，且**不得留下任何已写入的部分**。 */
  putStream(source: Readable, opts: { maxBytes: number }): Promise<{ key: string; bytes: number }>;
  /** 按键删除；**幂等**（multer 可能对同一个对象再来一次）。 */
  delete(key: string): Promise<void>;
}

/** 上传落库后的结果：存储键与写入字节数（控制器原样回给调用方）。 */
export interface UploadedArtifact {
  key: string;
  bytes: number;
}

/**
 * multer `StorageEngine` 的**结构**形状。
 *
 * 刻意不 `import type { StorageEngine } from 'multer'`：`multer` 不是 `apps/api` 的依赖
 * （它是 `@nestjs/platform-express` 的传递依赖，pnpm 严格隔离下裸包名解析不到），
 * 而为一个类型新增一条运行时依赖不值得。`MulterOptions.storage` 在 Nest 的类型里
 * 本来就是 `any`，因此结构化声明既够用，又不会随包的内部路径漂移。
 */
export interface MultipartStorageEngine {
  _handleFile(
    req: unknown,
    file: { stream: Readable },
    callback: (error: Error | null, info?: UploadedArtifact) => void,
  ): void;
  _removeFile(req: unknown, file: { key?: unknown }, callback: (error: Error | null) => void): void;
}

/**
 * 造一个「边收边写」的 multer storage engine。
 *
 * `_handleFile` **不 await** 自己的 promise，而是把结果交给 multer 的回调：
 * multer 的中间件不是 async 的，它靠这个回调继续（并据此判断「还有没有未完成的写入」——
 * 永远不回调会让请求**挂住**，这正是本函数必须保证「无论如何都回调一次」的原因）。
 */
export function createStreamingStorage(sink: UploadSink, options: { maxBytes: number }): MultipartStorageEngine {
  const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

  return {
    _handleFile(_req, file, callback): void {
      void sink.putStream(file.stream, { maxBytes: options.maxBytes }).then(
        (stored) => callback(null, stored),
        (error: unknown) => callback(asError(error)),
      );
    },

    _removeFile(_req, file, callback): void {
      // 没有键 = 这次写入根本没走到「有对象」那一步（引擎报错、或请求在中途被拒）。
      // 这不是错误，也不能去猜一个键来删——直接结算。
      const key = typeof file?.key === 'string' && file.key !== '' ? file.key : undefined;
      if (!key) {
        callback(null);
        return;
      }
      void sink.delete(key).then(
        () => callback(null),
        (error: unknown) => callback(asError(error)),
      );
    },
  };
}
