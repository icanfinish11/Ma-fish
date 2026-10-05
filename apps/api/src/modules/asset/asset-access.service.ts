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
   * 下载路径要的那几列（版本存在性 + 制品定位 + **带外明文长度**）。
   *
   * 为什么把 `plaintextBytes` 一起取出来（而不是让调用方再去查一次）：它是下载路径上
   * **承重**的那个数——必须作为 `expectedPlaintextLength` 传给归档校验（见
   * `download.service.ts` 的强制义务那一段）。同一次查询里取出它，就没有「忘了带上」
   * 这条路径。
   */
  async findDownloadableVersion(assetVersionId: string): Promise<DownloadableVersion | null> {
    const row = await this.prisma.assetVersion.findUnique({
      where: { id: assetVersionId },
      select: { id: true, assetId: true, storageKey: true, plaintextBytes: true },
    });
    if (row === null) return null;
    return {
      assetVersionId: row.id,
      assetId: row.assetId,
      storageKey: row.storageKey,
      plaintextBytes: row.plaintextBytes,
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
    };
  }
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
}

/** 元数据响应的形状：`ParsedMetadata` 逐字段 + 版本 id（**只有它，没有别的**）。 */
export interface AssetMetadataView extends ParsedMetadata {
  readonly assetVersionId: string;
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
