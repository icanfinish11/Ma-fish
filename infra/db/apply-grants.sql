-- ════════════════════════════════════════════════════════════════════════════
-- schema / 表级授权与 **append-only 撤权（C7 的核心）**。
--
-- ## 执行时机（硬性）
--
-- 本文件必须在 **`prisma migrate deploy` 之后**执行，由属主角色 `vca_owner` 运行。
-- 与角色层 `infra/db/roles.sql` 的分工见该文件顶部注释：那里只做「建角色 + 连接授权」，
-- 因为它在容器初始化时就跑，那时 `auth`/`audit`/`notify`/`asset` 四个 schema 与所有表都还不存在。
-- 这里才做建表之后的授权。
--
-- 另注：`roles.sql` 里**没有**任何 `public` schema 的默认权限。曾经有，但它会把
-- `prisma migrate deploy` 事后建出的迁移台账 `public._prisma_migrations` 一并授予运行期
-- 角色（实测 `has_table_privilege(app_user, ..., 'UPDATE'|'DELETE') = t`），故已删除；
-- 原因与实测见该文件末尾的长注释。各模块 schema 的默认权限只在本文件里施加。
--
-- ## 为什么必须重跑（不是保险动作）
--
-- `GRANT` 只作用于**执行那一刻已存在**的对象：Prisma 迁移新建的表**不会**继承此前
-- 发出的 `GRANT`。因此每次 `prisma migrate deploy` 之后都必须再执行本文件，
-- 否则新表对 `app_user` 完全不可见（表现为运行期 `permission denied for table ...`）。
-- Task 9 的 CI 同样要包含此步骤。
--
-- ## append-only 为什么能生效（依赖两角色）
--
-- `REVOKE UPDATE, DELETE ... FROM app_user` 之所以真的生效，是因为 `app_user` 与表属主
-- `vca_owner` 是**两个不同角色**。若二者是同一角色，PostgreSQL 的属主永远保有全部权限，
-- 这里的 `REVOKE` 就是空操作——已实测：撤权后属主仍能 `UPDATE` 且行值真的被改动。
-- 回归见 `tests/integration/db/append-only.test.ts`。
-- ════════════════════════════════════════════════════════════════════════════

-- 用 schema 的前提是有 USAGE；没有它，后续表级 GRANT 全部无意义。
-- P2 / Task 4：`ledger` 加进这一行——它是**前提**，不是可选的美化：没有 USAGE 时
-- 下面那条 `GRANT … ON ALL TABLES IN SCHEMA ledger` 语法就通不过（schema 必须存在），
-- 而即便它存在，运行期角色对 ledger 下的任何对象也会在解析阶段被挡。
-- P3 / Task 2：`exchange` 同款理由加进来（它由 p3 迁移创建，此刻已存在）。
GRANT USAGE ON SCHEMA auth, audit, notify, asset, ledger, exchange TO app_user;

-- ── auth：通用业务表，可读写（改密、注销需要 UPDATE/DELETE）──────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO app_user;

-- ── notify：outbox / 幂等记录，消费者要回写 processed_at，故可读写 ──
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA notify TO app_user;

-- ── asset：作品 / 版本 / 元数据 / 所有权历史（P1 Task 7，D11/D12）──
-- `assets` / `asset_versions` / `asset_metadata` 是普通业务表：接入期写版本与元数据，
-- 下载与预览路径读它们。`asset.ownership_history` 则是 **append-only**（C7），
-- 紧跟在下面按 audit 的同款写法**单独**撤权。
--
-- 这一行（而不是逐表列出）是刻意的：新表会不断出现，而「权限跟着新表走」的唯一可靠办法
-- 是 `ALL TABLES` + 每次迁移后重跑本文件（见文件头的「为什么必须重跑」）。
-- 代价是：**将来在 asset 里新增 append-only 表时，必须像 ownership_history 一样在下面
-- 再写一对 GRANT/REVOKE**——否则它会被这一行默默授予 UPDATE/DELETE。
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA asset TO app_user;

