import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { AssetAccessService, AssetNotFoundError } from '../asset/index.js';
import { AuditService } from '../audit/index.js';
import { assertClaimsVerifiable, claimFactsFrom, parseClaims, type Claim } from './core/claims.js';
import { eligibilityOf } from './core/eligibility.js';
import {
  AssetLockedError,
  IneligibleAssetError,
  InvalidExchangeTransitionError,
  StaleCommitmentError,
  SwapSelfOfferError,
  UnknownExchangeObjectError,
} from './core/errors.js';
import { ACTIVE_OFFER_STATUSES, assertOfferTransition, offerStatusOf } from './core/state-machine.js';
import { OFFER_STATUSES } from './core/types.js';
import type {
  AcceptOfferResponse,
  ContractView,
  OfferDecisionReason,
  OfferView,
  ProposeOfferResponse,
} from './dto.js';

/**
 * 要约有效期的**唯一**常量（§6.3:280 的「`EXPIRED`（72 小时）」）。
 *
 * 为什么是一个模块常量而不是环境变量：D14 明写「P3 不新增任何环境变量，周期任务的间隔
 * 是模块常量（照 `DEFAULT_POLL_MS` 的形状）」。它进的是**列**（`expires_at`），
 * 而不是任何查询里的字面量——契约是「要约在多长时间内有效」，将来按类别给不同期限时，
 * 改的是写入侧这一处。
 */
export const OFFER_TTL_HOURS = 72;

/**
 * 合约的 24 小时锁定期限（§6.3:283）。与 {@link OFFER_TTL_HOURS} 同一条纪律。
 *
 * **Task 6 是它的第一个写入者**：合约在 `accept` 那一刻诞生，而 `lock_deadline_at`
 * 是 NOT NULL —— 因此「谁写下这个数」必须有答案，而答案就是这里。
 * Task 7 的 `confirmLock` 与 Task 10 的计时器**读**它，不重写它。
 */
export const CONTRACT_LOCK_HOURS = 24;

/** 发要约的入参（§9:477 的 `DRAFT → SENT`；增量 A-6 的写入侧）。 */
export interface ProposeOfferInput {
  /** 发起方（来自会话上下文，**不是**请求体里的字段）。 */
  readonly proposerId: string;
  /** 发起方拿出来的那件作品。 */
  readonly offeredAssetId: string;
  /** 被要约的那件作品。**它的所有人 = 被要约方**（本方法派生并落库）。 */
  readonly targetAssetId: string;
  /**
   * ★ 增量 A-6：提议方**看过的**那份 dossier 的规范序列化摘要（规格 §5.1）。
   *
   * 本任务**不算它**（它是 A-9 的 `canonicalizeDossier()` 的产物；计划逐字：
   * 「A-6 **先存**，A-9 落地后再接真值；A-6 的集成用例用固定串」），只把它落进
   * `swap_offers.offered_dossier_digest`。**另两个承诺列由服务端读出**（版本是
   * 「当前那一份」、sha256 是 `asset_versions.sha256`），因此没有一项是调用方的自述。
   *
   * **据实记载这道信任缺口**：在 A-9 落地之前，这一列是**调用方声明的期望值**，
   * 而不是平台核对过的事实。它的消费点是 A-8 的释放前校验（§5.2 校验点 1：
   * 「钉住的版本仍存在、可读，`sha256` 与钉住值一致，dossier **重放摘要一致**」）——
   * 也就是说，一个说谎的提议方会在**释放**那一步被抓住，而不是在这里。
   * 这与接受侧的 `targetCommitment` 是同一形状（规格 §5.1 明写接受侧必须「原样带回」），
   * 因此两侧的信任模型是**一致**的，而不是这里松、那里紧。
   */
  readonly offeredDossierDigest: string;
  /**
   * 提议方的**声明**（规格 §6 的闭集）。`null` ⇒ 没有声明（列留 NULL）。
   *
   * 类型是 `unknown` 而不是 `readonly Claim[]`：闭集的**唯一**判定处是
   * `core/claims.ts` 的 `parseClaims`（规格 §6.3：「禁止两处各写一份」），
   * 因此这个字段在类型层也刻意是「一个待判定的取值」。
   */
  readonly claims: unknown;
}

