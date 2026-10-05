-- ════════════════════════════════════════════════════════════════════════════
-- 角色与连接层（C7 的第一半）。**与 `apply-grants.sql` 的分工是硬性的。**
--
-- ## 为什么必须是两个角色
--
-- 设计文档要求在数据库层撤销 append-only 表的 `UPDATE`/`DELETE`。**单角色做不到这件事，
-- 已实测**：PostgreSQL 中表的属主（owner）永远保有全部权限，属主自己发出的
-- `REVOKE ... FROM PUBLIC` 对属主是空操作——撤权后属主照样 `UPDATE` 成功且行值真的被改掉。
-- 唯一让不变式落地的办法就是拆成两个不同角色：
--
--   * `vca_owner` —— 只用于迁移/DDL，拥有 schema 与表；
--   * `app_user`  —— 应用运行期角色，在 append-only 表上只拿到 `SELECT` + `INSERT`。
--
-- 拆分后实测：`UPDATE` → `ERROR: permission denied for table audit_logs`，
-- 而 `INSERT` 照常成功。回归由 `tests/integration/db/append-only.test.ts` 常驻守住。
--
-- ## 这个文件为什么不能碰 schema / 表
--
-- 本文件在**两个**时机被执行：
--
--   1. `docker-compose.yml` 的 `docker-entrypoint-initdb.d`（容器首次初始化，`vca_owner` 身份）；
--   2. 集成测试里 testcontainer 起来之后（`tests/helpers/db.ts`，`vca_owner` 身份）。
--
-- 两处都发生在 **`prisma migrate deploy` 之前**：此时各模块 schema（`auth`/`audit`/`notify`，
-- P1 起还有 `asset`）以及所有表都还不存在。所以这里**只允许**出现「建角色」与
-- `GRANT CONNECT` 这类与 schema/表无关的语句。
-- 一旦在此写 `ALTER SCHEMA auth OWNER TO ...` 或 `GRANT ... ON ALL TABLES IN SCHEMA auth`，
-- 容器初始化会直接报错（`ALL TABLES` 更糟：它会静默地授予零个对象，留下一个看起来
-- 成功、实际没有任何授权的假象）。建表授权与 append-only 的 `GRANT`/`REVOKE` 全在
-- `infra/db/apply-grants.sql`，由 `prisma migrate deploy` **之后**执行。
--
-- 这里也**不再**有 `ALTER DEFAULT PRIVILEGES ... IN SCHEMA public`：那不是「schema 不存在」
-- 的问题，而是它会把迁移台账交给运行期角色。原因与实测见文件末尾的长注释。
--
-- ## 为什么迁移后必须重跑授权（不是可选项）
--
-- 新建的表**不会**继承此前发出的 `GRANT`（`GRANT` 只作用于执行那一刻已存在的对象）。
-- 所以「迁移之后重新授权」是流程的必需步骤，而不是保险动作。Task 9 的 CI 亦然。
--
-- ## 口令
--
-- `app_pw` 是**本地/测试专用**的一次性口令，与 C10 不冲突：生产运行时的 `DATABASE_URL`
-- 只从环境变量取（`.env.example` 是占位符，不含任何真实口令）。
-- ════════════════════════════════════════════════════════════════════════════

-- 幂等建角色：容器初始化只会跑一次，但测试助手可能在同一库上重复执行本文件，
-- 且 `CREATE ROLE` 没有 `IF NOT EXISTS`，故用 DO 块包裹。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pw';
  END IF;
END
$$;

-- 运行期角色至少要能连上库；库级权限与 schema 级权限是两套独立判定，缺一不可。
GRANT CONNECT ON DATABASE vca TO app_user;

-- ════════════════════════════════════════════════════════════════════════════
-- 这里**刻意不再有** `ALTER DEFAULT PRIVILEGES ... IN SCHEMA public`。
--
-- 曾经的写法是 `FOR ROLE vca_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE
-- ON TABLES TO app_user`，理由是「public 是 PostgreSQL 自带 schema，此刻必然存在」。
-- 那个理由本身没错，但**后果被漏掉了**：默认权限作用于「此后**任何**由 vca_owner 在
-- public 里新建的表」，而 `prisma migrate deploy`（以 vca_owner 身份运行）恰恰在容器
-- 初始化**之后**才建出迁移台账 `public._prisma_migrations`。于是这条默认权限把
-- **迁移历史**一并交给了最小权限的运行期角色。
--
-- 已在真实 postgres:16-alpine 上实测到该后果（修复前的取证）：
--   relacl = {vca_owner=arwdDxt/vca_owner,app_user=arwd/vca_owner}
--   has_table_privilege('app_user','public._prisma_migrations','UPDATE') = t
--   has_table_privilege('app_user','public._prisma_migrations','DELETE') = t
-- 即运行期角色可以改写或抹掉迁移历史——而它**从未**被 brief 或任何 ruling 要求过。
--
-- 应用真正需要的一切都在各模块 schema 里（`auth`/`audit`/`notify`，P1 起还有 `asset`），
-- `public` 里没有任何属于应用的表（迁移台账是 Prisma 的内部结构，应用不该碰）。所以：
-- 把 public 的默认权限整段删掉，运行期角色在 public 上不留任何表级权限。
-- 各模块 schema 的默认权限仍在 `apply-grants.sql` 里按模块分别施加
-- （那里本来就覆盖了，删掉这条零损失）。
-- ════════════════════════════════════════════════════════════════════════════