-- ── asset.ownership_history：**append-only**（C7 / 不变式 #5，D11）──
-- 所有权史的全部价值在于「写进去就删不掉、改不了」——一份可以被改写的所有权史，
-- 在争议里不构成任何证据。因此它与 `audit` 走同一条路：`app_user` 只有 SELECT + INSERT。
--
-- ## 为什么这两行是**逐表**写，而不是像 audit 那样发 schema 级
--
-- `asset` 这个 schema 里另外三张表（作品 / 版本 / 元数据）是**要可写的**（元数据会重算、
-- 版本记录要补 uploaded_by_id），所以上面那条 `ALL TABLES` 是必要的；它同时**顺带**
-- 把 UPDATE/DELETE 授给了本表——下面那对语句就是在这条广播之后把它单独收回来的。
--
-- ## 两行都在是刻意的（与 audit 同一条实测理由）
--
--   * `GRANT SELECT, INSERT` 是**实际执行点**——`GRANT` 是白名单，未授予即无权限；
--   * `REVOKE UPDATE, DELETE` 是**兜底**——权限是可叠加的，**后执行的 `REVOKE` 能覆盖
--     先前那条 `ALL TABLES` 的 `GRANT`**（audit 那段有实测：`has_table_privilege` 从 true
--     变回 false、relacl 从 `app_user=arw/...` 回到 `app_user=ar/...`）。
-- 只写 `REVOKE` 挡不住将来被重新授予，只写 `GRANT SELECT, INSERT` 则挡不住上面那条
-- 广播语句——因此两行缺一不可。**删掉 `REVOKE` 那一行会让判据 10 立刻变红**
-- （变异探针实测：`app_user` 的 `UPDATE` 从「被拒」变成「改写成功」）。
GRANT SELECT, INSERT ON asset.ownership_history TO app_user;
REVOKE UPDATE, DELETE ON asset.ownership_history FROM app_user;

-- ── audit：append-only，只给 SELECT + INSERT，撤销 UPDATE/DELETE（不变式 #5）──
-- 两行都在是刻意的，各有分工（已实测，勿删其中任何一行）：
--   * `GRANT SELECT, INSERT` 是不变式的**实际执行点**——`GRANT` 是白名单，未授予即无权限；
--   * `REVOKE UPDATE, DELETE` 是**兜底**——若将来有人把上一行误改成
--     `GRANT SELECT, INSERT, UPDATE, DELETE`（从 auth/notify 那两行复制粘贴是最可能的失误），
--     这条 `REVOKE` 会在同一脚本内把它拉回来。PostgreSQL 权限是可叠加的，**后执行的
--     `REVOKE` 能覆盖先前的 `GRANT`**：实测 `GRANT UPDATE` 后 `has_table_privilege` 为 true，
--     随后 `REVOKE` 变回 false，relacl 从 `app_user=arw/...` 回到 `app_user=ar/...`。
-- 反过来，只有 `REVOKE` 而**不写** `GRANT` 也无法防住将来被授予，故两行缺一不可。
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO app_user;
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA audit FROM app_user;

-- ── ledger：账本（P2 / Task 4，设计 §8.3 不变式 #5）──────────────────────
-- `accounts` 是**要可写**的（余额是物化值，过账就是改它），因此先发 schema 级广播；
-- `entries` 与 `transactions` 是 **append-only**，紧随其后逐表撤权；
-- `accounts` 本身另有一条更窄的撤权——**只撤 `DELETE`**（控制器裁定，见下面那一段）。
--
-- ⚠️ 这一对语句**不能省**：实测新建 schema 上只写 schema 级 `GRANT … ON ALL TABLES` 时
-- `has_table_privilege(app_user, …, 'UPDATE') = 'true'`，而且 app_user **真的**把一条分录
-- 从 100 改成了 999（append-only 不成立）。补上逐表 REVOKE 之后才拒绝、
-- relacl 回到 `app_user=ar/vca_owner`。
--
-- 见证（两层，缺一不可）：CI 的「运行期角色的权限事实」那一步查
-- `has_table_privilege` 的 14 项；`tests/integration/db/ledger-enforcement.test.ts` 另查
-- `aclexplode(relacl)` 的**逐表能力集合**，并**真的**以 app_user 发一次 UPDATE/DELETE
-- 看它被拒、且那两行数据没被动过（「拒绝」本身不是判据）。
--
-- ⚠️ `GRANT … ON ALL TABLES` **不覆盖 SEQUENCE**：本 schema 里**没有**任何 SEQUENCE
-- （三张表全是 UUIDv7 主键，C4），因此这里**刻意不写** `GRANT USAGE ON SEQUENCES`。
-- 那句话不是推测，而是被一条用例行使过的实测：
-- `tests/integration/db/ledger-enforcement.test.ts` 里「序列那条坑的两个方向」会临时建一张
-- bigserial 表，断言 app_user 的 INSERT 先以 `permission denied for sequence` 被拒、
-- 补上序列授权后被接受，然后把它删掉。将来谁在这里加自增主键，那条用例会指出必须补授权
-- （而不是等到生产上第一次写入）。
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ledger TO app_user;

