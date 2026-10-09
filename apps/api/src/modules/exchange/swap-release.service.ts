import { Injectable } from '@nestjs/common';
import { withBoundedConflictRetry } from '../../common/db/retryable-conflict.js';
import { PrismaService } from '../../db/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  AccessGrantService,
  AssetLockService,
  AssetNotFoundError,
  OwnershipService,
} from '../asset/index.js';
import { AuditService } from '../audit/index.js';
import { LedgerService } from '../ledger/index.js';
import { CommitmentMismatchError, SwapSelfOfferError, UnknownExchangeObjectError } from './core/errors.js';
import { exchangeKey } from './core/idempotency.js';
import { lockPair } from './core/lock-order.js';
import { assertContractTransition, contractStatusOf } from './core/state-machine.js';
import { CONTRACT_STATUSES } from './core/types.js';
import { ObligationService } from './obligation.service.js';

/**
 * 争议期（§8.4:401「7 天无申诉 ⇒ 自动确认」）。
 *
 * 与 `OFFER_TTL_HOURS`（72 小时）/ `CONTRACT_LOCK_HOURS`（24 小时）同一纪律：
 * **期限是显式常量 + 落库的时刻**，而不是让 `+ interval '7 days'` 出现在查询里
 * （`schema.prisma` 的 `disputeDeadlineAt` 注释逐字说明）。Task 10 的自动确认计时器
 * （`dueContractActions` 读 `disputeDeadlineAt`）与这里用的是**同一个数**，
 * 因此它必须能被 import 到，而不是各写一份。
 */
export const DISPUTE_WINDOW_DAYS = 7;

/** 一天的毫秒数（**唯一**一处：`addDays` 与用例的时间差断言共用它）。 */
const DAY_MS = 24 * 3_600_000;

/**
 * ★ 一次释放的结果（§6.3:294 的命题本体；计划 Step 3 的接口行）。
 *
 * `releasedNow` 是**本次调用**真的把状态从 `VALIDATING` 推到了 `RELEASED` 吗 ——
 * 它与「合约现在是不是 `RELEASED`」是两件事，而调用方需要区分的正是这个：
 * 一次网络重试（或一次并发释放的败者）拿到 `false`，它**不该**把响应的其余部分
 * （`transactionIds`）读成「这次锁了一笔托管」。
 */
export interface ReleaseResult {
  readonly contractId: string;
  readonly status: string;
  /** 补差那一笔的账本交易 id（`topUpAmount === 0` 时是空数组）。 */
  readonly transactionIds: readonly string[];
  /** 本次调用真的完成了释放 ⇒ `true`；幂等重放 / 并发败者 ⇒ `false`。 */
  readonly releasedNow: boolean;
}

/**
 * 事务里读出来的合约（**六个承诺列 + 补差两列 + 四个 id**，一次读全）。
 *
 * 承诺列经 `offer` 关系读（同 schema，**不违反 C5**）；`offered*` 是**提议方**那一侧
 * （`swap_offers` 上，写于 `propose` 那一刻），`target*` 是**接受方**那一侧
 * （`swap_contracts` 上，写于 `accept` 那一刻）。
 */
interface LoadedContract {
  readonly id: string;
  readonly status: string;
  readonly partyAId: string;
  readonly partyBId: string;
  readonly assetAId: string;
  readonly assetBId: string;
  readonly topUpAmount: bigint;
  readonly topUpPayerId: string | null;
  readonly targetVersionId: string | null;
  readonly targetSha256: string | null;
  readonly targetDossierDigest: string | null;
  readonly offeredVersionId: string | null;
  readonly offeredSha256: string | null;
  readonly offeredDossierDigest: string | null;
}

/** 已经走过（或越过）`RELEASED` 的状态：幂等重放不再动任何一行。 */
const ALREADY_RELEASED: ReadonlySet<string> = new Set([
  CONTRACT_STATUSES.RELEASED,
  CONTRACT_STATUSES.SETTLED,
  CONTRACT_STATUSES.DISPUTED,
]);

