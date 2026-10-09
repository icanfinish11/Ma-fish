-- ════════════════════════════════════════════════════════════════════════════
-- P3 / Task 8 —— `asset.access_grants`（交换对手方的访问权；§9:472 的中间那一档）
--
-- ## 它为什么是一张真表，而不是一档从合约推出来的判定
-- §9:472 的 `Asset` 制品 download 一行有三档：所有人 / **交换对手方（`RELEASED` 后）** /
-- 买家。第二档今天没有任何存储：判定它需要读 `exchange.swap_contracts`，
-- 而预检 §0.2 实测 `asset → exchange` 一旦成环，`pnpm arch` 就是 **6 条 error / exit 6**。
-- ⇒ 裁定（D11）：**判定住在 `asset`**（`checkAccess` 是唯一入口），
--   `exchange` 在 `RELEASED` 的那一刻把这一档**推**过来 —— 依赖方向保持单向。
--
-- ## 为什么归 `asset` schema（C5）
-- 它是**授权判定的存储**。放进 `exchange` 会让 `asset` 需要读别人的表（C5 禁止）；
-- 放进 `asset` 之后 `exchange` 只是一个**写入方**。同一处登记在
-- `tests/integration/db/schema-isolation.test.ts` 的精确数组里（第三次改那个数组）。
--
-- ## 为什么**不**撤权成 append-only（与 `ownership_history` 的差别，据实记载）
-- P3 里确实没有撤销路径（§6.3 的 `RELEASED` 之后没有退出，D8），但 **P3.5 的 D8 有**：
-- 机器可证的违约 ⇒ 自动回转所有权，那一次的清单里明写「撤销对手方访问权」，
-- 而它的判据就是这一行的 `source` 列（一次 `DELETE ... WHERE source = ...`）。
-- ⇒ 把这张表钉成 append-only 会让那条边**无路可走**，而 REVOKE 是数据库层的、应用改不回来。
--
-- ## 零漂移门**是**这条迁移的见证
-- 它整段由 `prisma migrate diff` 生成（下面这一段）。取证见
-- `.superpowers/sdd/2026-10-07-p3-exchange/evidence/t8-migration-gen.txt`。
-- ════════════════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "asset"."access_grants" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_grants_asset_id_user_id_key" ON "asset"."access_grants"("asset_id", "user_id");
