import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PrismaConfig } from 'prisma';

/**
 * Prisma 7 起连接串只在此处（及运行期 adapter）出现，schema 内已不允许 url。
 *
 * 这里的连接串**只服务于迁移**：它必须指向属主角色 `vca_owner`，因为迁移要建 schema、
 * 建表、改结构。运行期绝不复用本值——应用侧走 `DATABASE_URL`（`app_user`，最小权限）。
 * 两者混用会让 append-only 的撤权失效（属主永远保有全部权限，见 infra/db/roles.sql）。
 */

/**
 * 显式加载仓库根的 `.env`。
 *
 * ## 为什么必须自己读（这是 Prisma 7 的行为，不是我们的偏好）
 *
 * Prisma 7 的 CLI **不会**自己读 `.env`：`@prisma/config@7.10.0` 在加载本文件时设
 * `dotenv: false`（已实测，见 `node_modules/.pnpm/@prisma+config@7.10.0/.../dist/index.js`）。
 * 于是 `.env` 里写的 `MIGRATE_DATABASE_URL` 会被**静默丢弃**，CLI 落到下面的兜底值，
 * 迁移就打到**另一个库**上——正是「本地能跑、环境一换就迁错库」的那类失败。
 *
 * `.env.example` 是 Ruling 5 指给开发者的登记处，而 `.env.example` 在仓库根，
 * 所以这里读的也是仓库根的 `.env`。**刻意按本文件自身的位置算绝对路径，不用 `process.cwd()`**：
 * CLI 的 cwd 随调用方式变化（`pnpm --filter @vca/api db:migrate:deploy` 时是 `apps/api`，
 * 直接 cd 过去时也是 `apps/api`），按 cwd 找文件等于又埋一个「取决于怎么调用」的静默分支。
 *
 * 用 Node 内建的 `process.loadEnvFile` 而不是 `dotenv`：语义需求只有「读一个文件、
 * 且**不覆盖**已存在的环境变量」，内建函数正好如此（已实测：shell 里的同名变量保持不变）。
 * 另外 `dotenv` 虽然经由 `@nestjs/config` 存在于 store 里，却**不是 `@vca/api` 的直接依赖**，
 * pnpm 的隔离式布局下从 `apps/api` 解析不到（已实测 `Cannot find module 'dotenv/config'`），
 * 为一个文件读取再加一条依赖不划算。
 *
 * 文件不存在时静默跳过（新克隆的仓库只有 `.env.example`，本地/CI 靠真实环境变量即可）。
 */
