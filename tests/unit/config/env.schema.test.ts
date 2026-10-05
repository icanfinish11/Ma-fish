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
  // P1 / Task 1 新增（见 tests/helpers/env.ts 的 K9 清单）
  ARTIFACT_STORE_DIR: 'C:\\Temp\\vca-artifacts-fixture',
  ARTIFACT_MAX_UPLOAD_BYTES: '4194304',
  // P1 / Task 2 新增（同上清单）
  ARTIFACT_MASTER_KEY: 'c'.repeat(64),
  ARTIFACT_ACTIVE_KEY_ID: 'v1',
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

/**
 * 制品密钥（P1 / Task 2，C10 / 规格 D5）。
 *
 * `ARTIFACT_MASTER_KEY` 是**密钥**：必填、64 位 hex、占位值拒绝，且绝不入库不入 git。
 * `ARTIFACT_ACTIVE_KEY_ID` 是**标识符**而非密钥（它会逐字写进每份制品的头部），
 * 因此它**不**受占位层约束（见 `placeholder-boundary.test.ts` 的边界说明），
 * 但形状必须受限：它要按 1 字节长度写进文件头，且会出现在错误信息里。
 */
describe('制品密钥与 keyId（C10 / D5）', () => {
  it('缺少 ARTIFACT_MASTER_KEY 时拒绝启动', () => {
    const rest = { ...VALID };
    delete rest.ARTIFACT_MASTER_KEY;

    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrowError(/ARTIFACT_MASTER_KEY/);
  });

  it('拒绝占位值与长度不足的 ARTIFACT_MASTER_KEY', () => {
    // 逐字取自 .env.example 的占位值
    expect(() =>
      parseEnv({ ...VALID, ARTIFACT_MASTER_KEY: 'CHANGE_ME_64_HEX_CHARS' } as NodeJS.ProcessEnv),
    ).toThrowError(/ARTIFACT_MASTER_KEY/);
    // 63 位 hex：长度门差一位也不行
    expect(() =>
      parseEnv({ ...VALID, ARTIFACT_MASTER_KEY: 'ab'.repeat(31) + 'a' } as NodeJS.ProcessEnv),
    ).toThrowError(/ARTIFACT_MASTER_KEY/);
    // 64 个字符但不是 hex
    expect(() =>
      parseEnv({ ...VALID, ARTIFACT_MASTER_KEY: 'zz'.repeat(32) } as NodeJS.ProcessEnv),
    ).toThrowError(/ARTIFACT_MASTER_KEY/);
  });

  it('缺少 ARTIFACT_ACTIVE_KEY_ID 时拒绝启动（没有「悄悄用某个默认 keyId」这条路）', () => {
    const rest = { ...VALID };
    delete rest.ARTIFACT_ACTIVE_KEY_ID;

    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrowError(/ARTIFACT_ACTIVE_KEY_ID/);
  });

  it('ARTIFACT_ACTIVE_KEY_ID 的形状受限（空串 / 空格 / 超长 / 控制字符）', () => {
    const bad = ['', '   ', 'v 1', 'v1\n', 'k'.repeat(65), '轮换', '-v1', 'v1:'];
    for (const value of bad) {
      expect(
        () => parseEnv({ ...VALID, ARTIFACT_ACTIVE_KEY_ID: value } as NodeJS.ProcessEnv),
        `ARTIFACT_ACTIVE_KEY_ID=${JSON.stringify(value)} 不该被接受`,
      ).toThrowError(/ARTIFACT_ACTIVE_KEY_ID/);
    }
  });

  it('接受合法的制品密钥与 keyId，并在一次报错里同时点名两者', () => {
    const env = parseEnv(VALID);
    expect(env.ARTIFACT_MASTER_KEY).toBe('c'.repeat(64));
    expect(env.ARTIFACT_ACTIVE_KEY_ID).toBe('v1');

    const rest = { ...VALID };
    delete rest.ARTIFACT_MASTER_KEY;
    delete rest.ARTIFACT_ACTIVE_KEY_ID;
    try {
      parseEnv(rest as NodeJS.ProcessEnv);
      throw new Error('缺少两个制品变量却启动了');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('ARTIFACT_MASTER_KEY');
      expect(message).toContain('ARTIFACT_ACTIVE_KEY_ID');
    }
  });
});
