import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import type { ParsedMetadata } from './metadata/parse-metadata.js';

/**
 * `asset` 模块的**读与授权**门面（P1 / Task 8；设计决定 D11）。
 *
 * ## 它为什么存在（而不是把这几行写进控制器）
 *
 * 设计 §3.2 把 `asset` 模块的对外接口定为 `store / readMetadata / checkAccess / signDownloadUrl`。
 * 前两条就在这里，后两条在 `download/download.service.ts`。控制器只做 HTTP 的事
 * （取参数、翻译状态码、写响应），**判定**留在这里——否则「谁能下载」这件事会散在
 * 路由里，而 D11 要求它只有**一个**入口。
 *
 * ## `checkAccess` 是唯一的授权入口
 *
 * 今天它只回答一个问题：**调用方是不是这个作品的所有人**。设计 §9 的矩阵里
 * `Asset` 制品 download 一行还有「交换对手方（`RELEASED` 后）」「买家（成交且已托管）」，
 * 但那两档要等 P2/P3 的合约与托管状态存在——**今天它们不存在，因此不在判定里**
 * （C16：不为不存在的状态写分支）。将来加它们时，**只加在这里**：
 * 调用方（控制器、策略条件、将来的 worker）都不许自己再判一遍。
 *
 * ## 为什么 `userId` 允许 `null` 且一律返回 false
 *
 * 匿名请求在 HTTP 边界上已经被 `PolicyGuard` 拒掉了（票据兑换那条公开路由走的是
 * **签名**，见 `download.service.ts`）。这里的 `null` 是给非 HTTP 调用方用的
 * （将来的 worker / 内部任务可能没有当事人）。判定必须**自足**：一个「前提是调用方
 * 已经判过」的授权函数，在第二个调用方出现时就会变成两条不同的规则。
 *
 * ## 一处据实记载：`assetId` / `assetVersionId` 假定是 UUID
 *
 * 非法取值会让 Prisma/Postgres 以 `22P02` 失败，**不**伪装成「查不到」——
 * 那会把一次调用方错误说成一次正常的 404。参数校验属于 HTTP 边界（Task 7 的报告
 * 把这条明确移交给 Task 8），因此控制器在调用之前用**同一个** UUID 判据
 * （`download/signed-url.ts` 的 `UUID_IDENTIFIER`）挡掉形状不对的路径参数。
 */
