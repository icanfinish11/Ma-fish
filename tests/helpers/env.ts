/**
 * 测试环境变量夹具（**仅供测试进程使用，不是密钥，也绝不可放真实密钥**）。
 *
 * ## 为什么这个文件必须存在
 *
 * `AppModule` 在**模块求值期**就执行 `ConfigModule.forRoot()`，其中的 `validate`
 * 会立刻解析整份 env schema（`apps/api/src/config/env.schema.ts`）。因此任何
 * `import '@vca/api'` 的测试文件都要求这套变量**在模块图加载之前**就齐备，
 * 否则测试连模块都加载不了（表现为 `ZodError: DATABASE_URL …`）。
 *
 * `vitest.config.ts` 从这里 import 同一份值，供全部 project 使用；
 * 它位于仓库根部、在 Vitest 读取配置时求值，正好早于模块图加载。
 *
 * ## 唯一的登记处（single source of truth）
 *
 * Task 3–9 每加一个**必填**环境变量，都只在本文件加一处。不要再往
 * `vitest.config.ts` 内联字面量、也不要各测试文件自行 set：那样会散成多份
 * 互相看不出关系的副本，遗漏时排查成本极高。
 *
 * ## 为什么这不削弱 fail-fast（C10）
 *
 * 这里只影响**测试进程**的输入；开发/生产引导期照旧拒绝缺失与占位密钥。
 * 需要验证「拒绝行为」的测试必须**显式覆写**为非法值再断言抛错。
 *
 * ## 两条硬约束
 *
 * 1. **本文件不得 import `@vca/api` 或任何应用代码**：它在应用模块图之前求值，
 *    一旦引入应用依赖就会造成加载顺序环。保持为纯数据。
 * 2. **只放一次性测试值，绝不放真实密钥**（C10：密钥只来自环境变量，不落任何文件）。
 *    这里的字符串按定义就是公开的。
 *
 * ## 求值顺序与优先级（已实测，纠正一处常见误解）
 *
 * Vitest 5 的 `test.env` 是**叠加**到工人进程的 `process.env` 上，且**夹具值优先**：
 * 实测把 `NODE_ENV=production`、`DATABASE_URL=SENTINEL_FROM_SHELL` 放进 shell 后，
 * 测试进程内看到的仍是本文件的 `'test'` 与 `vca_test`。因此：
 *
 * - **不要在 shell 里设这些变量来「验证拒绝行为」**：夹具会把它们覆盖掉，测试照旧全绿。
 *   要断言拒绝，必须在测试体内显式覆写（如 `parseEnv({ ... })` 或 `process.env.X = 'bad'`）。
 * - 测试因而不受开发者本机环境变量影响（自足/hermetic），这是刻意的。
 * - 另见 `config.module.ts` 的 `ignoreEnvFile`：非开发环境连 `.env` 文件都不读。
 */
export const testEnv = {
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
} as const satisfies Partial<NodeJS.ProcessEnv>;
