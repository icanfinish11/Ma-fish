import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
// `OutboxConsumer` 经**模块的对外接口**取到，而不是深引 `…/outbox.consumer.js`
// （Task 9 修复轮 1）：worker 是独立构建/部署的进程，深引会让它的编译结果取决于
// `notify` 的内部布局。这条边界由 `.dependency-cruiser.cjs` 的
// `no-cross-module-internals` 守着（`apps/worker` 深引 `modules/*` 内部即报错）。
import { OutboxConsumer } from '@vca/api/modules/notify/index.js';
import { WorkerModule } from './worker.module.js';
import { describeError, runWorker } from './worker.js';

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
