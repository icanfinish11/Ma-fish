import { describe, it, expect, vi } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';
import { shouldIgnoreEnvFile } from '@vca/api/config/config.module.js';

describe('启动守卫（schema 层）', () => {
  it('校验器对缺失密钥抛错，确保引导期失败而非运行期', () => {
    expect(() => envSchema.parse({})).toThrow();
  });
});

/**
 * `ignoreEnvFile` 的判据已抽成纯函数，因此「非开发环境不读 `.env`」这条 C10 行为
 * 有了常驻回归；此前它内联在模块顶层，只能靠一次性进程探针取证。
 */
describe('shouldIgnoreEnvFile —— 除开发环境外一律不读 .env（C10）', () => {
  const CASES: Array<[string, boolean]> = [
    ['development', false],
    ['test', true],
    ['production', true],
    // 已知边界（`config.module.ts` 注释中已记载）：空串不等于「未设置」，
    // 走不读文件的一侧。显式钉住它，免得日后被当成 bug「顺手修掉」而放松生产路径。
    ['', true],
  ];

  it.each(CASES)('NODE_ENV=%o => ignoreEnvFile=%s', (nodeEnv, expected) => {
    expect(shouldIgnoreEnvFile(nodeEnv)).toBe(expected);
  });

  /**
   * 「未设置」这一态**只能**通过 `process.env` 表达，不能靠传字面量 `undefined`：
   * 默认参数在实参为 `undefined` 时一样生效（JS 语义如此），
   * `shouldIgnoreEnvFile(undefined)` 等价于 `shouldIgnoreEnvFile()`，
   * 于是会去读当下的 `process.env.NODE_ENV`。这里的判据因此是「把该变量删掉」。
   */
  it('NODE_ENV 未设置 => 按 development 处理，仍然读 .env', () => {
    const saved = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      expect(process.env.NODE_ENV).toBeUndefined();
      expect(shouldIgnoreEnvFile()).toBe(false); // 接线处的调用形式
      expect(shouldIgnoreEnvFile(process.env.NODE_ENV)).toBe(false); // 显式传 undefined
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  });

  it('不传参时读取调用当下的 process.env.NODE_ENV（不是模块求值期的快照）', () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(shouldIgnoreEnvFile()).toBe(true);
      process.env.NODE_ENV = 'development';
      expect(shouldIgnoreEnvFile()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  });
});

/**
 * **接线层**的 C10 回归：把 `ConfigModule` 从 `app.module.ts` 的 `imports` 里删掉，
 * 这条用例必须变红。（已用变异取证，见 task-2-report.md「修复轮 2」。）
 *
 * 为什么非要这一条：上面那句 `expect(() => envSchema.parse({})).toThrow()` 只证明
 * **schema 自己**会拒绝空配置，与「进程是否真的因此起不来」无关——把接线删掉、
 * 等于关掉整个 C10 fail-fast，那条断言照旧通过。这正是本文件此前「看着有守卫、
 * 实际没守卫」的原因：它断言的是**另一个门**保证的性质。
 *
 * 机制（prior 报告 F4.1 已经踩过这个坑）：`@nestjs/config` 的 `forRoot` 是
 * `static async`，在**模块求值期**被调用并立刻返回 promise；校验失败时该 promise
 * reject，而 `import()` 本身**成功**。所以 `try { await import() } catch` 抓不到它，
 * 只能监听 `unhandledRejection`。真实引导下它就是让进程起不来，本用例是这件事
 * 在测试进程里的等价物。
 */