const ENV_FILE = path.resolve(import.meta.dirname, '../../.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

/**
 * 本地开发的一次性兜底连接串（与 `infra/docker-compose.yml` 对齐）。
 *
 * **它不再是无条件生效的**（最终评审的 Minor）：兜底值的存在意味着「忘了设
 * `MIGRATE_DATABASE_URL`」与「故意在本地 compose 上迁移」这两种情况**长得完全一样**，
 * 而前者在部署环境里的后果是把迁移打到一台本地的 Postgres 上（要么连不上、要么迁错库，
 * 而两个都不是「失败得响亮」的形态）。因此现在必须**显式 opt-in**：
 * `MIGRATE_ALLOW_LOCAL_FALLBACK=1`（写进 `.env`、或由 shell 直接给）。
 *
 * 注意 `.env.example` 里的 `MIGRATE_DATABASE_URL` 带的是 `CHANGE_ME` 占位口令，
 * 照抄它**跑不通**本机 compose（口令是 `owner_pw`）——所以本地开发的两条可行路径是：
 * ① 把 `.env` 里的 `MIGRATE_DATABASE_URL` 手工改成 compose 的值；或
 * ② 在 `.env` 里写 `MIGRATE_ALLOW_LOCAL_FALLBACK=1`，用这个兜底值。
 * `infra/docker-compose.yml` 的「从零开始」小节记载了这两条。
 */
const LOCAL_FALLBACK_URL = 'postgresql://vca_owner:owner_pw@127.0.0.1:5432/vca';

/** 显式 opt-in 的开关名：只在**本地开发**用它，生产/CI 必须给真实的连接串。 */
const LOCAL_FALLBACK_OPT_IN = 'MIGRATE_ALLOW_LOCAL_FALLBACK';

/**
 * **不连数据库**的 Prisma 子命令白名单。
 *
 * 为什么需要它（三轮实测逼出来的，不要「顺手」删掉）：
 * 1. `prisma generate` 也会加载本文件并**读 `datasource.url`**——实测把 `url` 写成
 *    getter 后，`generate` 照样触发它（探针打出 `GETTER-ACCESSED`），所以「惰性求值」
 *    区分不出这两个命令；
 * 2. 于是「缺变量就抛」会连 `prisma generate` 一起挡住，而 `pretypecheck` 与根 `pretest`
 *    都跑 `generate`——CI 的类型检查步骤正好在设置连接串的步骤**之前**，
 *    那会让整条流水线在第一步就红（实测：vitest 的 globalSetup 直接以
 *    `Failed to parse syntax of config file` 失败）；
 * 3. 本文件与 CLI **同进程**求值，`process.argv` 就是 CLI 自己的参数
 *    （实测：`["…/node.exe","…/prisma/build/index.js","generate"]`），因此子命令是可靠的判据。
 *
 * 判据方向是 **fail-closed**：不在白名单里的一律当成「要连库」，缺变量就报错。
 */
const OFFLINE_COMMANDS = new Set(['generate', 'format', 'validate', 'version', 'init']);

/** 由 `process.argv` 取出 Prisma 的子命令（跳过 node 与 CLI 入口两个位置参数）。 */
function isOfflineCommand(argv: readonly string[]): boolean {
  const command = argv.slice(2).find((arg) => !arg.startsWith('-'));
  return command !== undefined && OFFLINE_COMMANDS.has(command);
}

/**
 * 迁移连接串：`MIGRATE_DATABASE_URL` 缺失时**报错**，而不是悄悄打到 localhost。
 *
 * ## 报错文案必须自己写到 stderr（实测：Prisma 会吞掉原因）
 *
 * 配置求值期抛出的任何错误，Prisma CLI 都统一报成
 * `Failed to parse syntax of config file at "…/prisma.config.ts"`——**原因不见了**，
 * 而那句话会把运维引向「语法错误」这条死路（实测，上面的迁移命令输出只有这一行）。
 * 因此这里先把可据以行动的说明写进 stderr（Prisma 不会吞掉子进程的 stderr），再抛一个
 * 指向它的短错误。退出码仍是 1。
 */
function resolveMigrateUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (url) return url;

  if (process.env[LOCAL_FALLBACK_OPT_IN] === '1') return LOCAL_FALLBACK_URL;

  // 不连库的命令（`generate` 等）拿到兜底值也无害：它不会被用来连接任何东西。
  if (isOfflineCommand(process.argv)) return LOCAL_FALLBACK_URL;

  const detail =
    '缺少 MIGRATE_DATABASE_URL：迁移**拒绝**回落到本地兜底连接串——那会让「忘了配置」与' +
    '「故意在本地迁移」无法区分，进而把迁移打到错误的库上。\n' +
    '  · 部署/CI：把 MIGRATE_DATABASE_URL 指到属主角色（形如 ' +
    'postgresql://vca_owner:***@<host>:5432/<db>），见 .env.example；\n' +
    `  · 本地开发：在 .env 里写 ${LOCAL_FALLBACK_OPT_IN}=1 ` +
    `（回落到 ${LOCAL_FALLBACK_URL}），或把 MIGRATE_DATABASE_URL 直接设成 compose 的值。`;
  // 见上面的说明：Prisma 会把抛出的原因吞成一句「解析语法失败」，所以自己写到 stderr。
  process.stderr.write(`\n[prisma.config] ${detail}\n\n`);
  throw new Error('缺少 MIGRATE_DATABASE_URL（原因见上方 [prisma.config] 的说明）');
}

const config: PrismaConfig = {
  schema: path.join('prisma', 'schema.prisma'),
  migrations: { path: path.join('prisma', 'migrations') },
  datasource: {
    // 优先级：shell/CI 的真实环境变量 > 仓库根 `.env` > 显式 opt-in 的本地兜底值
    // （最后这一档现在**必须**由 `MIGRATE_ALLOW_LOCAL_FALLBACK=1` 打开，见 `resolveMigrateUrl`）。
    // `process.loadEnvFile` 不覆盖已存在的变量，所以测试助手（tests/helpers/db.ts）
    // 传进来的 testcontainer 连接串永远优先，不会被开发者本机的 `.env` 抢走。
    //
    // 迁移必须用属主角色：它要建 schema、建表、改结构。生产环境必须通过
    // `MIGRATE_DATABASE_URL` 注入（C10：密钥只来自环境变量）。
    url: resolveMigrateUrl(),
  },
};

export default config;
