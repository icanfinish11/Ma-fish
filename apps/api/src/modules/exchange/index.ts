/**
 * `exchange` 模块的**对外接口**（设计 §3.3 第 2 条：跨模块只经显式接口 + DTO）。
 *
 * ## 为什么是逐条 `export { … }` 而不是 `export *`
 *
 * `export *` 会把模块内部的一切（纯核心的迁移表、Prisma 生成的类型、每个内部 helper）
 * 一次性变成对外契约；而 `.dependency-cruiser.cjs` 的 `no-cross-module-internals`
 * 放行的正是本文件——一个 `export *` 等于把那条规则一并关掉。理由与
 * `modules/audit/index.ts`、`modules/asset/index.ts`、`modules/ledger/index.ts`
 * 的文件头逐字同源。
 *
 * ## 今天有谁在用它
 *
 * **据实记载**：`AppModule`（组合根）直接 import `./exchange/exchange.module.js`
 * （组合根在架构规则里是显式豁免的，理由见 `dependency-cruiser.cjs`），
 * 而**没有任何模块**经本文件引用 exchange。这不是「为不存在的调用方建接口」：
 * **领域错误类型与 `POLICY_CONDITIONS` 是边界契约**，而「跨模块只走 index.ts」
 * 这条规则要求它在**第一个**调用方出现之前就存在——否则第一个调用方只能深引，
 * 而那正是规则要拦下的动作。`asset` 是第一个真实调用方（Task 8 的原子释放会读
 * `contract` 两侧的承诺列），届时它 import 的就是本文件。
 *
 * ## ★ 计划的那份接口清单里有五个**今天不存在**的导出（据实记载）
 *
 * 计划的 `exchange/index.ts` 清单写着八行 service：`ExchangeService` /
 * `SwapContractService` / `SwapSettlementService` / `SwapTimersService` /
 * `ObligationService` / `PreviewService` / …。后五个的文件今天**不存在**
 * （Task 7–10 的交付物），而 `export` 一个不存在的模块在本仓库是**编译期错误**
 * （`moduleResolution: nodenext`），不是一条可以被忽略的注释。
 * ⇒ 本文件导出**今天存在**的东西，每一个任务在自己的提交里把它的那一行加进来
 * （与 `ledger/index.ts` 逐字同一条纪律：**不导出**没有调用方的内部类型）。
 *
 * ## 导出四类东西，各自对应一条边界
 * * **模块本身**（给 `AppModule.imports` 用）；
 * * **策略条件名**：别的模块若要复用「是不是这份要约的对手方」，引用的是同一个字符串；
 * * **服务**：`ExchangeService` 是 Task 7/8/10 的 `Consumes`（它们在同模块内直接 import
 *   本文件旁边的实现，但跨模块的调用方走这里）；
 * * **领域错误类型**：边界要能分开说清责任方（404/409/422/500），把错误类藏在模块内部
 *   会让调用方只能按错误消息匹配（`asset/index.ts` 的头注释里有同一条理由）。
 */
export { ExchangeModule } from './exchange.module.js';
export { POLICY_CONDITIONS } from './exchange.controller.js';
export { ExchangeService, OFFER_TTL_HOURS, CONTRACT_LOCK_HOURS } from './exchange.service.js';
export type { AcceptOfferInput, OfferDecisionInput, ProposeOfferInput } from './exchange.service.js';
export { exchangeErrorToHttp } from './exchange-error-map.js';

// 增量 A-6 的闭集：Task 9 的 manifest 与 P3.5 的 `judge` 都读它
// （A-6 的 Produces 行逐字）。**逐条导出**（不用 `export *`），理由见文件头。
export {
  CLAIM_KINDS,
  MAX_CLAIM_ITEMS,
  MAX_CLAIM_TEXT,
  assertClaimsVerifiable,
  claimFactsFrom,
  parseClaims,
} from './core/claims.js';
export type { Claim, ClaimFacts, ClaimKind } from './core/claims.js';

export {
  AssetLockedError,
  EscrowShortfallError,
  IneligibleAssetError,
  InvalidClaimsError,
  InvalidExchangeTransitionError,
  StaleCommitmentError,
  SwapSelfOfferError,
  UnknownExchangeObjectError,
  UnknownExchangeStatusError,
  UnknownLockOrderError,
} from './core/errors.js';
