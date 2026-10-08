import { Injectable } from '@nestjs/common';
import { withBoundedConflictRetry } from '../../common/db/retryable-conflict.js';
import { PrismaService } from '../../db/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AssetAccessService, AssetLockService } from '../asset/index.js';
import { AuditService } from '../audit/index.js';
import { eligibilityOf } from './core/eligibility.js';
import {
  ExpiredExchangeWindowError,
  IneligibleAssetError,
  InvalidExchangeTransitionError,
  UnknownExchangeObjectError,
} from './core/errors.js';
import { assertContractTransition, bothLocked, contractStatusOf } from './core/state-machine.js';
import { lockWindowExpired } from './core/timers.js';
import { CONTRACT_STATUSES, type ContractSnapshot } from './core/types.js';
import type { ConfirmLockResponse } from './dto.js';

/**
 * `confirmLock` 的返回（§9:478）。
 *
 * **形状只有一处定义**：`dto.ts` 的 {@link ConfirmLockResponse}（`exchange` 的响应形状
 * 都在那里，与 `ProposeOfferResponse` / `ContractView` 同一纪律）。
 * 这个名字是简报接口行逐字要求的那个具名导出——它**是**那个形状，不是第二份定义。
 * `bothLocked` 是**派生值**（= 合约上两个时间戳都非空），不是「这一次调用有没有让它推进」：
 * 一份在双方确认之前被取消的合约上返回 `true` 会让响应说一件不成立的事。
 */
export type ConfirmedLock = ConfirmLockResponse;

/** 合约在事务里的完整快照：`ContractSnapshot` 的七个字段 + 本案要用的四个 id。 */
interface ContractRow extends ContractSnapshot {
  readonly id: string;
  readonly partyAId: string;
  readonly partyBId: string;
  readonly assetAId: string;
  readonly assetBId: string;
}

/**
 * 双锁与 `VALIDATING`（P3 / Task 7；§6.3:283-286）。
 *
 * ## 这一块回答的是「双方同意了吗」，而它**不**回答「东西换过去了吗」
 *
 * `PENDING_BOTH_LOCK` →「双方均锁定（资产变为不可编辑 / 不可另行上架 / 不可删除）」
 * → `VALIDATING` →「平台校验双方制品完整性」→ `RELEASED`。
 *
 * 它**不做所有权转移、也不动钱**——那些是 Task 8 的事（§6.3:294 的命题本体，C31）。
 * 这条边界是刻意的：一个 reviewer 完全可以接受「双方确认 + 校验通过之后合约进入
 * 下一步」而拒绝「释放时的资金语义」，**两件事各自有独立的拒绝面**。
 *
 * ## ★ 状态推进只到 `VALIDATING`：`RELEASED` 是 Task 8 的（一处计划自相矛盾的据实修正）
 *
 * 计划的接口注释写着 `validate()`「通过 ⇒ `RELEASED`」。**那句话会让 Task 8 的释放
 * 静默地什么都不做**：`release()` 的第一条判据是
 * `if (contract.status === 'RELEASED' | 'SETTLED' | 'DISPUTED') return { releasedNow: false }`
 * （幂等重放）——一份被 Task 7 写成 `RELEASED` 的合约，所有权**一次都不会换**，
 * 而且不会有任何断言变红（那份合约看起来「已释放」）。
 * ⇒ 写下 `RELEASED` 的那一处必须是**同一个事务里同时做完所有权 + 访问权 + 补差托管**
 * 的那一处（Task 8）。本服务的落点是 `VALIDATING`，「通过」这件事由 `validate()`
 * 的**判决**报出来（`eligible: true`），不由状态表达。
 *
 * ## 取锁顺序（C35 + 预检 §B.1）：为什么这里**不会**成环
 *
 * 本服务的取锁顺序是**固定**的：先「合约行」（`updateMany` 的委托写），再「作品行」
 * （`AssetLockService` 里那条 `ORDER BY id … FOR UPDATE`）。
 * 因此**它可能成为死锁环里的一员**（它持有一把锁再去要另一把），
 * 而 `withBoundedConflictRetry` 正是为这一档准备的（C36；Task 7 是它的第一个正当消费者）。
 *
 * ## 与 `cancel` 的差别（为什么只有 `confirmLock` 包了重试）
 * `cancel` 的取锁集合是「合约行 → 审计行」，而它在取合约行之前**不持有任何行锁**
 * （前两条语句都是读）⇒ 它阻塞在**第一条写语句**上，不满足「持有 A 又要 B」这个成环前提。
 * ⇒ 不包重试是**结构性**的，不是省事。**复访触发条件**：Task 8 的释放路径
 * （资产行 → 合约行的**相反**顺序）落地之后，`cancel` 与它之间的交错才可能成环，
 * 那一条由 Task 8 自己包（C36 的第二档在那里第一次真的用上）。
 */
