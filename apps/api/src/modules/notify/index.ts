/**
 * `notify` 模块的**对外接口**（设计 §3.3 第 2 条：跨模块只走显式接口 + DTO）。
 *
 * ## 为什么需要这个文件
 *
 * 在它出现之前，`apps/worker` 直接深引本模块的两个内部文件
 * （`@vca/api/modules/notify/notify.module.js` 与 `…/outbox.consumer.js`）。
 * 对一个**独立进程**来说这不是小事：worker 能不能编译、能不能起，取决于
 * `notify` 内部怎么组织（拆不拆 service、文件叫什么、`OutboxConsumer` 的构造参数怎么变），
 * 而两者之间没有任何可拆的边界。与 `modules/audit/index.ts` 同一个理由、
 * 同一个形状（那是 Task 9 为 `auth → audit` 建的接口）。
 *
 * ## 只导出 worker **真正**需要的两样东西
 *
 * - `NotifyModule`：给 `WorkerModule` 的 `imports` 用（模块类就是装配契约）；
 * - `OutboxConsumer`：给 `main.ts` 的 `app.get(OutboxConsumer)` 用。
 *
 * **刻意不 `export *`**，也刻意**不**重导出 `OutboxService` / `MAILER` / 两个 mailer 实现：
 * worker 今天一个都不用（没有生产者，见 `notify.module.ts` 的交接备注），
 * 而 `export *` 等于把内部实现换个地方继续暴露——规则就白设了（`audit/index.ts` 同一取舍）。
 * 将来 worker 若真的要发通知，第一件事是**在这里加一行并说明理由**，
 * 而不是绕过接口去深引：那样 `.dependency-cruiser.cjs` 的 `no-cross-module-internals`
 * 会在 CI 上把它拦下来。
 */
export { NotifyModule } from './notify.module.js';
export { OutboxConsumer } from './outbox.consumer.js';
