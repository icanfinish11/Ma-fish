/**
 * 交换的领域错误族（**只有这一处定义**，Task 3）。
 *
 * 分类标准与 `ledger/core/errors.ts` 逐字同源：HTTP 边界要按它们分开说清**责任方**。
 * 七种因由 → 五种状态码（`exchange-error-map.ts` 是**唯一**的翻译表，Task 6）：
 *
 * | 错误 | 状态码 | 责任方 |
 * |---|---|---|
 * | `UnknownExchangeStatusError` | 422 | **库里的数据**出现了 §6.3 之外的 status（不可接受的是数据） |
 * | `InvalidExchangeTransitionError` | 409 | 请求本身合法，冲突在于**资源的当前状态** |
 * | `SwapSelfOfferError` | 409 | 这是同一个人（「转给自己」的交换版，与 P1 的 `SelfTransferRejectedError` 同档） |
 * | `AssetLockedError` | 409 | 作品正被另一份合约锁着 / 正是本案要锁的那一件 |
 * | `IneligibleAssetError` | 422 | **制品本身**不满足 §6.1 第 2 条（与 P1 的 422 同义） |
 * | `EscrowShortfallError` | 500 | 不变式 #4 被破坏 —— **我们自己的**不变量 |
 * | `UnknownLockOrderError` | 500 | 调用方没有按全局锁序取锁（**我们的 bug**） |
 *
 * ## 为什么「422 与 409」这一刀切在这里
 * 与 `ledger` 的同一条读法：**不可接受的是数据**（422）与**不可接受的是这次请求**
 * （409）是两件不同的事。「库里的 `status` 是 `NOT_A_STATUS`」不是用户做错了什么，
 * 而「这份要约已经是 `ACCEPTED` 了，你不能再拒绝它」是请求与资源当前状态的冲突。
 * 把它们并成一个错误类型会让那次翻译只能靠猜，而状态码正是调用方唯一能据以行动的信号。
 */

/** 库里的 `status` 落在 §6.3 的闭集之外 ⇒ 422（不可接受的是**数据**）。 */
export class UnknownExchangeStatusError extends Error {
  constructor(readonly status: string) {
    super(`未知的交换状态（§6.3 之外）：${status}`);
    this.name = 'UnknownExchangeStatusError';
  }
}

/** §6.3 的图上没有这条边 ⇒ 409（请求合法，冲突在资源的当前状态）。 */
export class InvalidExchangeTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`非法的状态迁移（§6.3 的图上没有这条边）：${from} → ${to}`);
    this.name = 'InvalidExchangeTransitionError';
  }
}

/** 向自己发要约：`proposer === counterparty`（`top_up_payer_id` 之外的另一处自指）。 */
export class SwapSelfOfferError extends Error {
  constructor(readonly userId: string) {
    super(`不能向自己发要约：${userId}`);
    this.name = 'SwapSelfOfferError';
  }
}

/** 作品已被锁定（§6.3:284 的「不可编辑 / 不可另行上架 / 不可删除」）⇒ 409。 */
export class AssetLockedError extends Error {
  constructor(
    readonly assetId: string,
    readonly holder: string,
  ) {
    super(`作品已被锁定（§6.3:284）：${assetId}，持有者 ${holder}`);
    this.name = 'AssetLockedError';
  }
}

/** 制品本身不满足 §6.1 第 2 条（D16 的资格判据）⇒ 422，与 P1 的 422 同义。 */
export class IneligibleAssetError extends Error {
  constructor(
    readonly assetId: string,
    readonly reason: string,
  ) {
    super(`作品不满足交换资格（§6.1 第 2 条）：${assetId} —— ${reason}`);
    this.name = 'IneligibleAssetError';
  }
}

/**
 * 不变式 #4 被破坏：托管余额 < 未结算义务之和 ⇒ **500**。
 *
 * ## 它为什么是 500 而不是 409
 * 预检 §0.3 的证伪逐字：「两个合约各锁 1000，其中一笔释放 1500 ⇒ **接受**、
 * ESCROW = 500（≥ 0）、`isBalanced = true`、审计如实。**平台为该合约付出了它从未为
 * 这份合约持有的 500 分，而没有任何一条不变式看得见。**」
 *
 * 也就是说：一旦这个不等式被破坏，**平台已经付出了它没有的钱** —— 那不是调用方的
 * 操作问题，是我们自己的账做错了。两个量都记在错误上（金额是内部标识，**不进响应体**：
 * C11 的边界由 Task 6 的翻译表把守，它只回 `code`）。
 */
export class EscrowShortfallError extends Error {
  constructor(
    readonly escrowBalance: bigint,
    readonly outstanding: bigint,
  ) {
    super(`托管不足（不变式 #4）：ESCROW=${escrowBalance.toString()} < 未结算义务=${outstanding.toString()}`);
    this.name = 'EscrowShortfallError';
  }
}

/**
 * 取锁顺序违反了全局锁序（C35）⇒ **500**（我们的 bug，不是调用方的）。
 *
 * `held` 是本次事务**已经**持有行锁的资产（按取的先后），`wanted` 是即将要取的。
 * 唯一会抛它的是 `lock-order.ts` 的 `assertLockOrderHeld`，而它是给人看的：
 * 真出现这条错误说明某条双锁路径**写错了顺序** —— 那正是预检 §B.1 实测的两类死锁
 * （`P2010` / `P2034`，带 `40P01`）的**成因**，而这里把它变成一条在取锁之前就响的错。
 */
export class UnknownLockOrderError extends Error {
  constructor(
    readonly held: readonly string[],
    readonly wanted: readonly string[],
  ) {
    super(`取锁顺序违反了全局锁序（C35）：已持 [${held.join(',')}]，又要 [${wanted.join(',')}]`);
    this.name = 'UnknownLockOrderError';
  }
}