-- ledger.accounts：撤掉 `DELETE`，保留 `SELECT` / `INSERT` / `UPDATE`（**控制器裁定 2026-10-06**）
--
-- Task 4 交付时这里是四个动词（schema 级广播顺带把 DELETE 也授了出去），该任务在报告的
-- self-review §6.1 里记下这件事并请控制器裁定。裁定：**撤掉 DELETE**。三条理由：
--
--   ① **P2 没有任何删账户的代码路径**（没有原语、没有路由、没有 worker 任务），因此这个
--      能力**没有合法使用者**。一张钱表上一个没人用的能力，是本项目那类反复复发的缺陷的
--      **反形**：不是「声明了但未强制」，而是**授予了但从未声明**。
--   ② 两层兜底（`entries_account_id_fkey ON DELETE RESTRICT` 与不变式 #2 的对账）护的是
--      **完整性**，不是**可用性**——**一行被删掉的账户无法被对账恢复**：Σ 余额照样是 0
--      （钱随账户一起消失），没有任何一条不变式会红。
--   ③ 双角色模型的全部意义是最小权限，而账本账户上的 `DELETE` 不是最小权限。
--
-- `SELECT` / `INSERT` / `UPDATE` 一个都不能少：过账要读余额、惰性建账户要 INSERT（D2）、
-- 物化余额就是靠 UPDATE 改的（C27）。**只有 `DELETE` 没有使用者。**
--
-- 见证（两层，缺一不可）：`tests/integration/db/ledger-enforcement.test.ts` 里
-- 「运行期角色对 `ledger.accounts` 的 `DELETE` 也被真实拒绝」**真的**以 app_user 发一次
-- DELETE（打在一个**没有分录**的账户上——有分录的账户会被外键挡下，那条拒绝与 ACL 无关），
-- 断言它被拒且那一行还在；同文件的 ACL 用例另查 `has_table_privilege` 与 `aclexplode`。
-- CI 的「运行期角色的权限事实」那一步也查这一格（第 10 项，期望 `f`）。
-- **删掉下面这一行会让那三处一起变红**（变异探针实测：DELETE 从「被拒」变成 `rowCount: 1`，
-- 账户行真的没了）。
REVOKE DELETE ON ledger.accounts FROM app_user;

-- ledger.entries：**append-only**（不变式 #5）——分录是账本的事实，写进去就不能改、
-- 不能删。一行改过的分录会让「这笔钱去哪了」这个问题永久失去答案。
--
-- ⚠️ `SELECT` 在这里**不是**「读接口的权限」，它是**写入路径的一部分**：延迟约束触发器
-- `ledger.assert_tx_balanced()` 不是 `SECURITY DEFINER`，于是 COMMIT 时刻那句
-- `SELECT sum(amount) … FROM ledger.entries` 以**调用者**（app_user）的身份执行。
-- 实测：撤掉 SELECT 之后，app_user 的 INSERT 照样成功，而 COMMIT 以
-- `permission denied for table entries` 失败，`CONTEXT` 指向触发器内部那句 SQL——
-- 错误信息会把运维引向「触发器有 bug」这条错路。
--
-- 要保住的是**有效 ACL 里的 SELECT**，不是某一行语句。真库上量过三种形状
-- （`has_table_privilege`）：只把本行收窄成 `GRANT INSERT` ⇒ 仍是 `t`（上面那条 schema 级
-- 广播还在给）；把本行与那条广播**都**收窄 ⇒ 变 `f`。因此本行的 `SELECT` 今天与广播重复，
-- 但那不是可以随手删的理由——**改任何一处之前先看有效 ACL**。
-- 常驻见证：`tests/integration/db/ledger-enforcement.test.ts` 的
-- 「运行期角色的 SELECT 对**写入**也是承重的」（撤掉 ⇒ COMMIT 被拒；恢复 ⇒ 同形状过账被接受）。
GRANT SELECT, INSERT ON ledger.entries TO app_user;
REVOKE UPDATE, DELETE ON ledger.entries FROM app_user;

-- ledger.transactions：同样是 **append-only**。幂等键的唯一约束是「不许重复过账」的执行点，
-- 而允许改写/删除交易行会把那条约束变成一句可撤销的话（改掉 idempotency_key 即可重放）。
GRANT SELECT, INSERT ON ledger.transactions TO app_user;
REVOKE UPDATE, DELETE ON ledger.transactions FROM app_user;

