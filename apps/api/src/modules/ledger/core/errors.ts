/**
 * 领域错误族（**只有这一处定义**）。
 *
 * ## 为什么不是一个笼统的 `LedgerError`
 * HTTP 边界要按它们分开说清**责任方**（与 P1 的 `assetErrorToHttp` 同一标准）：
 * 「余额不足」（409，资源当前状态）与「服务端自己的账做不平了」（500，我们的 bug）
 * 是两件完全不同的事，把它们并成一个错误类型会让那次翻译只能靠猜。
 *
 * ## 为什么 `InsufficientFundsError` 带 `stage`
 * 它有**两个**来源：纯核心的预判（`predicted`）与条件更新的受影响行数（`conditional-update`）。
 * 后者才是并发权威（C25）。分开记录这件事让「条件更新那条路真的被走到过」变成可断言的事实——
 * `tests/integration/ledger/postings.test.ts` 里那条**确定性**用例（第三方连接先锁住目标行）
 * 断言 `stage === 'conditional-update'`，否则那条用例可能只是被预判拦下了，而并发路径
 * **一次都没被执行**。注意：「两笔并发各扣 6000」那条**不能**断言某一个 stage——第二笔若在
 * 第一笔提交之后才读快照，预判就会先拦下它（`predicted`），而那是提交时序、不是语义（Task 6 Step 1）。
 */
export class InvalidAmountError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidAmountError'; }
}
export class InvalidFeeRateError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidFeeRateError'; }
}
export class UnbalancedPostingError extends Error {
  constructor(readonly sum: bigint, readonly legs: number) {
    super(`借贷不平衡：sum(amount)=${sum.toString()} 分录数=${String(legs)}`);
    this.name = 'UnbalancedPostingError';
  }
}
export class EmptyPostingError extends Error {
  constructor(message: string) { super(message); this.name = 'EmptyPostingError'; }
}
export class ZeroAmountLegError extends Error {
  constructor(readonly accountId: string) {
    super(`分录金额为 0：账户 ${accountId}`);
    this.name = 'ZeroAmountLegError';
  }
}
export class NetZeroLegError extends Error {
  constructor(readonly accountId: string) {
    super(`一笔交易在账户 ${accountId} 上的净额为 0（两条互相抵消的转移不构成过账）`);
    this.name = 'NetZeroLegError';
  }
}
export class MissingAccountError extends Error {
  constructor(readonly key: string) {
    super(`账户未解析：${key}`);
    this.name = 'MissingAccountError';
  }
}
export class SelfMoveError extends Error {
  constructor(readonly accountId: string) {
    super(`转移的双方是同一个账户：${accountId}`);
    this.name = 'SelfMoveError';
  }
}
export class UnknownAccountKindError extends Error {
  constructor(readonly kind: string) {
    super(`未知的账户类型（§8.1 只有五个）：${kind}`);
    this.name = 'UnknownAccountKindError';
  }
}
/**
 * 引用的用户**不存在**（P2 最终全分支审查 C1）。
 *
 * ## 为什么它与 `UnknownAccountKindError`（422）分开
 * 那个说的是「**库里的数据**出现了 §8.1 之外的取值」——不可接受的是**数据**；
 * 这个说的是「**你这次请求**指向了一个不存在的用户」——不可接受的是**这次引用**。
 * HTTP 层因此是 **404**：不是 400（`userId` 的**格式**是对的，缺的是那一行），
 * 也不是 422（本仓库给 422 的含义是「数据本身不可接受」，见 `ledger-error-map.ts`）。
 *
 * ## 它挡的是什么（一句话）
 * 一次管理员的手误（UUID 差一个字符）此前会**静默地销毁额度**：那笔钱记进了一个没人能
 * 登录的账户，永远花不掉，而所有不变式、对账与审计都是绿的。
 */
export class UnknownUserError extends Error {
  constructor(readonly userId: string) {
    super(`用户不存在：${userId}——额度不能发给一个不存在的账户（没人能以此身份登录，这笔钱永远花不掉）`);
    this.name = 'UnknownUserError';
  }
}
export class SystemAccountMissingError extends Error {
  constructor(readonly kind: string) {
    super(`系统账户不存在：${kind}——迁移没跑？（D2：系统账户只由迁移种子化）`);
    this.name = 'SystemAccountMissingError';
  }
}
export class IdempotencyKeyReusedError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`幂等键 ${idempotencyKey} 已用于另一笔内容不同的过账`);
    this.name = 'IdempotencyKeyReusedError';
  }
}
export class InsufficientFundsError extends Error {
  constructor(
    readonly accountId: string,
    readonly kind: string,
    readonly balance: bigint,
    readonly needed: bigint,
    readonly stage: 'predicted' | 'conditional-update',
  ) {
    super(`余额不足（${stage}）：账户 ${accountId} 余额 ${balance.toString()}，需要 ${needed.toString()}`);
    this.name = 'InsufficientFundsError';
  }
}
