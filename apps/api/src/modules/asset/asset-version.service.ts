import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
// 待落库记录的**形状**住在它自己的文件里（Task 9）：它与 `AssetService` 共享，而两边直接
// 互相 import 会构成一个环（`no-circular` 在 `pnpm test` 的 architecture project 里实测抓到过）。
// 理由与依赖图写在 `ingested-version.ts` 的头部。
import type { IngestedVersion } from './ingested-version.js';
import { AssetLockService } from './asset-lock.service.js';
import { AssetNotFoundError } from './ownership.service.js';
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
 * ## Task 9 起：作品**随这次上传诞生**（这条缝的最后一手）
 *
 * Task 7 交付时，作品只能由调用方/测试直接写库——「上传一个包」与「作品」的关系是一个
 * **产品决定**，当时没有裁定，于是 `persistIngested` 一直没有生产调用方（Task 7 §9
 * Concern 4/5、Task 8 §10 Concern 4 都据实记着这件事）。控制器现在的裁定是：
 * **上传者即所有人**（不需要任何额外的产品输入，且与 D11「所有人可以下载」一致）。
 * 因此 `persistIngested` 多了一种入参形态：`{ ownerId }` = 作品与版本、元数据**同一个事务**
 * 里一起诞生；`{ assetId }` = 挂进一个已有作品（schema 支持的 1:N 形状，今天没有这条流程）。
 * 上传路径（`AssetService.ingest`）用的是第一种。
 *
 * ## 字段的来源（**每一个都必须来自它自己那一处**）
 *
 * | 列 | 来源 | 取错的后果（实测过的那一种） |
 * |---|---|---|
 * | `storage_key` | `IngestedVersion.storageKey`（= 制品库对象键） | 下载路径找不到对象 |
 * | `plaintext_bytes` | **Task 5 写入侧计量器**数出的明文长度 | 取密文长度 ⇒ 每次合法下载都以「长度不符」被拒（Task 5 探针 m1：11 条红；Task 9 的 m5 在**链路**上复现同一件事） |
 * | `sha256` | 同一趟流过的明文摘要 | 验的是密文摘要 ⇒ 与上传字节对不上 |
 * | `key_id` / `file_id` | 制品头 | 轮换后按错的键解、AAD 绑定错的文件 |
 * | `uploaded_by_id` | `IngestedVersion.uploadedById`（**可空**） | 匿名/系统导入被写成某个具体的人 |
 * | `assets.owner_id` | `{ ownerId }` 形态下由调用方给出（上传路径 = **上传者**） | 上传的作品不归上传者（Task 9 探针 m2：端到端用例红） |
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
 * 作品行（`{ ownerId }` 形态下）、版本与元数据**一起提交或一起回滚**：半份状态
 * （有版本、没有元数据；或作品建好了却没有版本）会让预览资料页显示一个「解析不出来」
 * 的作品，而它其实解析成功了——那正是 Task 6 §11 警告的形态（「把不知道写成没有」）。
 * 回滚由用例实测（元数据 INSERT 被撤权 ⇒ 版本行也不留；Task 9 又把「版本 INSERT 被撤权
 * ⇒ 作品行与密文对象都不留」在**端到端**上量了一次）。
 */
