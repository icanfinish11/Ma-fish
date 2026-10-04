import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { apiDir, configurePrismaGenerate, NODE_BIN, resolvePrismaCli } from './prisma-generate.js';

/**
 * 集成测试的数据库引导（C7/C5 的取证装置）。
 *
 * **绝不 mock 数据库**（设计文档 §12）：append-only 与 schema 隔离都是 PostgreSQL
 * 自身的权限/命名空间语义，只有真库能证明。这里起真 Postgres，按固定顺序做三件事。
 *
 * ## 三步顺序是硬性的，不可调换
 *
 * 1. `infra/db/roles.sql` —— **先建角色**。迁移与授权都要引用 `app_user`，角色不存在则
 *    后面的 `GRANT` 直接报错。
 * 2. `prisma migrate deploy` —— 以**属主** `vca_owner` 身份建 schema 与表。
 * 3. `infra/db/apply-grants.sql` —— **迁移之后**才授权。`GRANT` 只作用于执行那一刻已存在的
 *    对象，新建表不继承既有 `GRANT`，所以这一步不是保险动作而是必需步骤。
 *
 * `roles.sql` 内不含任何 schema/表级语句（那些此刻必然失败），原因见该文件顶部注释。
 *
 * ## 与 `docker-compose.yml` 的关系
 *
 * compose 侧把 `roles.sql` 挂在 `docker-entrypoint-initdb.d` 上（只做建角色/连接授权）；
 * 本助手则是「起容器 → 显式跑三个脚本」的等价流程，因此**不会**双跑：
 * testcontainer 在本文件里用 `new PostgreSqlContainer(...)` 创建，未挂载任何
 * `docker-entrypoint-initdb.d` 脚本，roles.sql 只由下面的第 ① 步执行一次。
 * 两处共用同一对 .sql 文件，语义因此只有一份。
 */

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '../..');
const ROLES_SQL = path.resolve(REPO_ROOT, 'infra/db/roles.sql');
const APP_GRANTS_SQL = path.resolve(REPO_ROOT, 'infra/db/apply-grants.sql');

// 本文件位于 `tests/helpers/`，仓库根即其向上两级。把锚点交给 prisma-generate，
// 使 CLI 入口解析与 `cwd` 都用同一个根（`vitest.setup.ts` 用同一函数，但锚点是它自己算的根）。
configurePrismaGenerate(REPO_ROOT);

// 与 `infra/docker-compose.yml` 及 `apps/api/prisma.config.ts` 的本地/测试取值保持一致。
// 角色名 `vca_owner` / `app_user` 是全局约定（见 infra/db/roles.sql），本地口令属测试一次性值。
const DB_NAME = 'vca';
const OWNER_USER = 'vca_owner';
const OWNER_PASSWORD = 'owner_pw';
const APP_USER = 'app_user';
const APP_PASSWORD = 'app_pw';

export interface TestPg {
  ownerUri: string;
  appUri: string;
  stop: () => Promise<void>;
}

/** 属主身份执行一段可能含多条语句的脚本（`pg` 的简单查询协议支持多语句）。 */
async function runSql(uri: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: uri });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    // 出错时也要断开，否则容器 stop 会被挂起的连接拖住。
    await client.end();
  }
}

/**
 * Prisma CLI 入口的解析与「为什么不用 `pnpm exec`」的理由，统一放在
 * `tests/helpers/prisma-generate.ts`（那里也被 `vitest.setup.ts` 与根 `pretest` 使用），
 * 此处只引用，避免同一段平台适配逻辑出现两份。
 */
const PRISMA_CLI = resolvePrismaCli();

/**
 * 把 `localhost` 归一为 `127.0.0.1`。
 *
 * 实测（Windows + Docker Desktop）：同一容器端口，`node-postgres` 用 `localhost` 能连上，
 * 而 **Prisma 引擎不能**——它报 `P1001: Can't reach database server at localhost:<port>`；
 * 换成 `127.0.0.1` 立刻成功。原因是两条解析路径不同：Docker 的端口发布只监听 IPv4，
 * 而 Prisma 的 Rust 引擎优先解析到 IPv6 `::1`。`container.getHost()` 在 Docker Desktop 上
 * 返回的正是字面量 `localhost`，所以不能只是「取容器上报的主机名」。
 * 归一之后 Windows 与 Linux（CI）行为一致：`127.0.0.1` 在两边都无歧义。
 */
function toLoopback(host: string): string {
  return host === 'localhost' || host === '::1' ? '127.0.0.1' : host;
}

/**
 * 启动真实 Postgres，跑 Prisma 迁移，再应用最小权限授权。
 */
export async function startPostgres(): Promise<TestPg> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase(DB_NAME)
    .withUsername(OWNER_USER)
    .withPassword(OWNER_PASSWORD)
    .start();

  const host = toLoopback(container.getHost());
  const port = container.getMappedPort(5432);
  const ownerUri = `postgresql://${OWNER_USER}:${OWNER_PASSWORD}@${host}:${port}/${DB_NAME}`;
  const appUri = `postgresql://${APP_USER}:${APP_PASSWORD}@${host}:${port}/${DB_NAME}`;

  try {
    // ① 建角色（属主身份执行；此刻还没有任何 schema/表）
    await runSql(ownerUri, await readFile(ROLES_SQL, 'utf8'));

    // ② 跑迁移（属主身份）
    // `migrate deploy` 的连接串来自 `apps/api/prisma.config.ts` 的 `datasource.url`，
    // 该值读 `MIGRATE_DATABASE_URL`——下面把它指向本次 testcontainer，而非本机 compose 的库。
    //
    // 刻意**不**加 `--url`：Prisma 7 的 `migrate deploy` 没有这个选项（`migrate dev` 才有），
    // 传了会被当作未知参数、退化成打印 help 并以非零码退出（已实测）。归属由此只由
    // `MIGRATE_DATABASE_URL` 决定，与 `infra/db/roles.sql`「先建角色」的顺序保持不变。
    execFileSync(
      NODE_BIN,
      [
        PRISMA_CLI,
        'migrate',
        'deploy',
        '--config',
        'prisma.config.ts',
        '--schema',
        'prisma/schema.prisma',
      ],
      {
        cwd: apiDir(),
        env: { ...process.env, MIGRATE_DATABASE_URL: ownerUri },
        stdio: 'inherit',
      },
    );

    // ③ 迁移后重新授权（新表不会继承既有 GRANT；append-only 的 REVOKE 在此生效）
    await runSql(ownerUri, await readFile(APP_GRANTS_SQL, 'utf8'));
  } catch (err) {
    // 引导失败时不要留下容器：否则 beforeAll 报错的同时容器还在跑，
    // 反复调试会攒下一堆占端口的 Postgres，后续失败原因会被带偏。
    // 这里吞掉 stop 自身的异常并原样抛出**引导错误**——真正的失败原因永远优先。
    await container.stop().catch(() => undefined);
    throw err;
  }

  return { ownerUri, appUri, stop: async () => void (await container.stop()) };
}
