import { z } from 'zod';
import type { Claim } from './core/claims.js';

/**
 * 交换的入参 / 出参（P3 / Task 6 + 增量 A-6）。
 *
 * ## 三条纪律，各有一处落点
 *
 * 1. **路径参数是 UUID**（{@link uuidParamSchema}）：不判的话一个形状不对的 id 会让
 *    Postgres 以 `22P02` 失败 ⇒ **500**，而那把一次调用方错误说成一次服务端故障
 *    （`asset-access.service.ts` 的类注释末段把这条明确交给 HTTP 边界）。
 *    `z.uuid()` 是 zod 4 的非弃用拼写（接受 RFC 9562 的 1–8 版，因此 UUIDv7 通过）。
 * 2. **理由的取值是闭集**（{@link OFFER_DECISION_REASONS}）：`reason` 会落进
 *    `swap_offers.reason` 并进审计行，而它的调用方是**外部 HTTP 请求**。
 * 3. **`claims` 是**不透明**取值**：闭集**不在这一层**（见下）。
 *
 * ## ★ 为什么 `claims` 在 zod 里是 `z.unknown()`（一次据实记载的偏离）
 *
 * 计划 Step 1 的 Files 行写着「`claims` 字段的 zod；**闭集外一律 400**」，
 * 而同一份计划的 A-6 集成用例写着「拒绝面：claims 里出现闭集外的 kind ⇒ **422**，
 * 且没有一行落库」。两者只能取一个，取 **422**，理由有三条：
 *   * 规格 §6.3 逐字：「`claims` 的解析器（zod）与 `judge` 的判据都从**同一张表**派生，
 *     **禁止两处各写一份**」——在 zod 里表达闭集就是第二份；
 *   * 闭集**已经**有一条类型层与运行期的收口（`core/claims.ts` 的 `CLAIM_KINDS` +
 *     `parseClaims`），第二份只会与它漂移；
 *   * 422 在本仓库的既定含义正是「**数据 / 制品本身**不可接受」，而「一个闭集外的
 *     kind」就是这个意思；400 的含义是「调用方给的**参数**不对」（UUID 的形状、理由的取值）。
 * `dto.test.ts` 有一条断言把这份分工变成可执行的：闭集外的 kind **必须**
 * 穿过这一层（若有人把闭集复制进 zod，那条会立刻红）。
 *
 * ## ★ 请求体里**没有**任何金额字段（第二处据实记载的偏离）
 *
 * 计划 Step 1 的 dto 用例提到 `proposeOfferSchema` 上的 `topUpAmount`（C22 的十进制
 * 字符串、拒绝 JSON `number`），而**它在今天的 schema 上无处可放**：
 *   * `exchange.swap_offers` **没有**补差列（Task 5.5 的六个列是保真链的，
 *     补差不在其中；加一列是改 P3 的 schema，且 C16 禁止为 Task 8 预埋）；
 *   * 合约在 `accept` 时创建，而 `AcceptOfferInput` 的字段是计划与 A-6 一起定下的
 *     （`offerId` + `targetCommitment`）——提议侧携带的补差**没有**任何一条路径能到达
 *     合约那一行。
 * ⇒ Task 6 把合约建成**等价互换**（`topUpAmount = 0` / `topUpPayerId = null`，即
 * 两个列的默认值，条件化 CHECK 对此放行）。补差的**金额与付款方**是 Task 8 的
 * `ESCROW_LOCK` 那一侧的事（§8.2 第 6 行 / C32 / D7）。因此本任务的请求体里
 * **没有任何金额**，C22 在这里没有落点——这是据实划界，不是遗漏
 * （报告 §self-review 与 §concerns 各记一次）。
 */

/**
 * 拒绝 / 撤回的理由（**闭集**）。
 *
 * ## 据实记载：设计文档里**没有任何一处**枚举过理由
 *
 * §6.3 只画出 `SENT → REJECTED / WITHDRAWN` 两条边，没有给理由取值。因此这里取的是
 * 「最保守并且在今天可判定的一档」——与 P2 的 `Ledger.grant`（§9 矩阵缺行）、
 * P1 的 `Asset.create` 同一处置：**不发明**一条设计文档没有写的规则，但也不把
 * 一个**外部调用方完全可控的自由串**放进 append-only 的审计链。
 *
 * ## 为什么是闭集而不是自由的短字符串（两条当代理由）
 *   * **C11 的边界**：`reason` 进 `swap_offers.reason` 与审计行，而自由文本正是
 *     邮箱、令牌、口令**溜进**审计记录的通道（`asset.service.ts` 与
 *     `download.service.ts` 都各有一处 `sanitizeReason` 在防同一件事，
 *     它们防的是**我们的**消息，防不了**调用方**的）；
 *   * **可查询**：一条被拒绝的交换在事后要能被统计（「多少份要约因为作品另有安排被拒」），
 *     而自由文本让那件事变成一次全文检索。
 *
 * ## 复访触发条件
 * 出现第四条真实理由、或者需要区分「拒绝对手方」与「拒绝这件作品」时，改这一行常量 +
 * 一处文档，而不是放宽成自由文本。
 */
