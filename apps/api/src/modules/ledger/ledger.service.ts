import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@vca/shared';
import { rowLockOrder } from '../../common/db/lock-order.js';
import { PrismaService } from '../../db/prisma.service.js';
import { AuditService } from '../audit/index.js';
// 跨模块引用**一律**经对方的 `index.ts`（设计 §3.3 第 2 条）——`no-cross-module-internals`
// 由 `pnpm arch` 守着，深引 `../auth/admin-directory.service.js` 会直接报错。
import { AdminDirectory } from '../auth/index.js';
import {
  ACCOUNT_KINDS, accountKey, assertAccountKind, mayGoNegative, normalizeRef,
  SYSTEM_ACCOUNT_KINDS, USER_ACCOUNT_KINDS,
} from './core/account-kind.js';
import {
  IdempotencyKeyReusedError, InsufficientFundsError, MissingAccountError,
  SystemAccountMissingError, UnknownAccountKindError, UnknownUserError,
} from './core/errors.js';
import { applyPosting, assertBalanced, movesToLegs, sameLegs } from './core/posting.js';
import {
  TRANSACTION_KINDS, assertTransactionKind, type AccountRef, type AccountSnapshot, type MoneyMove,
  type PostingLeg, type PostingLegsRequest, type PostingRequest, type PostingResult,
} from './core/types.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PLATFORM_FEE_BPS, computeFeeSplit } from './core/fee-split.js';

/**
 * 五个原语的入参（**显式命名**，不用内联匿名类型——它们是这个模块对外契约的一部分）。
 *
 * 三者形状几乎相同（`(userId|buyerId|sellerId) + amount/gross + idempotencyKey + actorId`），
 * 但刻意**不合并成一个泛型**（C16）：`releaseEscrow` 收的是 `gross` 且多一个 `feeBps`，
 * 把它塞进一个「有时是 amount、有时是 gross」的字段，会让每个读它的人都要先猜一次语义。
 */
export interface UserAmountInput {
  readonly userId: string;
  readonly amount: bigint;
  readonly idempotencyKey: string;
  readonly actorId?: string | null;
}

export interface EscrowLockInput {
  readonly buyerId: string;
  readonly amount: bigint;
  readonly idempotencyKey: string;
  readonly actorId?: string | null;
}

export interface EscrowReleaseInput {
  readonly sellerId: string;
  /** 释放的**总额**（手续费从它里面出；D4：`fee + net === gross` 按构造成立）。 */
  readonly gross: bigint;
  readonly idempotencyKey: string;
  /** 显式传入（默认值取 `PLATFORM_FEE_BPS`）⇒ P3/P4 换费率不必改账本（D4/D14）。 */
  readonly feeBps?: number;
  readonly actorId?: string | null;
}

/** 三个系统账户的引用（owner 恒为 NULL；D2 说它们只由迁移创建，这里只查不建）。 */
const TOPUP_REF: AccountRef = { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null };
const ESCROW_REF: AccountRef = { kind: ACCOUNT_KINDS.PLATFORM_ESCROW, ownerUserId: null };
const REVENUE_REF: AccountRef = { kind: ACCOUNT_KINDS.PLATFORM_REVENUE, ownerUserId: null };
const availableRef = (userId: string): AccountRef =>
  ({ kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: userId });
const frozenRef = (userId: string): AccountRef =>
  ({ kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: userId });

