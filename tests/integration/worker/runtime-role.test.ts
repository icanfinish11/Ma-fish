import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import {
  buildWorker,
  startWorker,
  waitForExit,
  waitForOutput,
  WORKER_STARTED,
} from '../../helpers/worker-process.js';

/**
 * worker 的**运行期数据库角色校验**（P2 / Task 3；设计 §14 点名「P1 应补」，P1 未做）。
 *
 * ## 为什么这条门必须存在（不是仪式）
 *
 * append-only（不变式 #5 / C7）成立的前提是「运行期连接的角色与表属主**不是同一个**」：
 * PostgreSQL 的属主永远保有全部权限，因此属主对自己发的 `REVOKE UPDATE, DELETE` 是
 * **空操作**（预检 §B.6 复验：属主连接下真的把分录从 100 改成 999）。
 *
 * API 侧已在 `bootstrap.ts:212` 拒绝启动；**worker 侧此前无人检查**——预检 §E.3 实测
 * `apps/worker/src/main.ts` 里 `assertRuntimeDbRole` 零匹配。于是任何一次把
 * `DATABASE_URL` 写成 `MIGRATE_DATABASE_URL` 的复制粘贴失误（两个变量都在 `.env.example`
 * 里，这是最自然的一种失误），在 worker 这个进程上就**没有人会发现**，而
 * `runtime-role.ts` 自己的注释把后果说得最准：此时**所有测试仍然全绿**。
 *
 * ## 为什么现在补（而 P2 里 worker 还没有账本写者）
 *
 * P2 **不交付任何业务状态机**（C29），因此 P2 里**没有** worker 侧的账本写者——
 * 「P2 的结算跑在 worker 里」这句话**不成立**，本计划末尾的
 * 「为什么 P2 不把 `LedgerModule` 装进 worker」据实否定了它。检查照旧现在落地，理由是：
 * 1. 设计 §14 已经点名它是 **P1 的欠账**，不是 P2 的新需求；
 * 2. worker 与 API 共用同一个 `DATABASE_URL` 契约与**同一个库**——「账本 append-only
 *    在这条连接上是不是空操作」这个问题，worker 今天就该回答；
 * 3. P3 的结算第一次从 worker 写账本时，这条检查是**前提**而不是附加项。
 *
 * ## 两条用例必须成对（这是本文件的核心）
 *
 * 只测「属主被拒」时，一个「怎么都拒绝启动」的实现也能骗过它——而那样 worker 永远起不来。
 * 因此第二条用**合法**的 `app_user` 连接证明它照常起来并开始轮询。两条合起来才说明
 * 「拒绝」是**有判别力**的，而不是恒真。
 *
 * 第一条另有一条**归属断言**（`RuntimeDbRoleError`）：只断言「退出了、退出码 1」不够，
 * 任何别的启动期失败都能产生同样的码；点名错误类型才说明是**这条检查**拒绝的。
 *
 * 复用的是 API 侧同一份实现（`apps/api/src/db/runtime-role.ts`，P0 已有）——
 * 不写第二份：两份实现必然漂移，而漂移的那一份会是没人测的那一份。
 */
const STARTUP_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 60_000;

describe('worker 的运行期角色校验（P2 前置 B / 不变式 #5）', () => {
  let pg: TestPg;

  beforeAll(async () => {
    // worker 的运行期解析走构建产物：`@vca/api/*` 的 `node` 条件指向 `dist/*`
    // （见 `apps/api/package.json` 的 exports），因此必须先把 @vca/api 与 worker 建出来。
    await buildWorker();
    // 真库：`roles.sql` → `migrate deploy` → `apply-grants.sql`。角色权限是 PostgreSQL 的
    // 语义，替身能证明的只有「我实现的假对象说了算」（与 `integration/db/runtime-role.test.ts` 同一纪律）。
    pg = await startPostgres();
  }, 300_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('DATABASE_URL 指向迁移属主 ⇒ 拒绝启动（自己以码 1 退出，且不点错变量）', async () => {
    const run = startWorker(pg.ownerUri);
    try {
      const outcome = await waitForExit(run.child, EXIT_TIMEOUT_MS);
      expect(
        outcome.signal,
        `worker 在属主连接下**没有**自己退出（被父进程 SIGKILL）：append-only 的撤权在它身上是空操作，` +
          `而它会照常消费。输出末段：${run.output().slice(-800)}`,
      ).toBeNull();
      expect(outcome.code, `退出码不是 1（实际 ${String(outcome.code)}）`).toBe(1);
      // **归属断言**：只断言「退出了」不够——任何启动期失败都能让它退出。
      // 点名错误类型，证明是**这条检查**拒绝的，而不是某个碰巧也失败的东西。
      expect(
        run.output(),
        `拒绝启动的原因不是运行期角色检查。输出末段：${run.output().slice(-800)}`,
      ).toContain('RuntimeDbRoleError');
      // 报错必须**可据以行动**：说清是哪个变量错了、以及错了会有什么后果。
      expect(run.output(), '失败信息没有点名 DATABASE_URL，运维不知道该改哪个变量').toContain(
        'DATABASE_URL',
      );
      expect(run.output(), '失败信息没有说明后果（append-only 失效）').toContain('append-only');
    } finally {
      run.child.kill('SIGKILL');
    }
  }, 120_000);

  it('DATABASE_URL 指向 app_user（合法配置）⇒ 照常起来并开始轮询（反面对照）', async () => {
    const run = startWorker(pg.appUri);
    try {
      expect(
        await waitForOutput(run, WORKER_STARTED, STARTUP_TIMEOUT_MS),
        `合法配置下 worker 没起来。输出末段：${run.output().slice(-800)}`,
      ).toBe(true);
      // **反空转**：它必须**还活着**。上一条的「退出码 1」若来自一个恒真的拒绝，
      // 这一条就会红——两条合起来才排除「怎么都拒绝」与「怎么都放行」两种假实现。
      expect(
        run.child.exitCode,
        `合法配置下 worker 起来了却已经退出（码 ${String(run.child.exitCode)}）。输出末段：${run.output().slice(-800)}`,
      ).toBeNull();
    } finally {
      run.child.kill('SIGKILL');
      await waitForExit(run.child, 5_000);
    }
  }, 120_000);
});
