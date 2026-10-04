import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { parseEnv } from './env.schema.js';

/**
 * 除开发环境外一律不读 `.env` 文件（C10：密钥只来自环境变量）。
 *
 * - **生产**：`.env` 是更弱的密钥保管路径（可能被误提交、权限过宽），必须走进程环境变量。
 * - **测试**：读开发者本机的 `.env` 会让运行不再自足（hermetic）——测试夹具里**缺**的变量
 *   会被本机文件悄悄补上，于是「本机能过、CI 挂掉」这种最难查的失败就会出现。
 * - **开发**：照旧读 `.env`，本地开发体验不变。
 *
 * 用 `??` 而非 `||` 是刻意的：`NODE_ENV` 未设置时按 'development' 处理（与
 * `envSchema` 中 `NODE_ENV` 的默认值一致），本地不起 `NODE_ENV` 也能读 `.env`。
 * 注意 `NODE_ENV=''`（设为空串）不等于「未设置」，会走不读文件的一侧（fail-closed）。
 *
 * 该判断在 `forRoot` 被调用时求值，即模块求值期；若此时已经把 `NODE_ENV` 改成别的值，
 * 它不会重新求值（`forRoot` 是 `static async`，选项在调用点即被消费）。
 */
const ignoreEnvFile = (process.env.NODE_ENV ?? 'development') !== 'development';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile,
      // validate 在引导期同步执行：密钥缺失/占位 => 进程直接起不来（C10）。
      // 用 parseEnv 而非 envSchema.parse：报错会一次列全**所有**问题字段，
      // 运维无需「修一个报一个」。
      validate: (raw: Record<string, string | undefined>) => parseEnv(raw),
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
