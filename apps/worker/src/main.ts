import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
// `OutboxConsumer` 经**模块的对外接口**取到，而不是深引 `…/outbox.consumer.js`
// （Task 9 修复轮 1）：worker 是独立构建/部署的进程，深引会让它的编译结果取决于
// `notify` 的内部布局。这条边界由 `.dependency-cruiser.cjs` 的
// `no-cross-module-internals` 守着（`apps/worker` 深引 `modules/*` 内部即报错）。
import { OutboxConsumer } from '@vca/api/modules/notify/index.js';
// P3 / Task 5：周期对账的执行者。走模块的**对外接口**取服务与判据（与 `OutboxConsumer` 同一条
// 依赖纪律：worker 是独立构建/部署的进程，深引 `modules/ledger` 的内部文件会被
// `.dependency-cruiser.cjs` 的 `no-cross-module-internals` 直接拒）。
import { LedgerReconciliationService } from '@vca/api/modules/ledger/index.js';
// 平台层（`db/*`）不是任何功能模块的内部实现，按设计可以直取——与 `worker.module.ts`
// import `@vca/api/db/db.module.js` 同一条依赖方向。
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { assertRuntimeDbRole } from '@vca/api/db/runtime-role.js';
import { WorkerModule } from './worker.module.js';
import { describeError, runWorker } from './worker.js';

/**
 * 账本对账的**周期**（P3 / Task 5；计划 D17 / 控制器裁定 ⑩）。
 *
 * ## 60 秒是怎么来的（据实：取值理由，不是实测最优）
 *
 * 两端各有一个已知量：
 * * **下界**：P2 的 `DEFAULT_POLL_MS = 1_000`（outbox 的轮询粒度）。对账没必要比通知更快
 *   —— 它的语义是**发现**，不是修复（P2 的划界逐字：不变式 #2 的职责是事后发现）。
 * * **上界**：运维能接受的通知延迟。设计 §8.3 的不变式 #2 是一条**告警**判据，
 *   而「下一次有人跑测试」是它今天的实际发现周期（P2 的边界一/二就是这么写的）。
 *   把最坏发现延迟从「下一次有人跑测试」压到「一分钟」已经达到目的；
 *   再压小只是让一条 40 ms 的查询更频繁地打库（20 万行实测 40 ms，`reconcilePerAccount`）。
 *
 * ## 与关停预算的关系（Step 8 的三个数之一）
 *
 * `DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000`，而一次 `reconcilePerAccount()` 在 20 万行上
 * 是 **40 ms** 量级 ⇒ **一次 tick 远小于关停预算**。收到 `SIGTERM` 时循环不再开新的一轮，
 * 正在跑的那一次照常跑完（P2 的划界：对账只读，跑完不会留下半成品），
 * 最坏情况是关停多等**一次 tick**。
 *
 * ## 为什么是模块常量而不是环境变量（D14）
 *
 * P3 **不新增任何环境变量**。周期任务的间隔照 `DEFAULT_POLL_MS` 的形状写成常量；
 * 真需要按部署调时再走一次「新增变量」的完整登记流程（K9：`tests/helpers/env.ts`
 * **与另外六处手写夹具**）。
 */
export const RECONCILE_INTERVAL_MS = 60_000;

