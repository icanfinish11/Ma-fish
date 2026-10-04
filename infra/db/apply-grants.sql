-- ════════════════════════════════════════════════════════════════════════════
-- schema / 表级授权与 **append-only 撤权（C7 的核心）**。
--
-- ## 执行时机（硬性）
--
-- 本文件必须在 **`prisma migrate deploy` 之后**执行，由属主角色 `vca_owner` 运行。
-- 与角色层 `infra/db/roles.sql` 的分工见该文件顶部注释：那里只做「建角色 + 连接授权 +
-- `public` 的默认权限」，因为它在容器初始化时就跑，那时 `auth`/`audit`/`notify` 三个
-- schema 与所有表都还不存在。这里才做建表之后的授权。
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
GRANT USAGE ON SCHEMA auth, audit, notify TO app_user;

-- ── auth：通用业务表，可读写（改密、注销需要 UPDATE/DELETE）──────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO app_user;

-- ── notify：outbox / 幂等记录，消费者要回写 processed_at，故可读写 ──
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA notify TO app_user;

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

-- ── 未来新建的表沿用同样默认权限 ──────────────────────────────────
-- 放在本文件而非 roles.sql：`ALTER DEFAULT PRIVILEGES ... IN SCHEMA <名>` 要求该 schema
-- 此刻已存在（只有属主或超级用户能执行，且 schema 必须存在），而这三个 schema 由 Prisma
-- 迁移创建，容器初始化时还不存在。默认权限只影响**此后**新建的表，因此「迁移后施加」
-- 在语义上没有损失；再加上每次迁移后都会重跑本文件，覆盖面与写在 roles.sql 完全等价。
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA notify
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO app_user;