@Injectable()
export class AssetVersionService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * ★ 增量 A-7：作品的**交换锁定**（P3 / Task 7 的 `AssetLockService`）。
     *
     * 它是 §6.3:284「不可编辑」这句话在本文件里的执行者：`{ assetId }` 分支在写任何一行
     * **之前**问一次「这件作品锁着吗」。注入而不是在这里读表：那个判定的**唯一**实现
     * 在 `AssetLockService.isLocked` 上（「作品现在能不能被编辑」只有一个答案来源）。
     */
    private readonly locks: AssetLockService,
  ) {}

  /**
   * 把一条待落库的接入记录（连同它的元数据）写进 `asset` schema。
   *
   * ## 作品是**已经存在**的，还是**随这次上传诞生**的
   *
   * 入参因此有两种形态（`PersistIngestedVersionInput` 是一个判别联合，写错哪一种都过不了类型检查）：
   *
   * | 形态 | 谁在用 | 语义 |
   * |---|---|---|
   * | `{ ownerId }` | **上传路径**（`AssetService.ingest`） | 作品**随这次上传诞生**，所有人是上传者（控制器裁定） |
   * | `{ assetId }` | 给已有作品加版本（schema 支持 1:N；今天没有这条生产流程，用例用它） | 版本挂进那个已有作品 |
   *
   * 两件事在**同一个事务**里：作品行、版本行、元数据行一起提交或一起回滚。
   * 半份状态（有作品没有版本、有版本没有元数据）都会让预览资料页显示一个「解析不出来」
   * 的作品，而它其实解析成功了——那正是 Task 6 §11 警告的形态（「把不知道写成没有」）。
   *
   * @param input.ownerId 作品随这次上传诞生时给出（**上传路径**）。作品不存在这一说因此
   *   不存在——它是本方法自己刚建的。
   * @param input.assetId 挂进一个**已有**作品时给出。
   * @throws {AssetNotFoundError} 给了 `assetId` 而那个作品不存在（**不**落任何行）。错误类型
   *   与 `OwnershipService.transferOwnership` 用的是**同一个类**：Task 8 的 HTTP 边界
   *   因此只需要一处翻译（否则同一种「指错了作品」会在两条路由上得到不同状态码）。
   * @returns 落库之后**确实写进去**的几个字段（作品 id、版本 id、制品键、明文长度）。
   *   刻意只回这几个：调用方（接入路径）需要它们继续往下走，而多回一份完整行只会多一份会过期的副本。
   */
  async persistIngested(input: PersistIngestedVersionInput): Promise<PersistedAssetVersion> {
    const { ingested, metadata } = input;

    return this.prisma.$transaction(async (tx) => {
      /**
       * ⓪-a 作品**随这次上传诞生**：`ownerId` 由调用方给出（上传路径给的是**上传者**，
       *     那是控制器已经裁定过的产品决定：上传者即所有人）。
       *
       *     它必须在**同一个事务**里建：分成两步的话，「作品建好了、版本没写进去」会留下
       *     一个没有任何版本的作品行——一份半成品，而它比干净地失败更难收拾
       *     （库里的作品是**永久实体**，没有一个「删除作品」的入口）。
       *
       *     顺序也在这一句里：作品是在**校验与元数据解析都通过之后**才被创建的
       *     （调用方 `AssetService.ingest` 的顺序），因此被拒的上传连作品行都不会有。
       */
      const assetId =
        input.assetId ??
        (
          await tx.asset.create({
            data: { ownerId: input.ownerId },
            select: { id: true },
          })
        ).id;

      /**
       * ⓪-b 给出了 `assetId` 时，作品的**归属**先被确认。不确认的话这里的失败来自外键
       *     （`P2003`），调用方拿到的是一句「约束失败」——说不出责任方，而且与
       *     `transferOwnership` 在同样情形下给出的 `AssetNotFoundError` 不一致
       *     （Task 8 把两个方法接在**同一个** HTTP 边界下，那种不对称会让翻译被决定两次、
       *     且两次不同）。
       *     错误类型与措辞都复用**同一个** `AssetNotFoundError`（它住在 `ownership.service.ts`，
       *     不是复制一份）：两个类同名同言，边界上的翻译就只有一处。
       *
       *     ★ **增量 A-7（P3 / Task 7）**：这一段同时是**处分冻结**的检查点
       *     —— §6.3:284 说双方锁定之后作品「**不可编辑**」，而本方法是**唯一**能把版本
       *     加到一件已存在作品上的写入点。判据走 `AssetLockService.isLocked`
       *     （**一个**判决给出两件事：作品在不在、锁着吗），因此两件事**在同一次读取里**
       *     被回答——分两次读会让「作品消失了」与「它刚被锁上」在两次快照之间换位。
       *
       *     **据实划界**：这条路径今天**零生产调用方**（类注释第 27 行写着这件事），
       *     所以这道检查今天拦住的是**测试与将来的调用方**。放它的理由是本项目的标准：
       *     **结构性不可能 > 约定** —— 等那条路径第一次有调用方时，锁已经在它里面了。
       *     **复访触发条件**（与 `isLocked` 的注释同一条）：这条检查是**读**，不是锁。
       *     真出现「看 v1、交 v2」的流程时，它必须改成按同一条全局锁序取行锁（`FOR UPDATE`），
       *     否则「读完之后、写版本之前，别人把作品锁上了」这个窗口就是一条真实的旁路。
       */
      if (input.assetId !== undefined) {
        const verdict = await this.locks.isLocked(tx, input.assetId);
        if (verdict === null) throw new AssetNotFoundError(input.assetId);
        if (verdict.locked) {
          // 409（`ASSET_LOCKED_FOR_VERSION`）。**不**复用 `AssetNotFoundError`：
          // 作品**存在**且调用方通常就是它的所有人，回 404 等于用「没有这个作品」
          // 去描述一个他拥有、只是被处分冻结的作品（`SelfTransferRejectedError`
          // 当初拒 404 的理由逐字相同）。
          throw new AssetLockedForVersionError(input.assetId, verdict.holderContractId);
        }
      }

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
          fileTree: metadata.fileTree,
          languages: metadata.languages,
          dependencies: metadata.dependencies,
          completeness: metadata.completeness,
          fileTreeTruncated: metadata.fileTreeTruncated,
          // ★ 增量 A / Task 5.5：代码行数**落库**（保真链的 `min_code_lines(n)` 判据要读它）。
          // 来源是解析器刚数出来的那个数（`ParsedMetadata.codeLines`，**总是**有值）；
          // 这一列在库里**可空**，因为迁移之前的旧行没有这个值——写入侧因此不存在
          // 「写 null」这条路（真写 null 只可能来自 `metadata.codeLines` 被伪造）。
          codeLines: metadata.codeLines,
        },
      });

      return {
        assetId,
        assetVersionId: version.id,
        storageKey: version.storageKey,
        plaintextBytes: version.plaintextBytes,
      };
    });
  }
}