@Injectable()
export class AssetAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * **唯一的**授权判定（D11）：`userId` 是不是 `assetId` 的当前所有人。
   *
   * @param assetId 作品（`asset.assets.id`）。
   * @param userId 当事人；`null`（匿名/系统）一律 false。
   */
  async checkAccess(assetId: string, userId: string | null): Promise<boolean> {
    if (userId === null || userId === '') return false;
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId }, select: { ownerId: true } });
    // 作品不存在 ⇒ false（而不是抛「不存在」）：授权判定的答案只有「可以」与「不可以」，
    // 把「这个作品存不存在」混进返回值会让调用方按错误类型分支，而那条分支没有消费者。
    return asset !== null && asset.ownerId === userId;
  }

  /**
   * 下载路径要的那几列（版本存在性 + 制品定位 + **带外明文长度** + **制品身份**）。
   *
   * 为什么把 `plaintextBytes` 一起取出来（而不是让调用方再去查一次）：它是下载路径上
   * **承重**的那个数——必须作为 `expectedPlaintextLength` 传给归档校验（见
   * `download.service.ts` 的强制义务那一段）。同一次查询里取出它，就没有「忘了带上」
   * 这条路径。
   *
   * 为什么 `fileId` / `keyId` 也在这里（I1）：它们同样是**承重**的核对值，而且只能是
   * 同一次查询里的同几列——「下载路径必须把制品的身份与这条记录比对」这条义务要么
   * 在这个 `select` 里成立，要么在调用方多一次查询里成立，后者迟早会漏。
   * 与 `plaintextBytes` 一样，它们**只**用于服务端的比对，不进任何响应体
   * （`readMetadata` 的 `select` 里没有它们，见那边的注释）。
   */
  async findDownloadableVersion(assetVersionId: string): Promise<DownloadableVersion | null> {
    const row = await this.prisma.assetVersion.findUnique({
      where: { id: assetVersionId },
      select: {
        id: true,
        assetId: true,
        storageKey: true,
        plaintextBytes: true,
        fileId: true,
        keyId: true,
      },
    });
    if (row === null) return null;
    return {
      assetVersionId: row.id,
      assetId: row.assetId,
      storageKey: row.storageKey,
      plaintextBytes: row.plaintextBytes,
      fileId: row.fileId,
      keyId: row.keyId,
    };
  }

  /**
   * **一件作品对外可用的全部事实**（P3 / Task 6；增量 A-6 的第一个消费者）。
   *
   * ## 为什么它必须存在（一处计划缺口，据实记载）
   *
   * 增量 A-6 要求 `proposeOffer` 写四个东西：提议方拿出的那一份的
   * `offered_version_id` / `offered_sha256` / `offered_dossier_digest` 与 `claims`。
   * 其中 `offered_sha256` 的来源是**唯一**的（A-6 的 Produces 行逐字：
   * 「`AssetVersion.sha256`（已存在）」），而 `claims` 的判据要读元数据的事实。
   * 此外 `swap_offers` 还需要两列**创建那一刻的快照**：`counterparty_id`
   * （= 被要约作品的所有人）与 `status` 的资格（§6.1 第 2 条要读完整度与 README）。
   *
   * 实测：`asset` 今天导出**三个**读形状，**没有一个**能回答「这件作品的所有人是谁」
   * 或「它当前那一份的 sha256 是什么」——
   * {@link checkAccess} 只回**布尔**、{@link readMetadata} 按**版本 id** 读且刻意不含
   * `sha256`（它是内容指纹，不进对外契约）、{@link findDownloadableVersion} 按**版本 id**
   * 读且不 select `sha256`。
   * ⇒ 这是 Task 6 对 `asset` 的**唯一**一处新增，而它是 A-6 的使能条件
   * （与 D4「为一个已交付功能加索引不是投机抽象，是它的使能条件」同一判据）。
   *
   * ## 为什么它返回 `ownerId` / `lockedAt`，而不是让调用方再判一次
   *
   * * `ownerId` 是**事实**，不是判定：授权判定仍然是 {@link checkAccess}（D11 的唯一入口，
   *   `proposeOffer` 里各调用一次）。但 `swap_offers.counterparty_id` 要存的是**取值**，
   *   而「是不是他的」这个布尔里没有那个取值；
   * * `lockedAt` 是 `asset.assets` 的列（D10 的锁落在作品行上），而 §6.3:284 的
   *   「不可编辑 / 不可另行上架 / 不可删除」要判的正是它。
   *
   * **一次读取给出全部四个事实**（而不是让调用方按需挑字段）：`eligibility.ts` 的类注释
   * 已经为同一族缺陷付过一次代价——「三个参数会在调用点散成三处取值来源」。
   *
   * ## 为什么它落在本文件而不是新开一个服务 / 让 `exchange` 直接读表
   *   * `swap_offers.counterparty_id` 的列注释把这件事写死了：**「按 `targetAssetId`
   *     反查 `asset.assets.owner_id` 会跨模块（C5 禁止）」** —— 直接读对方的表不是
   *     本仓库的形状；
   *   * 它**不改任何既有形状**：没有新模块、没有新文件、没有改 P1 的 schema、没有新索引。
   *
   * ## 为什么是「委托 `readMetadata`」而不是复制一份嵌套 `select`
   * 元数据的**形状只有一处定义**（{@link readMetadata} 的那个 `select`）。在这里再写
   * 一份嵌套 `select` 就是「同一件事两处各写一份」——那正是 `eligibility.ts` 点名的
   * 缺陷族。两次查询的代价换来的是：加一个元数据列时只有一处要改，而两次查询之间
   * 没有漂移风险（第二次的键就是第一次刚读出来的 id）。
   *
   * ## 据实记载：这是**第一条按 `assetId` 查 `asset_versions` 的读法**
   *
   * `AssetVersion` 上没有 `@@index([assetId])`（schema 的注释写着「今天唯一的读法是
   * 『按版本 id 取一份』，那是主键」）。本方法让那句话不再成立：**每次 `proposeOffer`
   * 会做两次按 `assetId` 的顺序扫描**。本轮**没有**顺手加索引——那是改 P1 schema 的
   * 一次迁移，而 Task 5.5 的先例是「不擅自把改动半径伸进 P1 既有文件」。
   * **复访触发条件**：`asset_versions` 的行数超过 10^4，或者 `proposeOffer` 的 p95
   * 出现可归因于这里的回归。修法是 `@@index([assetId])` + 一支迁移（Prisma 建得出来，
   * 因此零漂移门**是**它的见证）。
   *
   * @returns 作品不存在 ⇒ `null`（**不是**抛错：调用方要区分的是「这件作品没有可用的
   *   那一份」，而那是 `AssetNotFoundError` / `IneligibleAssetError` 的判断，属于调用方）。
   */
  async readAssetFacts(assetId: string): Promise<AssetFactsView | null> {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, ownerId: true, lockedAt: true },
    });
    if (asset === null) return null;
    const latest = await this.prisma.assetVersion.findFirst({
      where: { assetId },
      // `id` 是**决定性的次键**：`created_at` 是 `timestamptz(3)`，同一毫秒内的两份版本
      // 在只按时间排序时顺序未定义。主键是 UUIDv7（C4，时间有序），因此 `id desc`
      // 与 `createdAt desc` 同向，而它让「当前那一份」成为**确定**的。
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, sha256: true },
    });
    return {
      assetId: asset.id,
      ownerId: asset.ownerId,
      lockedAt: asset.lockedAt,
      // 一份版本都没有 ⇒ `null`（**不是**抛错、也不是一个全零的版本）。
      currentVersion: latest === null ? null : { assetVersionId: latest.id, sha256: latest.sha256 },
      metadata: latest === null ? null : await this.readMetadata(latest.id),
    };
  }

  /**
   * 元数据读取（§9 矩阵：`Asset` 元数据 read = **所有人**）。
   *
   * **只回元数据**：`storage_key` / `file_id` / `key_id` 是服务端内部标识
   * （Task 1 的控制器注释把「存储键不外泄」写成了义务），`sha256` 是**内容的指纹**
   * ——公开它等于给出一个「某人是否持有同一份制品」的判据，而 §9 授权的是「元数据」，
   * 不是「内容摘要」。三者一列都不在这一节的 `select` 里：不是靠过滤，是**取不到**。
   *
   * @returns 版本不存在、或该版本没有元数据行 ⇒ `null`（调用方回 404）。
   */
  async readMetadata(assetVersionId: string): Promise<AssetMetadataView | null> {
    const row = await this.prisma.assetVersion.findUnique({
      where: { id: assetVersionId },
      select: {
        id: true,
        metadata: {
          select: {
            readmeExcerpt: true,
            fileTree: true,
            languages: true,
            dependencies: true,
            completeness: true,
            fileTreeTruncated: true,
            // ★ 增量 A / Task 5.5：保真链的 `min_code_lines(n)` 判据要读这一列。
            // 它在白名单里（它不是 `storage_key` / `file_id` / `key_id` / `sha256`
            // 那四类服务端标识，而是 §6.1 的 dossier 十项之一「代码行数统计」）。
            codeLines: true,
          },
        },
      },
    });
    const metadata = row?.metadata;
    if (row === null || metadata === null || metadata === undefined) return null;

    return {
      assetVersionId: row.id,
      readmeExcerpt: metadata.readmeExcerpt,
      // 三份结构化内容是 Task 6 的解析器写进来的（同一进程、同一形状）。这两处断言是
      // **声明的延续**，不是校验：库里那份若是别的形状，那是写入侧的问题，而在读路径上
      // 再验一遍只会把一次数据问题伪装成一次 500（C16）。类型上 Prisma 只给得出 JsonValue。
      fileTree: metadata.fileTree as unknown as ParsedMetadata['fileTree'],
      languages: metadata.languages as unknown as ParsedMetadata['languages'],
      dependencies: metadata.dependencies as unknown as ParsedMetadata['dependencies'],
      completeness: metadata.completeness,
      fileTreeTruncated: metadata.fileTreeTruncated,
      // 原样读回（`number | null`）：旧行没有这个值 ⇒ `null`，**不是** `0`。
      // 编造一个 `0` 会让「这一列之前不存在」与「这份制品真的 0 行代码」变成同一个值，
      // 而声明侧的判据读到 `0` 会**判违约成立**——一次数据缺失变成一次错误的裁决。
      codeLines: metadata.codeLines,
    };
  }
}

