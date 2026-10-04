import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema.js';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // validate 在引导期同步执行：密钥缺失/占位 => 进程直接起不来（C10）
      validate: (raw: Record<string, unknown>) => envSchema.parse(raw),
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
