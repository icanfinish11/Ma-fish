import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service.js';
import type { Env } from '../config/env.schema.js';

/**
 * 数据库模块。标 `@Global` 是因为数据访问几乎每个业务模块都要用，
 * 逐模块 `imports: [DbModule]` 只会制造重复样板（C16：不做多余抽象）。
 *
 * 连接串由 `ConfigService` 提供（`ConfigModule` 是全局的，见 `config.module.ts`）：
 * 取 `DATABASE_URL`，即最小权限的运行期角色 `app_user`。
 * **绝不**在这里回退到 `MIGRATE_DATABASE_URL`——那是迁移属主，一旦被运行期用上，
 * append-only 的撤权就变成空操作（C7）。
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<Env, true>) =>
        new PrismaService(cfg.get('DATABASE_URL', { infer: true })),
    },
  ],
  exports: [PrismaService],
})
export class DbModule {}
