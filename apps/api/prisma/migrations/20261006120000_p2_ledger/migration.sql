-- ════════════════════════════════════════════════════════════════════════════
-- P2 / Task 4：新增 `ledger` schema —— 账户 / 交易 / 分录（设计 §8；D1/D2/D3）。
--
-- ## 本文件有两段，**见证方式完全不同**（Task 1 的决定性实测）
--
-- 上半段是**生成的**（`prisma migrate diff --from-config-datasource --to-schema
-- prisma/schema.prisma --script`，对着已应用 P0/P1 三个迁移的库取的差值），不要手改。
-- 下半段是**手写的**：Prisma 的模型语言表达不了函数、约束触发器与 CHECK。
--
-- ## 那条零漂移门到底证明了什么（**不要**读多）
--
-- CI 的「迁移零漂移」那一步（`prisma migrate diff … --exit-code`）证明的**只有**
-- 「**Prisma 建模面**（表 / 列 / 索引 / 外键 / 唯一约束）与库一致」。
--
-- 它**不是**手写 DDL 的见证。**实测**（`docs/superpowers/notes/2026-10-06-p2-migration-drift.md`
-- §3 有原始输出与退出码）：库里挂着手写的 plpgsql 函数 +
-- `DEFERRABLE INITIALLY DEFERRED` 约束触发器 + `CHECK` 时，它照样打印
-- `No difference detected.` 并以 **0** 退出。所以**手写对象消失时这条门不会红**。
--
-- 反方向的判别力也要记一句（否则下一个人会以为这条门什么都没测）：在**受管 schema**
-- 内 `DROP TABLE` ⇒ 门**变红**（实测输出 `[+] Added tables`，退出码非零）。
-- 两个方向合起来才是这条门的准确形状：它守的是「建模面别掉」，不是「手写面还在」。
--
-- ⇒ 因此下半段那些对象的**存在性**由
-- `tests/integration/db/ledger-enforcement.test.ts` 的真库断言负责：
--   * `pg_proc`（函数 `ledger.assert_tx_balanced`，plpgsql / returns trigger）；
--   * `pg_trigger`（`entries_tx_balanced`：`tgconstraint` 非 0、`tgdeferrable`、
--     `tginitdeferred`、以及 `tgtype` 的 INSERT/UPDATE/DELETE 三位）；
--   * `pg_get_constraintdef`（两条 CHECK 的条件原文）；
-- 外加行为用例（不平衡过账必须在 COMMIT 被拒；`app_user` 的 UPDATE/DELETE 必须被拒）。
--
-- ## 迁移必须**在全新库与既有库上都干净落地**（P1 的教训）
--
-- P0 期间踩过一次：迁移被再生成之后与本地那个**已经应用过**它的卷冲突。本文件的验证
-- 因此两处各做一次：全新库（testcontainer 每次从零跑）与既有库（本机 compose 的卷，
-- 已应用 P0/P1 的三个迁移）各 `migrate deploy` 一次，并各自跑一次零漂移门。
-- ════════════════════════════════════════════════════════════════════════════

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ledger";