/**
 * ★★ **原子释放**（P3 / Task 8）—— §6.3:294 的命题本体。
 *
 * 设计 §6.3:294 逐字：「**`RELEASED` 必须在单一数据库事务内完成**，任何异常必须完全回滚，
 * 不留半成品所有权。**这是本平台最核心的技术命题。**」
 *
 * ## 一个事务里的七件事（预检 §B.2 逐字）
 * 「一个事务里装下了『两个作品的所有权指针 + 两行 append-only 历史 + 补差/成交的托管两腿
 * + 手续费腿 + 一行审计 + 幂等键』」——本实现的逐项落点：
 *
 * | # | 那一件事 | 落在哪 |
 * |---|---|---|
 * | 1 | 两件作品的所有权指针 | `ownership.transferOwnership(tx, …)` × 2（Task 1 的接口） |
 * | 2 | 两行 append-only 历史 | 同上（同一次调用里，`ownership_history`） |
 * | 3 | 双方访问权（§9:472） | `AccessGrantService.grant(tx, …)` × 2（D11 的「推」） |
 * | 4 | 补差进托管（C31：**不动钱**，只 `ESCROW_LOCK`） | `ledger.lockToEscrow(tx, …)`，`feeBps` 不适用（C32/D7） |
 * | 5 | 义务行（不变式 #4 的右式） | `obligations.record(tx, …)`（`(producer, key)` 唯一索引） |
 * | 6 | 一行审计 | `audit.record(…, tx)`（**显式传 tx**） |
 * | 7 | 幂等键 | `exchangeKey('lock', contractId)`（确定性派生，Task 3） |
 *
 * **七件事一起滚**（§13.3 的验收判据）：`tests/integration/exchange/atomic-release-rollback.test.ts`
 * 在最后一件事之后注入一次异常，断言 `ownerA` / `ownerB` / `escrow` / `audits` / `entries`
 * / `transactions` / `history` **逐项与释放之前相同**。
 *
 * ## 为什么「单一事务」在这条路径上是**可建**的（预检 §0.1 的证伪与它的修复）
 * 预检用一条决定性构造证明过：P1 的 `transferOwnership` **自开事务**时，
 * 「账本回滚、所有权不滚」的释放可以构造出来（`[B6]`：外层回滚之后 `owner_id` 真的改了、
 * `history` 真的多了一行）。Task 1 因此把它的第一个参数改成**必填的事务客户端**
 * 并加了 `$connect` 否定约束 —— `PrismaService` 从此**不**满足它（编译期拒收），
 * 于是「忘了传 tx」不是一条测试才发现的事，而是一行红波浪线。
 * 本服务因此拿得到一条**结构上**装得下七件事的 `tx`。
 *
 * ## 顺序（每一次取锁都是承重的）
 * ```
 * ① 读合约（无锁）→ 幂等短路（已经是 RELEASED/SETTLED/DISPUTED ⇒ 直接返回）
 * ② `lockAssets`（C35：**先取全部行锁，再动任何一行**；Task 7 已在同一持有者名下锁过 ⇒ 幂等放行）
 * ③ ★ **取锁之后重读一次状态**（并发败者的判据，见下）
 * ④ 读两件作品的当前所有人 ⇒ 同一个人 ⇒ `SwapSelfOfferError`（在任何写之前）
 * ⑤ 增量 A-8：核六个承诺列（版本存在 + `sha256` 一致 + 钉住值非空）
 * ⑥ 两笔 `transferOwnership`（指针 + 历史）
 * ⑦ 两行访问权授予
 * ⑧ 补差进托管（`ESCROW_LOCK`）+ 义务行
 * ⑨ 状态置 `RELEASED` + `disputeDeadlineAt = releasedAt + 7 天`
 * ⑩ 一行审计（**最后一件事**：回滚用例把失败注入在这里）
 * ```
 *
 * ## ★ ③ 为什么存在（计划 Step 3 骨架里的一个**空洞**，据实记载）
 * 计划的骨架把状态推进放在**最后**、且只在那里做 `where status` 守卫。那在**并发**
 * 双释放时的行为是错的：败者在 ② 处被 C35 的行锁挡住，等胜者提交之后它继续往下走，
 * 而它读到的当前所有人**已经是交换之后**的 ⇒ 第一笔 `transferOwnership` 的
 * `toUserId` 恰好等于 `fromUserId` ⇒ 它撞上 P1 的 `SelfTransferRejectedError`（409），
 * **而「同一个合约只能释放一次」这件事本该是一次幂等重放**（`releasedNow: false`）。
 * ⇒ 修法不是在转让里加特例，而是**在取锁之后重读一次状态**：C35 已经让两次释放
 * 串行化了，因此那个重读看到的必然是**已提交的**事实。判据位置与「任何写之前」一致。
 * 见证：`concurrency.test.ts` 的「真并发双释放 ⇒ 恰好一次 `releasedNow: true`」。
 *
 * ## C31：`RELEASED` **不动钱**
 * 本服务**只**调 `lockToEscrow`（补差进托管），`releaseEscrow` 一次都不调 ——
 * 钱在 `SETTLED` 才动（Task 10）。理由（控制器裁定 ②）：争议期只有在钱还冻着时才有意义。
 * 见证：`atomic-release.test.ts` 的「接收方可用余额与平台收入都不变」。
 *
 * ## 重试（C36）：判别式认两档，重试的是**同一个幂等键**
 * `$queryRaw`（`lockAssets` / `transferOwnership` 的 `FOR UPDATE`）⇒ `P2010`；
 * Prisma 委托（`swapObligation.create` / `swapContract.updateMany`）⇒ `P2034`。
 * 两者都可能出现在这条路径上，而重试包住的是**整个事务**（死锁中止的是事务，
 * 在它内部重试没有意义）。幂等**由构造保证**：所有写都由状态守卫或确定性键保护，
 * 因此第二次走到同一个位置时不会重复任何一件事。
 *
 * ## 它**不**做什么（边界，写给下一个读它的人）
 *   * **不结算**（`releaseEscrow` / 手续费）—— Task 10；
 *   * **不写 `DISPUTED` / `SETTLED`** —— Task 10；
 *   * **不建路由**（§9 的矩阵里没有 `SwapContract release` 这一行；矩阵缺行时按
 *     P2 `Ledger.grant` 的处置取「最保守并且在今天可判定的一档」，而这里的调用方
 *     是**服务层**：Task 10 的自动确认与将来的管理员动作。加路由 = 一次设计裁定）。
 */
