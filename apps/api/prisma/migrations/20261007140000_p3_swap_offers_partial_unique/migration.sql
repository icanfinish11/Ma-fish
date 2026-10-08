-- ════════════════════════════════════════════════════════════════════════════
-- P3 / Task 6 —— 控制器裁定 ①：`swap_offers` 的唯一索引改成**部分**唯一索引
--
-- ## 它修的是什么（裁定逐字）
-- Task 5.5 留下的索引是**全线唯一**的 `(target_asset_id, counterparty_id)`，
-- 而 `REJECTED` 是一个**终态**：一对人只要被拒过一次，就**永远**不能再对同一件作品
-- 发第二次要约。裁定：**允许重新要约**。理由逐字 ——
-- **「`REJECTED` 是终态」约束的是*那一份要约*，而不是*那一对人*。**
-- 索引因此只覆盖**非终态**（`DRAFT` / `SENT`）。这不需要任何新的产品概念，
-- 也不动状态机：骚扰的上界由既有的限流档（C33 的 `bid` 档）与
-- **目标方自己拒绝的能力**承担。
--
-- ## ★★ 为什么这一段是**手写**的，以及它的见证是谁（实测，不是推断）
--
-- Prisma **表达不了**部分索引（`@@unique` 没有 `where` 参数），因此谓词只能手写。
-- 而手写这一半的见证**不是**零漂移门 —— 三个方向都实测过（本机 compose 上的
-- 一次性库 `vca_t6_drift`，命令与输出逐字进 evidence）：
--
--   ① 保持 `schema.prisma` 的 `@@unique`、把库里的索引换成**同名**的部分索引
--      ⇒ `migrate diff --exit-code` = **`No difference detected.`（exit 0）**。
--      **漂移门对谓词结构性失明**：它按（名字，列集合，唯一性）匹配索引，
--      `WHERE` 子句根本不参与比对。
--   ② 把 `@@unique` 从模型里删掉、库里留着那条部分索引
--      ⇒ **同样 `No difference detected.`（exit 0）**：漂移门连「库里多一条索引」都看不见。
--      ⇒ 于是「删掉 `@@unique`」会让这道门在这个索引上**彻底空转**，而
--      「保留 `@@unique`」至少留下「这条索引存在（按名字与列）」那一半 —— 实测：
--   ③ 保留 `@@unique` 而把索引整个删掉
--      ⇒ `[+] Added unique index on columns (target_asset_id, counterparty_id)`、**exit 2**。
--   ④ 部分索引换一个**别的名字** ⇒ 漂移门报 `Renamed index …`（exit 2）：
--      它按列集合匹配，因此**索引名必须保持 Prisma 的默认名**，否则会多出一条假漂移。
--
-- ⇒ 本轮的选择是 **③ + ① 的组合**：模型保留 `@@unique`（漂移门继续保证
-- 「这条索引存在」），谓词手写在这里，而谓词的**唯一机器见证**是
-- `tests/integration/db/exchange-enforcement.test.ts` 的真库目录断言
-- （`pg_indexes.indexdef` 里必须有 `WHERE`）+ 两条**行为**见证
-- （`REJECTED` 之后重新要约**成功** / 同一对的第二份**活跃**要约被 23505 拒）。
-- **不得**把它们宣传成「漂移门见证的」——它见证不了。
-- ════════════════════════════════════════════════════════════════════════════

-- 旧的全线唯一索引：删掉它。名字保持不变是**承重**的（见上面 ④）：
-- 漂移门按列集合匹配索引，改名会让它报一条 `Renamed index` 的假漂移。
DROP INDEX "exchange"."swap_offers_target_asset_id_counterparty_id_key";

-- 部分唯一索引：只覆盖**非终态**。终态（`ACCEPTED` / `REJECTED` / `WITHDRAWN` / `EXPIRED`）
-- 的历史行因此不再挡着下一次要约。
--
-- 闭集取值与 `swap_offers_status_check`（本目录上一支迁移）逐字一致：这里少写一个
-- 非终态会让那一档**静默地不再唯一**，而那正是「声明了但未强制」——
-- 因此 `exchange-enforcement.test.ts` 的目录断言把整段 `indexdef` 钉住
-- （含 `= ANY (ARRAY['DRAFT'::text, 'SENT'::text])`），而不只是「有个 WHERE」。
CREATE UNIQUE INDEX "swap_offers_target_asset_id_counterparty_id_key"
  ON "exchange"."swap_offers"("target_asset_id", "counterparty_id")
  WHERE status IN ('DRAFT', 'SENT');
