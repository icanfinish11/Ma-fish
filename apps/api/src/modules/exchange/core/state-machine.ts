import {
  CONTRACT_STATUSES,
  OFFER_STATUSES,
  type ContractSnapshot,
  type ContractStatus,
  type OfferStatus,
} from './types.js';
import { InvalidExchangeTransitionError, UnknownExchangeStatusError } from './errors.js';

/**
 * 两张状态机（设计 §6.3；Task 3）。**这是 §6.3 那张图在代码里的唯一落点。**
 *
 * ## 为什么是显式的整张表，而不是散落各处的 `if`
 * 设计 §7.3 对拍卖说了同一句话：「**状态的合法迁移仅限上述边**，由状态机守卫强制，
 * 不靠散落各处的 `if`」。交换的两张表在这里，而它们的取值集合同时出现在三处
 * （迁移的 `CHECK`、这里的表、HTTP 的 DTO）——**三处一致由 `state-machine.test.ts`
 * 的穷举用例看着**（它把合法与非法两个计数都写死：表里多一条边红一次，少一条边也红一次）。
 *
 * ## CHECK 与这张表的分工（别把它们当成彼此的备份）
 * `CHECK` 只保证「取值在闭集内」，**不**保证「迁移是合法的」：
 * `PENDING_BOTH_LOCK → SETTLED` 这种跳跃在库里完全合法（取值都在闭集里），
 * 它只能被下面这张表挡下。反过来，一条 `UPDATE` 直接写 `status='NOT_A_STATUS'` 会被
 * `CHECK` 拒，而这张表连看都看不到它（它不是一次迁移，是一次数据损坏）。
 *
 * ## 终态没有出边
 * `ACCEPTED` / `REJECTED` / `WITHDRAWN` / `EXPIRED` 都是终态（§6.3:277-280 的图里
 * 它们没有画出去的箭头）。`ACCEPTED` 的「后继」是**一份新的合约**，不是要约的新状态
 * ——那件事由 `swap_contracts.offer_id` 的唯一外键表达。
 */
export const OFFER_TRANSITIONS: Readonly<Record<OfferStatus, readonly OfferStatus[]>> = Object.freeze({
  DRAFT: ['SENT'],
  SENT: ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'],
  ACCEPTED: [],
  REJECTED: [],
  WITHDRAWN: [],
  EXPIRED: [],
});

export const CONTRACT_TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = Object.freeze({
  PENDING_BOTH_LOCK: ['VALIDATING', 'CANCELLED'],
  // 校验不通过时**不由合约状态表达**（那是一次拒绝，合约停在 VALIDATING 等人修）；
  // §6.3:286 的箭头只有 `通过 → RELEASED` 与 `RELEASED 前任一方退出 → CANCELLED`。
  VALIDATING: ['RELEASED', 'CANCELLED'],
  RELEASED: ['SETTLED', 'DISPUTED'],
  // ★ D6 / C31：`DISPUTED` 的唯一出路是 `SETTLED`（一次**冻结释放**，
  //   `releaseEscrow(sellerId = payer, feeBps: 0)`）。**账本上没有「逆转」这个原语**——
  //   「不存在」只对账本成立（规格 D8）：`RESOLVED_REVERSED` 那条边 = **所有权回转**，
  //   由 P3.5 在同一个事务里用两笔**正向**转让 + 罚没（`FORFEIT`）表达，不需要账本逆向。
  DISPUTED: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
});

const OFFER_SET: ReadonlySet<string> = new Set(Object.values(OFFER_STATUSES));
const CONTRACT_SET: ReadonlySet<string> = new Set(Object.values(CONTRACT_STATUSES));

/**
 * 把**从库里读回来的** `string` 收窄成 `OfferStatus`；闭集外 ⇒ 422。
 *
 * 为什么不是 `asserts`：调用方拿到的是一个**值**（`status` 会被写进 HTTP 响应、
 * 进审计、进比较），因此返回收窄后的值比断言更合用——`ledger` 的
 * `normalizeRef` 是同一种形状。
 */
export function offerStatusOf(raw: string): OfferStatus {
  if (!OFFER_SET.has(raw)) throw new UnknownExchangeStatusError(raw);
  return raw as OfferStatus;
}

export function contractStatusOf(raw: string): ContractStatus {
  if (!CONTRACT_SET.has(raw)) throw new UnknownExchangeStatusError(raw);
  return raw as ContractStatus;
}

export function assertOfferTransition(from: OfferStatus, to: OfferStatus): void {
  if (!OFFER_TRANSITIONS[from].includes(to)) throw new InvalidExchangeTransitionError(from, to);
}

/**
 * 一个要约状态是不是**终态**（= 上面那张表里没有出边）。
 *
 * 从迁移表**派生**，而不是另写一份名单：终态的定义就是「没有出边」，
 * 而多写一份 `['ACCEPTED','REJECTED','WITHDRAWN','EXPIRED']` 是同一件事的第二种说法。
 */
export function isTerminalOfferStatus(status: OfferStatus): boolean {
  return OFFER_TRANSITIONS[status].length === 0;
}

/**
 * **活跃**（非终态）的要约状态。
 *
 * ## 它是哪一条数据库约束的 TypeScript 侧定义处（P3 / Task 6，控制器裁定 ①）
 *
 * `exchange.swap_offers` 上的唯一索引是**部分**唯一索引，谓词是
 * `status IN ('DRAFT','SENT')`（迁移 `20261007140000_p3_swap_offers_partial_unique`）。
 * 服务层的「同一对 `(target, counterparty)` 上已有活跃要约吗」这一问必须与那条谓词
 * **是同一个集合**：两边漂移的失效形态是静默的——服务查了一个更宽的集合，
 * 于是「复用」会命中一行索引根本不挡的历史要约，而库里同时存在两份活跃要约。
 *
 * ## 为什么它由 `isTerminalOfferStatus` 派生（而不是手写两个字面量）
 * 手写 `['DRAFT','SENT']` 会让「§6.3 加一个非终态」变成两处改动，而漏掉的那一处
 * 正是这里。派生之后，state-machine 那张表的改动会**顺带**改到本常量。
 *
 * **见证**：`tests/integration/db/exchange-enforcement.test.ts` 把
 * `pg_indexes.indexdef` 里的取值集合与这个数组逐字比对（真库那一侧），
 * 因此「迁移的谓词」与「服务的集合」漂移时会红一次。`migrate diff` 对此**失明**
 * （实测见那个迁移的头注释）。
 */
export const ACTIVE_OFFER_STATUSES: readonly OfferStatus[] = Object.freeze(
  Object.values(OFFER_STATUSES).filter((status) => !isTerminalOfferStatus(status)),
);

export function assertContractTransition(from: ContractStatus, to: ContractStatus): void {
  if (!CONTRACT_TRANSITIONS[from].includes(to)) throw new InvalidExchangeTransitionError(from, to);
}

/**
 * 「双方均锁定」（§6.3:284）：**两个**时间戳都非空。
 *
 * 为什么是**两个**而不是「至少一个」：§6.3 的箭头是 `双方确认锁定 → VALIDATING`，
 * 而两列的存在理由正是「谁确认过」可分别记录（`locked_by_a_at` / `locked_by_b_at`）。
 * 一个时间戳就放行，等于把「任一方单方面就能把对方的作品带进校验」变成合法动作。
 */
export function bothLocked(contract: ContractSnapshot): boolean {
  return contract.lockedByAAt !== null && contract.lockedByBAt !== null;
}
