/**
 * `asset` 模块的**对外接口**（设计 §3.3 第 2 条：跨模块只经显式接口）。
 *
 * ## 为什么是逐条 `export { … }` 而不是 `export *`
 *
 * `export *` 会把模块内部的一切（`LocalArtifactStore`、归档 inspector、密钥环的内部
 * 判据、Prisma 的生成类型……）一次性变成对外契约，于是「这个模块依赖什么」这件事
 * 再也说不清，而 `.dependency-cruiser.cjs` 那条 `no-cross-module-internals` 放行的
 * 正是本文件——一个 `export *` 等于把那条规则一并关掉了（它还能被 import，但放行面
 * 变成了整个模块）。
 *
 * ## 这里导出的四类东西，对应设计 §3.2 的四条接口
 *
 * | 接口 | 落点 |
 * |---|---|
 * | `store` | `ARTIFACT_STORE` 令牌 + `ArtifactStore` 端口类型 |
 * | `readMetadata` | `AssetAccessService.readMetadata` |
 * | `checkAccess` | `AssetAccessService.checkAccess`（**唯一**授权入口，D11） |
 * | `signDownloadUrl` | `DownloadService.issueDownloadUrl` |
 *
 * 另外导出：模块类本身（组合根 import 它），以及**领域错误类型**——
 * 边界要能分开说清责任方（404/409/422/500），把错误类藏在模块内部会让调用方只能按
 * 错误消息匹配。
 *
 * **不导出**：`AssetService`（接入流程）、`AssetVersionService`——
 * 它们今天没有模块外的调用方（C16：不为不存在的调用方建接口）。测试直接用深路径 import，
 * 那是测试的特权（架构规则的主体是 `apps/` 的源码，不是 `tests/`）。
 *
 * ## P3 / Task 1 新增的四处导出（以及它们各自的**真实**调用方）
 *
 * | 导出 | 谁是第一个模块外的调用方 |
 * |---|---|
 * | `OwnershipService` | `exchange`（Task 8 的原子释放：同一个 `tx` 里装下所有权互换） |
 * | `AssetNotFoundError` / `SelfTransferRejectedError` | 同上：HTTP 边界要分开说清责任方（404 / 409） |
 * | `POLICY_CONDITIONS` | **没有**模块外调用方（见下面那条注释里的据实记载与复访条件） |
 *
 * `OwnershipService` 此前**刻意**不导出，理由写在旧版注释里：「它今天没有模块外的调用方
 * （C16：不为不存在的调用方建接口）」。**Task 8 是第一个真实调用方**，因此导出的时机
 * 就是现在，而不是 P1 那会儿——那条理由没有被推翻，只是它的前提到期了。
 * 两个错误类型同批导出：`transferOwnership` 会抛它们，而 HTTP 边界必须能分开翻译。
 */
export { AssetModule } from './asset.module.js';

/**
 * 策略条件的名字（P3 / Task 1）。
 *
 * ## 据实记载：它今天**没有任何模块外的调用方**
 *
 * 真正的引用者在模块**内部**（`asset.module.ts` 从 `./asset.controller.js` 直接 import
 * 它来注册条件），因此按 C16「不为不存在的调用方建接口」的严格读法，这一行本可以不加。
 * 它写在这里的理由是**计划 Task 1 Step 7 明写要加**，并且它属于「模块对外接口」这张表：
 * `asset` 的条件名从此是**具名且可见**的，而不是藏在内部文件里。
 *
 * **复访触发条件**：若到 P3 结束仍没有任何模块外代码 import 它，就删掉这一行
 * （而不是留着「以防万一」）——这句是给下一位实现者的，不是给读者的安慰。
 */
export { POLICY_CONDITIONS } from './asset.controller.js';

export {
  AssetNotFoundError,
  OwnershipService,
  SelfTransferRejectedError,
  type OwnershipTransferResult,
  type TransferOwnershipInput,
} from './ownership.service.js';

export {
  AssetAccessService,
  AssetVersionNotFoundError,
  // P3 / Task 6（增量 A-6）：`proposeOffer` 要按 `assetId` 取一件作品的四个事实
  // （所有人 / 锁 / 当前那一份的版本与摘要 / 元数据视图）。它是**本模块唯一的**新增读形状，
  // 理由与「为什么必须存在」写在 `asset-access.service.ts` 的 `readAssetFacts` 上。
  type AssetFactsView,
  type AssetMetadataView,
  type DownloadableVersion,
} from './asset-access.service.js';

export {
  DownloadForbiddenError,
  DownloadService,
  DownloadTicketRejectedError,
  type DownloadFailureReason,
  type IssuedDownload,
  type OpenedDownload,
} from './download/download.service.js';

export {
  DOWNLOAD_PATH,
  DOWNLOAD_TTL_SECONDS,
  UUID_IDENTIFIER,
  type DownloadTicket,
  type TicketVerdict,
} from './download/signed-url.js';

export { ARTIFACT_STORE, type ArtifactStore } from './store/artifact-store.port.js';