describe('引导期 fail-fast 接线（app.module → ConfigModule → validate）', () => {
  /** env schema 的全部必填字段：缺任意一个都必须让进程拒绝启动。 */
  const REQUIRED_KEYS = [
    'DATABASE_URL',
    'REDIS_URL',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_CALLBACK_URL',
    'SMTP_URL',
    'MAIL_FROM',
    // P1 / Task 1：制品卷与上传上限都是必填（无默认值），缺一个也不许启动。
    'ARTIFACT_STORE_DIR',
    'ARTIFACT_MAX_UPLOAD_BYTES',
    // P1 / Task 2：制品密钥环与写入 keyId 同样必填（D5：缺当前写入键 ⇒ 拒绝）。
    // `MASTER_ENCRYPTION_KEY` 与 `ARTIFACT_MASTER_KEY` **已删除**（修复轮 1 的 R6/R5）：
    // 前者必填却全仓无读取方，后者被 `ARTIFACT_KEYS` 取代。留在这里会让本用例在
    // 「app.module 求值期报错」那一步就失败——因为删一个不存在的变量之后，
    // 环境里仍然缺 `ARTIFACT_KEYS`，而下面那条断言要求报错点名 `ARTIFACT_KEYS`。
    'ARTIFACT_KEYS',
    'ARTIFACT_ACTIVE_KEY_ID',
    // P1 / Task 8：下载票据的 HMAC 密钥（D10）。它必填、无默认值 ⇒ 缺它同样不许启动。
    'DOWNLOAD_URL_SECRET',
  ] as const;

  /**
   * ★ **显式 `testTimeout`（P3 / Task 7；控制器裁定）—— 这是一个**测试预算**，不是断言被放宽。
   *
   * ## 为什么必须显式给（实测数字，两个会话各测一次）
   *
   * 这条用例会 `vi.resetModules()` 之后 `await import('@vca/api/app.module.js')`，
   * 也就是把**整棵应用模块图**重新求值一遍（含 `ConfigModule.forRoot()` 的校验）。
   * 它是这个文件里唯一一条**秒级**的用例，其余七条都是 0–3 ms。
   *
   * | 场景 | 实测 |
   * |---|---|
   * | 单独跑（Task 6 于 BASE `65d06a6`） | 1654 ms |
   * | 单独跑（Task 6 加上它的接线之后） | 1834 ms |
   * | **单独跑（Task 7 于 BASE `595a01f`，本机）** | **1950 ms** |
   * | 全量 `pnpm test`（5 个 project + 一堆 testcontainers 同时跑） | 1628 ms 通过 / **> 5000 ms 超时** |
   *
   * `unit` 这个 project **没有**自己的 `testTimeout`（`vitest.config.ts` 只给
   * integration / security / property / architecture 显式配过），因此它吃的是
   * vitest 的 **5 s 默认值** —— 而这条用例在满载时**离那条线只有几百毫秒**，
   * 并且**已经真的红过一次**（Task 6 的第 1 次全量跑）。
   *
   * ## 为什么这是「预算」而不是「放松断言」
   *
   * 一个**通过与否取决于机器有多忙**的用例不是见证：它绿的时候不代表任何东西成立，
   * 红的时候也不代表任何东西被破坏。这正是本仓库为 `architecture` project 已经用过一次的
   * 论证（`vitest.config.ts` 那条注释逐字：「默认值在这里量错了对象：它测的是机器有多忙，
   * 不是架构有没有被破坏」），也是 P1 的 `signed-download` flake 的同一类
   * （两个时钟采样之间隔一次 HTTP 往返、余量只有 1 s ⇒ 每次运行约 3.5% 跨秒红）。
   *
   * ⇒ **本用例断言的东西一个字都没改**（下面每一句 `expect` 与它此前的语义逐字相同）：
   * 改的只是「允许多久跑完」。给 60 s：实测最坏 ~1.95 s（单独）/ >5 s（满载），
   * 余量 ≥ 12 倍；而一个**真的**卡死的实现仍然会在 60 s 内被抓住。
   */
  it(
    '必填密钥全部缺失时，求值 app.module 会拒绝启动',
    async () => {
    const savedEnv = new Map(REQUIRED_KEYS.map((key) => [key, process.env[key]]));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };

    // `NODE_ENV` 在 vitest 下是 'test'，故 `ignoreEnvFile` 为真：本机 `.env`
    // 救不了这条用例（ruling (b)），它只可能因接线本身而失败。
    for (const key of REQUIRED_KEYS) delete process.env[key];
    // 监听器有两个作用：捕获这次刻意的拒绝；同时让 Vitest 的 unhandledRejection
    // 上报提前返回（其判据是「该事件已有第二个监听器 ⇒ 视为用户自行处理」）。
    process.on('unhandledRejection', onRejection);
    try {
      vi.resetModules();
      await import('@vca/api/app.module.js');
      // 等一个宏任务，让 Node 派发 unhandledRejection（它在微任务队列排空后触发）。
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      // 必须在 finally 里还原：断言失败也不能把删掉的变量留给同进程的其他用例。
      process.off('unhandledRejection', onRejection);
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    }

    expect(
      rejections,
      'app.module 求值期没有拒绝启动：C10 fail-fast 未接线（ConfigModule 是否还在 app.module.ts 的 imports 里？）',
    ).toHaveLength(1);
    const [reason] = rejections;
    expect(reason).toBeInstanceOf(Error);
    const message = reason instanceof Error ? reason.message : String(reason);
    expect(message).toContain('环境变量校验失败，服务拒绝启动');
    for (const key of ['ARTIFACT_KEYS', 'ARTIFACT_ACTIVE_KEY_ID', 'GITHUB_CLIENT_SECRET']) {
      expect(message).toContain(key);
    }
    },
    // ↑ 显式预算（60 s），理由与实测数字见这个 `it` 上方那段注释。
    //   **它是本文件唯一的秒级用例**：其余七条吃默认值（5 s）绰绰有余。
    60_000,
  );
});
