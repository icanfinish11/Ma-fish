import { defineConfig } from 'vitest/config';
import path from 'node:path';
// 说明符用 `.js` 是 NodeNext 的要求（本仓库 `moduleResolution: nodenext`），实体是 `env.ts`；
// 相对（而非 `@vca/tests/...` 裸包名）导入可避免 Vite 把裸包外置后交给 Node 去解析 `.ts` 实体。
import { testEnv } from './tests/helpers/env.js';

const alias = {
  '@vca/shared': path.resolve(import.meta.dirname, 'packages/shared/src'),
  '@vca/api': path.resolve(import.meta.dirname, 'apps/api/src'),
  // worker 的**进程内逻辑**（轮询循环、停机顺序）也在这里测：它是应用代码，
  // 而本仓库的测试一律住在 `tests/`（Task 8 加了 `apps/worker/src/worker.ts` 这个
  // 「可注入依赖的循环」而没有把逻辑写在带副作用的 `main.ts` 里，与 apps/api 的
  // main.ts/bootstrap.ts 拆分同一标准）。
  '@vca/worker': path.resolve(import.meta.dirname, 'apps/worker/src'),
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

/**
 * 所有 project 共用的**一次性**准备：确保 `apps/api/src/generated/` 已生成
 * （见 `vitest.setup.ts`）。
 *
 * 为什么需要它：该目录不入 git，而任何 import `@vca/api` 的测试都会经
 * `PrismaService` 走到对生成客户端的 import。npm 的 `pretest` 钩子**只在 `pnpm test` 时**
 * 触发，覆盖不到 `pnpm vitest run --project unit` 这类直接调用——而那正是 brief 的验证命令。
 *
 * 为什么是根级 `globalSetup` 而不是每个 project 的 `setupFiles`：根 `globalSetup` 每次
 * 测试运行**只执行一次**，因此 `pnpm vitest run`（无 `--project`）不会让 5 个 project 各自
 * 并发跑一遍 `prisma generate`；同时它与 `--project X` 的选择无关，覆盖面不减
 * （已实测：带与不带 `--project` 都恰好生成一次）。
 */
const globalSetup = ['./vitest.setup.ts'];

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    globalSetup,
    projects: [
      { resolve: { alias }, test: { name: 'unit', ...withTestEnv, include: ['tests/unit/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'integration', ...withTestEnv, include: ['tests/integration/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'security', ...withTestEnv, include: ['tests/security/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'property', ...withTestEnv, include: ['tests/property/**/*.test.ts'], testTimeout: 300_000 } },
      { resolve: { alias }, test: { name: 'architecture', ...withTestEnv, include: ['tests/architecture/**/*.test.ts'] } },
    ],
  },
});
