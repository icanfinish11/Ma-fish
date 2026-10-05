-- ════════════════════════════════════════════════════════════════════════════
-- P1 / Task 7：新增 `asset` schema —— 作品 / 版本 / 元数据 / 所有权历史（D11 + D12）。
--
-- ## 本文件是**生成的**，不要手改结构
--
-- 语句由 `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
-- --script` 产出（对着一个已应用 P0 两个迁移的库取的差值），逐字贴进来，只加了本段注释。
-- 因此它与 `schema.prisma` 的当前状态**结构上一致**：改模型之后必须重新生成一个迁移，
-- 不要在既有迁移里改语句（改过的迁移在新库上会造出与模型不同的结构，而**已应用**它的库
-- 不会有任何感觉——那是最难查的一类漂移）。
--
-- ## 为什么这条迁移必须能在**已迁移**的库上干净落地
--
-- P0 期间踩过一次：迁移被再生成之后，与本地那个**已经应用过**它的卷冲突。本任务的
-- 验证因此在两处各做一次（见 task-7-report.md）：全新库（testcontainer 每次从零跑）
-- 与既有库（本机 compose 的卷，已经应用了 P0 的两个迁移）上各 `migrate deploy` 一次，
-- 并各自跑一次 `migrate diff` 证明**无漂移**（差值为空）。
--
-- ## 三件必须留在语句里的东西
--
-- 1. **`TIMESTAMPTZ(3)`**（C6）：每一个时间列都是 `timestamp with time zone`。
--    裸 `timestamp` 存的是「本地墙上时间」，UTC 只在会话恰好是 UTC 时才成立；
--    本仓库的镜像恰好是 UTC，所以那种错误**不会**在这台机器上露出来。
-- 2. **`id` 列没有 DEFAULT**：C4 的 UUIDv7 由 **Prisma 客户端**生成
--    （`@default(uuid(7))`）——与 P0 的 `auth.users` 一模一样。若在库里加
--    `gen_random_uuid()` 兜底，那会变成 UUIDv4（无时间序），两条默认值还会互相打架。
-- 3. **`plaintext_bytes` 是 NOT NULL**：它不是可选元数据，而是**唯一的**带外明文长度
--    （Task 5 的写入侧计量器数出来）。制品格式里没有字段认证制品总长，所以这一列
--    在下载路径上就是「更短、完全自洽的截断制品」唯一的挡板（Task 5 探针 m6）。
-- ════════════════════════════════════════════════════════════════════════════

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "asset";

-- CreateTable
CREATE TABLE "asset"."assets" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset"."asset_versions" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "plaintext_bytes" INTEGER NOT NULL,
    "key_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset"."asset_metadata" (
    "asset_version_id" UUID NOT NULL,
    "readme_excerpt" TEXT,
    "file_tree" JSONB NOT NULL,
    "languages" JSONB NOT NULL,
    "dependencies" JSONB NOT NULL,
    "completeness" INTEGER NOT NULL,
    "file_tree_truncated" BOOLEAN NOT NULL,

    CONSTRAINT "asset_metadata_pkey" PRIMARY KEY ("asset_version_id")
);

-- CreateTable
CREATE TABLE "asset"."ownership_history" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ownership_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ownership_history_asset_id_created_at_idx" ON "asset"."ownership_history"("asset_id", "created_at");

-- AddForeignKey
ALTER TABLE "asset"."asset_versions" ADD CONSTRAINT "asset_versions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"."assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset"."asset_metadata" ADD CONSTRAINT "asset_metadata_asset_version_id_fkey" FOREIGN KEY ("asset_version_id") REFERENCES "asset"."asset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset"."ownership_history" ADD CONSTRAINT "ownership_history_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"."assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
