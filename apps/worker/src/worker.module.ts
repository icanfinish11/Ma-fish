import { Module } from '@nestjs/common';
import { ConfigModule } from '@vca/api/config/config.module.js';
import { PolicyModule } from '@vca/api/common/policy/policy.module.js';
import { DbModule } from '@vca/api/db/db.module.js';
import { LedgerModule } from '@vca/api/modules/ledger/index.js';
import { NotifyModule } from '@vca/api/modules/notify/index.js';

/**
 * worker 的模块图：配置 + 数据库 + 通知（outbox 消费者与邮件端口）。
 *
 * ## 刻意**不**包含什么
 *
 * - **没有 HTTP 层**（`main.ts` 用 `createApplicationContext`）：worker 不服务请求；
 * - **没有 `RedisModule`**：会话与限流是 API 进程的事。少一个 ioredis 连接就少一个
 *   活跃句柄与一条网络依赖——worker 只需要数据库；
 * - **没有 `AppLoggerModule`**：worker 的日志量级只有「启动/停机/消费失败」三类，
 *    走 Nest 默认 logger + stderr 即可；引入 pino 会带来一套与 API 不同（无请求上下文）
 *    的配置面。这是**当下的取舍**，不是「以后也不加」：一旦 worker 需要结构化日志
 *    （例如接指标），第一件事就是把 `AppLoggerModule` 加进来，而不是另造一套。
 *
 * `ConfigModule` / `DbModule` 自己标了 `@Global()`，所以只写 `NotifyModule` 也能跑；
 * 三个都显式列出是为了让依赖方向可读（与 `NotifyModule` 里 `imports: [DbModule]` 同一理由）。
 *
 * ## 为什么经 `modules/notify/index.js` 而不是它的内部文件（Task 9 修复轮 1）
 *
 * 本文件与 `main.ts` 曾经分别深引 `…/notify.module.js`、`…/outbox.consumer.js`：
 * worker 是被**独立构建、独立部署**的那个进程，深引意味着它的编译结果取决于
 * `notify` 的内部布局。现在两者都只从 `modules/notify/index.js` 取
 * （`NotifyModule` / `OutboxConsumer`），这条边界由 `.dependency-cruiser.cjs` 的
 * `no-cross-module-internals` 守着——`apps/worker` 深引 `modules/*` 的内部文件会直接报错。
 *
 * ## 为什么这里**没有** `LedgerModule`（P2 裁定；复访触发条件在下）
 *
 * P2 的控制器裁定里曾写「P2 的结算跑在 worker 里」，**这句话不成立**：P2 不交付任何
 * 业务状态机（C29），因此 P2 里**没有任何 worker 侧的账本写者**。把 `LedgerModule`
 * 放进这个 `imports` 会是「一个零调用方的模块进了 worker 的依赖图」（C16）——
 * 账本在 P2 里只被 api 侧的管理员额度发放路由与测试调用。P2 计划据此明确不改本文件。
 *
 * 但 worker 的**运行期角色校验**照旧在 P2 补上了（`main.ts` 里 `assertRuntimeDbRole`，
 * 设计 §14 点名它是 P1 的欠账）：worker 与 api 共用同一个 `DATABASE_URL` 契约与同一个库，
 * 「账本 append-only 在这条连接上是不是空操作」这个问题它今天就该回答。
 *
 * ## 复访触发条件**已落地**（P3 / Task 5；此前的版本写的是「条件还没到」）
 *
 * 本文件此前逐字记着：「**复访触发条件：worker 第一次写账本时（P3 结算），同一次改动里必须**
 * **(a) `imports` 加 `LedgerModule`，(b) 加对账（不变式 #2）的周期执行者（计划 D11）。**
 * 两条必须一起做，因为它们共享同一个理由：worker 是唯一能**自动**动账本的进程——
 * 一旦它开始写账本，没人周期性对账就意味着不变式 #2 又回到了「声明了但未强制」。」
 *
 * **P3 / Task 5 兑现了那两条**：(a) 上面的 `imports` 加了 `LedgerModule`；
 * (b) `main.ts` 把 `ledger-reconcile`（`LedgerReconciliationService.reconcilePerAccount`
 * + `isPerAccountClean`）挂进 `runWorker` 的 `tasks`，每 `RECONCILE_INTERVAL_MS` 一次。
 *
 * **顺序上的一点说明（据实）**：那两条触发条件写的是「worker 第一次**写**账本时」，
 * 而 Task 5 交付的周期对账**只读**账本（P2 的划界：对账的语义是**发现**，不是修复）。
 * 提前落地它的理由不是「条件到了」，而是**这一条读法需要索引与判据都先存在**：
 * 逐账户判据（`reconcilePerAccount`）与 `entries(account_id)` 索引是同一次落地的
 * （D4 / 裁定 ⑥），而周期执行者搭的是同一个 runner（裁定 ⑩：**不另造第二套循环**）。
 * 真正的**写**路径（结算 / 托管释放）在 Task 7/8/10 —— 那时 `LedgerService` 的导入
 * 才会在这里被真正用到（今天只有 `LedgerReconciliationService` 被取）。
 *
 * ## ★ 为什么必须同时加 `PolicyModule`（实测，DI 图不接受「只加 LedgerModule」）
 *
 * `LedgerModule` 是一个**带路由的模块**：它的类级构造函数注入 `PolicyGuard`（为了
 * `onModuleInit` 里注册 `ledgerAdminGrant` 条件），而 `PolicyGuard` 由 `PolicyModule`
 * 提供。`PolicyModule` 标了 `@Global()`，但 **`@Global()` 只让「已经被 import 过一次」的
 * 模块的 exports 对全局可见**——API 侧是 `AppModule` 自己 `imports: [PolicyModule, …]`
 * 提供的，而 worker 的图里从前没有任何东西 import 过它。
 *
 * 实测（不加会怎样）：`pnpm test --project integration tests/integration/worker` 下两条
 * 既有进程用例直接红，`InstanceLoader.createInstancesOfProviders` 抛
 * `UnknownDependenciesException: Nest can't resolve dependencies of the LedgerModule (?, AdminDirectory).
 * Please make sure that the argument PolicyGuard at index [0] is available in the LedgerModule module.`
 * —— **worker 起不来**，而这不是一条「少了个功能」的失败，是**进程级**的。
 *
 * ## ★ `AuthModule` **不需要**（同一轮实测，据实记载为什么不做冗余 import）
 *
 * 直觉上还要 `AuthModule`（`LedgerModule` 的构造函数同时注入 `AdminDirectory`，而它由
 * `AuthModule` 导出）。实测**不需要**：`LedgerModule` 自己 `imports: [AuditModule, AuthModule]`
 * （`ledger.module.ts:48`），`AdminDirectory` 因此在它的模块作用域里已经可解析。
 * 加 `AuthModule` 也能跑（两种写法都实测过），但那会往 worker 的依赖图里多拉进
 * `AuthController` 与 `RedisModule`（会话/限流），而 worker 两样都不需要
 * ——**为一个已经能解析的依赖加一条边，正是本项目反复惩罚的「为想象中的需求预埋」**。
 */
@Module({ imports: [ConfigModule, DbModule, NotifyModule, PolicyModule, LedgerModule] })
export class WorkerModule {}
