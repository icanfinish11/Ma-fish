import { OBLIGATION_STATES } from './types.js';

/**
 * 托管的 `≥` 判据（§8.3 不变式 #4 的**右式** / Task 3）。**只做加法与比较，不查库。**
 *
 * ## 它补的是哪一半（预检 §0.3 的证伪，逐字）
 * 「两个合约各锁 1000，其中一笔释放 **1500** ⇒ **接受**、ESCROW=500（≥0）、
 * `isBalanced=true`、审计如实。**平台为该合约付出了它从未为这份合约持有的 500 分，
 * 而没有任何东西看得见。**」
 *
 * 不变式 #4 的两边来自**两个模块**：`Σ PLATFORM_ESCROW`（左式）由 **ledger** 报，
 * `Σ 未结算义务`（右式）由 **exchange** 报（Task 2 的 `exchange.swap_obligations`
 * 就是那个「无处可查」的落点）。C5 禁止 `exchange` join `ledger`——
 * 因此这份判据的形状只能是「两个数进来、一个布尔出去」：**它不查库，也查不了库**。
 *
 * **它证明什么、不证明什么（据实划界）**：本文件证明「那个不等式一旦被喂进正确的一对数，
 * 它真的会说不」；「喂进去的那对数是不是真的」（ESCROW 余额来自 ledger、
 * 义务来自本模块的表，两边在同一个事务里读）是 Task 10 的
 * `SwapSettlementService` + `tests/integration/exchange/obligation-chain.test.ts` 的事。
 * 两半各自只证明自己那一半。
 */

/**
 * 一条托管义务（`exchange.swap_obligations` 的一行，**只需要这两个字段**）。
 *
 * `state` 写成 `string` 而不是 `ObligationState`：从库里读回来的就是 `string`，
 * 而收窄是消费侧的职责（与 `OfferSnapshot.status` 同一条纪律）。
 */
export interface OutstandingObligation {
  readonly state: string;
  /** 金额（**分**，bigint，C3）。恒 `>= 0`（迁移里的 `swap_obligations_amount_nonneg`）。 */
  readonly amount: bigint;
}

/**
 * `Σ 未结算义务`：**只数 `LOCKED`**。
 *
 * `SETTLED` 是义务的**终态**（钱已经付出去、义务已经消失），把它算进「还欠多少」会让
 * 已结算的合约永远占着额度，并让 `escrowCovers` 在完全正常的状态下为假。
 *
 * **白名单的失败方向与它的兜底（据实记载）**：白名单（而不是「不是 `SETTLED` 就算」）
 * 的失败方向是**少算义务** ⇒ 判据**更宽**。若将来出现第三个 state 而人们忘了在这里加一笔，
 * `escrowCovers` 会静默地变宽。今天兜住这条的是**数据库**：
 * `swap_obligations_state_check` 只允许 `('LOCKED','SETTLED')`，而它是 Task 2 的真库取证
 * 里逐条断言的对象。**复访触发条件**：任何一次给 `swap_obligations.state` 加取值的迁移，
 * 都必须同时改这里（`obligation.test.ts` 里「闭集之外的 state 不计入」那条用例是落点）。
 */
export function sumOutstanding(obligations: readonly OutstandingObligation[]): bigint {
  let total = 0n;
  for (const obligation of obligations) {
    if (obligation.state !== OBLIGATION_STATES.LOCKED) continue;
    total += obligation.amount;
  }
  return total;
}

/**
 * 不变式 #4：`escrowBalance >= Σ 未结算义务`。
 *
 * ## 边界是**闭**的
 * `2000 >= 2000` 成立（恰好够 ⇒ 接受）。用 `>` 会让「托管刚好等于义务」这个最常见的
 * 稳态被判为不足 —— 那不是更安全，那是把一个正确状态误报成事故。
 *
 * ## 空义务集恒成立
 * 没有任何未结算义务时（例如所有合约都已 `SETTLED`）这个不等式对**任意**托管余额成立，
 * 包括负的：托管为负是**另一条**判据的事（P2 迁移里的非负 CHECK），
 * 让这条判据顺手报它会让责任方从「账本坏了一行」变成「这算一次托管不足」。
 */
export function escrowCovers(escrowBalance: bigint, obligations: readonly OutstandingObligation[]): boolean {
  return escrowBalance >= sumOutstanding(obligations);
}
