import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildWorker,
  startWorker as spawnWorker,
  waitForExit,
  waitForOutput,
  WORKER_STARTED as STARTED,
  type WorkerRun,
} from '../../helpers/worker-process.js';

/**
 * worker **进程**的两件事：能不能起来、能不能自己停下来（C15）。
 *
 * ## 为什么必须有进程级用例
 *
 * 单测（`tests/unit/worker/loop.test.ts`）把 `exit` 注入掉了——它证明的是「逻辑顺序」，
 * 证明不了「进程真的会结束」。而本仓库已经实测过这个差别有多大：Task 7 的引导失败路径
 * 里，只设 `process.exitCode = 1` 的实现让进程**永远活着**（ioredis 的活跃 socket 撑住
 * 事件循环），编排系统看到的是一个健康容器。worker 的关停路径是同一类问题。
 *
 * ## 生产入口是**构建产物**
 *
 * `apps/worker/dist/main.js` 就是 `pnpm --filter @vca/worker start` 跑的那个文件。
 * 源码入口在子进程里跑不起来（相对 import 是 `.js` 而实体是 `.ts`，只有 vitest 的解析
 * 管线能处理），因此 `beforeAll` 现跑一次构建——产物不可能与源码不同步。
 *
 * ## Windows 的现实（不遮）
 *
 * 信号用例在 Windows 上是**跳过**的：Windows 没有真正的信号投递，Node 的
 * `child.kill('SIGTERM')` 直接走 `TerminateProcess`，子进程的 `process.on('SIGTERM')`
 * 根本不会运行——那样的用例只会测到「它被杀掉了」。因此：
 * - 不依赖平台的「能起来并开始轮询」这一条在**所有**平台跑；
 * - 依赖信号的「SIGTERM 后以码 0 自己退出」这一条在 POSIX（CI）上跑，Windows 上显式跳过。
 * 关停**逻辑**本身由不依赖平台的单测覆盖。
 *
 * ## 起进程/等待的装置住在哪里（P2 / Task 3）
 *
 * `startWorker` / `waitForOutput` / `waitForExit` / `buildWorker` 已抽到
 * `tests/helpers/worker-process.ts`：Task 3 的 `runtime-role.test.ts` 需要同一套装置，
 * 而复制两份必然会漂移（抽取是纯搬运，本文件的用例行为逐字未改）。
 */
/** 启动标记（`WORKER_STARTED`，`runWorker` 的第一行日志）由 helpers 导出，此处以 `STARTED` 引用。 */
/** 关停标记（`main.ts` 的信号处理器）。用它做**归属断言**：证明是信号让它退出的。 */
const SHUTDOWN = /收到 SIGTERM/;
/** 消费失败的标记：库指向死端口 ⇒ 失败是预期的，它同时证明循环真的在跑。 */
const CONSUME_FAILED = /消费失败/;

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;

/**
 * 本用例的库：一个**连不上**的死端口。
 *
 * 指到死端口是刻意的：这样消费必然失败（可预期的可观测行为），而且**不会**因为开发机上
 * 恰好有一个本地 Postgres 而变成另一条路径（用例必须自足）。
 *
 * 它同时是「连不上库 ⇒ 角色检查 `unverifiable` ⇒ **不**拒绝启动」这条边界的常驻见证
 * （`db/runtime-role.ts` 的边界一节）：P2 / Task 3 把该检查装进 worker 之后，这条用例
 * 若不红，就证明引导期没有把「连接故障」误当成「角色错误」——那会把「库暂时不可用」
 * 变成「worker 永久起不来」。
 */
const UNREACHABLE_DATABASE_URL = 'postgresql://app_user:test_pw@127.0.0.1:59999/vca_test';

/** 起一个指向 {@link UNREACHABLE_DATABASE_URL} 的 worker 子进程。 */
function startWorker(): WorkerRun {
  return spawnWorker(UNREACHABLE_DATABASE_URL);
}

describe('worker 进程（C15）', () => {
  beforeAll(async () => {
    // worker 的 build 会先建 @vca/api：后者是它运行期解析 `@vca/api/*` 的前提
    // （`apps/api/package.json` 的 `node` 条件指向 `dist/*`，见报告 §打包）。
    await buildWorker();
  }, 300_000);

  it('能引导起来并开始轮询（构建产物、模块图与子路径解析都对）', async () => {
    const run = startWorker();
    try {
      const started = await waitForOutput(run, STARTED, STARTUP_TIMEOUT_MS);
      expect(
        started,
        `worker 没有在 ${STARTUP_TIMEOUT_MS}ms 内打印启动标记。输出末段：${run.output().slice(-800)}`,
      ).toBe(true);
      // 库指到死端口 ⇒ 第一轮消费必然失败。这条断言同时证明循环真的在跑（而不是起来就静默退出）
      expect(
        await waitForOutput(run, CONSUME_FAILED, 10_000),
        `worker 没有在消费失败后记录可观测的一行。输出末段：${run.output().slice(-800)}`,
      ).toBe(true);
    } finally {
      run.child.kill('SIGKILL');
      await waitForExit(run.child, 5_000);
    }
  }, 120_000);

  it.skipIf(process.platform === 'win32')(
    'SIGTERM：进程自己在限时内以码 0 退出（关停处理器真的跑了，且没有挂住）',
    async () => {
      const run = startWorker();
      try {
        expect(
          await waitForOutput(run, STARTED, STARTUP_TIMEOUT_MS),
          `worker 没有起来。输出末段：${run.output().slice(-800)}`,
        ).toBe(true);

        run.child.kill('SIGTERM');

        const outcome = await waitForExit(run.child, SHUTDOWN_TIMEOUT_MS);
        expect(
          outcome.signal,
          `进程在 ${SHUTDOWN_TIMEOUT_MS}ms 内没有自己退出（被父进程 SIGKILL）：` +
            `关停路径挂住了——编排系统会把它当成健康容器。输出末段：${run.output().slice(-800)}`,
        ).toBeNull();
        expect(outcome.code, `关停不是「以码 0 结束」，实际 ${String(outcome.code)}`).toBe(0);
        // **归属断言**：只断言「退出了」是不够的——任何一个别的启动期失败都能让它退出。
        expect(
          run.output(),
          '没有证据表明它是因为 SIGTERM 而退出的（处理器可能没跑）',
        ).toMatch(SHUTDOWN);
      } finally {
        run.child.kill('SIGKILL');
      }
    },
    120_000,
  );
});