export const OFFER_DECISION_REASONS = [
  /** 不想换（对这笔交换本身没有兴趣）。 */
  'NOT_INTERESTED',
  /** 条款不接受（补差、期限等）。 */
  'TERMS_UNACCEPTABLE',
  /** 那件作品另有安排（已被别的合约占用 / 已下架）。 */
  'ASSET_UNAVAILABLE',
  /** 其他（**仍然是一个闭集取值**，不是自由文本的入口）。 */
  'OTHER',
] as const;

export type OfferDecisionReason = (typeof OFFER_DECISION_REASONS)[number];

/**
 * 理由的长度上限。它是**第二道**界（第一道是闭集本身），今天最长的那条远短于它，
 * 因此它现在的价值是「将来把闭集放宽成有界串时它已经在那儿」——
 * `dto.test.ts` 有一条用例把它单独行使到（`<64 个字符> + 1` ⇒ 400）。
 */
export const MAX_OFFER_REASON_TEXT = 64;

/**
 * dossier 摘要的长度上限（增量 A-6）。
 *
 * ## 为什么判的是「有界的非空串」而不是「64 位 hex」
 * 摘要的**算法与格式**是 A-9 的（`dossierDigestOf`，规格 §6.2 的四条规范化）；
 * A-6 **只存它**（计划的「先存后算」）。把 hex-64 钉在这里会让 A-9 的第一次格式
 * 改动必须同时改本文件——一次跨任务的耦合，而它买不到任何东西：真正要比对的两侧
 * （带回的值 vs 当前值）用的是**同一个**生产者的输出。
 */
export const MAX_DOSSIER_DIGEST_TEXT = 200;

/** 一个路径参数（`offerId` / `contractId`）：UUID 形状 ⇒ 400 在**碰数据库之前**。 */
export const uuidParamSchema: z.ZodType<string> = z
  .strictObject({ id: z.uuid() })
  .transform((value) => value.id);

/**
 * 发要约（§9:477 的 `DRAFT → SENT`）。
 *
 * `claims` 是可选的不透明取值：`undefined` ⇒ **没有声明**（`swap_offers.claims` 留 NULL，
 * 与「声明了一个空集」不是同一件事）。
 *
 * ★ **`offeredDossierDigest` 是 A-6 加进这个请求体的字段**（增量 A 的总说明逐字：
 * 「它改的是 Task 6 的**请求体**」）。它是「钉子」的第三项：版本 id 与 sha256 由服务端
 * 从「当前那一份」读出来（**不是**请求里给的），而摘要**今天只能由调用方带回**
 * ——它是 A-9 的 `canonicalizeDossier()` 的产物，而 A-9 尚未落地（计划的「先存后算」）。
 * **必填**而不是可选：一份没有钉住摘要的要约在 `accept` 时**永远**过不了 TOCTOU
 * （`offered_dossier_digest` 为 NULL ⇒ `StaleCommitmentError`），
 * 于是「可选」只会把一次请求期的 400 推迟成一次接受期的 409。
 */
export const proposeOfferSchema = z.strictObject({
  offeredAssetId: z.uuid(),
  targetAssetId: z.uuid(),
  offeredDossierDigest: z.string().trim().min(1).max(MAX_DOSSIER_DIGEST_TEXT),
  claims: z.unknown().optional(),
});

/** 拒绝 / 撤回的请求体（理由闭集；两条路由共用同一个 schema，因为它们问的是同一件事）。 */
export const offerReasonSchema: z.ZodType<OfferDecisionReason> = z
  .strictObject({
    reason: z
      .string()
      .min(1)
      .max(MAX_OFFER_REASON_TEXT)
      .refine(
        (value): value is OfferDecisionReason => (OFFER_DECISION_REASONS as readonly string[]).includes(value),
        { message: `理由的取值是闭集：${OFFER_DECISION_REASONS.join(' / ')}` },
      ),
  })
  .transform((value) => value.reason);

