import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = {
  '@vca/shared': path.resolve(import.meta.dirname, 'packages/shared/src'),
  '@vca/api': path.resolve(import.meta.dirname, 'apps/api/src'),
};

/**
 * 测试专用环境变量（**仅测试夹具，不是密钥**）。
 *
 * 为什么必须有：AppModule 在模块求值期就执行 `ConfigModule.forRoot()`，
 * 而它调用的 `validate` 会在引导期解析整份 env schema。因此任何 import
 * `@vca/api` 的测试文件都要求这套变量齐备，否则测试连模块都加载不了。
 * 这**不是**把 fail-fast 削弱——生产引导期照旧拒绝缺失/占位密钥（C10）；
 * 这里只是给测试进程提供一套合法输入，使其能走到「应用已起来」的状态。
 * 需要验证拒绝行为的测试，必须显式覆写这些值为非法值。
 */
const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app_user:test_pw@127.0.0.1:5432/vca_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET: 'test-only-session-secret-32-chars-min',
  MASTER_ENCRYPTION_KEY: 'ab'.repeat(32),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
};

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    projects: [
      { resolve: { alias }, test: { name: 'unit', env: testEnv, include: ['tests/unit/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'integration', env: testEnv, include: ['tests/integration/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'security', env: testEnv, include: ['tests/security/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'property', env: testEnv, include: ['tests/property/**/*.test.ts'], testTimeout: 300_000 } },
      { resolve: { alias }, test: { name: 'architecture', env: testEnv, include: ['tests/architecture/**/*.test.ts'] } },
    ],
  },
});
