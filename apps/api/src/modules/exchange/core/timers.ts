import type { ContractSnapshot, OfferSnapshot } from './types.js';

/**
 * 三个计时器（D13 / 控制器裁定 ⑩）。**P3 里唯一的时间判据形状，三个计时器共用它。**
 *
 * ## 为什么是「收 `now` 的纯函数」
 * 裁定 ⑩ 逐字：「**收 `now` 的纯函数 + 可注入 tick 的 runner**（照 `inspectTicket` 的先例）。
 * 理由：**一个只能靠等待来测的 7 天计时器是不可测的。**」
 * 预检 §0.5 的实测：`setInterval` / `@nestjs/schedule` / `@Cron` / `scheduler` 源码
 * **零匹配**、测试里**假时钟零匹配**、`LedgerReconciliationService` **零生产调用方**。
 * ⇒ 因此本文件里**一行都不读进程时钟**：没有任何 `Date.now()`、没有 `new Date()`。
 * 传两个不同的 `now` 进同一个快照会得到两个不同的结论，而那正是可测性的定义。
 *
 * ## 三个计时器与它们的期限
 * | 计时器 | 期限 | 出处 | 到期动作 |
 * |---|---|---|---|
 * | 要约过期 | 72 小时 | §6.3:280「`EXPIRED`（72 小时）」 | `expire-offer` |
 * | 双锁窗口 | 24 小时 | §6.3:283 | `cancel-contract`（`lock-timeout`） |
 * | 争议期 | 7 天 | §8.4:401 | `settle-contract`（自动确认） |
 *
 * 期限**本身不在本文件里**：`expiresAt` / `lockDeadlineAt` / `disputeDeadlineAt` 都由服务在
 * 创建时算出并落库（`schema.prisma` 的注释逐字说明了为什么：契约是「要约在多长时间内
 * 有效」，而不是「72 这个魔数出现在查询里」）。本文件只做比较，因此那三个数换了
 * （按类别给不同期限）时这里一个字都不用改。
 *
 * ## 边界是**闭**的
 * `now >= deadline` 算到期。先例是 `inspectTicket`（`signed-url.ts:155`）。
 * 用 `>` 会在**恰好**那一毫秒放行，而「7 天后的自动确认」在毫秒上差一位是不可测的。
 *
 * ## `Date` 的比较一律写成 `getTime()`
 * `Date` 是对象：`a < b` 走 `valueOf()`（毫秒数），而 `a === b` 走**引用** —— 两个表示同一
 * 毫秒的对象并不相等。显式取毫秒让三种比较说的是同一件事。
 */

/**
 * 到期动作。**闭集**（三个取值），且每个动作与状态机上的一条**合法**边一一对应：
 * `expire-offer` ⇒ `SENT → EXPIRED`；`cancel-contract` ⇒ `PENDING_BOTH_LOCK → CANCELLED`；
 * `settle-contract` ⇒ `RELEASED → SETTLED`（或 `DISPUTED → SETTLED`，裁决那条是人的动作）。
 *
 * 这个对应关系是刻意的：**计时器不产生状态机之外的边**。因此 runner（Task 5 的 worker
 * `tasks`）拿到的每一个动作都可以直接交给服务层执行，而服务层仍会走
 * `assertContractTransition`——两处一致由 `state-machine.test.ts` 的穷举看着。
 */
export type DueAction =
  | { readonly kind: 'expire-offer' }
  | { readonly kind: 'cancel-contract'; readonly reason: 'lock-timeout' }
  | { readonly kind: 'settle-contract' };

/** 要约的 72 小时窗口是否到期（闭边界）。 */
export function offerExpired(offer: OfferSnapshot, now: Date): boolean {
  return now.getTime() >= offer.expiresAt.getTime();
}

/** 双锁的 24 小时窗口是否到期（闭边界）。 */
export function lockWindowExpired(contract: ContractSnapshot, now: Date): boolean {
  return now.getTime() >= contract.lockDeadlineAt.getTime();
}

/**
 * 7 天争议期是否到期（闭边界）。**没有截止时刻 ⇒ `false`（fail-closed）。**
 *
 * `dispute_deadline_at` 是**可空**列：只有释放过的合约才有窗口。一个没有窗口的合约
 * 若被判为「窗口到期」，`dueContractActions` 就会在一份**从未走过争议期**的合约上自动放款
 * ——那正是 §8.4 的「争议期间全额冻结」要防的事。因此这一支的方向是
 * 「宁可不自动结算」，而它由 `timers.test.ts` 的一条用例独立行使。
 */
export function disputeWindowExpired(contract: ContractSnapshot, now: Date): boolean {
  if (contract.disputeDeadlineAt === null) return false;
  return now.getTime() >= contract.disputeDeadlineAt.getTime();
}

/**
 * 这份要约今天该做什么（0 或 1 个动作）。
 *
 * 前两条守卫的**方向**都是「不产生动作」，因为过期是**终态**（`EXPIRED` 没有出边）：
 *   * 只有 `SENT` 会在时间上出局（`DRAFT` 还没发出去，四个终态更不该被动）；
 *   * 一行 `SENT` 却**已有合约**是**不可能**的数据（接受动作在同一次状态迁移里把
 *     `status` 翻成 `ACCEPTED`），真出现就说明行不一致 —— 在一份有合约的要约上自动
 *     `EXPIRED` 会让「合约存在」与「要约是终态 `EXPIRED`」同时成立。这一条是
 *     `OfferSnapshot.acceptedContractId` 的**唯一**消费者（见 `types.ts`）。
 */
export function dueOfferActions(offer: OfferSnapshot, now: Date): readonly DueAction[] {
  if (offer.status !== 'SENT') return [];
  if (offer.acceptedContractId !== null) return [];
  if (!offerExpired(offer, now)) return [];
  return [{ kind: 'expire-offer' }];
}

/**
 * 这份合约今天该做什么（0 或 1 个动作）。
 *
 * ## 只有两种状态会产生定时动作
 *   * `PENDING_BOTH_LOCK` 过了 24 小时 ⇒ 取消（§6.3:283）。**`VALIDATING` 超时不取消**：
 *     §6.3:286 的箭头只有 `通过 → RELEASED` 与 `RELEASED 前任一方退出 → CANCELLED`，
 *     自动取消会**多出一条** §6.3 没授权的边；
 *   * `RELEASED` 过了 7 天且**无争议** ⇒ `SETTLED`（§8.4:401 的自动确认）。
 *
 * ## 为什么「已争议」与「没有窗口」都不产生动作
 * `DISPUTED` 的出路是**裁决**（§2.1 把仲裁归 P6），不是时间；而 `RELEASED` 上出现
 * `disputedAt` 是「争议刚提出、状态还没翻」的那一瞬（或一行不一致的数据）——
 * 两种读法下都**不该自动放款**：钱要么等着裁决，要么等着状态机先把它推进 `DISPUTED`。
 */
export function dueContractActions(contract: ContractSnapshot, now: Date): readonly DueAction[] {
  if (contract.status === 'PENDING_BOTH_LOCK') {
    return lockWindowExpired(contract, now) ? [{ kind: 'cancel-contract', reason: 'lock-timeout' }] : [];
  }
  if (contract.status === 'RELEASED') {
    if (contract.disputedAt !== null) return [];
    return disputeWindowExpired(contract, now) ? [{ kind: 'settle-contract' }] : [];
  }
  // `VALIDATING`（等人修或人退）/ `DISPUTED`（等裁决）/ 两个终态：时间不产生动作。
  return [];
}
