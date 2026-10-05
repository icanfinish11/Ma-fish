import type { AccountKind } from './account-kind.js';

/**
 * 纯核心的输入/输出形状（Task 5）。**这里没有任何 I/O、没有 Nest、没有 Prisma。**
 *
 * 为什么单独一个文件而不是塞进 `posting.ts`：`types.ts` 只 import **类型**与
 * `account-kind.js`，不反向 import 任何实现，因此 `posting.ts` / `fee-split.ts` /
 * 属性测试 / `LedgerService` 都能安全地 import 它而没有环。
 */

/**
 * 一个账户的**引用**（还没解析成数据库行）。
 *
 * `ownerUserId === null` 恒等于「系统账户」（D2：系统账户由迁移种子化，owner 是 NULL）。
 * 两者的对应关系由 `account-kind.ts` 的两张表负责，这里不重复表达。
 */
export interface AccountRef {
  readonly kind: AccountKind;
  readonly ownerUserId: string | null;
}

/** 解析后的账户 + 它的物化余额（`balance` 是数据库里的那一列）。 */
export interface AccountSnapshot extends AccountRef {
  readonly id: string;
  readonly balance: bigint;
}

/** 一次「转移」：从 from 到 to，金额为**正数**。过账的输入形状就是它。 */
export interface MoneyMove {
  readonly from: AccountRef;
  readonly to: AccountRef;
  readonly amount: bigint;
}

/** 复式腿：**正 = 贷（余额增加），负 = 借（减少）**。同一笔交易的所有腿之和恒为 0。 */
export interface PostingLeg {
  readonly accountId: string;
  readonly amount: bigint;
}

/**
 * 交易类型（§8.2 的六行记账示例各对应一条；D12 说明为什么第 3、6 行没有命名包装）。
 *
 * 它是 `ledger.transactions.kind` 的取值来源——**不是**一个状态机（C29）。
 */
export const TRANSACTION_KINDS = {
  TOPUP: 'TOPUP',            // §8.2 行 1（充值 / 额度发放）
  FREEZE: 'FREEZE',          // §8.2 行 2（出价冻结保证金）
  FORFEIT: 'FORFEIT',        // §8.2 行 3（悔拍没收）—— 由通用 post 表达，无命名包装（D12）
  ESCROW_LOCK: 'ESCROW_LOCK',      // §8.2 行 4（成交进托管）；行 6（交换补差）机械上是同一个形状
  ESCROW_RELEASE: 'ESCROW_RELEASE', // §8.2 行 5（释放 + 扣费）
  UNFREEZE: 'UNFREEZE',      // 冻结的对偶（「冻结与释放」的字面另一半，§2.1）
} as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[keyof typeof TRANSACTION_KINDS];

/** 一次过账请求（`LedgerService.post` 的输入形状）。 */
export interface PostingRequest {
  readonly kind: TransactionKind;
  readonly idempotencyKey: string;
  readonly moves: readonly MoneyMove[];
  /** 发起人（HTTP 路径是管理员；系统/worker 路径为 null）。写进审计的 `actorId`。 */
  readonly actorId?: string | null;
}

/**
 * **直接腿入口**的输入形状（`LedgerService.postLegs`）。
 *
 * 与 `PostingRequest` 的唯一差别：腿是调用方**手工构造**的（`accountId` 已经是库里的 id），
 * 因此这条路上没有「引用 → 账户」的解析——也就没有惰性创建、没有 kind/owner 绑定、
 * 没有自转检查（那些是 `post` 那扇门的活）。它存在的理由是 C28：显式平衡断言必须有一条
 * **可达**的路径（`movesToLegs` 产出的腿集按构造总是平衡的，见 `postLegs` 的注释）。
 */
export interface PostingLegsRequest {
  readonly kind: TransactionKind;
  readonly idempotencyKey: string;
  readonly legs: readonly PostingLeg[];
  /** 发起人；写进审计的 `actorId`。 */
  readonly actorId?: string | null;
}

export interface PostingResult {
  readonly transactionId: string;
  readonly created: boolean;
}