/** 接受的入参（§9:477；增量 A-6 的 **TOCTOU 执行点**）。 */
export interface AcceptOfferInput {
  readonly offerId: string;
  /** 被要约方（来自会话上下文）。 */
  readonly actorId: string;
  /**
   * **接受方看过的**被要约作品的那一份（规格 §5.1）。原样带回，与当前值不一致 ⇒
   * `StaleCommitmentError`（409，「资料已变更，请重新查看」），且**一列都不写**。
   * 没有它，`target_version_id` 记的是「平台此刻的版本」，而不是「接受方当时判的那一份」。
   */
  readonly targetCommitment: { readonly assetVersionId: string; readonly dossierDigest: string };
}

/** 拒绝 / 撤回的入参。 */
export interface OfferDecisionInput {
  readonly offerId: string;
  readonly actorId: string;
  readonly reason: OfferDecisionReason;
}

/**
 * 要约的生命周期（P3 / Task 6；§6.3 的 `DRAFT → SENT → ACCEPTED / REJECTED / WITHDRAWN / EXPIRED`）。
 *
 * ## 这个类**不做**什么（写给下一个读它的人）
 *   * **不做双锁**（`confirmLock` / `VALIDATING` / 24 小时到期）—— Task 7；
 *   * **不做原子释放**（所有权互换 + 访问权 + 补差 `ESCROW_LOCK`）—— Task 8；
 *   * **不做结算 / 争议 / 撤销**—— Task 10；
 *   * **不算 dossier 摘要** —— A-9；
 *   * **不判质量** —— 平台从设计上不判（D7），它只把「作者说的话」变成一组
 *     **可机器核对的承诺**（§6.1 的闭集）与一份**钉住**（§5.1）。
 *
 * ## 六个依赖里为什么没有 `LedgerService`
 * 要约的生命周期**一分钱都不动**（D9：发要约不收保证金、不冻结任何余额）。
 * 补差是合约的事，而它进托管发生在 Task 8 的释放路径上（C31）。
 * 提前注入账本是 C16 意义上的空抽象，而且它会让「这条路径动钱吗」多一个要靠读代码回答的问题。
 */