/**
 * 往一件**被处分冻结**的作品里写新版本 ⇒ **409**（增量 A-7 / §6.3:284 的第一个执行点）。
 *
 * ## 为什么这个错误住在 `asset` 而不是复用 `exchange/core/errors.ts` 的 `AssetLockedError`
 * 预检 §0.2 实测：`asset → exchange` 一旦成环，`pnpm arch` 就是 **6 条 error / exit 6**
 * （单向时 exit 0）。D11 的接缝是「`asset` 拥有处分判定，`exchange` 把事实**推**给它」，
 * 因此这里**只**读 `asset.assets` 自己的两列，不 import 任何 exchange 符号。
 *
 * ## 为什么是 409 而不是 404 / 422
 * 与 `AssetLockedByContractError`（同一份锁的另一条路径）逐字同一条理由：
 * 作品**存在**，请求本身完全合法，冲突在于**资源的当前状态**（它被另一份合约处分冻结）。
 * 404 会用「没有这个作品」描述一个调用方拥有的作品；422 在本仓库是「内容不可接受」。
 *
 * ## 为什么它**不**从 `asset/index.ts` 导出（一处据实记载）
 * 今天没有任何模块外的调用方：它的 HTTP 出口在本模块的 `assetErrorToHttp` 里，
 * 而抛出它的那条路径（`persistIngested` 的 `{ assetId }` 分支）也没有生产调用方。
 * C16：不为不存在的调用方建接口。**复访触发条件**：那条路径第一次有 HTTP 调用方时，
 * 它跟着 `AssetNotFoundError` 一起进 `index.ts`（那时边界才需要分开说清责任方）。
 */
export class AssetLockedForVersionError extends Error {
  constructor(
    readonly assetId: string,
    readonly holderContractId: string | null,
  ) {
    super(`作品已被锁定（§6.3:284）：${assetId} 由合约 ${holderContractId ?? '(未知)'} 持有`);
    this.name = 'AssetLockedForVersionError';
  }
}

/**
 * {@link AssetVersionService.persistIngested} 的入参。
 *
 * **判别联合**（不是两个可选字段）：`ownerId` 与 `assetId` 恰好给一个，另一个必须是
 * `undefined`——写成 `assetId?: string; ownerId?: string` 会让「两个都给」与「两个都不给」
 * 在类型上合法，而它们在语义上根本没有定义（前者是「谁是所有人」的两种说法，
 * 后者是「版本挂在哪」的缺失）。
 */
export type PersistIngestedVersionInput = {
  /** Task 5 的接入记录（**唯一**的字段来源，见类注释的表）。 */
  readonly ingested: IngestedVersion;
  /** Task 6 的元数据解析结果。 */
  readonly metadata: ParsedMetadata;
} & (
  | {
      /** 作品**随这次上传诞生**，所有人是这个人（上传路径给的是上传者本人）。 */
      readonly ownerId: string;
      readonly assetId?: undefined;
    }
  | {
      /** 版本挂进这个**已有**作品。 */
      readonly assetId: string;
      readonly ownerId?: undefined;
    }
);

/** 落库之后的版本记录（只含调用方继续往下走需要的那几个字段）。 */
export interface PersistedAssetVersion {
  /** 这份版本所属的作品（`{ ownerId }` 形态下就是本次新建的那个）。 */
  readonly assetId: string;
  readonly assetVersionId: string;
  /** 制品库对象键（与 `ingested.storageKey` 逐字相同——回读自数据库，不是回显入参）。 */
  readonly storageKey: string;
  /**
   * 明文长度。**Task 8 必须**在下载路径把它作为 `expectedPlaintextLength` 传给读取器
   * （见类注释：格式里没有字段认证制品总长）。
   */
  readonly plaintextBytes: number;
}
