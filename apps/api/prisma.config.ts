import path from 'node:path';
import type { PrismaConfig } from 'prisma';

/**
 * Prisma 7 起连接串只在此处（及运行期 adapter）出现，schema 内已不允许 url。
 *
 * 这里的连接串**只服务于迁移**：它必须指向属主角色 `vca_owner`，因为迁移要建 schema、
 * 建表、改结构。运行期绝不复用本值——应用侧走 `DATABASE_URL`（`app_user`，最小权限）。
 * 两者混用会让 append-only 的撤权失效（属主永远保有全部权限，见 infra/db/roles.sql）。
 *
 * 兜底默认值是**本地开发**的一次性值，与 `infra/docker-compose.yml` 对齐；
 * 生产环境必须通过 `MIGRATE_DATABASE_URL` 注入（C10：密钥只来自环境变量）。
 */
const config: PrismaConfig = {
  schema: path.join('prisma', 'schema.prisma'),
  migrations: { path: path.join('prisma', 'migrations') },
  datasource: {
    // 迁移必须用属主角色：它要建 schema、建表、改结构
    url: process.env.MIGRATE_DATABASE_URL ?? 'postgresql://vca_owner:owner_pw@127.0.0.1:5432/vca',
  },
};

export default config;
