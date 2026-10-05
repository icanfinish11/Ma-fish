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
 * ## 唯一的登记处（但并非唯一一处副本）
 *
 * **应用侧只有这一处**：不要再往 `vitest.config.ts` 内联字面量、也不要各测试文件自行 set：
 * 那样会散成多份互相看不出关系的副本，遗漏时排查成本极高。
 *
 * **但「Task 3–9 新增必填变量只改这一处」是不准确的**，据实记载：另有两处**手写的完整
 * 合法环境**，它们刻意不 import 本文件（一处要构造非法变体、一处要显式覆写 `NODE_ENV`）：
 *
 * - `tests/unit/config/env.schema.test.ts` 的 `VALID`
 * - `tests/unit/config/placeholder-boundary.test.ts` 的 `VALID`
 *
 * 新增必填变量时**这三处都要改**；漏改的表现是那两个文件里的断言变红（快速失败，
 * 不会静默放行）。
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
 * - 测试因而不受开发者本机环境变量影响（自足/hermetic）——**但仅限本文件登记过的键**
 *   （已实测）。`test.env` 只是**叠加**，未登记的变量会从 shell 原样透传：将来在 schema 里
 *   新增必填变量却忘了登记到本文件时，开发机 shell 里的同名变量会悄悄把它填上，
 *   于是「本机能过、CI 挂掉」。这就是上一节要求「三处同步改」的原因。
 * - 另见 `config.module.ts` 的 `ignoreEnvFile`：非开发环境连 `.env` 文件都不读（已实测）。
 *
 * ## 数据库凭据的「同名不同值」（Task 3 起，务必读这段）
 *
 * 下面的 `DATABASE_URL` 里角色是 `app_user`、口令是 `test_pw`、库名是 `vca_test`——
 * 它**对上的是本地 compose 的库名 `vca` 与 testcontainer 的一次性口令（`app_pw`）都不一致**，
 * 这是**刻意**的，不是笔误：本文件是**应用启动期校验**的夹具，用于任何 `import '@vca/api'`
 * 的测试（`AppModule` 求值期就要一份合法 env）。这类测试**从不去连库**，因此 URL 只需形状合法。
 *
 * **必须一致的是角色名**：运行期 `app_user`、迁移属主 `vca_owner` 在
 * `infra/docker-compose.yml`、`infra/db/roles.sql`、`apps/api/prisma.config.ts` 与本文件里
 * 拼写完全相同（见 C7 与不变式 #5）。口令与库名允许按上下文不同。
 *
 * **Task 4 起若要真连库**：不要用这个 URL，用 `tests/helpers/db.ts` 的 `startPostgres()`
 * ——它返回 `ownerUri` / `appUri`（testcontainer 真实地址，且已跑完迁移与最小权限授权）。
 *
 * `MIGRATE_DATABASE_URL`（迁移属主连接串）**刻意不登记在这里**：它只被 `prisma.config.ts`
 * 读取，从不进入应用进程，登记了反而会让「运行期拿到了属主连接串」这种事看起来合法
 * ——那正是 C7 要防的。
 */
// `as const` 只给**编译期**只读类型，运行期照样可写；`Object.freeze` 才把它真正钉死，
// 免得某个测试顺手改写这份「唯一登记处」而污染同进程的其他用例（vitest 的 `env` 是共享的）。
export const testEnv = Object.freeze({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app_user:test_pw@127.0.0.1:5432/vca_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MASTER_ENCRYPTION_KEY: 'ab'.repeat(32),
  // `TRUST_PROXY` 有默认值（`loopback`），登记在这里是为了让「一份完整合法 env」这件事
  // 在三处夹具里保持一致（见文件头 K9；生产引导读的也是同一个变量）。
  TRUST_PROXY: 'loopback',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
} as const satisfies Partial<NodeJS.ProcessEnv>);
