import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * 数据库访问入口。**继承而非包装** `PrismaClient`，因此调用方直接用
 * `prisma.user.findMany()` 这类原生 API，不必穿透一层 `prisma.client`。
 *
 * ## 连接串从哪来
 *
 * 由 `DbModule` 注入 `DATABASE_URL`——那是**运行期**角色 `app_user` 的最小权限连接，
 * 不是迁移属主 `vca_owner`。两者混用会让 append-only 的撤权失效（属主永远保有全部权限，
 * 见 `infra/db/roles.sql`）。
 *
 * ## 为什么必须有 driver adapter
 *
 * Prisma 7 的 `schema.prisma` 里**不允许**再写 `datasource.url`；连接串改由运行期
 * driver adapter 提供。这里用 `@prisma/adapter-pg`（node-postgres）。
 *
 * `apps/api/src/generated/` 是 `prisma generate` 的产物且不入 git，因此**克隆后必须先
 * `pnpm db:generate`**（根 `pretest` 与 `apps/api` 的 `pretypecheck` 已自动串联，
 * 正常无需手动执行）。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(connectionString: string) {
    // Prisma 7 要求运行期传入 driver adapter（schema 内已无 url）
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // 措辞刻意保守：`$connect()` 只是**初始化连接池**，它并不触碰数据库
    // （惰性建连，连接串指向一个不存在的库时这里照样不报错——已实测）。
    // 所以这里能诚实宣称的只有「客户端已就绪」，不是「数据库已连接」。
    // 真正的探活属于后续模块的健康检查端点，且**不放在这里**：
    // 应用启动测试本就允许在没有数据库的情况下起服务，加 `SELECT 1` 会把它们打红。
    this.logger.log('Prisma 客户端已初始化');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
