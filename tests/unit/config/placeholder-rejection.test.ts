import { describe, it } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';

/**
 * C10 回归：`.env.example` 里那些**长于长度门**的占位值必须被拒绝。
 *
 * 这些值不是随便编的——它们逐字取自本仓库的 `.env.example`。它们都 ≥ 32 字符，
 * 因此长度门与 64 位 hex 正则都拦不住（`.env.example` 的定义就是「运维会照抄的模板」）。
 * 若占位规则退化成「逐字相等」，下面的断言会失败：这正是它存在的意义。
 */
const ENV_EXAMPLE_PLACEHOLDERS = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://app_user:CHANGE_ME@127.0.0.1:5432/vca',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET: 'CHANGE_ME_AT_LEAST_32_CHARS_LONG',
  MASTER_ENCRYPTION_KEY: 'CHANGE_ME_64_HEX_CHARS',
  GITHUB_CLIENT_ID: 'CHANGE_ME',
  GITHUB_CLIENT_SECRET: 'CHANGE_ME',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
};

describe('占位值拒绝规则（C10 / 威胁 #15）', () => {
  it('拒绝 .env.example 中长于长度门的占位值，并在一次报错里列全字段', () => {
    const result = envSchema.safeParse(ENV_EXAMPLE_PLACEHOLDERS);

    if (result.success) {
      throw new Error(
        `占位值被放行，生产环境可带占位密钥启动：SESSION_SECRET=${result.data.SESSION_SECRET}`,
      );
    }
    const fields = result.error.issues.map((i) => i.path.join('.'));
    for (const field of ['SESSION_SECRET', 'MASTER_ENCRYPTION_KEY', 'GITHUB_CLIENT_SECRET']) {
      if (!fields.includes(field)) {
        throw new Error(`字段 ${field} 的占位值未被拒绝；实际被拒字段=${fields.join(',')}`);
      }
    }
  });
});