-- CreateTable
CREATE TABLE "ledger"."accounts" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "owner_user_id" UUID,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger"."transactions" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger"."entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_owner_user_id_kind_key" ON "ledger"."accounts"("owner_user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "ledger"."transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "entries_transaction_id_idx" ON "ledger"."entries"("transaction_id");

-- AddForeignKey
ALTER TABLE "ledger"."entries" ADD CONSTRAINT "entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger"."transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger"."entries" ADD CONSTRAINT "entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 以下为**手写**部分（Prisma 的模型语言表达不了）。生成部分在上面，不要手改它。
-- 四类对象各自对应一条**已实测**的强制点，缺任何一条那条不变式就回到纸面上：
--   ① 延迟约束触发器 —— 不变式 #1（每笔交易借贷平衡）
--   ② 条件化 CHECK    —— 不变式 #3（用户账户不可透支）
--   ③ 行级非零 CHECK  —— 「0 金额的腿」这一条（触发器看得见行，但 0 是合法的和）
--   ④ 系统账户种子    —— D2：系统账户只在这里诞生，恰好一次
-- ════════════════════════════════════════════════════════════════════════════

-- ── ① 不变式 #1 的唯一强制点：延迟约束触发器 ──────────────────────────────
-- 为什么不是行级 CHECK：实测 `ADD CONSTRAINT … CHECK (sum(amount) = 0)` 被 PostgreSQL
-- 拒绝——`ERROR: aggregate functions are not allowed in check constraints`。
-- 借贷平衡是**跨行**谓词，行级 CHECK 只能看这一行。延迟约束触发器因此不是可选项。
--
-- 为什么 SQLSTATE 显式写成 23514（check_violation）：这是**实测值**，而它重要是因为
-- 经 Prisma 7.10.0 时该错误退化成 `DriverAdapterError` 且 `code === undefined`，
-- 只有 `cause.code` / `cause.originalCode` 带着 '23514'。写成默认的 P0001 会让
-- 「拿 cause.code 判别」这条路也断掉。
--
-- 它能强制的精确表述：**同一个 transaction_id 上，所有已提交分录的 amount 之和为 0**。
-- 它**不能**强制「这笔过账真的发生了」（空事务合法）、也不能强制「一条 0 金额的腿没有意义」
-- （预检 §B.2 场景 3 实测：单腿 amount=0 被接受）——后两条由 ③ 与应用层断言负责。
CREATE FUNCTION ledger.assert_tx_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
  legs  integer;
  tx_id uuid;
BEGIN
  -- UPDATE/DELETE 时 NEW 为空、OLD 有值（运行期角色做不到这两件事——ACL 挡着，
  -- 但属主可以，而纵深防御不该有一个「到了属主手上就崩」的分支）。
  tx_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT COALESCE(sum(amount), 0), count(*) INTO total, legs
    FROM ledger.entries WHERE transaction_id = tx_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'tx % 借贷不平衡: sum(amount)=% 分录数=%', tx_id, total, legs
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER entries_tx_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger.entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_tx_balanced();

-- ── ② 不变式 #3：**条件化**的非负 CHECK ──────────────────────────────────
-- 条件化是必需的，不是保守：`EXTERNAL_TOPUP`（充值对手方）与 `PLATFORM_*` 天然为负
-- （§8.2 第一行 `DR EXTERNAL_TOPUP CR USER_AVAILABLE`），而不变式 #3 也只约束用户账户。
-- 一个无条件的 `CHECK (balance >= 0)` 会把整条充值路径钉死——实测：条件化之后
-- 「系统账户扣到负 → 接受、用户账户扣成负 → 拒绝（P2039 / 23514 /
-- accounts_nonneg_by_kind）」。
ALTER TABLE ledger.accounts
  ADD CONSTRAINT accounts_nonneg_by_kind
  CHECK (kind NOT IN ('USER_AVAILABLE', 'USER_FROZEN') OR balance >= 0);

-- ── ③ 一笔交易在某个账户上的净额不得为 0 ──────────────────────────────────
-- 这一条**可以**是行级 CHECK（它是单行谓词），因此不留给应用层：一条 0 金额的腿
-- 在账本里没有任何信息量，却会让「这笔过账真的发生了吗」这个问题无法回答。
-- 注意它与 ① 的分工：① 管「每笔交易的和为零」，③ 管「每一行都不为零」——两者都不是
-- 对方的子集（单腿 amount=0 满足 ① 而被 ③ 拒绝；单腿 amount=1 被 ① 拒绝而满足 ③）。
ALTER TABLE ledger.entries
  ADD CONSTRAINT entries_amount_nonzero CHECK (amount <> 0);

-- ── ④ 系统账户的种子（D2：**只有这里**创建它们，恰好一次）────────────────
-- 为什么是常量 UUID 而不是 `gen_random_uuid()`：迁移必须在**任何环境**上产出同一组行，
-- 否则每个环境/每次重建的账本身份都不同，而测试与对账都要按 kind 找到「那一个」账户。
-- 三个值都是 UUIDv7 形状（版本位 7、变体位 8），与 C4 的主键约定一致；业务代码**只按
-- (kind, owner_user_id IS NULL) 查**，绝不硬编码这三个常量。
--
-- 为什么不靠唯一索引兜住「恰好一次」：`(owner_user_id, kind)` 上的唯一索引把 NULL
-- 视为互不相同，所以它**挡不住**第二行 (NULL, 'PLATFORM_ESCROW')。这条不变式的执行者
-- 因此分成两半：种子只出现一次（本文件，迁移只应用一次）+ 条数断言
-- （`tests/integration/db/ledger-enforcement.test.ts` 的「系统账户恰好三个」）。
-- 刻意**不**依赖 `NULLS NOT DISTINCT`：它会把这条约束挂在一个 PG15+ 特性上，而它今天
-- 挡不住的那个情形（应用侧惰性创建系统账户）本来就被 D2 禁止。
INSERT INTO ledger.accounts (id, kind, owner_user_id, balance) VALUES
  ('01920000-0000-7000-8000-000000000001', 'PLATFORM_ESCROW',  NULL, 0),
  ('01920000-0000-7000-8000-000000000002', 'PLATFORM_REVENUE', NULL, 0),
  ('01920000-0000-7000-8000-000000000003', 'EXTERNAL_TOPUP',   NULL, 0);