/**
 * worker 进程入口（**独立进程、没有 HTTP 服务器**）。
 *
 * ## 为什么是 `createApplicationContext` 而不是 `create`
 *
 * 本进程不监听端口、不装中间件栈、不需要 Express。`createApplicationContext` 建的是
 * 纯 DI 容器：少一个 HTTP 服务器，就少一个既没用又会占端口的监听器
 * （Task 7 的端口冲突取证正是踩在这类多余句柄上）。
 *
 * ## 停机：信号 → `AbortController` → 有界 `close()` → `exit(0)`
 *
 * 顺序是承重的，三条缺一不可：
 * 1. **收到信号先 abort**：循环不再开新的一轮，把当前这一批做完就退出；
 * 2. **`app.close()`**：走 Nest 的关停流程，`PrismaService.onModuleDestroy` 断开连接池。
 *    worker 不 import `RedisModule`（它不需要会话与限流），所以这里没有 ioredis socket，
 *    但 pg 连接池同样是**活跃句柄**——不关它，进程能否退出就取决于事件循环的运气；
 * 3. **`exit(0)`**：由 `runWorker` 在关停之后调用（有界：`close()` 挂住也会退出）。
 *
 * **Windows 的现实**：`process.on('SIGINT'|'SIGTERM')` 只在 POSIX 上会被触发；
 * Windows 的 `child.kill()` 走 `TerminateProcess`，处理器根本不会运行。
 * 因此进程级用例 `tests/integration/worker/process.test.ts` 在 Windows 上是**跳过**的
 * （跳过原因写在用例里），而关停**逻辑**由不依赖平台的单测钉住。这不是「没测」，
 * 是「这一条只能在能投递信号的操作系统上测」。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });

  // ── 运行期数据库角色校验（P2 / Task 3；设计 §14 点名「P1 应补」，P1 未做）──────────
  // 位置是承重的：**在任何一次消费之前**。api 侧同一检查在 `listen()` 之前
  // （`bootstrap.ts:212`），理由一样——失误的部署要在能做事**之前**退出。
  //
  // 为什么 worker 必须有它：append-only（不变式 #5 / C7）成立的前提是运行期连接的角色
  // 与表属主不是同一个（属主对自己的 `REVOKE UPDATE, DELETE` 是空操作，预检 §B.6 复验：
  // 值真的被改成 999）。而预检 §E.3 实测此前**只有 api 侧**有此检查——worker 被以属主
  // 角色启动时不会自我拒绝，于是「账本 append-only 在这条连接上是不是空操作」这个
  // 问题在 worker 这个进程上无人回答，且**所有测试仍然全绿**（`runtime-role.ts` 原话）。
  //
  // 为什么**现在**补（而 P2 里 worker 还没有账本写者）：P2 不交付业务状态机（C29），
  // 所以「P2 的结算跑在 worker 里」不成立；这是设计 §14 已经点名的 **P1 欠账**，
  // 且 worker 与 api 共用同一个 `DATABASE_URL` 契约与同一个库。P3 的结算第一次从 worker
  // 写账本时，这条检查是**前提**——那时若还没补，缺陷形态是「静默失效且全绿」。
  //
  // 「连不上库」按 P0 的既定边界**不**拒绝启动（`runtime-role.ts` 的边界一节：
  // 应用允许「先起来、库稍后可用」，且 worker 的进程级用例就是跑在死端口上的）——
  // 只记一行 warn。方向仍是安全的：连不上时它什么也消费不了，而一旦连上就一定会被检查。
  // 这条边界由 `tests/integration/worker/process.test.ts`（死端口）常驻见证。
  try {
    await assertRuntimeDbRole(app.get(PrismaService), {
      // worker 不装 pino（`WorkerModule` 刻意不含 `AppLoggerModule`，见其注释），
      // 因此这里直接写 stderr：与 worker 其余诊断信息同一个出口，不另造一套日志面。
      onUnverifiable: (fields, message) =>
        process.stderr.write(`[worker] ${message} ${JSON.stringify(fields)}\n`),
    });
  } catch (error) {
    // 拒绝启动时要**有序关掉**已经建好的 DI 容器（pg 连接池是活跃句柄）。
    // 这里不设超时：检查本身有 5s 上限（`ROLE_CHECK_TIMEOUT_MS`），而 `close()`
    // 挂住的失效形态由外层 `process.exit(1)` 兜住（与 api 的 `closeQuietly` 同一纪律）。
    await app.close().catch(() => undefined);
    throw error;
  }

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    // 记下**是哪个信号**：没有这一行，进程级用例分不清「处理器跑了」与「别的原因退出了」
    process.stderr.write(`[worker] 收到 ${signal}，开始关停\n`);
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await runWorker(
    {
      consumer: app.get(OutboxConsumer),
      // ── 周期任务（P3 / Task 5；控制器裁定 ⑩：**一个**共享机制，不另造第二套循环）──────
      // 它与 Task 10 的三个计时器搭的是**同一个** runner：`runWorker` 的 `tasks`。
      // 判据（「到点了吗」）是收 `now` 的纯函数、住在 `exchange/core/timers.ts`；
      // 这里给的只是「一次 tick 做什么」。
      tasks: [
        {
          name: 'ledger-reconcile',
          intervalMs: RECONCILE_INTERVAL_MS,
          runOnce: async () => {
            const report = await app.get(LedgerReconciliationService).reconcilePerAccount();
            if (LedgerReconciliationService.isPerAccountClean(report)) return;
            // ## 对账的语义是「**发现**」，不是「修复」（P2 的划界，逐字继承）
            // 不变式 #2 的职责是**事后发现**。因此这里只**报**，不改任何一行 ——
            // 把发现改写成修复会让「钱被动过」这件事失去证据（那正是要查的东西）。
            //
            // ## 这一行的形状：一行、有界、不含机密量（C11）
            // 账户 id 是内部标识，可以进日志；余额可以进（它不是凭证）。**只报前 5 条**：
            // 一份 20 万行的漂移报告不应该把日志打成一片，而「有漂移」这件事本身
            // 已经由 `driftAccounts=` 那个计数说清楚了（完整的报告是运维入口的事）。
            //
            // 出口是 stderr（与 worker 其余诊断同一个出口，`WorkerModule` 刻意不含
            // `AppLoggerModule`）；`describeError` 那条「压成单行」的纪律在这里同样适用
            // —— 因此列表用 `join(',')` 而不是多行。
            process.stderr.write(
              `[worker] 账本对账不干净：totalBalance=${report.totalBalance.toString()} ` +
                `totalEntryAmount=${report.totalEntryAmount.toString()} ` +
                `driftAccounts=${report.drifts.length} ` +
                `first=${report.drifts
                  .slice(0, 5)
                  .map((d) => `${d.accountId}:${d.drift.toString()}`)
                  .join(',')}\n`,
            );
          },
        },
      ],
      close: () => app.close(),
    },
    { signal: controller.signal },
  );
}

void bootstrap().catch((error: unknown) => {
  // 引导失败必须**可见且非零退出**（Task 7 的 Ruling 3 标准）。
  // 未处理拒绝在 Node 22 下也会以码 1 结束，但那条路径没有诊断语、错误格式也不受控；
  // 这里显式记一行再退出，并且**不吞原始错误**（栈照样打出来）。
  process.stderr.write(`[worker] 启动失败，进程以退出码 1 结束：${describeError(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
