-- ════════════════════════════════════════════════════════════════════════════
-- P2 最终修复轮（全分支审查 I1）：把 `accounts_nonneg_by_kind` 的允许名单从
-- 「两个用户 kind」收紧到「**恰好一个**注入端 kind」。
--
-- ## 它挡的缺陷形态
-- 原条件是 `kind NOT IN ('USER_AVAILABLE','USER_FROZEN') OR balance >= 0`，而
-- `PLATFORM_ESCROW` 是**系统** kind ⇒ 托管账户的借方在库层**没有**任何守卫。
-- 应用侧 `applyBalances` 的守卫当时用的是同一个名单（`isUserAccountKind`），于是两个落点
-- 一起漏：一次「释放得比锁进来的更多」的调用会把托管扣成负的、把差额付给卖家——平台付出了
-- 它从未持有的钱，而 Σ=0 成立、五条不变式全绿、对账全绿、审计也如实。
--
-- §8.3 的不变式 #4 原文是「`Σ PLATFORM_ESCROW ≥ Σ 所有未结算托管义务`（**托管不透支**）」。
-- 独立义务来源（`EscrowRecord`）属 P3（D3/C29），但「托管余额不得为负」这一半在 P2 里
-- **是可强制的**——这条 CHECK 就是它在库层的执行者，应用侧的那一半在
-- `LedgerService.applyBalances`（`mayGoNegative()`），两处逐字同一条规则。
--
-- ## 为什么名单写成「恰好一个 kind」而不是「加上 PLATFORM_ESCROW」
-- 「系统账户天然为负」这句话**只对注入端成立**：`EXTERNAL_TOPUP` 代表系统之外，充值是从
-- 这个方向把钱造进账本，它必然越扣越负；而托管与收入账户只收不放（P2 里没有任何一条转移
-- 从它们借出超过其余额的部分）。写成允许名单的一个 kind，把这条规则变成**排他**的：
-- 将来若有第六个 kind，它默认**带守卫**——默认安全的那一侧。
--
-- ## 为什么是**新迁移**而不是改 `20261006120000_p2_ledger/migration.sql`
-- `_prisma_migrations` 存了每个已应用迁移的校验和，改一个**已应用**的迁移文件会让
-- `migrate deploy` 在既有库上直接失败（"migration ... was modified after it was applied"）。
-- 本文件因此必须在**全新库**（testcontainer 每次从零跑四条迁移）与**既有库**
-- （本机 compose 的卷，已应用 P0/P1/P2 四条）上都干净落地。
--
-- ## 它**不会**被零漂移门看见（Task 1 的决定性实测）
-- `prisma migrate diff … --exit-code` 对 `CHECK` / plpgsql 函数 / `DEFERRABLE` 约束触发器
-- **结构性失明**（`docs/superpowers/notes/2026-10-06-p2-migration-drift.md` §3）。
-- 因此这条约束的**存在性与条件原文**由 `tests/integration/db/ledger-enforcement.test.ts`
-- 的目录断言（`pg_get_constraintdef`）负责，行为由同一文件那两条真库用例负责。
--
-- ## 为什么 `DROP` + `ADD` 而不是别的写法
-- PostgreSQL 没有 `ALTER CONSTRAINT … CHECK`：改一个 CHECK 的条件只能重建它。
-- 重建会以新条件**校验既有行**——这正是想要的（它同时是一次对既有数据的审计）。
-- 若某台库上真的存在负的托管余额（只能由修复前的代码造出来），这条迁移会在那里**失败**，
-- 而那正是需要有人看见的事，不是需要绕过的事。
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE ledger.accounts DROP CONSTRAINT accounts_nonneg_by_kind;

ALTER TABLE ledger.accounts
  ADD CONSTRAINT accounts_nonneg_by_kind
  CHECK (kind = 'EXTERNAL_TOPUP' OR balance >= 0);