@Injectable()
export class SwapContractService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: AssetLockService,
    private readonly assets: AssetAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * §9:478 的 `confirmLock`：本人在 24 小时内确认锁定。
   *
   * ## 顺序（每一步都在同一个事务里，且顺序是承重的）
   * 1. 读合约（**无锁**：它的写由下一句的 `UPDATE … WHERE status = …` 保护）；
   * 2. 当事人判定（**自足**：不假设路由层的条件已经判过）；
   * 3. 非 `PENDING_BOTH_LOCK` ⇒ **幂等重放**：返回当前状态而**不抛错**
   *    （一次网络重试不该看起来像一次非法迁移）；
   * 4. 24 小时的判据：`lockWindowExpired(contract, now)` ⇒ `ExpiredExchangeWindowError`；
   * 5. 写**本人**那一侧的时间戳：`updateMany(where status = 'PENDING_BOTH_LOCK' AND 本侧为 NULL)`
   *    —— 与 P2 的 D8 同一条纪律：**并发权威是受影响行数**，不是「读-判断-写」。
   *    那个 `IS NULL` 守卫让**重放不推后**第一次确认的时刻（时间戳记的是「他什么时候按的」）；
   * 6. 两人都锁上了 ⇒ `lockAssets`（按全局锁序）⇒ 状态置 `VALIDATING` ⇒ 一行审计。
   *
   * ## 为什么「两人都锁上」与「推进到 VALIDATING」在同一个事务里
   * 分开会让一个中间的瞬态可被观察到：两人都锁了、资产也锁了，而状态还是
   * `PENDING_BOTH_LOCK` —— 此时第三个请求（或计时器）能走一条不该走的路。
   *
   * ## 资格判决必须在**提交之后**算
   * §6.1 第 2 条不通过时，合约要**停在** `VALIDATING`（D8：不自动取消）。
   * 在事务里抛会把「锁 + 时间戳 + 状态推进」一起回滚掉，于是合约留在
   * `PENDING_BOTH_LOCK` 而锁没了 —— 那不是设计要的形状。
   * ⇒ 事务只做「锁定 + 推进」，判决在提交之后按**已提交的**事实算（见 `verdictOn`）。
   *
   * ## 每一条写都以**受影响行数**为准
   * 状态推进那一条也看行数：`count !== 1` 说明有别的写者（计时器 / 另一路取消）
   * 在我们读完之后动过这一行 ⇒ 抛 `InvalidExchangeTransitionError`（409），
   * 而不是把一次并发说成一次成功。
   */
  async confirmLock(contractId: string, actorId: string): Promise<ConfirmedLock> {
    // C36：判别式同时认 `P2034` 与 `P2010`（后者是本路径上的实际形状，见类注释）。
    // 重试的是**整个事务**：死锁中止的是一个事务，在它内部重试没有意义。
    // 幂等性由构造保证（条件更新 + 时间戳的 IS NULL 守卫 + `lockAssets` 对同一持有者放行）。
    const outcome = await withBoundedConflictRetry(() =>
      this.prisma.$transaction((tx) => this.confirmLockInTx(tx, contractId, actorId), { timeout: 20_000 }),
    );

    if (outcome.justAdvanced !== null) {
      const verdict = await this.verdictOn(outcome.justAdvanced.assetAId, outcome.justAdvanced.assetBId);
      if (!verdict.eligible) {
        // 提交之后才报：状态**已经**是 `VALIDATING`（见方法注释里那条承诺），
        // 调用方拿到 422 并知道是哪一件作品不合格。
        throw new IneligibleAssetError(verdict.assetId, verdict.reason ?? '不满足 §6.1 第 2 条');
      }
    }
    return outcome.result;
  }

  /**
   * §6.1 第 2 条的资格校验（**双方**）：通过 ⇒ `eligible: true`，不通过 ⇒ `eligible: false`。
   *
   * ## 它**是读**，不是写（这一条把 D8 的边界钉住）
   *   * 通过**不**写 `RELEASED`（那是 Task 8 的释放，见类注释里那段据实记载）；
   *   * 不通过**不**写 `CANCELLED`（§6.3 没有这条边，D8 明写「不自动取消」）。
   * `status` 原样回显，是为了让调用方知道**自己在判哪一份合约的哪个阶段**。
   *
   * ## 两个消费点
   * `confirmLock` 在提交之后用它（把不合格报成 422），而**生产**上的下一个消费者
   * 是 Task 8 的释放路径（它必须在同一个事务里、任何写之前再核一次 —— A-8）。
   * **据实记载**：今天只有测试与 `confirmLock` 行使它，与 `unlockAssets` 同一处境。
   */
  async validate(contractId: string): Promise<{ status: string; eligible: boolean }> {
    const contract = await this.prisma.swapContract.findUnique({
      where: { id: contractId },
      select: { id: true, status: true, assetAId: true, assetBId: true },
    });
    if (contract === null) throw new UnknownExchangeObjectError('contract', contractId);
    const verdict = await this.verdictOn(contract.assetAId, contract.assetBId);
    return { status: contract.status, eligible: verdict.eligible };
  }

  /**
   * `PENDING_BOTH_LOCK` / `VALIDATING` 阶段任一方退出（§6.3:290；D8）。
   *
   * ## 为什么 `RELEASED` 之后没有这条路
   * §6.3 的箭头只画在 `RELEASED` 之前，而迁移表（`CONTRACT_TRANSITIONS`）里
   * `RELEASED → CANCELLED` **不存在** ⇒ `assertContractTransition` 抛
   * `InvalidExchangeTransitionError`（409）。这正是 C31 成立的一半理由：
   * 钱还好端端地冻着，所以「还没到不可回头」。
   *
   * ## 它**不**解锁作品（增量 A-10 的边界）
   * 「两个终态解锁」是 A-10（Task 10）的交付物，A-10 逐字写着
   * 「今天的计划里 `unlockAssets` **零调用方**……本任务给锁定义生命周期」。
   * ⇒ 本方法只做「状态 + 时间戳 + 审计」，解锁留给那条路径。
   *
   * ## 理由进审计，不进列
   * `swap_contracts` 没有 `reason` 列（Task 5.5 的列清单里没有它），而理由的取值是
   * **闭集**（`dto.ts` 的 `OFFER_DECISION_REASONS`）⇒ 它落进 append-only 的审计是安全的
   * （自由文本才是邮箱/令牌溜进审计的通道，C11）。
   */
  async cancel(contractId: string, actorId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const contract = await this.loadContract(tx, contractId);
      this.assertParty(contract, actorId);
      // 状态守卫**在任何写之前**（闭集外的取值 ⇒ 422；§6.3 之外的边 ⇒ 409）。
      const from = contractStatusOf(contract.status);
      assertContractTransition(from, CONTRACT_STATUSES.CANCELLED);

      const now = this.now();
      // 条件更新 + 受影响行数：两个阶段（`PENDING_BOTH_LOCK` / `VALIDATING`）都能退出，
      // 而并发的另一个写者会让 `count` 变成 0 ⇒ 409，而不是「后写的赢」。
      const cancelled = await tx.swapContract.updateMany({
        where: { id: contractId, status: { in: [CONTRACT_STATUSES.PENDING_BOTH_LOCK, CONTRACT_STATUSES.VALIDATING] } },
        data: { status: CONTRACT_STATUSES.CANCELLED, cancelledAt: now },
      });
      if (cancelled.count !== 1) {
        throw new InvalidExchangeTransitionError(from, CONTRACT_STATUSES.CANCELLED);
      }
      await this.audit.record(
        {
          actorId,
          action: 'exchange.contract_cancelled',
          resource: 'SwapContract',
          resourceId: contractId,
          // 理由是**闭集取值**；`from` 记下它是从哪个阶段退出的（排障时唯一想知道的事）。
          metadata: { reason, from },
        },
        tx,
      );
    });
  }

  /**
   * 事务内的 `confirmLock`：只做「锁定 + 推进」，**不**做资格判决（见 `confirmLock`）。
   *
   * `justAdvanced` 非 `null` 表示「这一次调用真的推进到了 `VALIDATING`」，值是
   * **要判哪两件作品**（判决在提交之后算，见 `verdictOn`）。
   */
  private async confirmLockInTx(
    tx: Prisma.TransactionClient,
    contractId: string,
    actorId: string,
  ): Promise<{ result: ConfirmedLock; justAdvanced: { assetAId: string; assetBId: string } | null }> {
    const contract = await this.loadContract(tx, contractId);
    this.assertParty(contract, actorId);

    if (contract.status !== CONTRACT_STATUSES.PENDING_BOTH_LOCK) {
      // 幂等重放：已经是 `VALIDATING` / `CANCELLED` 之类的状态时，返回**当前**状态而不是抛错。
      // `bothLocked` 取**派生值**（不是常量 `true`）：一份在双方确认之前被取消的合约上
      // 返回 `true` 会让响应说一件不成立的事（计划那一行写的是 `true`，这里据实修正）。
      return { result: { contractId, status: contract.status, bothLocked: bothLocked(contract) }, justAdvanced: null };
    }

    const now = this.now();
    if (lockWindowExpired(contract, now)) {
      throw new ExpiredExchangeWindowError('lock', contract.lockDeadlineAt, now);
    }

    const isPartyA = actorId === contract.partyAId;
    const applied = await tx.swapContract.updateMany({
      // 三条条件一起：状态仍是待锁、**本侧**还没有时间戳（重放不推后时刻）、id 对得上。
      where: { id: contractId, status: CONTRACT_STATUSES.PENDING_BOTH_LOCK, ...(isPartyA ? { lockedByAAt: null } : { lockedByBAt: null }) },
      data: isPartyA ? { lockedByAAt: now } : { lockedByBAt: now },
    });

    const fresh = await this.loadContract(tx, contractId);
    if (applied.count !== 1) {
      // 并发权威是**受影响行数**（C25 / D8）：可能是另一个请求把状态翻走了，
      // 也可能是本人已经确认过（那条 `IS NULL` 守卫）。两种情形的回答都由**重读**给出——
      // 幂等重放**不是**一次错误。
      return { result: { contractId, status: fresh.status, bothLocked: bothLocked(fresh) }, justAdvanced: null };
    }
    if (!bothLocked(fresh)) {
      return { result: { contractId, status: fresh.status, bothLocked: false }, justAdvanced: null };
    }

    // ── 双方均锁定 ⇒ §6.3:284 的三个谓词（不可编辑 / 不可另行上架 / 不可删除）。
    await this.locks.lockAssets(tx, [fresh.assetAId, fresh.assetBId], contractId);

    // 迁移的合法性：从**这一行实际的**状态出发（比计划字面写的常量参数更强：
    // 它同时挡住「库里那一行不是 PENDING_BOTH_LOCK」的情形）。
    assertContractTransition(contractStatusOf(fresh.status), CONTRACT_STATUSES.VALIDATING);
    const advanced = await tx.swapContract.updateMany({
      where: { id: contractId, status: CONTRACT_STATUSES.PENDING_BOTH_LOCK },
      data: { status: CONTRACT_STATUSES.VALIDATING },
    });
    if (advanced.count !== 1) {
      throw new InvalidExchangeTransitionError(CONTRACT_STATUSES.PENDING_BOTH_LOCK, CONTRACT_STATUSES.VALIDATING);
    }
    await this.audit.record(
      {
        actorId,
        action: 'exchange.contract_both_locked',
        resource: 'SwapContract',
        resourceId: contractId,
        // 锁的两件作品是**非机密**标识，而「谁锁的」就是合约自己（id 已在上一格）。
        metadata: { assetAId: fresh.assetAId, assetBId: fresh.assetBId },
      },
      tx,
    );

    return {
      result: { contractId, status: CONTRACT_STATUSES.VALIDATING, bothLocked: true },
      // ★ 判决在**提交之后**才算（`confirmLock` 里那一句）：这里只交出「要判哪两件」。
      justAdvanced: { assetAId: fresh.assetAId, assetBId: fresh.assetBId },
    };
  }

  /**
   * 两件作品的资格判决（**第一次不合格就报出来**，并点名是哪一件）。
   *
   * ## 为什么它读的是**提交之后**的事实
   * `AssetAccessService.readAssetFacts` 是 Task 6 的既有读形状，它**不收 `tx`**，
   * 而它读的两张表（`asset_versions` / `asset_metadata`）在本事务里**一个字节都没写**
   * （作品行只写了锁的两列，元数据行是 write-once 的）。⇒ 放在提交之后读，
   * 结论与「事务内读」逐字相同，而不必为一个只读的判据去改 Task 6 的公开读形状。
   * **边界据实记载**：资格判据哪天开始读**本事务写过**的行时，它必须搬进事务里
   * （那时 `readAssetFacts` 需要一个收 `tx` 的形状）。
   */
  private async verdictOn(
    assetAId: string,
    assetBId: string,
  ): Promise<{ assetId: string; eligible: boolean; reason: string | null }> {
    for (const assetId of [assetAId, assetBId]) {
      const facts = await this.assets.readAssetFacts(assetId);
      // 作品不存在 / 没有元数据行都走 `eligibilityOf(null)` 那一支（判据只有一份）。
      const verdict = eligibilityOf(
        facts === null || facts.metadata === null
          ? null
          : {
              completeness: facts.metadata.completeness,
              readmeExcerpt: facts.metadata.readmeExcerpt,
              fileTreeTruncated: facts.metadata.fileTreeTruncated,
            },
      );
      if (!verdict.eligible) {
        return { assetId, eligible: false, reason: facts === null ? '作品不存在' : verdict.reason };
      }
    }
    return { assetId: '', eligible: true, reason: null };
  }

  /** 读合约（**无锁**：它的写由条件更新保护）或 404（`UnknownExchangeObjectError`）。 */
  private async loadContract(tx: Prisma.TransactionClient, contractId: string): Promise<ContractRow> {
    const row = await tx.swapContract.findUnique({
      where: { id: contractId },
      select: {
        id: true,
        status: true,
        partyAId: true,
        partyBId: true,
        assetAId: true,
        assetBId: true,
        lockDeadlineAt: true,
        lockedByAAt: true,
        lockedByBAt: true,
        releasedAt: true,
        disputeDeadlineAt: true,
        disputedAt: true,
      },
    });
    // 「不存在」与「不是当事人」给**同一个**错误（理由见 `UnknownExchangeObjectError`）。
    if (row === null) throw new UnknownExchangeObjectError('contract', contractId);
    return row;
  }

  /** 当事人判定（服务层**自足**：不假设路由层的 `swapContractParty` 条件已经判过）。 */
  private assertParty(contract: ContractRow, actorId: string): void {
    if (actorId !== contract.partyAId && actorId !== contract.partyBId) {
      throw new UnknownExchangeObjectError('contract', contract.id);
    }
  }

  /**
   * 时钟的**唯一**读取点（D13：判据收 `now`，服务读一次传下去）。
   *
   * 它写成方法而不是散在各处的 `new Date()`：24 小时窗口的判据（`lockWindowExpired`）
   * 因此仍然是**纯函数**，而「这一次调用是什么时候」只有一个来源。
   */
  private now(): Date {
    return new Date();
  }
}
