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
 * **但「新增必填变量只改这一处」是不准确的**，据实记载：另有**四处**手写的完整
 * 合法环境（它们刻意不 import 本文件：有的要构造非法变体、有的只取 schema 做局部断言），
 * 外加一份「必填清单」。**P1 Task 1 逐个核对过**（此前文件里写的是「另有两处」，不准）：
 *
 * 1. `tests/unit/config/env.schema.test.ts` 的 `VALID`（要构造缺字段/非法值的变体）
 * 2. `tests/unit/config/placeholder-boundary.test.ts` 的 `VALID`（显式 `production`）
 * 3. `tests/unit/config/placeholder-rejection.test.ts` 的 `ENV_EXAMPLE_PLACEHOLDERS`
 *    （逐字取自 `.env.example`，含 `production` 与占位密钥）
 * 4. `tests/security/trust-proxy.test.ts` 里 `envSchema.parse({...})` 的内联对象
 *    （只验 `TRUST_PROXY` 的默认值与单一来源）
 * 5. `tests/unit/config/bootstrap-guard.test.ts` 的 `REQUIRED_KEYS`
 *    （缺任意一个都必须让引导期拒绝启动，因此**新必填变量必须加进那份清单**）
 *
 * 新增必填变量时这五处都要改；漏改的表现是那些文件里的断言变红（快速失败，不会静默放行）。
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
// 命名空间导入而不是 `import { join } from 'node:path'`：本文件会被 Vite **内联进
// `vitest.config.ts` 的打包产物**，而那份配置自己也有一个 `path` 绑定——实测两者同名时
// 打包产物里会留下一个未绑定的 `path`，启动直接报 `ReferenceError: path is not defined`
// （配置连加载都失败，全部 project 都跑不起来）。用一个不会撞名的绑定即可。
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

/**
 * 制品卷的**根目录**（修复轮 1 / Fix 5）。
 *
 * 这里只登记**根**；**每个制品套件必须在引导应用之前把它覆写成自己的子目录**，
 * 做法是 `process.env.ARTIFACT_STORE_DIR = artifactStoreDirFor(process.env.VITEST_POOL_ID ?? process.pid)`
 * ——`tests/integration/asset/upload-stream.test.ts` 的 `beforeAll` 就是这么做的。
 *
 * 理由：那个目录曾经是所有文件共用的一个固定路径，而该文件在 `beforeAll`/`beforeEach` 里
 * `rm -rf` 它——单个消费者时看不出问题，**第二个**并发的集成文件一上来就会把第一个正在用的
 * 对象全删掉，表现为「上传成功后读回是空」这类看不出原因的失败。
 *
 * 为什么**必须**覆写 `process.env`（实测两次才定位到，不是风格选择）：
 *
 * 1. `test.env` 是 **Vitest 主进程**求值后**序列化**分发给各 worker 的——worker 里重新
 *    import 本文件算出的值与应用读到的那一份**可能不同**（`VITEST_POOL_ID` 只在 worker 里存在）。
 *    实测：worker 里 `process.env.ARTIFACT_STORE_DIR` = `…vca-test-artifacts-15712`、
 *    重新 import 本夹具 = `…vca-test-artifacts-1`（`evidence/t1-fix1-probe-store-dir.txt`）。
 * 2. 应用侧（`LocalArtifactStore` 的工厂）只读**它启动时**的 `process.env`：
 *    在 `beforeAll` 里 import 应用**之后**再改夹具值是没用的——实测「应用写根目录、
 *    测试读子目录」，三条用例当场变红（`evidence/t1-fix1-diag.txt`）。
 *    唯独「**引导之前**改 `process.env`，且**应用与测试读同一个值**」这一种形状两边一致
 *    （`createTestApp()` 内部才 import `AppModule`，因此那次求值晚于本覆写）。
 *
 * 残留的已知边界（据实记载）：根目录是共享的，因此**两次同时在同机跑的**
 * `pnpm test` 会共用它。子目录按套件隔离，所以两次运行之间仍不会互相删对象；
 * 代价只是崩溃后的残留目录可能被另一次运行的清理顺手收掉——这不影响断言。
 */
const artifactRoot = nodePath.join(tmpdir(), 'vca-test-artifacts');

/**
 * 某个标识下面的制品套件目录：`<根>/<tag>`。
 *
 * `tag` 由调用方给出（在 worker 里取 `process.env.VITEST_POOL_ID`，
 * 没有它时用 `process.pid`：同一个进程内仍然自洽）。
 */
export function artifactStoreDirFor(tag: string | number): string {
  return nodePath.join(artifactRoot, String(tag));
}

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
  // ── P1 / Task 1 起 ────────────────────────────────────────────────────────────
  // 制品卷放在系统临时目录下：测试进程对仓库目录没有写权限的机器上也能跑，
  // 且 `pnpm test` 不会在仓库里留下制品（`storage/` 虽已 gitignore，但测试不该依赖它）。
  //
  // 这里登记的是**根**：真正的套件目录由各套件自己用 `artifactStoreDirFor(tag)` 取
  // （**必须**如此，见上面的实测说明——应用读的是 `process.env` 里那一份，一个进程只有一份）。
  //
  // 上限取 **4 MiB** 而不是生产默认的 1 GiB：任务 1 的验收里有一条「超限上传中止后无残留」，
  // 它必须**真的**触发 `limits.fileSize`，而用 1 GiB 触发意味着每个用例都要传 >1 GiB。
  // 这是刻意的测试期取值，不是把生产上限改小（生产的 `.env.example` 是 1 GiB）。
  ARTIFACT_STORE_DIR: artifactRoot,
  ARTIFACT_MAX_UPLOAD_BYTES: '4194304',
} as const satisfies Partial<NodeJS.ProcessEnv>);
