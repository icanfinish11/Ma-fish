import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import type { Env } from '../../config/env.schema.js';
import { createStreamingStorage } from '../../common/upload/stream-upload.js';
import { AssetController } from './asset.controller.js';
import { AssetService } from './asset.service.js';
import { ARTIFACT_STORE, type ArtifactStore } from './store/artifact-store.port.js';
import { LocalArtifactStore } from './store/local-artifact.store.js';

/**
 * 制品存储**与接入服务**的提供者模块。
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
 *
 * ## Task 5 起：`AssetService` 也住在这里，理由与存储提供者**完全相同**
 *
 * multer 的存储引擎需要一个**会加密的 sink**（`createStreamingStorage` 的入参），
 * 而那个 sink 就是 `AssetService`（它的 `putStream` 立即加密写入、`delete` 是唯一的
 * 清理出口）。它必须能被上面那个动态模块的工厂注入 ⇒ 必须在动态模块自己的 `imports`
 * 里可见 ⇒ 只能住在被 import 的这个静态模块里，不能住在 `AssetModule`。
 *
 * 模块名里那个 "Store" 因此比实际职责窄了一点；保留名字是**刻意的**：改名的收益只是名字
 * 好看一点，代价是让 Task 1 那份「为什么必须独立成模块」的记载与代码对不上号。
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
    // 加密即入库的接入服务：`putStream`（落盘的是密文）+ `finalize`（校验）+ `delete`（清理）。
    AssetService,
  ],
  exports: [ARTIFACT_STORE, AssetService],
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
      inject: [AssetService, ConfigService],
      useFactory: (assets: AssetService, config: ConfigService<Env, true>) => {
        // **一个**上限值同时给两层：HTTP 层（`limits.fileSize`，唯一的 413 来源）与存储层
        // （`putStream({ maxBytes })`，中止并删除已写入的部分——它保证的是「无残留」，
        // 不是状态码）。两份数值迟早漂移，因此只允许有一个来源。
        //
        // Task 5 起这个上限的含义是**明文**字节数（用户上传的字节），而落盘的是密文：
        // 换算与「超限即中止上游」都在 `AssetService.putStream` 里，因为只有它同时看得见
        // 明文与制品两个量。HTTP 层这一份仍然是**明文**口径，两者因此仍然一致。
        const maxBytes = config.get('ARTIFACT_MAX_UPLOAD_BYTES', { infer: true });
        return {
          // `AssetService` 在**结构上**就满足 `UploadSink`（putStream + delete），
          // 因此不需要任何适配器——这正是把 sink 声明成本地接口的收益。
          // 它落盘的是**密文**（加密即入库，D1）：Task 1 时这里直接是存储本身。
          storage: createStreamingStorage(assets, { maxBytes }),
          /**
           * 两类上限：`fileSize` 管**文件本身**，另外四条管**请求形状**。
           *
           * `fileSize` 取 `maxBytes` —— 它是 413 的**唯一**来源（见类注释）。
           *
           * 另外四条是**防御纵深**，不是主要控制：按设计 §3.1 的部署图，请求形状的
           * 第一层限制在 Nginx（`client_max_body_size` / 请求头与连接数限制）。这里仍然
           * 必须自己成立，因为「Nginx 配好了」不是本进程能验证的性质；而**只有 `fileSize`
           * 时，字段面是无界的**：multer 会把每个文本字段追加进 `req.body`，因此
           * 「很多个小字段」是一条不吃文件上限的内存路径（实测 busboy 的默认值是
           * `fields: Infinity` / `parts: Infinity`——`lib/types/multipart.js` 第 255–264 行；
           * 连 `fieldSize` 也只是默认 1 MiB，见下）。
           *
           * 取值理由（本路由只接受**一个** zip 附件，不接受任何业务字段）：
           * - `fields: 16`：给将来可能出现的少量元数据（如 `note`）留量，但把「字段数」这条
           *   无界路径封住。**这是本节里唯一能被客户端观察到的上限**（实测：24 个 32 字节的
           *   小字段 ⇒ `LIMIT_FIELD_COUNT` ⇒ 400，而字段总量远在 `fieldSize` 与 `fileSize` 之下）；
           * - `fieldSize: 64 KiB`：单个字段值的上限（busboy 默认 1 MiB 对「一个注释」而言太宽）。
           *   实测 96 KiB 的字段 ⇒ `LIMIT_FIELD_VALUE` ⇒ 400。与 `fields` 是**两条不同**的路径
           *   （单个太大 vs 个数太多），因此都要写；
           * - `parts: 17` = `fields + files`：总数上限（实测第 18 个部分 ⇒ `LIMIT_PART_COUNT` ⇒ 400）。
           *   它是前两条的兜底：将来把 `fields`/`files` 调大而忘了这一条时，它仍然封住总量。
           *   `parts` 是**总数**（文件 + 字段），因此写成 `fields + files`——两个数字不该各写一份；
           * - `files: 1`：多给一个文件是错的，早失败比晚失败好。**据实记载：这一条在今天的
           *   客户端行为上与「没有它」无法区分**——实测带它时 busboy 报 `LIMIT_FILE_COUNT`，
           *   不带时 multer 的 `.single()` 报 `LIMIT_UNEXPECTED_FILE`，两者都是 400、都清掉第一个
           *   文件（`evidence/t1-fix1-probe-multer-limits.txt`）。留着它的理由是**接线会变**：
           *   若将来某条路由改用 `.array()`/多字段形式，`.single()` 那道拦截就没了，而这条上限
           *   仍然在（那时它才有判别力）。它不是可以顺手删掉的装饰。
           *
           * 超限的表现是 multer 的 `LIMIT_PART_COUNT` / `LIMIT_FIELD_COUNT` / `LIMIT_FIELD_VALUE` /
           * `LIMIT_FILE_COUNT` / `LIMIT_UNEXPECTED_FILE`，Nest 的 `FileInterceptor` 把它们一律翻成
           * **400**（处理器不会被调用），因此这里**不会**把「字段/形状太多」变成 413——
           * 413 只属于 `fileSize`。
           */
          limits: {
            fileSize: maxBytes,
            files: 1,
            fields: 16,
            fieldSize: 64 * 1024,
            parts: 17,
          },
        };
      },
    }),
  ],
  controllers: [AssetController],
  exports: [AssetStoreModule],
})
export class AssetModule {}
