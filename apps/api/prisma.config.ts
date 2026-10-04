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

const config: PrismaConfig = {
  schema: path.join('prisma', 'schema.prisma'),
  migrations: { path: path.join('prisma', 'migrations') },
  datasource: {
    // 优先级：shell/CI 的真实环境变量 > 仓库根 `.env` > 下面的本地开发兜底值。
    // `process.loadEnvFile` 不覆盖已存在的变量，所以测试助手（tests/helpers/db.ts）
    // 传进来的 testcontainer 连接串永远优先，不会被开发者本机的 `.env` 抢走。
    //
    // 兜底默认值是**本地开发**的一次性值，与 `infra/docker-compose.yml` 对齐；
    // 生产环境必须通过 `MIGRATE_DATABASE_URL` 注入（C10：密钥只来自环境变量）。
    // 迁移必须用属主角色：它要建 schema、建表、改结构
    url: process.env.MIGRATE_DATABASE_URL ?? 'postgresql://vca_owner:owner_pw@127.0.0.1:5432/vca',
  },
};

export default config;
