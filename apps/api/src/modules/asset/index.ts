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
 * **不导出**：`AssetService`（接入流程）、`AssetVersionService`、`OwnershipService`——
 * 它们今天没有模块外的调用方（C16：不为不存在的调用方建接口）。测试直接用深路径 import，
 * 那是测试的特权（架构规则的主体是 `apps/` 的源码，不是 `tests/`）。
 */
export { AssetModule } from './asset.module.js';

export {
  AssetAccessService,
  AssetVersionNotFoundError,
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