@Injectable()
export class SwapReleaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: AssetLockService,
    private readonly owners: OwnershipService,
    private readonly access: AccessGrantService,
    private readonly ledger: LedgerService,
    private readonly obligations: ObligationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 释放一份合约（§6.3:294）。**幂等**：同一份合约释放两次，第二次不动任何一行。
   *
   * @param contractId 合约 id。
   * @param actorId 当事人（审计的 `actorId`）。`null` = 系统动作（Task 10 的计时器路径）；
   *   本服务**不**判当事人 —— 判定属于路由层的策略条件（§9 的矩阵），
   *   而这里今天没有路由（见类注释末条）。
   */
  async releaseContract(contractId: string, actorId: string | null): Promise<ReleaseResult> {
    return withBoundedConflictRetry(() =>
      this.prisma.$transaction((tx) => this.releaseInTx(tx, contractId, actorId), { timeout: 20_000 }),
    );
  }

  /** 事务内的释放（**唯一**的写入路径：`releaseContract` 只负责包重试）。 */
  private async releaseInTx(
    tx: Prisma.TransactionClient,
    contractId: string,
    actorId: string | null,
  ): Promise<ReleaseResult> {
    // ── ① 读合约（**无锁**）＋ 幂等短路 ────────────────────────────────────────
    const contract = await this.loadContract(tx, contractId);
    if (ALREADY_RELEASED.has(contract.status)) {
      return { contractId, status: contract.status, transactionIds: [], releasedNow: false };
    }
    // 闭集外的 status ⇒ 422；§6.3 的图上没有这条边 ⇒ 409
    // （`PENDING_BOTH_LOCK → RELEASED` **不是**一条边：中间那一格是 `VALIDATING`）。
    assertContractTransition(contractStatusOf(contract.status), CONTRACT_STATUSES.RELEASED);

    // ── ② 全局锁序（C35）：先取全部行锁，再动任何一行 ──────────────────────────
    // `lockPair` 把两个 id 排成升序；`lockAssets` 用**一条** `SELECT … ORDER BY id
    // FOR UPDATE` 取完全部行锁。Task 7 的 `confirmLock` 已经把这两行锁在**同一个**
    // 持有者名下 ⇒ 这里是一次幂等放行（判据是「持有者相等」而不是「已锁」）。
    const [first, second] = lockPair(contract.assetAId, contract.assetBId);
    await this.locks.lockAssets(tx, [first, second], contractId);

    // ── ③ 取锁之后**重读状态**：并发双释放的败者在这里返回幂等结果 ──────────────
    // 见类注释里那段「③ 为什么存在」：C35 已把两次释放串行化，因此这次重读看到的
    // 必然是胜者**已提交**的事实，而败者必须返回 `releasedNow: false` 而不是
    // 在第一笔转让上撞 `SelfTransferRejectedError`。
    const afterLock = await this.loadContract(tx, contractId);
    if (ALREADY_RELEASED.has(afterLock.status)) {
      return { contractId, status: afterLock.status, transactionIds: [], releasedNow: false };
    }

    // ── ④ 两件作品的当前所有人必须是**两个不同的人**（在任何写之前）─────────────
    // 预检 §B.3 点名的组合风险：「交换的语义天然包含『转给对手方』」，而两件作品都属于
    // 同一个人时，第一笔转让之后第二笔会撞上 P1 的 `SelfTransferRejectedError`（409）
    // —— 行为是对的（事务回滚、七个量一起滚），**只是错误因由说错了话**。
    // ⇒ 判在这里，用一个更准确的因由（`SwapSelfOfferError`：这次交换不成立）。
    const owners = await this.ownersOf(tx, contract.assetAId, contract.assetBId);
    if (owners.ownerA === owners.ownerB) throw new SwapSelfOfferError(owners.ownerA);

    // ── ⑤ 增量 A-8：核六个承诺列 ─────────────────────────────────────────────
    await this.assertCommitmentsMatch(tx, contract);

    // ── ⑥ 两笔转让：指针 + 历史（Task 1 的 `tx` 必填接口）──────────────────────
    // 朝向由**合约**决定（`assetAId` 是被要约作品、`partyAId` 是它的原所有人）：
    // A 的作品归 B，B 的作品归 A。★ 计划 Step 3 的骨架在这里写反了
    // （它把 `assetAId` 转给 `partyAId`，那是**自转**，会立刻抛 `SelfTransferRejectedError`）
    // —— 据实记载这处修正，理由与证据写在任务报告里。
    const reason = `交换释放：合约 ${contractId}`;
    const transferA = await this.owners.transferOwnership(tx, {
      assetId: contract.assetAId,
      toUserId: contract.partyBId,
      reason,
    });
    const transferB = await this.owners.transferOwnership(tx, {
      assetId: contract.assetBId,
      toUserId: contract.partyAId,
      reason,
    });
    //  `transferOwnership` 自己的 `SELECT … FOR UPDATE` 与 ② 取的是**同一行、同一顺序**
    //  ⇒ 无等待的重复加锁（`FOR UPDATE` 对已持有者是幂等的，PostgreSQL 直接放行）。

    // ── ⑦ 对手方访问权（§9:472 的中间那一档；D11 的「推」）────────────────────
    // 两条都要给：A 拿到作品 B 的访问权，B 拿到作品 A 的。**转让本身已经让新所有人
    // 过 `checkAccess` 的第一档**，因此这两行是为「转让之后再转让」留的
    // （前手仍需在争议期内能下载自己的交付物）——据实记载：今天没有一条用例依赖后者，
    // 但 §9:472 的措辞是「交换对手方」，而不是「当前所有人」。
    const source = `swap-contract:${contractId}`;
    await this.access.grant(tx, contract.assetBId, contract.partyAId, source);
    await this.access.grant(tx, contract.assetAId, contract.partyBId, source);

    // ── ⑧ 补差进托管（C31：**只 LOCK，不 RELEASE**）＋ 义务行 ──────────────────
    const transactionIds: string[] = [];
    if (contract.topUpAmount > 0n) {
      // 条件化 CHECK（`swap_contracts_top_up_payer_bound`）保证「有金额 ⇔ 有付款人」，
      // 因此这一支**不该**走到。写出来是 fail-closed：静默跳过会让一次「有补差」的
      // 释放**不锁任何钱**，而它看起来完全成功（那正是 §0.3 那一类「没人看得见」的缺陷）。
      if (contract.topUpPayerId === null) {
        throw new Error(
          `合约 ${contractId} 的 top_up_amount = ${contract.topUpAmount.toString()} 而 top_up_payer_id 为空`,
        );
      }
      const locked = await this.ledger.lockToEscrow(tx, {
        buyerId: contract.topUpPayerId,
        amount: contract.topUpAmount,
        // ★ 确定性幂等键（Task 3）：`exchange:lock:{contractId}`。它同时是 C31 与
        //   「释放两次不会真的再锁一笔」的执行点（预检 §A.5：键里带时间戳的实现在
        //   第二次会**真的再锁一笔**，而所有不变式与对账都是绿的）。
        idempotencyKey: exchangeKey('lock', contractId),
        actorId,
      });
      transactionIds.push(locked.transactionId);
      // 义务行在**过账之后**：它登记的金额是刚才真的进托管的那一笔（顺序见 `ObligationService`）。
      await this.obligations.record(tx, { contractId, amount: contract.topUpAmount });
    }

    // ── ⑨ 状态推进 + 争议期截止（`releasedAt + 7 天`）──────────────────────────
    const now = new Date();
    const released = await tx.swapContract.updateMany({
      // 状态守卫：`VALIDATING` 是 §6.3 里**唯一**通向 `RELEASED` 的那一格
      // （计划骨架写的是 `in: ['PENDING_BOTH_LOCK','VALIDATING']`，而那多出来的一格
      //  与 `CONTRACT_TRANSITIONS` 直接矛盾 —— 那条边在图上不存在，据实修正）。
      where: { id: contractId, status: CONTRACT_STATUSES.VALIDATING },
      data: {
        status: CONTRACT_STATUSES.RELEASED,
        releasedAt: now,
        disputeDeadlineAt: new Date(now.getTime() + DISPUTE_WINDOW_DAYS * DAY_MS),
      },
    });
    if (released.count !== 1) {
      // 走到这里说明**在 ③ 与 ⑨ 之间**有人把这一行推走了（③ 的重读之后、⑨ 之前的窗口
      // 只可能是本次事务自己在等锁时被别的写者插队 —— 而 C35 的行锁已经把它排除了）。
      // 因此这一支是**兜底**：它返回幂等结果而不是抛错（「同一条合约只能释放一次」），
      // 而它与 ③ 的区别由 `releasedNow` 表达（两者都是 `false`）。
      return { contractId, status: CONTRACT_STATUSES.RELEASED, transactionIds, releasedNow: false };
    }

    // ── ⑩ 审计（**显式传 tx**；最后一件事，回滚用例的注入点就在这里）─────────────
    // 预检 §B.2 第 2 条：「P3 的三条路径（释放 / 自动确认 / 争议回退）各自都要有一条
    // 『回滚后审计 0 行』的独立断言，不能折进总数核对」——释放那一条在本服务上。
    await this.audit.record(
      {
        actorId,
        action: 'exchange.contract_released',
        resource: 'SwapContract',
        resourceId: contractId,
        metadata: {
          // bigint 不进 JSON（C22）：金额一律十进制字符串。
          topUpAmount: contract.topUpAmount.toString(),
          fromA: transferA.fromUserId,
          toA: transferA.toUserId,
          fromB: transferB.fromUserId,
          toB: transferB.toUserId,
        },
      },
      tx,
    );

    return { contractId, status: CONTRACT_STATUSES.RELEASED, transactionIds, releasedNow: true };
  }

  /** 读合约（**无锁**：它的写由条件更新与 ② 的行锁保护）或 404。 */
  private async loadContract(tx: Prisma.TransactionClient, contractId: string): Promise<LoadedContract> {
    const row = await tx.swapContract.findUnique({
      where: { id: contractId },
      select: {
        id: true,
        status: true,
        partyAId: true,
        partyBId: true,
        assetAId: true,
        assetBId: true,
        topUpAmount: true,
        topUpPayerId: true,
        targetVersionId: true,
        targetSha256: true,
        targetDossierDigest: true,
        // 提议方那一侧的三个承诺列住在**同一个 schema** 的要约行上（C5 允许关系读）。
        offer: {
          select: { offeredVersionId: true, offeredSha256: true, offeredDossierDigest: true },
        },
      },
    });
    if (row === null) throw new UnknownExchangeObjectError('contract', contractId);
    const { offer, ...rest } = row;
    return {
      ...rest,
      offeredVersionId: offer.offeredVersionId,
      offeredSha256: offer.offeredSha256,
      offeredDossierDigest: offer.offeredDossierDigest,
    };
  }

  /**
   * 两件作品的**当前所有人**（一次读两行）。
   *
   * 作品不存在**不**折进「两个 undefined 相等」那一支：那会把一次 `AssetNotFoundError`
   * （404）伪装成一次「这次交换不成立」（409）。判据因此显式地分开。
   */
  private async ownersOf(
    tx: Prisma.TransactionClient,
    assetAId: string,
    assetBId: string,
  ): Promise<{ readonly ownerA: string; readonly ownerB: string }> {
    const rows = await tx.asset.findMany({
      where: { id: { in: [assetAId, assetBId] } },
      select: { id: true, ownerId: true },
    });
    const ownerOf = (assetId: string): string | undefined =>
      rows.find((row) => row.id === assetId)?.ownerId;
    const ownerA = ownerOf(assetAId);
    const ownerB = ownerOf(assetBId);
    if (ownerA === undefined) throw new AssetNotFoundError(assetAId);
    if (ownerB === undefined) throw new AssetNotFoundError(assetBId);
    return { ownerA, ownerB };
  }

  /**
   * ★ 增量 A-8（规格 §5.2 校验点 1）：**在同一个事务里、任何写之前**核对六个承诺列。
   *
   * ## 它买的是什么（**据实划界，不要把它宣传成拦截**）
   * 规格 §5.2 逐字：「**据实划界**：今天版本不可删、制品不可改，所以校验点 1 在正常路径上
   * **总是通过**。它的价值是证据与将来（一旦有人加了删除/替换能力，这里就是执行点）。」
   * ⇒ 它在今天**不是**一道拦截（没有一条真实攻击路径被它挡住），而是一条**执行点**：
   * 加删除/替换能力的那一次改动会让它第一次真的承重。
   *
   * ## 三条判据，逐条说清今天的能力边界
   *   ① **钉住的版本仍然存在**：`asset_versions.id` 命中 ⇒ 通过（见证：删掉那一行 ⇒ 拒绝）；
   *   ② **它的 `sha256` 与钉住值一致** ⇒ 通过（见证：改那一行 ⇒ 拒绝）；
   *   ③ **dossier 重放摘要一致** —— **今天做不到重放**：重放要 `canonicalizeDossier()`，
   *      而那是**增量 A-9（Task 9）**的交付物（Task 6 的 `offered_dossier_digest` 因此
   *      是「调用方声明的期望值」，`exchange.service.ts` 的 `ProposeOfferInput` 注释里
   *      已经据实记过这道信任缺口）。本任务**不替 A-9 实现它**（那会把 Task 9 的核心
   *      提前写掉，且两处各写一份序列化 = 规格 §6.3 禁止的形状）。
   *      ⇒ 今天这一条落地的是它的**fail-closed 半边**：钉住值必须**非空**
   *      （NULL = 这一行从来没有承诺过，那样的一次释放无法成为可辩护的事实）。
   *      **复访触发条件**：A-9 落地 `dossierDigestOf(versionId)` 之后，把下面那两处
   *      「非空」换成「重放摘要相等」——两行改动 + 一条新用例，而 `CommitmentMismatchError`
   *      与错误映射一个字都不用改（它们已经在了）。
   *
   * ## 为什么读的是**行**而不是**制品字节**（"可读"的边界）
   * 规格写的是「版本仍存在、**可读**」。今天这里读的是 `asset_versions` 那一行 ——
   * 「制品字节可读」是**下载路径**的判据（它必须跑完整归档校验，C37/§C.3 的实测：
   * tar.gz 的部分读取对整块截断是瞎的），在释放路径上重跑一遍会把一次 60 MB 的解密
   * 搬进一个事务里。⇒ 两条路径各自只证明自己那一半，这处边界据实记载。
   */
  private async assertCommitmentsMatch(tx: Prisma.TransactionClient, contract: LoadedContract): Promise<void> {
    await this.assertPinnedVersion(tx, 'offered_version', contract.offeredVersionId, contract.offeredSha256);
    await this.assertPinnedVersion(tx, 'target_version', contract.targetVersionId, contract.targetSha256);
    // ③ 的 fail-closed 半边（见方法注释：重放比对属 A-9）。
    if (contract.offeredDossierDigest === null) {
      throw new CommitmentMismatchError('offered_dossier', '提议方那一侧没有钉住 dossier 摘要（这一行没有承诺）');
    }
    if (contract.targetDossierDigest === null) {
      throw new CommitmentMismatchError('target_dossier', '接受方那一侧没有钉住 dossier 摘要（这一行没有确认）');
    }
  }

  /** ① 版本仍在 + ② `sha256` 一致（两个方向共用一份判据，分档只体现在 `field` 上）。 */
  private async assertPinnedVersion(
    tx: Prisma.TransactionClient,
    field: string,
    versionId: string | null,
    sha256: string | null,
  ): Promise<void> {
    if (versionId === null || sha256 === null) {
      throw new CommitmentMismatchError(field, '没有钉住版本（这一行没有承诺）');
    }
    const version = await tx.assetVersion.findUnique({
      where: { id: versionId },
      select: { sha256: true },
    });
    // ① 版本不存在（今天不可能：没有任何删除路径 —— 而这一支正是「一旦有人加了删除能力，
    //    这里就是执行点」那句话的落点）。
    if (version === null) {
      throw new CommitmentMismatchError(field, `钉住的版本不存在：${versionId}`);
    }
    // ② 摘要不一致（今天不可能：`asset_versions.sha256` 是 write-once 的）。
    if (version.sha256 !== sha256) {
      throw new CommitmentMismatchError(field, `sha256 与钉住值不一致：钉住 ${sha256}，库里 ${version.sha256}`);
    }
  }
}
