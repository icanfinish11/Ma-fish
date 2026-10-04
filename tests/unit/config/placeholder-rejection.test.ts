import { describe, it } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';

/**
 * C10 回归：`.env.example` 里那些**能通过长度类门**的占位值必须被拒绝。
 *
 * 这些值不是随便编的——它们逐字取自本仓库的 `.env.example`（模板的定义就是「运维会照抄」）。
 * 但三个字段的「牙齿」并不相同，据实说明如下（变异取证见 task-2-report.md 修复轮 2）：
 *
 * - `SESSION_SECRET=CHANGE_ME_AT_LEAST_32_CHARS_LONG`（32 字符，**正好通过** `min(32)`）与
 *   `GITHUB_CLIENT_SECRET=CHANGE_ME`（**通过** `min(1)`）**只**被占位层拦住
 *   —— **这两个字段承担本用例的回归**。
 * - `MASTER_ENCRYPTION_KEY=CHANGE_ME_64_HEX_CHARS` **不是**：它不是 64 位 hex，下游的
 *   64 位 hex 正则自己就会拒绝它。把它写进断言没错，但它不构成本用例的牙齿
 *   （变异实测：占位层失效时它仍被拒，报「实际被拒字段=MASTER_ENCRYPTION_KEY」）。
 *
 * 变异取证：删掉子串层里的 `change_me` 后，`SESSION_SECRET` 与 `GITHUB_CLIENT_SECRET`
 * 双双被**放行**（fail-open），本用例随即变红。这正是它存在的意义。
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