-- ── exchange：交换（P3 / Task 2；设计 §6 / §9）────────────────────────────
-- 三张表都是**状态机表**：状态会变（`UPDATE` 必须有），但**没有任何删合约 / 删要约 /
-- 删义务的代码路径**（没有路由、没有原语、没有 worker 任务——§6.3 的两张状态机里
-- 没有任何一条箭头通向「删除」）。
--
-- ## 为什么逐表撤掉 `DELETE`（与 P2 撤 `ledger.accounts` 的 `DELETE` 同一处置）
--   ① **没有被声明的使用者**：这个能力没有任何合法调用方；
--   ② **删掉的合约无法被恢复**：义务行会随合约一起消失（`swap_obligations_contract_id_fkey`
--      的 `ON DELETE RESTRICT` 会先挡住它，但那是完整性的兜底、不是可用性的保证），
--      而不变式 #4 的右式会因此**凭空变小**——一次「删除合约」看起来像一次「义务被结清」；
--   ③ 双角色模型的全部意义是最小权限，而这三张表上的 `DELETE` 不是最小权限。
--
-- ## ⚠️ 这一对语句**不能省**（P2 实测过的形态，本任务在 exchange 上重测）
-- `GRANT … ON ALL TABLES` 会把 `DELETE` 一并授出去（P2 实测：schema 级广播之后
-- `has_table_privilege(app_user, …, 'DELETE') = 'true'`，而 app_user **真的**删掉了那行）。
-- 补上逐表 REVOKE 之后才拒绝、relacl 回到 `app_user=arw/vca_owner`。
-- 见证（两层，缺一不可）：CI 的「运行期角色的权限事实」那一步查 19 项 `has_table_privilege`
-- 与 exchange 的 relacl；`tests/integration/db/exchange-enforcement.test.ts` 再以
-- **app_user 自己**发一次 DELETE，断言它被拒**且那一行还在**（「拒绝」本身不是判据）。
-- **删掉下面任何一条 REVOKE 会让那两处一起变红**（探针 S-1 实测：拒绝面变成删除成功、
-- ACL 变成 `DELETE,INSERT,SELECT,UPDATE`）。
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA exchange TO app_user;

GRANT SELECT, INSERT, UPDATE ON exchange.swap_offers TO app_user;
REVOKE DELETE ON exchange.swap_offers FROM app_user;

GRANT SELECT, INSERT, UPDATE ON exchange.swap_contracts TO app_user;
REVOKE DELETE ON exchange.swap_contracts FROM app_user;

GRANT SELECT, INSERT, UPDATE ON exchange.swap_obligations TO app_user;
REVOKE DELETE ON exchange.swap_obligations FROM app_user;

-- ── 未来新建的表沿用同样默认权限 ──────────────────────────────────
-- 放在本文件而非 roles.sql：`ALTER DEFAULT PRIVILEGES ... IN SCHEMA <名>` 要求该 schema
-- 此刻已存在（只有属主或超级用户能执行，且 schema 必须存在），而这些 schema 由 Prisma
-- 迁移创建，容器初始化时还不存在。默认权限只影响**此后**新建的表，因此「迁移后施加」
-- 在语义上没有损失；再加上每次迁移后都会重跑本文件，覆盖面与写在 roles.sql 完全等价。
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA notify
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO app_user;
-- asset 的默认权限是**可读写**（作品/版本/元数据会持续演进），append-only 的表靠
-- 逐表撤权（默认权限是按 schema 发的，做不到「只给这张表少一档」）。
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA asset
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
-- ledger 同 asset 的形状：`accounts` 要可写（物化余额），`entries` / `transactions`
-- 靠上面那两对逐表 GRANT/REVOKE 例外出来，`accounts` 的 `DELETE` 靠它自己那条 REVOKE
-- 例外出来。**默认权限只影响此后新建的表**，而每次 `migrate deploy` 之后本文件都会重跑，
-- 因此「新表拿到什么权限」只有这一份定义。
-- ⚠️ 因此**将来在 ledger 里新建的、不该被删的表**（例如任何 append-only 或只增不改的表）
-- 必须像 `accounts` / `entries` / `transactions` 一样在下面补一条逐表 `REVOKE`——
-- 这一行 `ALTER DEFAULT PRIVILEGES` 会把 `DELETE` 一并授予它。
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA ledger
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
-- exchange 同 asset / ledger 的形状：三张状态机表**要可写**（状态会转），而
-- `DELETE` 靠上面那三对逐表 `REVOKE` 例外出来。
-- ⚠️ 因此**将来在 exchange 里新建的、不该被删的表**（例如任何 append-only 或只增不改的表）
-- 必须像上面三张一样补一条逐表 `REVOKE`——这一行会把 `DELETE` 一并授予它。
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA exchange
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
