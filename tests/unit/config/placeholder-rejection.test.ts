import { describe, it } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';

/**
 * C10 回归：`.env.example` 里那些**能通过长度类门**的占位值必须被拒绝。
 *
 * 这些值不是随便编的——它们逐字取自本仓库的 `.env.example`（模板的定义就是「运维会照抄」）。
 * 但各字段的「牙齿」并不相同，据实说明如下（变异取证见 task-2-report.md 修复轮 2）：
 *
 * - `GITHUB_CLIENT_SECRET=CHANGE_ME`（**通过** `min(1)`）**只**被占位层拦住
 *   —— **它承担本用例的回归**（变异：删掉子串层里的 `change_me` 后它被放行，本用例随即变红）。
 * - `MASTER_ENCRYPTION_KEY=CHANGE_ME_64_HEX_CHARS` **不是**：它不是 64 位 hex，下游的
 *   64 位 hex 正则自己就会拒绝它。把它写进断言没错，但它不构成本用例的牙齿
 *   （变异实测：占位层失效时它仍被拒，报「实际被拒字段=MASTER_ENCRYPTION_KEY」）。
 *
 * ## 牙齿从两颗减到一颗（最终评审 I-2，据实记载）
 *
 * 上一版这里还有 `SESSION_SECRET=CHANGE_ME_AT_LEAST_32_CHARS_LONG`（32 字符，**正好通过**
 * `min(32)`）——它同样是「只有占位层能拦」的一颗牙。而 I-2 把那个字段**整个从 schema 里删掉**了
 * （它必填却无人读取：会话是随机 id + Redis 状态、CSRF 是不签名的双提交令牌，都不需要服务器密钥），
 * 于是这颗牙随字段一起消失。剩下的 `GITHUB_CLIENT_SECRET` 仍然足以让「占位层失效」这件事变红，
 * 但**覆盖面确实比之前窄**：这一点写在这里，免得后人以为这里还在守着两个字段。
 */
const ENV_EXAMPLE_PLACEHOLDERS = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://app_user:CHANGE_ME@127.0.0.1:5432/vca',
  REDIS_URL: 'redis://127.0.0.1:6379',
  // `.env.example` 里它是注释掉的一行（可选，有默认值 loopback）；这里补上以保持「完整 env」。
  TRUST_PROXY: 'loopback',
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
        `占位值被放行，生产环境可带占位密钥启动：GITHUB_CLIENT_SECRET=${result.data.GITHUB_CLIENT_SECRET}`,
      );
    }
    const fields = result.error.issues.map((i) => i.path.join('.'));
    for (const field of ['MASTER_ENCRYPTION_KEY', 'GITHUB_CLIENT_SECRET']) {
      if (!fields.includes(field)) {
        throw new Error(`字段 ${field} 的占位值未被拒绝；实际被拒字段=${fields.join(',')}`);
      }
    }
  });
});
