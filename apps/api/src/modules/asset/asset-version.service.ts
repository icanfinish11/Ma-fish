import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../db/prisma.service.js';
import type { IngestedVersion } from './asset.service.js';
import type { ParsedMetadata } from './metadata/parse-metadata.js';

/**
 * 接入记录与元数据的**落库**（P1 / Task 7；`asset` schema 的写入侧）。
 *
 * ## 为什么需要这个文件（brief 的 Step 1b 是**强制义务**）
 *
 * Task 5 的 `finalize` 返回 {@link IngestedVersion}——一条「行形状」的版本记录——但它
 * **故意没有落库**：`Asset` / `AssetVersion` 两张表当时还不存在（Task 5 报告 §3 末段）。
 * 那条接缝的下一手就是本任务。于是这里的职责只有一个：把那个记录**逐字段**写进
 * `asset_versions`，并把 Task 6 的 `ParsedMetadata` 写进 `asset_metadata`。
 *
 * ## 字段的来源（**每一个都必须来自它自己那一处**）
 *
 * | 列 | 来源 | 取错的后果（实测过的那一种） |
 * |---|---|---|
 * | `storage_key` | `IngestedVersion.storageKey`（= 制品库对象键） | 下载路径找不到对象 |
 * | `plaintext_bytes` | **Task 5 写入侧计量器**数出的明文长度 | 取密文长度 ⇒ 每次合法下载都以「长度不符」被拒（Task 5 探针 m1：11 条红） |
 * | `sha256` | 同一趟流过的明文摘要 | 验的是密文摘要 ⇒ 与上传字节对不上 |
 * | `key_id` / `file_id` | 制品头 | 轮换后按错的键解、AAD 绑定错的文件 |
 * | `uploaded_by_id` | `IngestedVersion.uploadedById`（**可空**） | 匿名/系统导入被写成某个具体的人 |
 *
 * ## `plaintextBytes` 为什么是这一层的**承重**字段（写给 Task 8 与以后的读代码的人）
 *
 * 制品格式里**没有任何字段认证「制品有多长」**（`plaintextLength` 写在尾部、不进任何 AAD），
 * 所以「这份制品是不是被截短过」只能靠**带外**的那个数来判。Task 5 的探针 m6 实测：
 * 不传带外长度 ⇒ 一份更短、完全自洽的制品被**接受**（201）；传它就 422。
 * **Task 8 必须在下载路径上把这一列作为 `expectedPlaintextLength` 传回读取器**——
 * 否则这条核对只在接入期成立，静置在盘上的制品可以被人换成一份更短的、自洽的。
 *
 * ## 刻意**不**落库的东西
 *
 * `IngestedVersion.kind`（`'zip' | 'tar.gz'`）不进任何列。理由有两条，都是当代的：
 * ① brief 与设计的字段清单里没有它（C16：不为「以后可能会用」加列）；
 * ② 今天没有任何读者需要它——`validateArchive` 自己嗅探类型，元数据里也没有「容器类型」
 * 这一项。将来真出现一个「按容器类型过滤」的查询时再加列，那时它是一条被逼出来的迁移。
 * **这是一处据实记载的取舍**，不是遗漏（报告 §Concerns 有同一条）。
 *
 * ## 一个事务
 *
 * 版本与元数据**一起提交或一起回滚**：半份状态（有版本、没有元数据）会让预览资料页
 * 显示一个「解析不出来」的作品，而它其实解析成功了——那正是 Task 6 §11 警告的形态
 * （「把不知道写成没有」）。回滚由用例实测（元数据 INSERT 被撤权 ⇒ 版本行也不留）。
 */
@Injectable()
export class AssetVersionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 把一条待落库的接入记录（连同它的元数据）写进 `asset` schema。
   *
   * @param input.assetId 归属的作品。**由调用方给出**：`Asset` 的创建有自己的入口
   *   （作品可以在上传之前就存在，一个作品也有多个版本），本服务不替它决定。
   * @returns 落库之后**确实写进去**的几个字段（版本 id、制品键、明文长度）。刻意只回这三个：
   *   调用方（接入路径）需要它们继续往下走，而多回一份完整行只会多一份会过期的副本。
   */
  async persistIngested(input: PersistIngestedVersionInput): Promise<PersistedAssetVersion> {
    const { assetId, ingested, metadata } = input;

    return this.prisma.$transaction(async (tx) => {
      const version = await tx.assetVersion.create({
        data: {
          assetId,
          sha256: ingested.sha256,
          storageKey: ingested.storageKey,
          // 唯一正确的来源：写入侧计量器（见文件头）。这里**不做任何转换**——
          // 一旦这里出现 `Number(...)`/`+ 0` 之类的「顺手一算」，来源就不再是它了。
          plaintextBytes: ingested.plaintextBytes,
          keyId: ingested.keyId,
          fileId: ingested.fileId,
          uploadedById: ingested.uploadedById,
        },
        select: { id: true, storageKey: true, plaintextBytes: true },
      });

      await tx.assetMetadata.create({
        data: {
          assetVersionId: version.id,
          readmeExcerpt: metadata.readmeExcerpt,
          // 三份结构化内容整份存（JSONB）：它们是**展示**用的资料，压缩/裁剪都发生在
          // Task 6 的解析里（那些上限是它的职责），这里再削一次只会让两处口径打架。
          fileTree: metadata.fileTree as unknown as Prisma.InputJsonValue,
          languages: metadata.languages as unknown as Prisma.InputJsonValue,
          dependencies: metadata.dependencies as unknown as Prisma.InputJsonValue,
          completeness: metadata.completeness,
          fileTreeTruncated: metadata.fileTreeTruncated,
        },
      });

      return {
        assetVersionId: version.id,
        storageKey: version.storageKey,
        plaintextBytes: version.plaintextBytes,
      };
    });
  }
}

/** {@link AssetVersionService.persistIngested} 的入参。 */
export interface PersistIngestedVersionInput {
  /** 归属的作品（`asset.assets.id`）。 */
  readonly assetId: string;
  /** Task 5 的接入记录（**唯一**的字段来源，见类注释的表）。 */
  readonly ingested: IngestedVersion;
  /** Task 6 的元数据解析结果。 */
  readonly metadata: ParsedMetadata;
}

/** 落库之后的版本记录（只含调用方继续往下走需要的那几个字段）。 */
export interface PersistedAssetVersion {
  readonly assetVersionId: string;
  /** 制品库对象键（与 `ingested.storageKey` 逐字相同——回读自数据库，不是回显入参）。 */
  readonly storageKey: string;
  /**
   * 明文长度。**Task 8 必须**在下载路径把它作为 `expectedPlaintextLength` 传给读取器
   * （见类注释：格式里没有字段认证制品总长）。
   */
  readonly plaintextBytes: number;
}