/**
 * 一件作品对外可用的全部事实（见 {@link AssetAccessService.readAssetFacts}）。
 *
 * ## 为什么 `sha256` 在这里（而 `AssetMetadataView` 里没有它）
 * 两者是不同的边界：`AssetMetadataView` 会**直接成为 HTTP 响应**
 * （`asset.controller.ts` 的元数据路由），因此内容指纹不进它；
 * 本类型是**跨模块的服务端形状**——增量 A-6 要把它写进
 * `swap_offers.offered_sha256`（那一列由 A-8 在释放前回比）。
 * 它**不进任何响应体**：`OfferView` 里刻意没有 `offeredSha256`（理由见 `dto.ts`）。
 */
export interface AssetFactsView {
  readonly assetId: string;
  /**
   * 作品的所有人。**是事实，不是判定**：授权判定的唯一入口仍然是
   * {@link AssetAccessService.checkAccess}（D11）。`exchange` 需要这个**取值**
   * 是因为 `swap_offers.counterparty_id` 存的是「创建那一刻的所有人快照」。
   */
  readonly ownerId: string;
  /**
   * 处分冻结的时刻（D10：锁落在**作品**行上）。`null` = 没锁。
   * §6.3:284 的「不可编辑 / 不可另行上架 / 不可删除」判的就是它。
   */
  readonly lockedAt: Date | null;
  /** 当前那一份（最新的版本行）。一份都没有 ⇒ `null`。 */
  readonly currentVersion: { readonly assetVersionId: string; readonly sha256: string } | null;
  /** 当前那一份的元数据视图；没有版本、或那一份没有元数据行 ⇒ `null`。 */
  readonly metadata: AssetMetadataView | null;
}