/**
 * 过账（P2 的核心；设计 §8.2 / §8.3 / §8.5）。
 *
 * 它同时落实四条**实测**结论，四条合起来才是「钱只有一种流动方式」：
 *
 * | 结论 | 落点 | 谁看着它 |
 * |---|---|---|
 * | C25/D8 余额扣减的并发权威是**条件更新的受影响行数** | `applyBalances` | 「两笔并发各冻结 6000」+ 那条确定性用例（`stage === 'conditional-update'`）+ 「解冻」那条（`USER_FROZEN` 那一侧只有它看着）+ 「托管不透支」那条（I1：托管 / 收入那一侧） |
 * | C26/D9 幂等键是数据库**唯一约束**，三态：重放 / 409 / 新键 | `postLegs` 的 findUnique 比**腿 + kind** + `isIdempotencyConflict` | 幂等①②③ + 幂等②′（I2：同键同腿异 kind） |
 * | C28 「应用侧显式平衡断言」是唯一稳定的错误通道 | **`postLegs` 头部**那次 `assertBalanced` | 「直接腿入口」三条用例（探针 p7'：删掉它 ⇒ ② 变红） |
 * | D5/裁定 ⑦ §8.2 之外的交易 `kind` 必须由**应用**拒绝（那一列上没有任何约束，CHECK 无法枚举六行） | **`postLegs` 头部**的 `assertTransactionKind`（在幂等判定之前） | `tests/unit/ledger/transaction-kind.test.ts`（闭集两侧）+ `tests/integration/ledger/transaction-kind.test.ts`（真服务路径 + 顺序） |
 * | D10 一笔过账一行审计，**写在同一个事务里** | `postLegs` 末尾的 `audit.record(…, tx)` | 「账本回滚 ⇒ 审计行 0 行」（独立断言） |
 *
 * **不要**把延迟约束触发器当主错误通道：实测经 Prisma 7.10.0 时它退化成
 * `DriverAdapterError` 且 `code === undefined`（只有 `cause.code === '23514'`）。
 * 本文件里因此**没有任何**捕获 `DriverAdapterError` 的代码——那条防线由
 * `tests/integration/db/ledger-enforcement.test.ts` 用「绕过应用直接写分录」证明。
 *
 * ## ★ 幂等键是**一个全局命名空间**（P2 最终审查 M2：现在把约定写下来）
 *
 * 库里那条唯一索引建在 `idempotency_key` **一列**上（`migration.sql` 的
 * `transactions_idempotency_key_key`），**不是** `(producer, key)`。因此**所有生产者共用
 * 一个命名空间**，而今天有两个来源会往里放键：
 *   * **管理员自选**（`POST /ledger/credits` 的请求体，≤ 200 字符，任意字符串）；
 *   * **worker / P3 自选**（设计 §8.5 举例的 `settle:auction:{id}`）。
 *
 * ⇒ **约定（现在就定，因为今天只有一个生产者，改动成本为零）**：
 *   1. `settle:` 前缀**保留**给 worker / P3 的结算键；管理员（以及任何将来的调用方）
 *      不得使用它；
 *   2. 每个生产者给自己的键加**自己的前缀**（管理员走 `admin:` 之类），
 *      命名空间因此是**不相交的**而不是靠运气；
 *   3. 一个键一旦用过，它的**含义**就固定了（D9 的判别式含 `kind` 与腿，见幂等②′）。
 *   **为什么要紧**：若管理员用一个将来会被 worker 使用的键发了额度，那次结算会以
 *   「重放」返回 `created:false`（或 409）——**调用方以为结算发生了**，而账本里躺着的
 *   是那笔 TOPUP。这不是理论风险：键是调用方给的，而 `settle:auction:{id}` 是可猜的。
 *
 * **据实记载：这是一条约定，不是一条守卫。** 今天**没有**任何代码检查前缀（加检查需要
 * 先定下「谁拥有哪些前缀」，而那是一次契约变更）。**复访触发条件**：出现**第二个**
 * 生产者时（P3 的结算落地），同一次改动里必须二选一——加前缀校验，或把唯一索引改成
 * `(producer, key)`。在那之前，本节是这条规则唯一的存在形式。
 *
 * ## 为什么本文件只 import `../audit/index.js` 与 `../auth/index.js`
 * §3.3 第 2 条「跨模块只走显式接口」由 `no-cross-module-internals` 静态强制：
 * 只有 `modules/<other>/index.ts` 被放行。深引 `../audit/audit.service.js` 会让
 * `pnpm arch` 直接报错（那条规则的存在理由写在 `dependency-cruiser.cjs` 里）。
 * `../auth/index.js` 是同一处置（C1：收款人必须存在，而「在不在」归 auth）。
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admins: AdminDirectory,
  ) {}

  /**
   * **唯一的过账入口**（引用 → 腿：解析账户、展开成复式腿，然后交给 `postLegs`）。
   * 与业务写入共用**调用方**的事务（与 `OutboxService.publish(tx, msg)` 同一纪律：
   * 「必须走到 $transaction 里」这件事在调用点就是看得见的）。
   *
   * ## 为什么签名收 `tx` 而不是自己开事务
   * P3 的「原子释放」要求「所有权转移 + 资金释放」在**同一个**事务里（设计 §8.5 原文：
   * 「`RELEASED` 与 `SETTLEMENT` 各自在单一事务内完成」）。账本自己开事务会从结构上
   * 排除这件事——而那时候的修法是「把账本拆成两半」，代价远大于一开始就收 `tx`。
   *
   * ## 两扇门，一条落库路径
   * 本方法只做「引用 → 腿」这一半（① 解析/惰性创建账户、② 展开成复式腿）；
   * ③–⑥（幂等 / 快照与预判 / 落库 / 审计）在 `postLegs` 里，**两条路共用同一份实现**。
   * 分开的理由不是分层美学，而是 C28 那条平衡断言需要一条**可达**的路径——见 `postLegs`。
   *
   * 顺序里有一处是**承重**的：幂等判定在落库之前。幂等键的唯一约束在 `ledger.transactions`
   * 上，而 `ledgerTransaction.create` 是落库的第一步——因此「同键」在**没有并发**时
   * 由判定判出来（重放或 409）；并发时第二个请求会卡在唯一索引上、等第一个提交后拿到
   * `P2002`，由 `runWithIdempotentRetry` 重试一次、走重放路径。
   */
  async post(tx: Prisma.TransactionClient, request: PostingRequest): Promise<PostingResult> {
    const moves = request.moves.map((m) => ({ ...m, from: normalizeRef(m.from), to: normalizeRef(m.to) }));
    const resolved = await this.resolveAccounts(tx, moves);
    const legs = movesToLegs(moves, resolved);
    return this.postLegs(tx, {
      kind: request.kind,
      idempotencyKey: request.idempotencyKey,
      legs,
      actorId: request.actorId ?? null,
    });
  }

  /**
   * **直接腿入口**：腿由调用方手工构造（`accountId` 已是解析后的 id）。
   *
   * ## 它为什么存在 —— C28 那条显式平衡断言需要一条**可达**的路径
   * `post` 的腿永远来自 `movesToLegs`，而它**按构造**总是平衡的（每一条转移同时产生
   * `−a` 与 `+a`，和恒为 0）。探针 **p7**（Task 6）实测：把 `post` 里那次
   * `assertBalanced` 删掉，**一条用例都不红**——在那条路上它是装饰。
   * 控制器据此裁定（`progress.md` 的 p7 条）：保留这条断言，但把**理由**改成
   * 「它是为**腿集不来自 `movesToLegs`** 的路径准备的」，并给它一条真的见证。
   * 本方法就是那条路径：断言在它的第一行，`tests/integration/ledger/postings.test.ts`
   * 的「直接腿入口」三条用例从这扇门进来（其中 ② 是**判别性**见证，见下）。
   *
   * ## 为什么判别性见证靠的是**顺序**而不是「会不会抛」
   * 任何不平衡的腿集 `applyPosting` 也会抛同一个 `UnbalancedPostingError`（它的第一句
   * 也是 `assertBalanced`），所以「抛没抛」分不开这两处。能分开的只有顺序：
   * 本方法这一次在幂等判定**之前**（因此一笔结构上就是错的请求不会被当成
   * 「一次幂等重放/冲突」来回答），而 `applyPosting` 那次在它**之后**。
   * 探针 **p7'**（删掉本方法里的 `assertBalanced`）实测：入口 ② 以
   * `IdempotencyKeyReusedError` 变红，其余用例全绿。**据实记载**：在同一条路径上，
   * 这次的「拒绝」判据与纯核心那次是**冗余**的；它真正独有的责任是那个**顺序**。
   *
   * ## 这扇门验证得**更少**（据实记载，不是疏漏）
   * 它不解析引用，因此没有：kind/owner 绑定检查、§8.1 之外的 kind 拒绝、
   * 惰性创建账户、自转检查、同账户净额合并。`accountId` 由调用方负责，
   * 从库里读回的快照仍会做 `assertAccountKind`，`applyPosting` 仍会判不变式 #3，
   * 数据库那道延迟约束触发器仍会在 COMMIT 兜底。**P2 里唯一的调用方是本类自己**
   * （`post`）与用例；将来若有第二条腿路，它必须先回答「谁保证那些 id 是被授权的」。
   */
  async postLegs(tx: Prisma.TransactionClient, request: PostingLegsRequest): Promise<PostingResult> {
    const legs = request.legs.map((leg) => ({ ...leg }));
    // ↓ C28 的执行点（本文件里**唯一**一次）：腿集不来自 `movesToLegs` 的那条路上，
    //   这是「借贷必须平衡」的第一道、也是唯一一道应用侧守卫。
    assertBalanced(legs);
    // ↓ D5（控制器裁定 ⑦）：`kind` 的运行期执行者。位置是**承重**的：在幂等判定**之前**，
    //   因此一笔 kind 就是错的请求不会被当成「一次幂等重放 / 冲突」来回答。理由与上面那条
    //   `assertBalanced` 逐字相同（见本方法签名后的长注释）——「结构上就是错的请求」
    //   先报结构错误。见证：`tests/integration/ledger/transaction-kind.test.ts` 的
    //   「同键 + 同腿 + 非法 kind ⇒ 不是 409」那条（把这一行挪到 `findUnique` 之后它就红）。
    assertTransactionKind(request.kind);

    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
      select: { id: true, kind: true, entries: { select: { accountId: true, amount: true } } },
    });
    if (existing) {
      // 同键同腿 = 重放（**不是**静默去重：调用方拿到 created:false，这是它需要知道的事实）。
      // 比腿用的是纯核心的 `sameLegs`（顺序无关）——顺序敏感会让一个合法重放变成 409。
      //
      // ## ★ `kind` 是判别式里承重的一维（P2 最终全分支审查 I2 的落点）
      //
      // 只比腿不算重放：`kind` **不在**腿上，因此「同键 + 同腿 + 不同 kind」曾被判成一次重放，
      // 返回**库里那一笔的 id** 与 `created:false`——调用方以为自己的 `FORFEIT` 落了账，
      // 而账本里躺着的是 `TOPUP`。五个原语到不了那里（腿形状两两不同，审查逐对核过），
      // 但**通用 `post` 到得了**：§8.2 的第 3 / 6 行正是 P4 带着调用方自选的键走这条门（D12）。
      // 而 D9 的契约原文是「**同一个键 + 同一个请求**」——`kind` 属于那个请求。
      // 见证：`postings.test.ts` 的「幂等②′」（同键同腿异 kind ⇒ 409，同 kind ⇒ 重放）。
      if (existing.kind === request.kind && sameLegs(existing.entries, legs)) {
        return { transactionId: existing.id, created: false };
      }
      throw new IdempotencyKeyReusedError(request.idempotencyKey);
    }

    const snapshots = await this.loadSnapshots(tx, [...new Set(legs.map((leg) => leg.accountId))]);
    applyPosting(snapshots, legs); // ← 只取它的异常；并发权威在下面的受影响行数

    const transaction = await tx.ledgerTransaction.create({
      data: { kind: request.kind, idempotencyKey: request.idempotencyKey },
      select: { id: true },
    });

    // ↓ C35（控制器裁定 ⑧）：**在任何账户写入之前**按全局锁序取全部账户行锁。
    //   位置是**三次实测**定下来的（见 `lockAccountRows` 的长注释）：它在
    //   `createMany`（FK 的 `FOR KEY SHARE`）与 `applyBalances`（余额写）之前，
    //   但在 `ledgerTransaction.create` **之后**——最后这一点偏离了计划 Step 4 的字面位置，
    //   理由是那一版会把「并发同键撞唯一索引（P2002）」这条路径变成**不可达**
    //   （实测：`postings.test.ts` 那条确定性用例变红），而这里只需要「在账户写入之前」。
    await this.lockAccountRows(tx, legs.map((leg) => leg.accountId));

    await tx.ledgerEntry.createMany({
      data: legs.map((leg) => ({ transactionId: transaction.id, accountId: leg.accountId, amount: leg.amount })),
    });
    await this.applyBalances(tx, legs, snapshots);

    await this.audit.record(
      {
        actorId: request.actorId ?? null,
        action: 'ledger.posted',
        resource: 'LedgerTransaction',
        resourceId: transaction.id,
        metadata: { kind: request.kind, idempotencyKey: request.idempotencyKey, legs: legs.length },
      },
      tx, // ← 与账本同生共死（Task 2）
    );
    return { transactionId: transaction.id, created: true };
  }

  /**
   * ## 五个原语（§2.1 的「额度发放、冻结与释放」）
   *
   * 每个都只做两件事：**构造一组转移**，然后交给 `post`。本类里没有任何余额算术、
   * 任何百分比（除了 `releaseEscrow` 调用**唯一那个**拆分函数）、任何状态机（C29）。
   * 「什么时候冻、冻多少、费率是多少」都是 P3/P4 的决定，这里只提供机械部分。
   *
   * ## 它们与 §8.2 六行的关系（**不是一对一**，据实说清）
   * 行 1→`grantCredit`、行 2→`freeze`、行 4→`lockToEscrow`、行 5→`releaseEscrow`；
   * 行 3 由通用 `post` 走通（金额规则属 P4）；行 6 由 `lockToEscrow` + `releaseEscrow`
   * 两次调用走通，**与行 4 共用 `ESCROW_LOCK`**。而 `unfreeze` 是 §2.1「冻结与释放」的
   * 字面对偶，**不在 §8.2 的六行里**。六行各有用例：`tests/integration/ledger/primitives.test.ts`。
   *
   * ## 为什么不为行 3 / 行 6 建命名包装（D12 / C16）
   * 它们的**金额规则**属于 P4/P3（罚没比例、补差额），而它们的**记账形状**完全由通用
   * `post`（或两次原语调用）表达。给它们建命名包装等于把「谁分多少」这个还不存在的
   * 决定预埋进账本——那正是本项目反复惩罚过的「声明了但没人读」。
   */

  /** 额度发放：§8.1「MVP 由管理员发放虚拟额度」⇒ `DR EXTERNAL_TOPUP / CR USER_AVAILABLE`。 */
  async grantCredit(tx: Prisma.TransactionClient, input: UserAmountInput): Promise<PostingResult> {
    await this.assertUserExists(tx, input.userId);
    return this.post(tx, {
      kind: TRANSACTION_KINDS.TOPUP,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId ?? null,
      moves: [{ from: TOPUP_REF, to: availableRef(input.userId), amount: input.amount }],
    });
  }

  /**
   * 收款人必须**存在**（P2 最终全分支审查 C1 的执行点）。
   *
   * ## 为什么它在这**一个**原语上，而不是所有原语上
   * `grantCredit` 是五个原语里唯一**凭空造钱**的那一个：其余四个的借方都必须先有余额，
   * 而余额只能来自一次发放 ⇒ 「钱在某人的可用账户里」这件事本身已经蕴含那个用户存在。
   * 因此这里是唯一的入口，而把它放在**服务层**（不是控制器）意味着 P3/P4 直接调用
   * `grantCredit` 时**继承**这道门——绕过 HTTP 也绕不过它。
   *
   * ## 为什么排在 `post` 之前、且用调用方的事务读
   * 排在前面：拒绝时**一行都不写**（连账户行都不建——那正是缺陷的另一半「每个不同 uuid
   * 永久多两行」）。用 `tx` 读：与那笔过账同一个快照、同一条连接（见 `AdminDirectory.userExists`
   * 关于「参数必填而不是可选」的理由，那是 Task 2 裁定 C-1 记下的形状）。
   */
  private async assertUserExists(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    if (!(await this.admins.userExists(userId, tx))) throw new UnknownUserError(userId);
  }

  /**
   * 冻结：可用 → 冻结（§8.2 行 2）。
   * **不含**业务状态机：什么时候冻、冻多少是 P4 的规则，本原语只提供机械部分（C29）。
   */
  async freeze(tx: Prisma.TransactionClient, input: UserAmountInput): Promise<PostingResult> {
    return this.post(tx, {
      kind: TRANSACTION_KINDS.FREEZE,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId ?? null,
      moves: [{ from: availableRef(input.userId), to: frozenRef(input.userId), amount: input.amount }],
    });
  }

  /** 解冻：冻结 → 可用（冻结的对偶；§2.1 的「冻结与释放」，**不是** §8.2 的一行）。 */
  async unfreeze(tx: Prisma.TransactionClient, input: UserAmountInput): Promise<PostingResult> {
    return this.post(tx, {
      kind: TRANSACTION_KINDS.UNFREEZE,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId ?? null,
      moves: [{ from: frozenRef(input.userId), to: availableRef(input.userId), amount: input.amount }],
    });
  }

  /** 进托管：买家可用 → `PLATFORM_ESCROW`（§8.2 行 4 / §8.4「成交 → 全额冻结进托管」）。 */
  async lockToEscrow(tx: Prisma.TransactionClient, input: EscrowLockInput): Promise<PostingResult> {
    return this.post(tx, {
      kind: TRANSACTION_KINDS.ESCROW_LOCK,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId ?? null,
      moves: [{ from: availableRef(input.buyerId), to: ESCROW_REF, amount: input.amount }],
    });
  }

  /**
   * 释放：**手续费先按 D4 那唯一一个函数算出来**，再把两条转移交给 `post`；
   * 零额的那一条**不构造**——「转移 0 分」会被 `movesToLegs` 的 `InvalidAmountError` 拒，
   * 而写一条 0 金额的腿会撞迁移里的 `entries_amount_nonzero`。两条路都不该被走到。
   *
   * `feeBps` 显式收到（默认 `PLATFORM_FEE_BPS`）：P3/P4 换费率不必改账本（D4/D14），
   * 也让「补差不收手续费」这类业务规则在外层表达（`feeBps: 0`），而不是在这里写死。
   */
  async releaseEscrow(tx: Prisma.TransactionClient, input: EscrowReleaseInput): Promise<PostingResult> {
    const { fee, net } = computeFeeSplit(input.gross, input.feeBps ?? PLATFORM_FEE_BPS);
    const moves: MoneyMove[] = [];
    if (net > 0n) moves.push({ from: ESCROW_REF, to: availableRef(input.sellerId), amount: net });
    if (fee > 0n) moves.push({ from: ESCROW_REF, to: REVENUE_REF, amount: fee });
    return this.post(tx, {
      kind: TRANSACTION_KINDS.ESCROW_RELEASE,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId ?? null,
      moves,
    });
  }

  /**
   * ① 解析账户：**用户账户惰性创建、系统账户只查不建**（D2）。
   *
   * ## 为什么用户账户用 `ON CONFLICT DO NOTHING` 而不是 `SELECT … FOR UPDATE` + INSERT
   * 预检实测（C.17/C.19）：`SELECT … FOR UPDATE` **锁不住不存在的行**（没有行可锁），
   * 两个并发「没有就建」会撞唯一约束抛 P2002；而 `INSERT … ON CONFLICT DO NOTHING`
   * 三次并发得到 `1/0/0` 且最终 1 行——**安全**。这里要的就是「无论谁赢，之后行都在」。
   *
   * ## 为什么系统账户不在这里创建
   * `(owner_user_id, kind)` 上的唯一索引把 NULL 视为**互不相同**，因此惰性创建在库里
   * **拿不到**「一个 kind 一行」的保证。系统账户因此只由迁移种子化（D2），这里缺了就抛
   * ——那说明迁移没跑，而这句错误比「悄悄建了第二个 ESCROW 账户」有用得多。
   *
   * ## 为什么 id 在这里生成而不是靠数据库默认值
   * C4：主键是 UUIDv7，由**客户端**生成（与 `@default(uuid(7))` 一致，P1 的迁移注释里
   * 已确立「不要在库里加 `gen_random_uuid()` 兜底」）。而对**裸 SQL** 来说这不是风格问题：
   * 迁移里建的是 `"id" UUID NOT NULL`，**没有** `DEFAULT`（已核对
   * `20261006120000_p2_ledger/migration.sql` 的三条 `CREATE TABLE`）——`@default(uuid(7))`
   * 是 Prisma 查询引擎在客户端填的，`$executeRaw` 拿不到它。省掉 `uuidv7()` 会直接
   * 以 NOT NULL 违反失败。
   * `$executeRaw` 是**标签模板**，插值会变成绑定参数——C9 的 lint 门禁的那条字符串拼接
   * 路径在这里不可达。
   *
   * ## ★ 为什么 INSERT **只对确实不存在的账户**发（实测修正，偏离计划 Step 3 的字面写法）
   * 计划写的是「对每个用户账户无条件发一次 `INSERT … ON CONFLICT DO NOTHING`」。**实测**：
   * 当那一行正被另一个事务 `UPDATE` 时，这条 INSERT 会**等那个事务结束**
   * （唯一索引的冲突检测按行的 `xmin` 等锁；`pg_stat_activity` 实测
   * `wait_event = 'transactionid'`，阻塞语句逐字就是这条 INSERT）。
   * 代价有两条，第二条才是要紧的：
   * ① 它让**每一笔**过账在第一条语句上就被「同一个账户上的并发过账」串行化——一次没有
   *    任何目的的写入与等锁；
   * ② 它挡在条件更新（**真正的**并发权威，C25/D8）**前面**：于是「两笔并发各冻结 6000」
   *    的败者会在 INSERT 上等，等完再读快照 ⇒ 读到的是胜者**已提交**的余额、由纯核心的
   *    预判拦下（`stage = 'predicted'`）。结果就是 `conditional-update` 那条路
   *    **一次都走不到**，而「条件更新是并发权威」这句话在测试里**没有任何见证**。
   * 先读一次、只补缺的那些，就没有这个问题：账户已存在时本方法**不发任何写语句**，
   * 借方守卫因此是这笔过账遇到的第一个锁。
   * **惰性创建的安全性没有变**：并发「没有就建」依旧是 `INSERT … ON CONFLICT DO NOTHING`
   * （预检 C.19 实测 1/0/0），只是把它收窄到真正需要它的那一刻。
   */
  private async resolveAccounts(
    tx: Prisma.TransactionClient,
    moves: readonly MoneyMove[],
  ): Promise<(AccountRef & { id: string })[]> {
    const refs = new Map<string, AccountRef>();
    for (const move of moves) {
      refs.set(accountKey(move.from), normalizeRef(move.from));
      refs.set(accountKey(move.to), normalizeRef(move.to));
    }
    const wanted = [...refs.values()];

    for (const ref of wanted) {
      assertAccountKind(ref.kind); // C30：§8.1 之外的 kind 在这里就报出来
      const isSystem = SYSTEM_ACCOUNT_KINDS.includes(ref.kind);
      // 「kind」与「有没有 owner」是**绑定**的（§8.1 / D2）：用户 kind 必有 owner、系统 kind 必无。
      // 写反了（给系统账户安一个 owner，或用 §8.2 的 `SELLER_AVAILABLE` 冒充 kind）在这里就失败，
      // 而不是等到库里出现第二行 `(NULL, 'PLATFORM_ESCROW')`——那件事只有对账才看得见。
      if (isSystem !== (ref.ownerUserId === null)) throw new UnknownAccountKindError(ref.kind);
    }

    const where = { OR: wanted.map((ref) => ({ kind: ref.kind, ownerUserId: ref.ownerUserId })) };
    const select = { id: true, kind: true, ownerUserId: true } as const;
    const before = await tx.ledgerAccount.findMany({ where, select });

    const have = new Set(
      before.map((row) => {
        assertAccountKind(row.kind); // C30：从库里读回的 `kind` 同样必须落在 §8.1 的五个之内
        return accountKey({ kind: row.kind, ownerUserId: row.ownerUserId });
      }),
    );
    // 系统账户**只查不建**（D2：迁移是唯一的创建者）；用户账户只补缺的那些。
    const missing = wanted.filter(
      (ref) => !SYSTEM_ACCOUNT_KINDS.includes(ref.kind) && !have.has(accountKey(ref)),
    );
    for (const ref of missing) {
      await tx.$executeRaw`
        INSERT INTO "ledger"."accounts" ("id", "kind", "owner_user_id", "balance")
        VALUES (${uuidv7()}::uuid, ${ref.kind}, ${ref.ownerUserId}::uuid, 0)
        ON CONFLICT DO NOTHING
      `;
    }
    // 什么都没补时，上面那次读就是全部答案（少一次往返，也少一次快照）。
    const rows = missing.length === 0 ? before : await tx.ledgerAccount.findMany({ where, select });

    const byKey = new Map(
      rows.map((row) => {
        assertAccountKind(row.kind);
        return [accountKey({ kind: row.kind, ownerUserId: row.ownerUserId }), row] as const;
      }),
    );
    return wanted.map((ref) => {
      const row = byKey.get(accountKey(ref));
      // 这一句在实践中**只**可能为系统账户触发：用户账户在上面刚被「读 + 补缺」保证过
      // （要么本来就有一行，要么这一次插了进去 / 被并发插了进去）。错误消息因此说的是系统账户。
      if (!row) throw new SystemAccountMissingError(ref.kind);
      assertAccountKind(row.kind);
      return { kind: row.kind, ownerUserId: row.ownerUserId, id: row.id };
    });
  }

  /**
   * ④ 读快照（**同一事务内**）。没有它，纯核心的预判就只能靠猜余额。
   * 读出来的 `balance` 是 Prisma 的 `BigInt` → JS `bigint`，预检 A.2 实测**完全无损**
   * （含 `9007199254740993n` 与负数，`$queryRaw` 路径同样成立）。
   *
   * 参数是 **id 列表**（不是解析结果）：两扇门走到这里时都已经有 id 了——`post` 由
   * `resolveAccounts` 解析出来，`postLegs` 由调用方直接给出。
   */
  private async loadSnapshots(
    tx: Prisma.TransactionClient,
    accountIds: readonly string[],
  ): Promise<AccountSnapshot[]> {
    const rows = await tx.ledgerAccount.findMany({
      where: { id: { in: [...accountIds] } },
      select: { id: true, kind: true, ownerUserId: true, balance: true },
    });
    return rows.map((row) => {
      assertAccountKind(row.kind); // C30：从库里读回的 `kind` 同样必须落在 §8.1 的五个之内
      return { id: row.id, kind: row.kind, ownerUserId: row.ownerUserId, balance: row.balance };
    });
  }

  /**
   * ⑤ 落余额：**借方条件更新、以受影响行数为准**（C25 / D8），贷方无条件。
   *
   * ## 哪些借方带守卫 —— **只有注入端不带**（P2 最终审查 I1 的落点）
   * 名单来自 `account-kind.ts` 的 `mayGoNegative()`（**唯一**定义处），今天恰好只有
   * `EXTERNAL_TOPUP`：充值是把钱从系统之外注入账本，它必然越扣越负——给所有借方都加上
   * `balance >= x`，第一次充值就会失败（余额 0 扣 10000）。
   * 这与迁移里那条**条件化** CHECK 是同一条规则的两个落点，两处必须一致。
   *
   * ## ★ 这里此前漏掉了托管（I1：一条会**凭空付款**的路）
   * 原来的条件是 `isUserAccountKind(snapshot.kind)`，而 `PLATFORM_ESCROW` 是**系统** kind
   * ⇒ 托管账户的借方是**无条件**扣减。于是一次「释放得比锁进来的更多」的调用会把托管扣成
   * 负的、把差额付给卖家：平台付出了它从未持有的钱，而 Σ=0 成立、五条不变式全绿、对账全绿、
   * 审计也如实。审查逐条核过 `tests/` 里全部 7 个 `releaseEscrow` 调用点——**每一个释放的
   * 都恰好是它锁进来的**，也就是说这条规则此前没有任何见证。
   * 见证：`primitives.test.ts` 的「托管不透支」那条（超一分 ⇒ 拒绝、恰好等于 ⇒ 接受）。
   *
   * ## 为什么 `count !== 1` 就是「余额不足」
   * READ COMMITTED 之下，`UPDATE … WHERE balance >= x` 在拿到行锁之后会**重新求值**
   * 那个谓词（PostgreSQL 的 EvalPlanQual）。因此 count=0 的两种含义在这里是同一件事：
   * 「现在不够」与「我们读快照的时候还不够，且中间被别的事务改小了」。两者都是
   * 余额不足；把它区分开只会给出一个调用方无法据以行动的错误码。
   * 并发证据（预检 C.3 实测）：条件更新 ⇒ 影响行数 1/0、余额 400（正确）；
   * 读-判断-写 ⇒ 两笔都成功、余额 400 而实际扣了 1200（丢更新）。
   *
   * ## 为什么按金额排序
   * 先处理借方：**唯一会失败的那一半先失败**，错误信息与顺序无关（同事务，全部回滚）。
   * 这也让「哪一行先被加锁」是确定的——那条确定性并发用例依赖它。
   */
  private async applyBalances(
    tx: Prisma.TransactionClient,
    legs: readonly PostingLeg[],
    snapshots: readonly AccountSnapshot[],
  ): Promise<void> {
    const byId = new Map(snapshots.map((s) => [s.id, s]));
    const ordered = [...legs].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
    for (const leg of ordered) {
      const snapshot = byId.get(leg.accountId);
      if (!snapshot) throw new MissingAccountError(leg.accountId);
      if (leg.amount < 0n) {
        const needed = -leg.amount;
        const applied = await tx.ledgerAccount.updateMany({
          where: mayGoNegative(snapshot.kind)
            ? { id: leg.accountId }
            : { id: leg.accountId, balance: { gte: needed } },
          data: { balance: { decrement: needed } },
        });
        if (applied.count !== 1) {
          throw new InsufficientFundsError(leg.accountId, snapshot.kind, snapshot.balance, needed, 'conditional-update');
        }
      } else {
        await tx.ledgerAccount.update({ where: { id: leg.accountId }, data: { balance: { increment: leg.amount } } });
      }
    }
  }

  /**
   * ★ **账户行的全局锁序**（C35 / 控制器裁定 ⑧；预检 §B.1 第（3）条的实测）。
   *
   * ## 它修的是什么（实测复现，逐字）
   * 真实 `LedgerService` 的两笔**相反方向**过账（A→B 与 B→A）：
   * ```
   * [B4] S1 = {"code":"P2034","message":"\nInvalid `tx.ledgerEntry.createMany()` invocation …",
   *            "metaOrigin":"40P01","metaKind":"TransactionWriteConflict"}
   * ```
   * **死锁报在 `ledgerEntry.createMany()`**，不是余额更新——因为 `entries` 上有指向
   * `accounts` 的外键，插入子行会对被引用账户取 `FOR KEY SHARE`，而那**发生在
   * `applyBalances` 之前**。⇒ `applyBalances` 的「按金额升序、借方先」**不是全局锁序**，
   * 它连自己这条路径上的取锁点都没覆盖全。
   *
   * ## 为什么在**任何账户写入之前**一次性取全部行锁
   * 「按 id 排序再逐个取」是不够的：`createMany` 会在那之后以**自己的**顺序（腿的数组序）
   * 对被引用账户取 `FOR KEY SHARE`。但只要那些行**已经**被本次事务持有更强级别的锁
   * （`FOR UPDATE`），`FOR KEY SHARE` 就是一次**无等待**的加锁。因此顺序必须
   * **先取完、再动任何一行**——这就是这个方法在 `createMany` 与 `applyBalances` 之前的原因。
   *
   * ## ★ 据实记载一处**实测发现**：这条路径上的物理取锁顺序由 **SQL 的 `ORDER BY id`** 决定
   * 探针 `P-ORDER-DESC-INT` 实测（见 evidence 的探针矩阵）：把共享判据 `rowLockOrder` 的
   * 比较器**反过来**，账户侧的真库锁序见证**照样绿**——因为 `WHERE id = ANY($1::uuid[])` 的
   * 扫描顺序对 `FOR UPDATE` 没有约束力，真正定序的是那一句 `ORDER BY id`（`LockRows` 节点
   * 按排序后的输出顺序逐个加锁）。⇒ 这条路径上是**两个介质在表达同一个决定**：
   *   * JS 侧：`rowLockOrder` 负责**数组准备**（去重 + 字节升序，与资产侧**同一个函数**）；
   *   * SQL 侧：`ORDER BY id` 是**执行者**（PostgreSQL 的 `uuid` 比较 = 16 字节字典序）。
   * 两者给出的顺序**逐个相同**（十六进制小写定长文本上的字节序 = 16 字节字典序），由真库用例
   * 「两种介质上的同一条规则」断言。
   * **这一点不粉饰**：「一个实现、两个调用方」在账户侧因此**没有独立的判别力**——那条判别力
   * 只在资产侧（`P-ORDER-DESC-UNIT` 红）。保留两个介质是**刻意的纵深防御**：即使有人改坏了
   * JS 比较器，数据库这一层仍按 id 升序取锁。
   *
   * ## ★ 位置由**三次实测**定下来（据实偏离计划 Step 4 的字面位置）
   * 计划把调用点写在 `assertTransactionKind` 之后（读快照**之前**、事务行**之前**）。
   * 实测那一版会**改变两条既有语义**，两条都发生在 `postings.test.ts` 的确定性用例上：
   *
   * 1. **`conditional-update` 那条路不再被走到**：败者在读快照**之前**就卡在取锁上，
   *    等胜者提交之后才读 ⇒ 纯核心的预判先拦下它（`stage = 'predicted'`）。计划 Step 6
   *    明写这一条必须仍然成立（「若它变成了 predicted … 停下来报控制器」）。
   * 2. **「并发同键撞唯一索引（P2002）」那条路变成不可达**：两笔同键请求的腿相同 ⇒
   *    账户集相同 ⇒ 先卡在账户行锁上，胜者提交后败者重读就能看见那一行、
   *    直接走**重放**。于是 `runWithIdempotentRetry` 的 P2002 分支与
   *    `postings.test.ts` 里那条**唯一**见证它的用例一起失效（实测：那条用例红了）。
   *
   * ⇒ 本方法只需要「在**任何账户写入**之前取完」，而那两笔纯读（`findUnique` /
   * `loadSnapshots`）与那一次**不碰账户**的 `ledgerTransaction.create` 都不构成拦阻。
   * 因此调用点落在**事务行之后、`createMany` 之前**，三条性质同时成立（实测）：
   * ① 账户行锁按升序一次取完 ⇒ ABBA 消失；② 败者读到旧快照 ⇒ `conditional-update`
   * 仍是并发权威；③ 同键并发仍会撞唯一索引（它在账户行锁**之前**）⇒ P2002 与重放两条路
   * 都还在。**为什么不能再往后挪**（`createMany` 之后）：那一版会让两个事务各自先拿到
   * 对方的 `FOR KEY SHARE` 再互要 `FOR UPDATE`——而这两者是冲突的，死锁原样回来。
   *
   * ## 代价（据实记载）
   * 每一笔过账现在对涉及的每一个账户各发一条 `SELECT … FOR UPDATE`，而且这些锁
   * **持到 COMMIT**。P2 的 D8 选择「条件更新 + 受影响行数」的部分理由正是「不需要重试路径」
   * ——这条改动**不**推翻那个选择（条件更新仍是并发权威、仍不需要 SERIALIZABLE），
   * 但它承认了一件事：并发权威在**余额**那一层，而**取锁顺序**是另一层。
   *
   * ## 据实记载：仍有一处**未被排序**的取锁点（本任务不动它）
   * `resolveAccounts` 里那条 `INSERT … ON CONFLICT DO NOTHING` 发生在 `postLegs` **之前**，
   * 而它自己的顺序是 `wanted` 数组序。触发条件很窄：一次过账要**同时创建两个以上尚不存在的
   * 账户**，且两笔这样的过账以相反顺序创建同一组账户（两个全新用户之间的第一笔过账）。
   * 它的形状与 P2 实测过的那条「INSERT 等唯一索引」同源，而 P2 的收窄（先读、只补缺的）
   * 已经把它压到「账户真的不存在」那一刻。**修法是一行**（对 `missing` 排序之后再插入），
   * 但它不在 Task 4 的 Steps 里，且它需要自己的见证 ⇒ 交给控制器裁定，不就地改。
   */
  private async lockAccountRows(tx: Prisma.TransactionClient, accountIds: readonly string[]): Promise<void> {
    // 去重 + **升序**：与资产那一侧**同一个函数**（`common/db/lock-order.ts` 的
    // `rowLockOrder`；exchange 的 `lockOrder` 也是它）。**据实记载**：这条路径上真正定序的
    // 是下面那句 SQL 的 `ORDER BY id`（探针 `P-ORDER-DESC-INT` 实测：改这里的比较器不影响
    // 物理锁序）——这里的排序仍然要有（去重 + 让「意图」在数组上看得见），而两者是**同一条
    // 规则**（见上面那段长注释）。
    // `$queryRaw` 是标签模板 ⇒ 插值变成绑定参数（C9 那条 lint 门不可达）。
    const ordered = rowLockOrder(accountIds);
    if (ordered.length === 0) return;
    // 一条语句取完（`ORDER BY id` + `FOR UPDATE`）：PostgreSQL 在 `LockRows` 节点上按
    // 排序后的输出顺序逐个加锁，因此这一句本身就是「先取全部、按升序」的执行点。
    await tx.$queryRaw`
      SELECT id FROM ledger.accounts WHERE id = ANY(${ordered}::uuid[]) ORDER BY id FOR UPDATE
    `;
  }

  /**
   * 只读：用户的可用 / 冻结余额（路由用它回答「发放之后他的余额是多少」）。
   *
   * **「没有账户行」与「余额为 0」在这里等价**（D2 的落点）：余额只由账本推导，
   * 而账本的第一次写入必然先把行建出来，因此「没有行」只可能意味着「从来没有过钱」。
   * 把这两种状态合成一个返回值不是偷懒——分开表达会让每个调用方都要处理同一个
   * 「其实一样」的分支。
   *
   * ## 关于 `userId.toLowerCase()`（实测更正了一条**说错了的**注释）
   * 计划在这里写的是「先小写：UUID 在库里存的是小写（P1 的 `ownership.service` 在这里踩过）」。
   * **那句话在 `uuid` 列上不成立**：`owner_user_id` 的类型是 `uuid`，PostgreSQL 在输入时就
   * 把大小写归一化了，因此 `'ABC…'` 与 `'abc…'` 在库里是**同一个值**，比较与大小写无关。
   * 证据是探针 **p19**（把 `.toLowerCase()` 删掉）：**一条用例都不红**——这一句今天
   * **既没有见证、也没有作用**。
   * P1 踩到的那个坑在**纯核心**那一侧（`accountKey` 拿字符串当 Map 的键，`'ABC…' !== 'abc…'`），
   * 那里的小写归一化是**承重**的，并且有单测（Task 5 的探针 ak4 / ak5）。
   * 这里保留这一句只为一个理由：它是本模块「引用进账本就先归一化」这条约定的统一点
   * （`resolveAccounts` 走的是同一个 `normalizeRef`），删掉它会让两处的约定看起来不一致。
   * **据实记载**：它是一条约定，不是一条守卫。
   */
  async readBalances(
    client: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ available: bigint; frozen: bigint }> {
    const rows = await client.ledgerAccount.findMany({
      where: { ownerUserId: userId.toLowerCase(), kind: { in: [...USER_ACCOUNT_KINDS] } },
      select: { kind: true, balance: true },
    });
    const byKind = new Map(rows.map((row) => [row.kind, row.balance]));
    return {
      available: byKind.get(ACCOUNT_KINDS.USER_AVAILABLE) ?? 0n,
      frozen: byKind.get(ACCOUNT_KINDS.USER_FROZEN) ?? 0n,
    };
  }

  /**
   * 在**新事务**里跑一段账本调用；同一幂等键的**并发**冲突（P2002）重试一次（D9）。
   *
   * 为什么只需要一次重试，不需要退避、不需要计数：Postgres 会让第二个 `INSERT` 等第一个
   * 提交/回滚，然后以 23505 拒绝（预检 C.5 实测）。此刻那一行**已经提交**，因此重试必然
   * 走重放路径（`created:false`）——第二次尝试不可能再撞同一个键。这与
   * 「`SERIALIZABLE` 的 P2034 重试」是**两件事**：那条路 P2 不走（见 D8 的裁定，
   * 它写在规格 §8.5 里），`P2034` 在这里会原样抛出，不被当成重试信号。
   */
  async runWithIdempotentRetry<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
      return await this.prisma.$transaction(fn);
    }
  }
}

