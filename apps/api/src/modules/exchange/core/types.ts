/**
 * 交换纯核心的输入 / 输出形状（Task 3）。
 *
 * ## 这个文件里**没有任何 I/O**、没有 Nest、没有 Prisma
 * 与 `ledger/core/types.ts` 同一条分层：这里只有取值集合与快照形状，因此
 * `state-machine.ts` / `timers.ts` / 服务层（Task 6–10）都能安全地 import 它而没有环；
 * 三条计时器判据与两张状态机因此可以在**没有数据库**的情况下被穷举
 * （`tests/unit/exchange/*.test.ts`）。
 *
 * ## 三处取值集合的一致性（第一个纪律）
 * 两张状态机的闭集同时出现在**三处**：
 *   1. 迁移里的 `CHECK`（`swap_offers_status_check` / `swap_contracts_status_check`，
 *      Task 2 的真库取证在 `tests/integration/db/exchange-enforcement.test.ts`）；
 *   2. **本文件**这两张表（唯一的 TypeScript 定义处）；
 *   3. HTTP 的 DTO（Task 6）。
 * `CHECK` 保证「取值在闭集内」，**不**保证「迁移是合法的」——后者是
 * `state-machine.ts` 的迁移表。两张表的逐字断言与穷举计数在
 * `tests/unit/exchange/state-machine.test.ts`。
 *
 * ## 「从库里读回来的 `status` 是 `string`」
 * 快照上的 `status` 刻意写成 `string` 而不是 `OfferStatus`：Prisma 生成出来的类型就是
 * `string`，而**收窄是 `offerStatusOf` / `contractStatusOf` 的职责**。写成联合类型会让
 * 调用方在传参处被迫 `as`，那等于把「库里的数据可能落在闭集外」这件事藏起来——
 * 而它是一条 422（`UnknownExchangeStatusError`：不可接受的是**数据**）。
 */

/** 要约状态（§6.3:276-280）。**闭集**，与 `swap_offers_status_check` 逐字相同。 */
export const OFFER_STATUSES = {
  DRAFT: 'DRAFT',
  SENT: 'SENT',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
  EXPIRED: 'EXPIRED',
} as const;

export type OfferStatus = (typeof OFFER_STATUSES)[keyof typeof OFFER_STATUSES];

/** 合约状态（§6.3:282-291 + D18）。**闭集**，与 `swap_contracts_status_check` 逐字相同。 */
export const CONTRACT_STATUSES = {
  PENDING_BOTH_LOCK: 'PENDING_BOTH_LOCK',
  VALIDATING: 'VALIDATING',
  RELEASED: 'RELEASED',
  DISPUTED: 'DISPUTED',
  SETTLED: 'SETTLED',
  CANCELLED: 'CANCELLED',
} as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[keyof typeof CONTRACT_STATUSES];

/**
 * 托管**义务**的状态（D2）。**只有两个**。
 *
 * 为什么它也需要一张表（而不是在 `obligation.ts` 里写一个 `'LOCKED'` 字面量）：
 * 它是**第三个闭集**，它的权威定义在迁移里（`swap_obligations_state_check`，
 * Task 2 的真库取证），而 `sumOutstanding` 是它的**唯一**运行期消费者。
 * 与两张状态机同一条纪律：定义处一处、消费处读名字而不是读字面量。
 *
 * 多一个 `REVERSED` 都是多余：C31 决定了「争议裁决 = 一次冻结释放」，
 * 而那个动作的账本语义与 `SETTLED` 的释放**逐字相同**（都是 `ESCROW_RELEASE`）。
 */
export const OBLIGATION_STATES = {
  LOCKED: 'LOCKED',
  SETTLED: 'SETTLED',
} as const;

export type ObligationState = (typeof OBLIGATION_STATES)[keyof typeof OBLIGATION_STATES];

/** 要约的快照（`timers.ts` 的三个判据只读这三个字段）。 */
export interface OfferSnapshot {
  readonly status: string;
  readonly expiresAt: Date;
  /**
   * 接受这份要约而产生的合约（`ACCEPTED` 时非空）。
   *
   * 它今天**只有一个用途**：`dueOfferActions` 的一条 fail-closed 守卫——
   * 一份 `SENT` 却已经有合约的要约是**不可能的**（接受动作在同一次状态迁移里
   * 把 `status` 翻成 `ACCEPTED`），真出现就说明行不一致，而在一份有合约的要约上
   * 自动 `EXPIRED` 会让「合约存在」与「要约是终态 EXPIRED」同时成立。
   * 见 `timers.ts` 的 `dueOfferActions`。
   */
  readonly acceptedContractId: string | null;
}

/** 合约的快照（两张状态机 + 三条计时器判据读它）。 */
export interface ContractSnapshot {
  readonly status: string;
  readonly lockDeadlineAt: Date;
  readonly lockedByAAt: Date | null;
  readonly lockedByBAt: Date | null;
  readonly releasedAt: Date | null;
  /** `releasedAt + 7 天`（§8.4 的争议期）。**可空**：没释放就没有窗口，见 `disputeWindowExpired`。 */
  readonly disputeDeadlineAt: Date | null;
  readonly disputedAt: Date | null;
}
