/**
 * `auth` 模块的**对外接口**（设计 §3.3 第 2 条：跨模块只经显式接口 + DTO）。
 *
 * ## 为什么直到 P2 才需要它
 *
 * 在它出现之前，全仓只有 `app.module.ts`（组合根，`.dependency-cruiser.cjs` 里显式豁免）
 * 从外部引用 auth 的东西，因此没有「跨模块深引」这条路径可走。
 * P2 的额度发放路由是 **auth 的第一个真实调用方**（`LedgerModule` 要注入
 * `AdminDirectory` 来判管理员），于是那条规则第一次有了实际约束力。
 *
 * ## 为什么是逐条 `export { … }` 而不是 `export *`
 *
 * `export *` 会把模块内部的一切（`SessionMiddleware`、GitHub OAuth 的实现、
 * `PasswordService` 的口令校验细节……）一次性变成对外契约，于是「这个模块依赖什么」
 * 再也说不清；而 `no-cross-module-internals` 放行的正是本文件——一个 `export *`
 * 等于把那条规则一并关掉了（它还能被 import，但放行面变成了整个模块）。
 * 理由与 `modules/audit/index.ts`、`modules/asset/index.ts` 的文件头逐字同源。
 *
 * ## 导出的四样东西，各自有谁用
 *
 * | 导出 | 谁用 |
 * |---|---|
 * | `AuthModule` | 组合根（`app.module.ts`）的 `imports`；`LedgerModule` 的 `imports` |
 * | `AdminDirectory` | `LedgerModule` 的策略条件 `ledgerAdminGrant` |
 * | `SessionService` / `type SessionData` | 组合根（`SessionMiddleware` 的依赖）、限流按 `userId` 分桶、审计按会话追溯 |
 * | `PasswordService` | 目前**没有**模块外调用方——它在这里是因为组合根与 Task 8 的说明都把它算作 auth 的对外能力；据实记载，P2 没有新增调用方 |
 *
 * **不导出**：`AuthService`、`GithubOauthService`、`SessionMiddleware`——它们今天没有
 * 模块外的调用方（C16：不为不存在的调用方建接口）。测试直接用深路径 import，
 * 那是测试的特权（架构规则的主体是 `apps/` 的源码，不是 `tests/`）。
 */
export { AuthModule } from './auth.module.js';
export { AdminDirectory } from './admin-directory.service.js';
export { SessionService, type SessionData } from './session.service.js';
export { PasswordService } from './password.service.js';