/** 下载路径定位制品所需的那几列（见 {@link AssetAccessService.findDownloadableVersion}）。 */
export interface DownloadableVersion {
  readonly assetVersionId: string;
  readonly assetId: string;
  /** 制品库里的对象键（**不外泄**：它只出现在服务端与审计的非机密字段里）。 */
  readonly storageKey: string;
  /**
   * 写入侧计量器数出的明文长度（Task 5）。下载路径**必须**把它作为
   * `expectedPlaintextLength` 传回校验器——格式里没有任何字段认证制品总长。
   */
  readonly plaintextBytes: number;
  /**
   * 「这份制品」的身份：制品头里的 `fileId`（hex，AAD 绑定的那个值）。
   *
   * 下载路径**必须**把它与读取器解出来的 `fileId` 比对（I1）：只核长度挡不住
   * 「另一份明文等长的合法制品」被换进制品卷——那正是这份设计所针对的不可信角色
   * 能做、且只靠长度看不出来的事。
   */
  readonly fileId: string;
  /** 写入时用的制品密钥 id（= 制品头里的那个）。同一次比对里顺带核对（见 `reader.keyId`）。 */
  readonly keyId: string;
}

/**
 * 元数据响应的形状：`ParsedMetadata` 逐字段 + 版本 id（**只有它，没有别的**）。
 *
 * ## ★ 增量 A / Task 5.5：`codeLines` 的**类型两侧不同**，因此它是 `Omit` 之后单独声明的
 *
 * ```ts
 * extends Omit<ParsedMetadata, 'codeLines'>   // 其余字段照旧（写入侧与读取侧事实相同）
 * readonly codeLines: number | null;          // ← 这一侧**可能不知道**
 * ```
 *
 * 写成 `extends ParsedMetadata`（即 `codeLines: number`）**连编译都过不去**——而那是好事：
 * 这两侧的事实确实不同。**写入侧**（`parse-metadata.ts` 的 `ParsedMetadata`）的行数总是
 * 刚算出来的，**读取侧**却要面对**迁移之前的旧行**（那一列是 NULL）。
 * ⇒ 从 `ParsedMetadata` 里 `Omit` 掉再单独声明，**不是**为了绕开类型检查，而是因为
 * 「写侧一定有值、读侧可能没有」这句话在类型上必须说出来；写成 `number` 会逼出一个
 * 编造的 `0`，而 `0` 与「不知道」在保真链的判据里是**相反**的结论。
 */
export interface AssetMetadataView extends Omit<ParsedMetadata, 'codeLines'> {
  readonly assetVersionId: string;
  /**
   * `asset_metadata.code_lines` **原样**读回。**可空**是刻意的：迁移之前的行没有这个值，
   * 而 `0` 会把「之前不存在」与「真的 0 行」混成同一个值 —— 那正是
   * `eligibility.ts` 类注释里点名的「三个取值来源」那一类缺陷。
   *
   * 消费侧的义务（Task 6 的 `assertClaimVerifiable`）：这一项为 `null` 时**不允许**
   * 声明 `min_code_lines`（fail-closed），而不是把它当成 0 去判违约。
   */
  readonly codeLines: number | null;
}

/**
 * 版本不存在（下载与元数据两条路径共用）。
 *
 * 与 {@link AssetNotFoundError}（Task 7，作品层面的不存在）分开：两者的调用方不是同一批，
 * 而错误消息里点名的对象也不同（一个 UUID 是作品、另一个是版本）。状态码都是 404，
 * 因此 HTTP 边界上它们落在同一条翻译里，但**类型**分得开——否则「哪个对象指错了」
 * 在日志与测试里要靠猜。
 */
export class AssetVersionNotFoundError extends Error {
  constructor(readonly assetVersionId: string) {
    super(`版本不存在：${assetVersionId}`);
    this.name = 'AssetVersionNotFoundError';
  }
}