@Injectable()
export class ExchangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 发要约（§9:477 / §6.3 的 `DRAFT → SENT`）。
   *
   * ## 五个拒绝面（每一个都有一条用例，而且**每一个都有一条验收对照**）
   *
   * | 拒绝 | 判据 | 错误 | 状态码 |
   * |---|---|---|---|
   * | 作品不存在 / 不是自己的 | `checkAccess(offered, proposer)` = false | `AssetNotFoundError` | 404 |
   * | 向自己发要约（两份作品同属一人） | `checkAccess(target, proposer)` = **true** | `SwapSelfOfferError` | 409 |
   * | 任一作品已被锁定（§6.3:284） | `assets.locked_at` 非空 | `AssetLockedError` | 409 |
   * | 任一作品不满足 §6.1 第 2 条 | `assessEligibility(metadata)` | `IneligibleAssetError` | 422 |
   * | `claims` 落在闭集外 / 核不动 | `parseClaims` + `assertClaimsVerifiable` | `InvalidClaimsError` | 422 |
   *
   * ## 判定的**顺序**是承重的，两条都在这一处
   *
   * 1. **归属判定在最前**（D11 的唯一入口）。一个不是自己的作品**在碰任何其它事实之前**
   *    就被拒——否则「这件作品锁着吗」这类问题会先于授权被执行，而它的答案本身
   *    就是一条不该给陌生人的信息。
   * 2. **「向自己发」排在「作品不存在」之后、其余判定之前**：它由
   *    `checkAccess(targetAssetId, proposerId)` 的 **true** 给出（我拥有目标作品），
   *    而不是由任何一条「按 id 取所有人」的新查询给出。**这就是为什么它必须在
   *    `checkAccess(target)` 为 false 之后才可能到达**——两个失败因由因此在
   *    同一次判定里就分开了，不需要第二条授权路径（D11 的「唯一入口」由此成立）。
   *
   * ## 最后一行为什么是「复用」而不是 409
   *
   * `(target_asset_id, counterparty_id)` 上的唯一索引是数据库层的执行点，而它**带状态**
   * （P3 / Task 6 的控制器裁定 ①：部分唯一索引，只覆盖 `DRAFT` / `SENT`）。
   * 因此服务必须先按 `(target, counterparty, status IN ACTIVE_OFFER_STATUSES)` 查一次：
   * 命中就**返回它**（`created: false`，与账本的幂等三态同一条纪律：重复是调用方需要
   * 知道的**事实**，而不是被静默吞掉的错误）。
   *
   * **历史行（终态）不挡路**：裁定 ① 逐字——「『`REJECTED` 是终态』约束的是**那一份**
   * 要约，而不是**那一对人**」。因此 `REJECTED` 之后重新要约是**允许**的，而且它写的是
   * **新的一行**（历史行一个字都不改：`REJECTED` 作为终态这件事对**那一份**仍然成立）。
   *
   * ## ★ 据实记载：计划 Step 2 的那条「409 `EXCHANGE_OFFER_ALREADY_DECIDED`」不存在
   *
   * 计划原文写的是：「历史行存在时，第二次要约以 409 返回，并且那条 409 的 `code` 是
   * `EXCHANGE_OFFER_ALREADY_DECIDED`。**据实记载**：这条边界是一个**已知的产品粗糙点**
   * （用户不能在对方拒绝后重新要约），它的修法是一次规格变更（新增一条边
   * 或换一个唯一索引的形状）」。**控制器裁定 ① 就是那次形状变更**，
   * 于是「历史行存在」不再是一个错误情形 —— 它走的是正常的插入路径。
   * ⇒ 那个错误类**没有**被创建：今天没有任何路径能到达它（C16：不为不存在的路径建抽象）。
   *
   * ## 并发
   *
   * 两个调用同时走到插入那一句时，数据库的部分唯一索引会拒掉第二个（`P2002`）。
   * 服务**吞掉它并重读**——那一次重读必然命中刚插入的那一行，于是调用方拿到
   * 与串行情形**逐字相同**的结果（`created: false`）。这与账本的 `P2002` 处置同一条纪律：
   * 唯一索引是执行点，而我们**不**用 `upsert` 静默去重（C26 的同一条读法）。
   *
   * **据实记载它的粗糙点**：复用命中的那一行可能是**另一件**被拿出作品
   * （`(target, counterparty)` 上只允许一份活跃要约，而这一对与 `offeredAssetId` 无关）。
   * 复访触发条件写在 `ProposeOfferResponse.created` 上。
   *
   * ## 审计的时机
   *
   * **只在真的创建了一行**时写（`created: true`）。复用不改变任何状态，把它记进
   * append-only 的审计会让一次客户端的重试变成一条永久记录。
   */
  async proposeOffer(input: ProposeOfferInput): Promise<ProposeOfferResponse> {
    const { proposerId, offeredAssetId, targetAssetId } = input;

    // ── ① 归属判定：**恰好两次** `checkAccess`（D11 的唯一入口）。
    //    `false` 同时覆盖「不存在」与「不是你的」——`checkAccess` 的答案只有可以/不可以，
    //    而那条边界是刻意的（见 `asset-access.service.ts` 的类注释）。
    if (!(await this.assets.checkAccess(offeredAssetId, proposerId))) {
      throw new AssetNotFoundError(offeredAssetId);
    }
    // ── ② 「向自己发」：目标作品**也归我** ⇒ 409。它在 `checkAccess(target)` 的 true
    //    那一支上被判定，因此不需要第三条查询。
    if (await this.assets.checkAccess(targetAssetId, proposerId)) {
      throw new SwapSelfOfferError(proposerId);
    }

    // ── ③ 事实（一次读取给出四个）：所有人 / 锁 / 当前那一份 / 元数据。
    const offered = await this.assets.readAssetFacts(offeredAssetId);
    if (offered === null) throw new AssetNotFoundError(offeredAssetId);
    const target = await this.assets.readAssetFacts(targetAssetId);
    if (target === null) throw new AssetNotFoundError(targetAssetId);

    // ── ④ 锁（§6.3:284）。两个方向都要判：锁着的作品**既不能拿出、也不能被要约**。
    if (offered.lockedAt !== null) throw new AssetLockedError(offeredAssetId, 'locked');
    if (target.lockedAt !== null) throw new AssetLockedError(targetAssetId, 'locked');

    // ── ⑤ 资格（§6.1 第 2 条 / D16）。**两件作品都要**满足：拿出来的那一件是对方将得到的，
    //    被要约的那一件是我将得到的，任一侧不达标这次交换都不成立。
    assertEligible(offeredAssetId, offered.metadata);
    assertEligible(targetAssetId, target.metadata);

    // ── ⑥ 声明（A-6）。闭集与「核得动吗」都在 `core/claims.ts` 里判（唯一来源）。
    const claims = parseClaims(input.claims);
    // 声明说的是**提议方拿出来的那一件**（对方将得到的东西），因此判据读它的事实。
    // `offered.metadata` 在这一步必然非 null（⑤ 已经拒掉了没有元数据的情形）——
    // 但类型上它仍是可空的，所以这里显式收窄而不是 `!`。
    if (claims !== null) {
      if (offered.metadata === null) throw new IneligibleAssetError(offeredAssetId, '没有元数据行');
      assertClaimsVerifiable(claims, claimFactsFrom(offered.metadata));
    }

    const counterpartyId = target.ownerId;
    const expiresAt = new Date(Date.now() + OFFER_TTL_HOURS * 3_600_000);

    // ── ⑦ 复用：同一对上的**活跃**要约已存在 ⇒ 返回它（`created: false`）。
    const active = await this.findActiveOffer(targetAssetId, counterpartyId);
    if (active !== null) {
      // `expiresAt` 在响应里是 **ISO 字符串**（`dto.ts` 的 `ProposeOfferResponse`）：
      // 一个 `Date` 也能被 `JSON.stringify` 成 ISO，但那样「响应体的形状」就由
      // Nest 的序列化器决定，而不是由契约决定——而这条契约要在覆盖率门与前端之间稳定。
      return { offerId: active.id, counterpartyId, expiresAt: active.expiresAt.toISOString(), created: false };
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.swapOffer.create({
          data: {
            proposerId,
            offeredAssetId,
            targetAssetId,
            counterpartyId,
            // `status` 用列默认值（`SENT`）——「`DRAFT → SENT` 是同一次动作」。
            reason: null,
            expiresAt,
            // ★ 增量 A-6：提议方的三个承诺列。版本与 sha256 是**服务端**读出来的
            //   （「当前那一份」），摘要是调用方带回的期望值（见 `ProposeOfferInput`）。
            offeredVersionId: offered.currentVersion?.assetVersionId ?? null,
            offeredSha256: offered.currentVersion?.sha256 ?? null,
            offeredDossierDigest: input.offeredDossierDigest,
            // `null` = **没有声明**（与 `[]`「声明了一个空集」不是同一件事）。
            claims: (claims ?? null) as never,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId: proposerId,
            action: 'exchange.offer_proposed',
            resource: 'SwapOffer',
            resourceId: row.id,
            // 非机密字段：被要约的作品与对手方（审计要能回答「谁向谁发了什么」）。
            // **不放** sha256 与 dossier 摘要：它们是内容指纹，不是事由（C11 的边界）。
            metadata: { offeredAssetId, targetAssetId, counterpartyId, claims: claims?.length ?? 0 },
          },
          tx,
        );
        return row;
      });
      return { offerId: created.id, counterpartyId, expiresAt: expiresAt.toISOString(), created: true };
    } catch (error) {
      // 并发下的第二次插入撞部分唯一索引（P2002）⇒ **重读**并复用。
      // 只在这一档上重试：别的失败（check 约束、连接问题）必须原样抛出。
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.findActiveOffer(targetAssetId, counterpartyId);
      if (raced === null) throw error;
      return { offerId: raced.id, counterpartyId, expiresAt: raced.expiresAt.toISOString(), created: false };
    }
  }

  /**
   * 接受一份要约（§9:477；§6.3 的 `SENT → ACCEPTED → 生成 SwapContract`）。
   *
   * ## TOCTOU 判定在**任何写之前**（规格 §5.1 / §5.2）
   *
   * 逐字来自 Task 8 的同一条纪律：「判在取锁之后、任何写之前」。这里没有锁可取的
   * （要约的接受不碰作品行），但**顺序**是同一条：先把两个承诺项核完，再进事务。
   * 失败时合约数与审计数都不变（`offers.test.ts` 逐条断言）。
   *
   * ## 「当前值」是什么
   *
   * `swap_offers.offered_version_id` / `offered_dossier_digest` —— **提议方在
   * `propose` 那一刻钉下的那两份**。接受方带回的 `(assetVersionId, dossierDigest)`
   * 是**平台在预览响应里给过他的**那一份（A-9 的 `PreviewManifest`），
   * 因此两者不一致只可能意味着一件事：**他看到的与钉住的不是同一份**
   * （作者在他查看之后、点接受之前上传了新版本）。那时唯一的正确处理是拒绝，
   * 并让他重新查看 —— 而不是把这次接受绑到一份他从未看过的 dossier 上。
   *
   * ## 为什么两个字段各自都要判（`offers.test.ts` 各有两条方向）
   *
   * 它们是**同一个事实**（「哪一份」）的两个投影：版本 id 说**哪一个版本**，
   * 摘要是那个版本产出的 dossier 的指纹。只判一个会让另一个成为装饰，
   * 而装饰在下一次重构里就会消失（本项目反复抓到的形状）。
   *
   * ## 状态守卫在**任何写之前**，而且它的错误与「已被接受」要分得开
   *
   * `assertOfferTransition(SENT → ACCEPTED)` 先跑。不跑的话第二次接受会走到
   * `swap_contracts.offer_id` 的**唯一索引**上 —— 那样这条用例红在**别的机制**上，
   * 而它声称的是状态守卫（Task 2 的探针 S-3 为同一族问题付过一次代价）。
   *
   * ## 一个事务
   *
   * 要约翻状态、建合约、写审计**一起提交或一起回滚**：半份状态（`ACCEPTED` 而没有合约）
   * 与 `timers.ts` 的 `dueOfferActions` 那条 fail-closed 守卫直接冲突
   * （「一份 `SENT` 却已经有合约的要约是不可能的」）。
   */
  async acceptOffer(input: AcceptOfferInput): Promise<AcceptOfferResponse> {
    const { offerId, actorId, targetCommitment } = input;

    const offer = await this.prisma.swapOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        status: true,
        proposerId: true,
        counterpartyId: true,
        offeredAssetId: true,
        targetAssetId: true,
        offeredVersionId: true,
        offeredSha256: true,
        offeredDossierDigest: true,
      },
    });
    // 不区分「不存在」与「不是你的」：不向非当事人泄露一份要约是否存在。
    // 与 `checkAccess` 同一个形状（授权判定的答案只有可以 / 不可以）。
    if (offer === null || offer.counterpartyId !== actorId) {
      throw new UnknownExchangeObjectError('offer', offerId);
    }

    // 状态守卫（闭集外的取值 ⇒ 422；§6.3 之外的边 ⇒ 409）。**在任何写之前**。
    const from = offerStatusOf(offer.status);
    assertOfferTransition(from, OFFER_STATUSES.ACCEPTED);

    // ── TOCTOU：两个投影各自判，且**在任何写之前**。
    if (offer.offeredVersionId === null || targetCommitment.assetVersionId !== offer.offeredVersionId) {
      // 钉住的那一列为 NULL 也走这一支：一份**没有钉过**的要约不可能被「原样带回」确认，
      // 而那正是这一列存在的理由（迁移之前的旧行因此不能被接受，据实记载这条边界）。
      throw new StaleCommitmentError(
        'assetVersionId',
        offer.offeredVersionId ?? '(未钉住)',
        targetCommitment.assetVersionId,
      );
    }
    if (offer.offeredDossierDigest === null || targetCommitment.dossierDigest !== offer.offeredDossierDigest) {
      throw new StaleCommitmentError(
        'dossierDigest',
        offer.offeredDossierDigest ?? '(未钉住)',
        targetCommitment.dossierDigest,
      );
    }

    const lockDeadlineAt = new Date(Date.now() + CONTRACT_LOCK_HOURS * 3_600_000);

    return this.prisma.$transaction(async (tx) => {
      // ★ **带条件的**更新 + **以受影响行数为准**（C25 的同一条纪律：「余额绝不『读-判断-写』」）。
      //
      // ## 不带条件时会出一条 500 的路径（本轮据实发现并修掉）
      // 状态守卫是在**事务之外**读的那一次 `findUnique`。两个并发的 `accept` 可以都读到
      // `SENT`（READ COMMITTED 下各自的快照都合法），然后：
      //   * `UPDATE … WHERE id = $1`（无状态条件）：T1 拿到行锁、提交；T2 在锁上等到之后
      //     **照样写成功**（它只是把已经是 `ACCEPTED` 的行再写成 `ACCEPTED`）；
      //   * 接着 T2 去建合约 ⇒ 撞 `swap_contracts.offer_id` 的**唯一索引** ⇒ `P2002` ⇒ **500**。
      // 加上 `status: SENT` 之后，T2 的那条 UPDATE 在 PostgreSQL 的 READ COMMITTED 语义下
      // 会**重新求值** `WHERE`（行版本已经变了）⇒ 受影响行数 **0** ⇒ 我们抛
      // `InvalidExchangeTransitionError`（**409**，与串行情形逐字相同）。
      //
      // ⇒ 「读-判断-写」在这里被换成「条件更新 + 看行数」：判据不变，而它现在对
      // **并发**也成立。这一条与 `ledger` 的借方更新是同一条纪律，不是新发明的形状。
      const updated = await tx.swapOffer.updateMany({
        where: { id: offerId, status: OFFER_STATUSES.SENT },
        data: { status: OFFER_STATUSES.ACCEPTED },
      });
      if (updated.count !== 1) throw new InvalidExchangeTransitionError(from, OFFER_STATUSES.ACCEPTED);

      const contract = await tx.swapContract.create({
        data: {
          offerId,
          // 朝向固定：`partyA` = 被要约方（目标作品的所有人），`partyB` = 发起方。
          // 「谁确认过锁」是两个可空时间戳（Task 7），因此这个朝向必须是**稳定**的。
          partyAId: offer.counterpartyId,
          partyBId: offer.proposerId,
          assetAId: offer.targetAssetId,
          assetBId: offer.offeredAssetId,
          // `status` 用列默认值（`PENDING_BOTH_LOCK`）。
          // ★ Task 6 **只建等价互换**的合约：补差的金额与付款方是 Task 8 的
          //   `ESCROW_LOCK` 那一侧的事（§8.2 第 6 行 / C32 / D7）。两个默认值
          //   （`0` / NULL）同时满足那条条件化 CHECK，理由写在 `dto.ts` 的头部。
          topUpAmount: 0n,
          topUpPayerId: null,
          lockDeadlineAt,
          // ★ 增量 A-6：接受方的三个承诺列 = **他带回并已被核对过**的那一份
          //   （写入的是**要约那一行的值**，不是请求里的原串：两者此刻逐字相同，
          //    但来源必须是**核过的那个**，否则将来那道核对被绕过时这里会静默跟着变）。
          //    契约上钉住的是**接受方看过的**那一份（= 提议方拿出的作品），
          //    这与 `swap_offers` 上提议侧的三个列**对称**：为双方各写入一份承诺。
          targetVersionId: offer.offeredVersionId,
          targetSha256: offer.offeredSha256,
          targetDossierDigest: offer.offeredDossierDigest,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId,
          action: 'exchange.offer_accepted',
          resource: 'SwapContract',
          resourceId: contract.id,
          metadata: { offerId, targetVersionId: offer.offeredVersionId },
        },
        tx,
      );
      return { offerId, contractId: contract.id };
    });
  }

  /** 拒绝（§9:477；`SENT → REJECTED`）。**只有被要约方**，且只从 `SENT` 出发。 */
  async rejectOffer(input: OfferDecisionInput): Promise<void> {
    await this.decide(input, {
      action: 'exchange.offer_rejected',
      to: OFFER_STATUSES.REJECTED,
      // 拒绝由**被要约方**发出（`offer.counterpartyId`）。
      actorField: 'counterpartyId',
    });
  }

  /**
   * 撤回（§6.3:279；`SENT → WITHDRAWN`）。**只有发起方**。
   *
   * ## 为什么这条路由的声明是**无条件**的，而这条判定在**服务层**
   *
   * §9 的矩阵里**没有** `SwapOffer.withdraw` 这一行（只有 `accept` / `reject`）。
   * 按 P2 `Ledger.grant` 的处置（「矩阵缺行这件事据实记载，取最保守并且在今天可判定的
   * 一档」），声明的部分是「登录即可」——因为 §9 没有画出一条「只有发起方」的授权规则，
   * 而**不发明**一条设计文档没有写的规则是 C16 的读法。
   * 但契约明写「**只有发起方**」能撤回：因此那条限制由**服务层**执行
   * （`actorField: 'proposerId'`），它的失效方向是 fail-closed（别人撤不动）。
   * 这处分工是**刻意的**，不是遗漏：授权规则（谁）在声明里，业务规则（哪一方的动作）
   * 在服务里，而两者的判据是同一个字段。
   */
  async withdrawOffer(input: OfferDecisionInput): Promise<void> {
    await this.decide(input, {
      action: 'exchange.offer_withdrawn',
      to: OFFER_STATUSES.WITHDRAWN,
      actorField: 'proposerId',
    });
  }

  /**
   * 读一份要约（**双方可见**：对手方 / 发起方）。
   *
   * 服务层的判定是**自足**的（不假设调用方已经判过）：第三方与不存在的 id 得到
   * **同一个** `UnknownExchangeObjectError` —— 不向非当事人泄露一份要约是否存在。
   *
   * ## ★ 两层在 Task 7 之后**一致**了（此前不一致，据实记载）
   * Task 6 时这里允许发起方与终态要约，而路由上的条件 `swapOfferSent` 只放行
   * 「被要约方 + `SENT`」⇒ 发起方与终态要约在 HTTP 上是 403 而服务层允许。
   * 控制器裁定**修**，Task 7 因此新增了对象级条件 `swapOfferParty`（双方、不判状态），
   * 路由与服务层现在说的是同一件事。**这条注释保留这段历史**：
   * 它是「注释、声明、服务层三处必须说同一件事」的一个真实例子。
   */
  async getOffer(offerId: string, actorId: string): Promise<OfferView> {
    const row = await this.prisma.swapOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        status: true,
        proposerId: true,
        counterpartyId: true,
        offeredAssetId: true,
        targetAssetId: true,
        expiresAt: true,
        createdAt: true,
        offeredVersionId: true,
        offeredDossierDigest: true,
        claims: true,
      },
    });
    if (row === null || (row.proposerId !== actorId && row.counterpartyId !== actorId)) {
      throw new UnknownExchangeObjectError('offer', offerId);
    }
    return {
      offerId: row.id,
      status: row.status,
      proposerId: row.proposerId,
      counterpartyId: row.counterpartyId,
      offeredAssetId: row.offeredAssetId,
      targetAssetId: row.targetAssetId,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      // 三个值一起才是「哪一份」；缺任何一个（迁移之前的旧行）⇒ `null`，
      // 而不是一个半份的承诺（半份会让「有没有钉住」变成一个要靠猜的问题）。
      offeredCommitment:
        row.offeredVersionId === null || row.offeredDossierDigest === null
          ? null
          : { assetVersionId: row.offeredVersionId, dossierDigest: row.offeredDossierDigest },
      // 库里那一列原样读回：`null` = 没有声明，`[]` = 声明了空集（两个不同的值）。
      claims: row.claims === null ? null : (row.claims as unknown as readonly Claim[]),
      // 刻意**没有** `offeredSha256`：内容指纹不进对外契约（理由见 `dto.ts` 的 `OfferView`）。
    };
  }

  /** 读一份合约（**当事人可见**）。判定与 `getOffer` 同一条纪律。 */
  async getContract(contractId: string, actorId: string): Promise<ContractView> {
    const row = await this.prisma.swapContract.findUnique({
      where: { id: contractId },
      select: {
        id: true,
        offerId: true,
        status: true,
        partyAId: true,
        partyBId: true,
        assetAId: true,
        assetBId: true,
        lockDeadlineAt: true,
        createdAt: true,
        targetVersionId: true,
        targetDossierDigest: true,
      },
    });
    if (row === null || (row.partyAId !== actorId && row.partyBId !== actorId)) {
      throw new UnknownExchangeObjectError('contract', contractId);
    }
    return {
      contractId: row.id,
      offerId: row.offerId,
      status: row.status,
      partyAId: row.partyAId,
      partyBId: row.partyBId,
      assetAId: row.assetAId,
      assetBId: row.assetBId,
      lockDeadlineAt: row.lockDeadlineAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      targetCommitment:
        row.targetVersionId === null || row.targetDossierDigest === null
          ? null
          : { assetVersionId: row.targetVersionId, dossierDigest: row.targetDossierDigest },
    };
  }

  /**
   * 拒绝与撤回的**同一段**逻辑（两者的差别只有三样：目标状态、谁是当事人、审计动作名）。
   *
   * 写成两个方法体而不是一个带开关的方法，是因为「哪一方的动作」是**业务规则**，
   * 而它的判据（`counterpartyId` / `proposerId`）在这两个调用点上各自是常量。
   */
  private async decide(
    input: OfferDecisionInput,
    spec: {
      readonly action: string;
      readonly to: typeof OFFER_STATUSES.REJECTED | typeof OFFER_STATUSES.WITHDRAWN;
      readonly actorField: 'counterpartyId' | 'proposerId';
    },
  ): Promise<void> {
    const { offerId, actorId, reason } = input;
    const row = await this.prisma.swapOffer.findUnique({
      where: { id: offerId },
      select: { id: true, status: true, proposerId: true, counterpartyId: true },
    });
    // 同一对判据：不存在 / 不是这一方的动作 ⇒ 一个错误（不泄露存在性）。
    if (row === null || row[spec.actorField] !== actorId) {
      throw new UnknownExchangeObjectError('offer', offerId);
    }
    // 状态守卫**在任何写之前**。
    const from = offerStatusOf(row.status);
    assertOfferTransition(from, spec.to);

    await this.prisma.$transaction(async (tx) => {
      // 与 `acceptOffer` 同一条纪律：**条件更新 + 以受影响行数为准**（C25）。
      // 两个并发的决策（例如对手方拒绝的同时发起方撤回）都会先读到 `SENT`，
      // 而**只有一份**能把它翻走——另一份的 `count` 是 0 ⇒ 409，而不是「后写的赢」。
      const updated = await tx.swapOffer.updateMany({
        where: { id: offerId, status: OFFER_STATUSES.SENT },
        data: { status: spec.to, reason },
      });
      if (updated.count !== 1) throw new InvalidExchangeTransitionError(from, spec.to);
      await this.audit.record(
        {
          actorId,
          action: spec.action,
          resource: 'SwapOffer',
          resourceId: offerId,
          // 理由是**闭集取值**（`dto.ts` 的 `OFFER_DECISION_REASONS`），因此它落进
          // append-only 的审计是安全的（C11：自由文本才是邮箱/令牌溜进审计的通道）。
          metadata: { reason },
        },
        tx,
      );
    });
  }

  /** 同一对上的**活跃**要约（集合与部分唯一索引的谓词是同一个，见 `ACTIVE_OFFER_STATUSES`）。 */
  private async findActiveOffer(
    targetAssetId: string,
    counterpartyId: string,
  ): Promise<{ id: string; expiresAt: Date } | null> {
    return this.prisma.swapOffer.findFirst({
      where: { targetAssetId, counterpartyId, status: { in: [...ACTIVE_OFFER_STATUSES] } },
      select: { id: true, expiresAt: true },
    });
  }
}