/**
 * 接受一份要约（增量 A-6 的 **TOCTOU 执行点**，规格 §5.1）。
 *
 * `targetCommitment` = **接受方看过的**那一份的 `(assetVersionId, dossierDigest)`，
 * 由预览响应给出、必须**原样带回**。没有它，钉住记的是「平台此刻的版本」，
 * 而不是「接受方当时判的那一份」。
 */
export const acceptOfferSchema = z.strictObject({
  targetCommitment: z.strictObject({
    assetVersionId: z.uuid(),
    dossierDigest: z.string().trim().min(1).max(MAX_DOSSIER_DIGEST_TEXT),
  }),
});

/** 发要约的响应（`POST /exchange/offers`）。 */
export interface ProposeOfferResponse {
  readonly offerId: string;
  /** 被要约方（= `targetAssetId` 在创建那一刻的所有人）。 */
  readonly counterpartyId: string;
  readonly expiresAt: string;
  /**
   * `false` 表示这次调用**复用**了一份已存在的活跃要约
   * （`(target, counterparty)` 上的部分唯一索引：同一对只能有一份非终态要约）。
   *
   * 与账本的幂等三态同一条纪律：重复是调用方需要知道的**事实**，
   * 而不是被静默吞掉的错误。**据实记载它的粗糙点**：复用命中的那一行可能
   * 是**另一件**被拿出作品（`(target, counterparty)` 上只允许一份活跃要约），
   * 而本响应不含 `offeredAssetId`——调用方因此无法从响应里看出这一点。
   * 复访触发条件：真出现「同一对之间反复换被拿出作品」的需求时，给这一格一个具名的
   * 409（那是一次产品裁定），而不是把 `offeredAssetId` 也塞进复用判据。
   */
  readonly created: boolean;
}

/** 接受一份要约的响应（`POST /exchange/offers/:offerId/accept`）。 */
export interface AcceptOfferResponse {
  readonly offerId: string;
  /** 本次接受生成的合约（§6.3 的 `SENT → ACCEPTED → 生成 SwapContract`）。 */
  readonly contractId: string;
}

/**
 * 确认锁定的响应（`POST /exchange/contracts/:contractId/confirm-lock`；§9:478）。
 *
 * `status` 回的是**做完这一次确认之后**的合约状态：`PENDING_BOTH_LOCK`（还在等另一方，
 * 或本人是重放）、`VALIDATING`（这一次让双方都锁上了）。
 * `bothLocked` 是**派生值**（= 两个时间戳都非空），不是「这一次有没有推进」——
 * 一份在双方确认之前被取消的合约上它不是 `true`。
 */
export interface ConfirmLockResponse {
  readonly contractId: string;
  readonly status: string;
  readonly bothLocked: boolean;
}

/**
 * 一份要约的视图（`GET /exchange/offers/:offerId`；**双方可见**）。
 *
 * ## 刻意**没有** `offeredSha256` / `targetSha256`
 * 摘要是**内容的指纹**：公开它等于给出一个「某人是否持有同一份制品」的判据。
 * `readMetadata` 的 `select` 里也没有 `sha256`，理由逐字相同（「§9 授权的是『元数据』，
 * 不是『内容摘要』」）。它只出现在服务端的比对里（A-8 的释放前校验）。
 */
export interface OfferView {
  readonly offerId: string;
  readonly status: string;
  readonly proposerId: string;
  readonly counterpartyId: string;
  readonly offeredAssetId: string;
  readonly targetAssetId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  /**
   * 提议方钉住的那一份（增量 A-6）。**可空**：迁移之前的要约没有这三个值
   * （列是可空的，而填一个假值会让「没有承诺」与「承诺了一个全零的版本」分不开）。
   */
  readonly offeredCommitment: { readonly assetVersionId: string; readonly dossierDigest: string } | null;
  /**
   * 提议方的声明。`null` = **没有声明**（与 `[]`「声明了一个空集」不是同一件事：
   * `swap_offers.claims` 的列注释逐字写着这条纪律）。
   */
  readonly claims: readonly Claim[] | null;
}

/**
 * 一份合约的视图（`GET /exchange/contracts/:contractId`；**当事人可见**）。
 *
 * 契约上钉住的是**接受方看过的**那一份（`targetVersionId` / `targetDossierDigest`），
 * 与提议方钉在要约上的那三个列对称（规格 §5.1：「为**双方**各写入」）。
 */
export interface ContractView {
  readonly contractId: string;
  readonly offerId: string;
  readonly status: string;
  readonly partyAId: string;
  readonly partyBId: string;
  readonly assetAId: string;
  readonly assetBId: string;
  readonly lockDeadlineAt: string;
  readonly createdAt: string;
  readonly targetCommitment: { readonly assetVersionId: string; readonly dossierDigest: string } | null;
}
