import { defineConfig } from 'vitest/config';
import path from 'node:path';
// 说明符用 `.js` 是 NodeNext 的要求（本仓库 `moduleResolution: nodenext`），实体是 `env.ts`；
// 相对（而非 `@vca/tests/...` 裸包名）导入可避免 Vite 把裸包外置后交给 Node 去解析 `.ts` 实体。
import { testEnv } from './tests/helpers/env.js';

const alias = {
  '@vca/shared': path.resolve(import.meta.dirname, 'packages/shared/src'),
  '@vca/api': path.resolve(import.meta.dirname, 'apps/api/src'),
};

/**
 * 测试环境变量夹具的**唯一登记处**是 `tests/helpers/env.ts`。
 *
 * 为什么必须注入：`AppModule` 在模块求值期就执行 `ConfigModule.forRoot()`，
 * 其 `validate` 会立刻解析整份 env schema，因此任何 import `@vca/api` 的测试
 * 都必须在这之前拿到一套合法变量，否则连模块都加载不了。
 *
 * Task 3–9 新增必填变量时，只改 `tests/helpers/env.ts`，不要在此处内联，
 * 也不要各测试文件自行 set：那样会散成多份看不出关系的副本。
 */
const withTestEnv = { env: testEnv };

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    projects: [
      { resolve: { alias }, test: { name: 'unit', ...withTestEnv, include: ['tests/unit/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'integration', ...withTestEnv, include: ['tests/integration/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'security', ...withTestEnv, include: ['tests/security/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'property', ...withTestEnv, include: ['tests/property/**/*.test.ts'], testTimeout: 300_000 } },
      { resolve: { alias }, test: { name: 'architecture', ...withTestEnv, include: ['tests/architecture/**/*.test.ts'] } },
    ],
  },
});
