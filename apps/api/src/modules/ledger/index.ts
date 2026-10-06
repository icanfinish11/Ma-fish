/**
 * `ledger` 模块的**对外接口**（设计 §3.3 第 2 条：跨模块只经显式接口 + DTO）。
 *
 * ## 为什么是逐条 `export { … }` 而不是 `export *`
 *
 * `export *` 会把模块内部的一切（纯核心的账户类型表、Prisma 生成的类型、每个内部 helper）
 * 一次性变成对外契约；而 `.dependency-cruiser.cjs` 的 `no-cross-module-internals`
 * 放行的正是本文件——一个 `export *` 等于把那条规则一并关掉。理由与
 * `modules/audit/index.ts`、`modules/asset/index.ts` 的文件头逐字同源。
 *
 * ## 今天有谁在用它
 *
 * **据实记载**：`AppModule`（组合根）直接 import `./ledger/ledger.module.js`
 * （组合根在架构规则里是显式豁免的，理由见 `dependency-cruiser.cjs`），
 * 而**没有任何模块**经本文件引用 ledger。
 * 这不是「为不存在的调用方建接口」：**领域错误类型与 `POLICY_CONDITIONS` 是边界契约**，
 * 而「跨模块只走 index.ts」这条规则要求它在**第一个**调用方出现之前就存在——
 * 否则第一个调用方只能深引，而那正是规则要拦下的动作（P1 的 `modules/auth/index.ts`
 * 也是同一处境：它由 Task 10 建、由 ledger 用）。
 *
 * 导出三类东西，各自对应一条边界：
 * - **模块与服务**（给 `imports` 与 DI 用）：`LedgerModule` / `LedgerService` /
 *   `LedgerReconciliationService`；
 * - **策略条件名**：别的模块若要复用「管理员才能发额度」这条判定，引用的是同一个字符串；
 * - **领域错误类型**：边界要能分开说清责任方（400/409/422/500），把错误类藏在模块内部
 *   会让调用方只能按错误消息匹配（`asset/index.ts` 的头注释里有同一条理由）。
 *
 * **不导出**：`LedgerController`（路由由 Nest 装配，没有模块外调用方）、
 * `grantCreditsSchema` / `GrantCreditResponse`（今天只有本模块的控制器用它，
 * 将来前端要按它写请求时再加——C16）。
 */
export { LedgerModule } from './ledger.module.js';
export { POLICY_CONDITIONS } from './ledger.controller.js';
export { LedgerService } from './ledger.service.js';
export { LedgerReconciliationService } from './reconciliation.service.js';

export {
  EmptyPostingError,
  IdempotencyKeyReusedError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidFeeRateError,
  MissingAccountError,
  NetZeroLegError,
  SelfMoveError,
  SystemAccountMissingError,
  UnbalancedPostingError,
  UnknownAccountKindError,
  // P3 / Task 4（D5）：§8.2 之外的**交易** kind。**它必须在这里**：Task 6/7/8/10 的交换路径
  // 自己构造 `post` 请求，传错 kind 时`instanceof` 是 HTTP 边界唯一能分开责任方的手段，
  // 而跨模块引用只走 `index.ts`（§3.3 第 2 条 / `no-cross-module-internals`）。
  UnknownTransactionKindError,
  ZeroAmountLegError,
} from './core/errors.js';
