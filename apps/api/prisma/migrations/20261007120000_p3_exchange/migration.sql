-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "exchange";

-- AlterTable
ALTER TABLE "asset"."assets" ADD COLUMN     "locked_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "exchange"."swap_offers" (
    "id" UUID NOT NULL,
    "proposer_id" UUID NOT NULL,
    "offered_asset_id" UUID NOT NULL,
    "target_asset_id" UUID NOT NULL,
    "counterparty_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "reason" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swap_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange"."swap_contracts" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "party_a_id" UUID NOT NULL,
    "party_b_id" UUID NOT NULL,
    "asset_a_id" UUID NOT NULL,
    "asset_b_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_BOTH_LOCK',
    "top_up_amount" BIGINT NOT NULL DEFAULT 0,
    "top_up_payer_id" UUID,
    "lock_deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "locked_by_a_at" TIMESTAMPTZ(3),
    "locked_by_b_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "dispute_deadline_at" TIMESTAMPTZ(3),
    "settled_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "disputed_at" TIMESTAMPTZ(3),
    "disputed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swap_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange"."swap_obligations" (
    "id" UUID NOT NULL,
    "producer" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "contract_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'LOCKED',
    "locked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "swap_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "swap_offers_target_asset_id_counterparty_id_key" ON "exchange"."swap_offers"("target_asset_id", "counterparty_id");

-- CreateIndex
CREATE UNIQUE INDEX "swap_contracts_offer_id_key" ON "exchange"."swap_contracts"("offer_id");

-- CreateIndex
CREATE INDEX "swap_contracts_status_lock_deadline_at_idx" ON "exchange"."swap_contracts"("status", "lock_deadline_at");

-- CreateIndex
CREATE INDEX "swap_contracts_status_dispute_deadline_at_idx" ON "exchange"."swap_contracts"("status", "dispute_deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "swap_obligations_contract_id_key" ON "exchange"."swap_obligations"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "swap_obligations_producer_key_key" ON "exchange"."swap_obligations"("producer", "key");

-- CreateIndex
CREATE INDEX "entries_account_id_idx" ON "ledger"."entries"("account_id");

-- AddForeignKey
ALTER TABLE "exchange"."swap_contracts" ADD CONSTRAINT "swap_contracts_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "exchange"."swap_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange"."swap_obligations" ADD CONSTRAINT "swap_obligations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "exchange"."swap_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 以下为**手写**部分（P3 / Task 2）。生成段到此为止，一个字都没有手改。
--
-- ## ★ 计划里那句话是错的，据实测改正（不要照抄 P2 的边界，也不要照抄计划的乐观版）
--
-- 计划 Step 2 的注释写着「本迁移的**全部**表 / 列 / 索引 / 唯一约束都是 Prisma 建得出来的
-- （没有 plpgsql 函数、没有约束触发器、没有条件化 CHECK），因此本迁移整体是那条零漂移门的
-- 见证对象」。**前半句对，后半句错**：下面六条 `CHECK` 里恰好有一条是**条件化**的
-- （`swap_contracts_top_up_payer_bound`），而 `prisma migrate diff` 对它**结构性失明**
-- （P2 Task 1 的决定性实测；Task 2 的探针 S-2 在本迁移上重测：删掉
-- `swap_contracts_top_up_payer_bound` 之后 `migrate diff --exit-code` **照样以 0 退出**，
-- 而 enforcement 用例真的红了）。
--
-- ⇒ 与 P2 同构的分工在这里同样成立：
--   * **Prisma 建模的那半**（三张表 / 列 / 索引 / 外键 / 唯一约束）由零漂移门见证；
--   * **下面这六条 CHECK** 只有真库能见证 ——
--     `tests/integration/db/exchange-enforcement.test.ts` 的 `pg_get_constraintdef` 目录断言。
-- ════════════════════════════════════════════════════════════════════════════

-- ── ① 两张状态机的取值闭集（§6.3）────────────────────────────────────────
-- 为什么是 CHECK 而不是 PostgreSQL 枚举类型：加一个取值时 `ALTER TYPE ... ADD VALUE`
-- 在事务里有限制（PG12 之前完全不能在事务块里跑，之后也不能在同一个事务里用新值），
-- 而 `ALTER TABLE … DROP/ADD CONSTRAINT` 是一个普通的 DDL 变更。
--
-- **闭集本身是承重的**：一个拼错的 `status` 写进去之后，任何按状态过滤的查询都会
-- **静默地少看一行**——Task 10 的计时器按 `(status, *_deadline_at)` 取到期集合，
-- 于是一份永远不被自动结算的合约看起来和「还没到期」一模一样。
-- P2 已经为「`kind` 没有运行期执行者」付过一次代价（实测 `kind='NOT_A_KIND'` 落库成功），
-- 那是同一个家族的第十个缺陷；这里是它在 P3 的对应物。
--
-- **注意边界**：CHECK 保证「取值在闭集内」，**不**保证「迁移是合法的」——
-- `PENDING_BOTH_LOCK → SETTLED` 这种跳跃在库里是合法的，它由
-- `core/state-machine.ts` 的迁移表挡（Task 3）。
ALTER TABLE exchange.swap_offers
  ADD CONSTRAINT swap_offers_status_check
  CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','WITHDRAWN','EXPIRED'));

ALTER TABLE exchange.swap_contracts
  ADD CONSTRAINT swap_contracts_status_check
  CHECK (status IN ('PENDING_BOTH_LOCK','VALIDATING','RELEASED','DISPUTED','SETTLED','CANCELLED'));

ALTER TABLE exchange.swap_obligations
  ADD CONSTRAINT swap_obligations_state_check
  CHECK (state IN ('LOCKED','SETTLED'));

-- ── ② 金额的取值域（C3 / C22 / D2）───────────────────────────────────────
-- 补差恒 `>= 0`（方向由 `top_up_payer_id` 表达，不由符号表达）；义务金额同。
-- 这两条与 C22 的分工：C22 管**表示**（HTTP 边界上是十进制字符串、拒绝 JSON number），
-- 这里管**取值域**——库里不可能出现一笔负的补差造成「A 补 B 而 B 也补 A」的歧义。
ALTER TABLE exchange.swap_contracts
  ADD CONSTRAINT swap_contracts_top_up_nonneg CHECK (top_up_amount >= 0);

ALTER TABLE exchange.swap_obligations
  ADD CONSTRAINT swap_obligations_amount_nonneg CHECK (amount >= 0);

-- ── ③「有补差」与「有付款人」必须同时成立（条件化 CHECK）──────────────────
-- 两条方向都要挡：
--   * 一个有付款人却没有钱的合约（`payer_id != null, amount = 0`）是一份**空的义务**；
--   * 一笔没有付款人的补差（`amount > 0, payer_id = null`）那笔钱**无人可扣**，
--     而不变式 #4 的右式会把它算成一份义务，于是 `Σ PLATFORM_ESCROW ≥ Σ 未结算义务`
--     会**永远差这一笔**（预检 §0.3 的证伪就是这一类）。
--
-- ## ★ 第二支为什么是 `<> 0` 而不是计划原文的 `> 0`（一次有实测理由的偏离）
--
-- 计划 Step 2 把它写成 `(top_up_amount > 0 AND top_up_payer_id IS NOT NULL)`。
-- 那样写的**强制行集合与 `<> 0` 逐行相同**（因为上面那条 `top_up_nonneg` 已经把负数排除了），
-- 但代价是：任何负数都会**同时**违反两条 CHECK，于是 `swap_contracts_top_up_nonneg`
-- **没有任何一条用例能单独行使它**——把非负那条删掉，行为用例一条都不红。
-- 那正是本项目反复抓的「一条不可能失败的断言」。
--
-- 探针实测（两个方向都在）：
--   * **S-2b**：删掉 `swap_contracts_top_up_nonneg` ⇒ 「负数 + 有付款人」那一格**变红**
--     （`<> 0` 之下，条件化 CHECK 对它是放行的 ⇒ 只可能被非负那条拦下）；
--   * **S-2c**（反向对照，证明 S-2b 的前提不是恒真的）：同时把条件化那条改成计划的 `> 0`
--     并删掉非负那条 ⇒ **同一格不再变红**（负数被条件化那条顺手拦住了）。
-- ⇒ `<> 0` 是「两条约束各自都有独立见证」的那个写法，而它强制的集合一个字都没变。
ALTER TABLE exchange.swap_contracts
  ADD CONSTRAINT swap_contracts_top_up_payer_bound
  CHECK ((top_up_amount = 0 AND top_up_payer_id IS NULL) OR (top_up_amount <> 0 AND top_up_payer_id IS NOT NULL));
