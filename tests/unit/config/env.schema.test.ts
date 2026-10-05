import { describe, it, expect } from 'vitest';
import { parseEnv } from '@vca/api/config/env.schema.js';

const VALID = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://app_user:pw@127.0.0.1:5432/vca',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MASTER_ENCRYPTION_KEY: 'b'.repeat(64),
  TRUST_PROXY: 'loopback',
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
} as unknown as NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('接受完整合法配置并做类型转换', () => {
    const env = parseEnv(VALID);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('缺少必填密钥时抛错并指出字段名', () => {
    // 与计划逐字版的差异：计划用 `const { X, ...rest }` 解构剔除，
    // 那会留下未使用的绑定，被 @typescript-eslint/no-unused-vars 判错（本仓库 lint 门为 error）。
    // 改为解构后显式 delete，语义相同且不产生死绑定。
    //
    // 被剔除的字段从 `SESSION_SECRET` 换成了 `GITHUB_CLIENT_SECRET`（最终评审 I-2 删掉了前者：
    // 它必填却无人读取）。**「缺一个必填变量就拒绝启动」这条性质本身不变**。
    const rest = { ...VALID };
    delete rest.GITHUB_CLIENT_SECRET;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrowError(/GITHUB_CLIENT_SECRET/);
  });

  it('拒绝占位默认值（生产环境）', () => {
    expect(() =>
      parseEnv({ ...VALID, NODE_ENV: 'production', GITHUB_CLIENT_SECRET: 'changeme' } as NodeJS.ProcessEnv),
    ).toThrowError(/GITHUB_CLIENT_SECRET/);
  });

  it('拒绝长度不足的密钥（63 位 hex 差一位也不行）', () => {
    expect(() =>
      parseEnv({ ...VALID, MASTER_ENCRYPTION_KEY: 'a'.repeat(63) } as NodeJS.ProcessEnv),
    ).toThrowError(/MASTER_ENCRYPTION_KEY/);
  });

  it('拒绝非 32 字节的主密钥（AES-256 需要 64 位 hex）', () => {
    expect(() =>
      parseEnv({ ...VALID, MASTER_ENCRYPTION_KEY: 'zz' } as NodeJS.ProcessEnv),
    ).toThrowError(/MASTER_ENCRYPTION_KEY/);
  });

  it('拒绝未知的 NODE_ENV', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'staging' } as NodeJS.ProcessEnv)).toThrowError(/NODE_ENV/);
  });
});