/**
 * §6.1 第 2 条的资格判定（D16 的代理判据在 `core/eligibility.ts`）。
 *
 * **没有元数据行**也走这一支：一件解析不出元数据的作品不是「合格品」，
 * 而 `assessEligibility` 收的是三个事实、没有「有没有事实」这一说 —— 因此那一条
 * 在 `eligibilityOf` 这一层表达，而不是把一个编造的 `completeness: 0` 喂给判据
 * （那会让「没解析过」与「完整度为 0」变成同一个答案，正是 `eligibility.ts` 点名的缺陷族）。
 *
 * **P3 / Task 7 的一次提取**：判据搬去 `core/eligibility.ts` 的 `eligibilityOf`
 * （`SwapContractService.validate` 要的是**判决**而不是一个异常，因为它的结论必须在
 * `VALIDATING` 提交**之后**才报出去）。这里保留的是「抛」那一种呈现方式。
 */
function assertEligible(assetId: string, metadata: AssetMetadataViewLike | null): void {
  const verdict = eligibilityOf(metadata);
  if (!verdict.eligible) throw new IneligibleAssetError(assetId, verdict.reason ?? '不满足 §6.1 第 2 条');
}

/** 资格判据要读的那三个字段（结构化地写下依赖，而不是收整个 `AssetMetadataView`）。 */
interface AssetMetadataViewLike {
  readonly completeness: number;
  readonly readmeExcerpt: string | null;
  readonly fileTreeTruncated: boolean;
}

/** Prisma 的**唯一冲突**（`P2002`）。判别式窄到恰好一个 code（照 `ledger-error-map.ts` 的形状）。 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}
