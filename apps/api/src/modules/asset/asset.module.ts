import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import type { Env } from '../../config/env.schema.js';
import { createStreamingStorage } from '../../common/upload/stream-upload.js';
import { AssetController } from './asset.controller.js';
import { ARTIFACT_STORE, type ArtifactStore } from './store/artifact-store.port.js';
import { LocalArtifactStore } from './store/local-artifact.store.js';

/**
 * 制品存储的提供者模块。
 *
 * ## 为什么它必须是一个**独立**模块（而不是 `AssetModule` 里的一条 provider）
 *
 * `MulterModule.registerAsync({ inject: [...] })` 的工厂跑在**那个动态模块自己的**
 * 注入器里：它只看得见自己的 `imports` 与全局模块，**看不见** import 它的那个模块的
 * 提供者（这是 Nest 的解析规则，不是配置疏漏）。把 `ARTIFACT_STORE` 留在 `AssetModule`
 * 里，`inject: [ARTIFACT_STORE]` 会在启动期抛「Nest can't resolve dependencies」。
 *
 * 于是把它拆成一个只提供存储的模块，`AssetModule` 与那个动态模块**同时** import 它——
 * Nest 对静态模块按类缓存实例，两边拿到的是**同一个**存储对象。
 * （这一点由 `tests/integration/asset/upload-stream.test.ts` 间接钉住：它用
 * `app.get(ARTIFACT_STORE)` 读回上传的字节，若上传走的是另一个实例/另一个目录，读回就是空。）
 */
@Module({
  providers: [
    {
      provide: ARTIFACT_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ArtifactStore =>
        // 目录来自环境变量（C10），不在这里回退到任何默认值：没有 `ARTIFACT_STORE_DIR`
        // 时引导期就已经拒绝了（schema 必填），这里能拿到的必然是显式配置过的值。
        new LocalArtifactStore(config.get('ARTIFACT_STORE_DIR', { infer: true })),
    },
  ],
  exports: [ARTIFACT_STORE],
})
export class AssetStoreModule {}

/**
 * 制品模块（P1 / Task 1）。
 *
 * 上传管线是**一条**：`FileInterceptor`（解析 multipart）→ 自定义 storage engine
 * （`createStreamingStorage`）→ `ArtifactStore.putStream`（边收边写）。
 * 中间没有任何落盘缓冲，也没有「整份进内存」的分支——那两条是 C21 结构性排除的东西。
 *
 * ## 为什么这里**没有**「把 `ArtifactTooLargeError` 翻成 413」的适配层（变异探针 IMP2a 的结论）
 *
 * 写了，然后**删掉了**——它是一段永远执行不到、也不改变结果的代码。实测：
 * 把 HTTP 层的 `limits.fileSize` 去掉（只留存储层上限）并保留那个映射，客户端拿到的
 * 仍然是 **500**，不是 413（`evidence/t1-mutation-imp2a-store-cap-only.txt`）。
 *
 * 机制（由代码路径得出，测量结果与之一致）：存储层中止时 `pipeline` 会 **destroy 上游**，
 * 而 Node 的 `process.nextTick` 队列先于 promise 微任务队列执行——于是 multer 的
 * `fileStream.on('error')` 先带着**流错误**调用 `abortWithError`，我们把 HttpException
 * 交回去时 `errorOccured` 已是 true，它被直接忽略。
 *
 * 因此 413 这条路径**只有一个**来源：`limits.fileSize` → `MulterError: LIMIT_FILE_SIZE`
 * → Nest `FileInterceptor` 的 `transformException` → `PayloadTooLargeException`（实测）。
 * 两个上限取**同一个**配置值，所以这层限制不可能「忘了配」；真要出现「存储层上限更小」
 * 的配置，需要的是让 `putStream` 中止时**不销毁上游**（或把映射放到能赢过流错误的位置），
 * 而不是留一段看起来在兜底、实际不生效的代码。
 */
@Module({
  imports: [
    AssetStoreModule,
    MulterModule.registerAsync({
      imports: [AssetStoreModule],
      inject: [ARTIFACT_STORE, ConfigService],
      useFactory: (store: ArtifactStore, config: ConfigService<Env, true>) => {
        // **一个**上限值同时给两层：HTTP 层（`limits.fileSize`，唯一的 413 来源）与存储层
        // （`putStream({ maxBytes })`，中止并删除已写入的部分——它保证的是「无残留」，
        // 不是状态码）。两份数值迟早漂移，因此只允许有一个来源。
        const maxBytes = config.get('ARTIFACT_MAX_UPLOAD_BYTES', { infer: true });
        return {
          // `ArtifactStore` 在**结构上**就满足 `UploadSink`（putStream + delete），
          // 因此不需要任何适配器——这正是把 sink 声明成本地接口的收益。
          storage: createStreamingStorage(store, { maxBytes }),
          limits: { fileSize: maxBytes },
        };
      },
    }),
  ],
  controllers: [AssetController],
  exports: [AssetStoreModule],
})
export class AssetModule {}
