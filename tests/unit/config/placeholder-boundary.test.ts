import { describe, it, expect } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';

/**
 * 划定 `nonPlaceholder` 的**使用边界**：占位值拒绝层只允许用于「密钥」字段。
 *
 * 为什么需要这组用例：该层的词表含 `example`、`todo` 这类通用词（为了堵住
 * `CHANGE_ME_*` 这类长占位值，见 `placeholder-rejection.test.ts`）。它们绝不能
 * 被套到非密钥字段上——`MAIL_FROM=no-reply@example.com` 就是本仓库 `.env.example`
 * 里的合法值，一旦误套，每次启动都会被自己挡住。
 *
 * 判别方式：下面的非密钥字段本身就含 `example` / `todo` 子串。若有人把占位层
 * 扩大到这些字段，用例立刻变红；而密钥字段上的占位拒绝能力仍由第三个用例守住。
 */

/** 合法基线；除用例显式覆写的字段外均通过校验。 */
const VALID = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://app_user:pw@127.0.0.1:5432/vca',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MASTER_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
  TRUST_PROXY: 'loopback',
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'gho_realistic_oauth_secret_value',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  // P1 / Task 1 新增（见 tests/helpers/env.ts 的 K9 清单）
  ARTIFACT_STORE_DIR: 'C:\\Temp\\vca-artifacts-fixture',
  ARTIFACT_MAX_UPLOAD_BYTES: '4194304',
} as unknown as NodeJS.ProcessEnv;

describe('nonPlaceholder 的使用边界（只作用于密钥字段）', () => {
  it('放行含 example 的 MAIL_FROM —— 与 .env.example 逐字一致', () => {
    const result = envSchema.safeParse({ ...VALID, MAIL_FROM: 'no-reply@example.com' });

    if (!result.success) {
      throw new Error(
        `MAIL_FROM 是非密钥字段，不应受占位规则约束；实际报错=${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' | ')}`,
      );
    }
    expect(result.data.MAIL_FROM).toBe('no-reply@example.com');
  });

  it('放行 URL 里含 todo / example 的 DATABASE_URL —— 这类通用词在非密钥配置里合法', () => {
    const url = 'postgresql://app_user:pw@127.0.0.1:5432/todo_example_db';
    const result = envSchema.safeParse({ ...VALID, DATABASE_URL: url });

    if (!result.success) {
      throw new Error(
        `DATABASE_URL 是非密钥字段，不应受占位规则约束；实际报错=${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' | ')}`,
      );
    }
    expect(result.data.DATABASE_URL).toBe(url);
  });

  it('密钥字段上仍然拒绝含占位词的「长」值（边界不得以放松密钥为代价）', () => {
    // 被覆写的字段从 `SESSION_SECRET` 换成了 `GITHUB_CLIENT_SECRET`（最终评审 I-2 删掉了前者：
    // 它必填却无人读取）。`min(1)` 的下游**拦不住**这个 86 字符的值，
    // 因此这里仍然是「占位层自己在承重」的判别式。
    const result = envSchema.safeParse({
      ...VALID,
      GITHUB_CLIENT_SECRET: `${'x'.repeat(40)}-changeme-${'y'.repeat(40)}`,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('GITHUB_CLIENT_SECRET');
    }
  });
});