/** `transactions_idempotency_key` —— 幂等键的唯一索引名（迁移里逐字核对过，见下）。 */
const IDEMPOTENCY_CONSTRAINT = 'transactions_idempotency_key';

/**
 * 把任意外来值安全地变成字符串（判别器要在**不可信**的错误对象里找约束名）。
 *
 * **这个 helper 必须真的写出来**（自审第 8 条的同类：计划的判别器调用了一个仓库里
 * **不存在**的 `safeJson` —— 核对：`apps/` 与 `packages/` 下 `safeJson` 零匹配，
 * 照抄会以 `Cannot find name 'safeJson'` 让 `pnpm typecheck` 失败）。
 * 它自己**绝不能抛**：判别器的契约是「探不到就返回 false」（fail-closed）。
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value); // 循环引用 / 有 toJSON 会抛的对象：退化成 String
  }
}

/**
 * **只**认这一条约束的 P2002（D9）。
 *
 * 为什么必须窄：P2002 是「唯一约束被违反」这一类，把任何 P2002 都当成「重放」会把
 * 别的唯一冲突（主键重复、将来别的唯一索引）悄悄吞掉——那正是「静默去重」。
 * 实测的错误形态（预检 C.7）：`PrismaClientKnownRequestError` / `code = 'P2002'`，
 * 约束名在 `meta.driverAdapterError.cause.constraint.index` 或 message 里。
 * 两种来源都探，**探不到就返回 false**（fail-closed：不重试、不吞错）。
 *
 * ## 为什么 `IDEMPOTENCY_CONSTRAINT` 是**前缀**而不是全名
 * 库里那条唯一索引的真实名字是 `transactions_idempotency_key_key`（迁移逐字：
 * `CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "ledger"."transactions"("idempotency_key")`），
 * 而 Prisma 在某些路径上报的是 `idempotency_key` / 约束名两种拼法之一。判别器用
 * **子串**判，两种都认得；而它要拒绝的是**别的**约束（`accounts_owner_user_id_kind_key`
 * 之流），那些名字里不含这个子串——这条边界由反例用例守着。
 */
export function isIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== 'P2002') return false;
  const meta = (error as { meta?: unknown }).meta;
  const text = safeJson(meta) + '|' + String((error as { message?: unknown }).message ?? '');
  return text.includes(IDEMPOTENCY_CONSTRAINT);
}
