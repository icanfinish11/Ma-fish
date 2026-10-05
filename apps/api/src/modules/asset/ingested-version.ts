import type { ArchiveKind } from './archive/sniff.js';

/**
 * 待落库的版本记录：`AssetService.finalize`（Task 5）的返回值，`AssetVersionService.persistIngested`
 * （Task 7）的入参。
 *
 * ## 为什么它自己住一个文件（Task 9；这是一条**被架构门逼出来**的边界，不是风格选择）
 *
 * 生产接线之后 `AssetService` 需要 `AssetVersionService`（`ingest` 的第三步要落库），
 * 而 `AssetVersionService` 需要这个类型。两边直接互相 import 就会构成一个环，而
 * `.dependency-cruiser.cjs` 的 `no-circular` 规则**真的抓到了它**（`pnpm test` 的 architecture
 * project 实测：`apps/api/src/modules/asset/asset-version.service.ts →
 * apps/api/src/modules/asset/asset.service.ts` 一条 error）。
 *
 * 那个环不是配置噪音：`options.tsPreCompilationDeps` 是**刻意打开**的——类型依赖同样是一条依赖
 * （它让两个文件在编译期互为前提，改一个的导出形状就会动到另一个）。因此修法是把共享的**形状**
 * 提到一个两侧都依赖、而它自己不依赖任何一方的文件里：
 *
 * ```
 * asset.service.ts ──(值)──▶ asset-version.service.ts
 *         │                            │
 *         └────(类型)──▶ ingested-version.ts ◀──(类型)────┘
 * ```
 *
 * ## 字段刻意用「行」的粒度
 *
 * Task 7 把它铺成 `Asset` / `AssetVersion` / `AssetMetadata` 时不需要再回到别处补任何东西
 * ——特别是 `plaintextBytes`，它是**唯一**那条带外长度的载体（制品格式里没有任何字段认证
 * 「制品有多长」，见 `artifact-format.ts` 与 `validate-archive.ts` 的移交说明）。
 */
export interface IngestedVersion {
  /** 制品库对象键（下载路径靠它取对象；**不**出现在 HTTP 响应里）。 */
  readonly storageKey: string;
  /** 明文（上传字节）的 sha256，hex。**不是**制品的摘要。 */
  readonly sha256: string;
  /** 明文字节数（写入侧计量器数出的那个数）。**不是**密文对象的字节数。 */
  readonly plaintextBytes: number;
  /** 写入时用的 keyId（= 制品头里的那个，轮换靠它选键）。 */
  readonly keyId: string;
  /** 制品头里的 fileId（hex）。 */
  readonly fileId: string;
  /** 嗅探出来、且通过了校验的归档类型。 */
  readonly kind: ArchiveKind;
  /** 上传人；匿名/系统导入为 `null`（`asset_versions.uploaded_by_id` 可空）。 */
  readonly uploadedById: string | null;
}
