import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';
import pino from 'pino';
import { AppModule } from './app.module.js';
import { buildLoggerOptions } from './common/logging/logger.module.js';
import { applySecurityMiddleware } from './common/security/security-stack.js';

/**
 * 引导层（**不在 brief 的 Step 5 里，是 Ruling 3 要求的补齐**）。
 *
 * ## 为什么从 `main.ts` 拆出来
 *
 * Ruling 3 要求「引导失败必须经应用 logger 记录 + 以非零码退出」，而 `main.ts` 是
 * 一个**带副作用的模块**（顶层就 `void runBootstrap()`），测试一旦 `import` 它就会真的
 * 去连库、去监听端口。把可测的部分放进本文件后：
 *
 * - `main.ts` 只剩一行入口（与生产逐字一致的那一行）；
 * - `bootstrap` / `runBootstrap` / `configureApp` 都能被 `tests/unit/bootstrap.test.ts`
 *   直接调用，失败路径是**可重复的单元**而不是一次性的进程探针
 *   （本仓库此前多次因为「只能靠进程探针取证」而留下没有常驻回归的接线）。
 *
 * ## 为什么这里自己造一个 pino（而不是复用应用里那个）
 *
 * 引导期**最早的失败**发生在 `NestFactory.create` 里（环境变量校验不过、某个 provider
 * 构造抛错）——那时**根本没有应用**，也就取不到 `app.get(Logger)`。
 * 因此引导期日志器在模块求值期就建好，并且与 `AppLoggerModule` 共用**同一份**
 * `buildLoggerOptions`：字段、脱敏规则（C11）、trace mixin 只有一处定义，
 * 不存在「引导日志和应用日志长得不一样」这种第二套语义。
 */

/** 引导失败时真正用到的面（结构化类型：测试不必造一个真 pino 就能断言）。 */
export interface BootstrapLogger {
  error(obj: unknown, msg?: string): void;
  /**
   * 把已排队的日志刷到 fd 上（修复轮 2）。
   *
   * **为什么它是接口的一部分而不是可选**：因为退出路径要 `process.exit(1)`（见
   * `runBootstrap`），而它**不会**等任何未完成的写入。生产那份
   * `bootstrapLogger` 用显式 destination 构造（`pino.destination({ dest: 1 })`），
   * 这里的 `flush()` 就是它的 `flushSync()`——同步写，返回后字节已经在 fd 里。
   * 写成可选会让「忘了刷」在类型上合法，而它的失效形态恰好是「进程以 1 退出、
   * 但日志里什么都没有」，也就是这次修复本身要消灭的那种静默失败。
   */
  flush(): void;
}

/** 引导期日志的目的地（显式持有，才能在上面 `flushSync()`）。 */
const bootstrapLogDestination = pino.destination({ dest: 1 });

/**
 * 与 `AppLoggerModule` 同一份配置的引导期日志器（见文件头）。
 *
 * `pino(BUILD_LOGGER_OPTIONS, DESTINATION)`：选项照旧来自那唯一一处构造器，
 * destination 只是为了让退出路径能同步刷盘（见 `BootstrapLogger.flush`）。
 * 与 `AppLoggerModule` **不共用** destination：那是应用内的日志器（由 nestjs-pino 建），
 * 引导期的失败发生在应用存在之前，两者本来就是两条独立的写入链。
 */
const pinoInstance = pino(buildLoggerOptions(process.env), bootstrapLogDestination);

export const bootstrapLogger: BootstrapLogger = {
  error: (obj, msg) => pinoInstance.error(obj, msg),
  // SonicBoom 的同步刷（`sonic-boom/types/index.d.ts` 第 52 行 `flushSync()`），
  // 实现在 `flushSync` 分支里直接 `fs.writeSync`：返回后字节已经进了 fd，
  // `process.exit()` 截断不了它。
  flush: () => bootstrapLogDestination.flushSync(),
};

/** 应用工厂：默认是真引导；测试可注入一个必然失败的工厂来覆盖失败路径。 */
export type AppFactory = () => Promise<INestApplication>;

const defaultAppFactory: AppFactory = () => NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

/**
 * 引导失败后等待关停的上限（毫秒）。
 *
 * 2 秒是刻意的量级选择：正常关停（disconnect + 连接池收尾）是毫秒级的，
 * 而一个**挂住**的关停流程必须迅速让位给 `process.exit(1)`——
 * 引导已经失败了，这里多等一秒都只是在延长「容器看起来还活着」的窗口。
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * `runBootstrap` 的可注入面（**全部**有生产默认值；测试只需覆盖关心的那几个）。
 *
 * 为什么收成一个对象而不是继续加位置参数：失败路径上要注入的东西从 1 个变成了 4 个
 * （工厂、logger、退出函数、关停上限），位置参数会让调用点变成一串 `undefined`，
 * 而「第 3 个参数是退出函数」这种信息在调用点看不出来。
 */
export interface RunBootstrapOptions {
  createApp?: AppFactory;
  logger?: BootstrapLogger;
  /**
   * 进程退出函数，默认 `process.exit`。
   *
   * **为什么它是可注入的**：单测里真调 `process.exit(1)` 会杀掉 vitest 的 worker
   * （整条套件以 1 结束），于是「失败路径」在单元层面变得不可断言。
   * 注入之后单测可以断言「确实请求了以 1 退出」，而**真的会终止**这件事
   * 由子进程用例观测（`tests/unit/bootstrap.test.ts` 的第三条：真进程、真端口占用、
   * 断言它自己退出且码非零）——两条合起来才覆盖「请求退出」与「真的退出」。
   */
  exit?: (code: number) => void;
  /** 关停等待上限，默认 {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}。 */
  shutdownTimeoutMs?: number;
}

/**
 * 应用级接线（生产引导与探针都用它；**不含** `listen`）。
 *
 * 顺序与理由：
 *
 * 1. **`app.useLogger(app.get(PinoLogger))`** —— Nest 的框架 logger（`PolicyGuard` 的
 *    默认拒绝告警、启动日志、异常处理器）改走 pino。**Ruling 3**：`app.module.ts` 里
 *    「业务代码（含 Nest logger）在请求内打的日志全部带 traceId」这句话此前是**假的**
 *    （全仓没有一处调用 `useLogger`，Nest 的 `ConsoleLogger` 直接写 stdout、绕过 pino），
 *    这句话由这一行变真，而不是被删掉——删掉它等于把一个真实的可观测性缺口藏起来。
 *
 *    **必须放在 `listen()` 之前，但机制不是「一设好就 flush」（修复轮 2 更正）**：
 *    上一版注释声称「`useLogger` 一设好就 flush 进 pino」——那是错的说法。读
 *    `@nestjs/core@12.1.2` 的源码：`useLogger` 只在 `shouldFlushLogsOnOverride` 为真时
 *    才调 `flushLogs()`（`nest-application-context.js` 第 157–162 行），而那个标志**只**由
 *    `flushLogsOnOverride()` 打开，全仓只有 `NestFactory.createApplicationContext`
 *    一处调用它（`nest-factory.js` 第 81 行）。**HTTP 应用走的是另一条**：
 *    `listen()` → `init()`，由 `init()` 末尾的
 *    `if (this.appOptions?.autoFlushLogs ?? true) this.flushLogs()`
 *    （`nest-application.js` 第 130–135 行，注释写着「否则只有 serverless/e2e 那种
 *    从不 `listen()` 的应用会把日志永远缓着」）把那批**缓冲起来的启动日志**冲出去。
 *
 *    于是**顺序要求的真正理由**是：`bufferLogs: true` 把启动日志缓在
 *    `Logger` 的静态缓冲区里，而缓冲区是在 `init()` 里被**当时那个 logger** 冲掉的。
 *    `useLogger` 晚于 `listen()` ⇒ 启动期那批日志（含路由映射）由默认的
 *    `ConsoleLogger` 写出去，绕过 pino——正是这一行要消灭的那种不一致。
 *    行为不变（仍在 `listen()` 之前），改的只是解释。
 * 2. **`applySecurityMiddleware`** —— 与测试**同一个函数**（Ruling 4），
 *    因此「安全头/CSRF 只读 cookie」这件事在两边不可能漂移。
 * 3. **`trust proxy = 1`** —— Nginx 反代后 `req.ip` 才是真实客户端 IP。
 *    不设它时 express 把 Nginx 的地址当客户端，于是**所有用户共用一个限流桶**：
 *    登录层（5 次/15 分钟）会变成全站共享配额，属自伤级故障（详见报告 §trust proxy）。
 *    代价（如实记录）：`X-Forwarded-For` 变成**可伪造**的——只有当应用**只**能从
 *    受信反代进来时 `1`（信任一跳）才是正确取值；直连暴露的部署必须把它调成
 *    `false`/具体网段，否则攻击者可以用 XFF 伪造 IP 绕过 IP 维度的限流。
 * 4. **`enableShutdownHooks`** —— SIGTERM 时关连接（Redis/Prisma）再退出。
 */
export function configureApp(app: INestApplication, options: { isProduction: boolean }): void {
  app.useLogger(app.get(PinoLogger));
  applySecurityMiddleware(app, options);
  // `set()` 只存在于 `NestExpressApplication` 的类型面上（Nest 12 的 `INestApplication`
  // 没有它，只有 use/enableCors/useSecurityHeaders/enableCsrfProtection/…）。
  // 运行期对象一定是 express 应用：`NestFactory.create` 与 `createNestApplication`
  // 在 Express 适配器下产出的就是它。这一处类型逃逸是**刻意**的，且只有一处。
  (app as NestExpressApplication).set('trust proxy', 1);
  app.enableShutdownHooks();
}

/**
 * 建立应用 → 接线 → 监听。返回应用实例（测试需要它来 `close()`；`main.ts` 不关心）。
 *
 * ## `onReady` 是**承重**的（修复轮 2 实测踩到，不是预留接缝）
 *
 * 失败路径必须能拿到**已经建好的那个应用**才能 `close()` 它——而 `listen()` 失败时
 * 本函数的返回值**根本不会产生**（异常先走）。上一版正是这么写的：
 * `app = await bootstrap(createApp)`，于是 `listen()` 抛错时 `app` 仍是 `undefined`，
 * `closeQuietly` 第一步 `if (!app) return` 直接返回，**`close()` 一次都没被调用**
 * （实测：探针打出 `listen → logger.error → exit 1`，中间没有 `close`；
 * 而把 `app` 换成注入的形状就能看到 `close`——说明问题在「拿不到句柄」，不在关停逻辑）。
 *
 * 因此这里在**最后一次可能失败的操作之前**把句柄交出去——修复轮 3 起这个「之前」被推到
 * 了 `configureApp` **之前**（见 `bootstrap` 里的说明：接线自己也会抛）。用一个显式的回调参数，
 * 而不是把这三步在 `runBootstrap` 里重抄一遍：抄一遍等于「引导顺序」有两份定义，
 * 而顺序正是 Task 6/Task 7 反复吃过亏的地方（见 `app.module.ts` 的中间件顺序记载）。
 */
export async function bootstrap(
  createApp: AppFactory = defaultAppFactory,
  onReady?: (app: INestApplication) => void,
): Promise<INestApplication> {
  const app = await createApp();
  // **句柄在接线之前就交出去**（修复轮 3 从 `configureApp` 之后移上来的）：
  // `configureApp` 自己也会抛（`app.get(PinoLogger)` 取不到、安全栈安装失败、
  // `set('trust proxy')` 在非 express 适配器上不好使……），而那时 `bootstrap()` 的返回值
  // 同样不会产生——`onReady` 若排在它后面，失败路径上 `closeQuietly` 又会拿到 `undefined`，
  // 「关掉已经建好的应用」这件事**一次都不会发生**（与修复轮 2 修掉的那个
  // 「`listen()` 失败时拿不到句柄」是同一个形状，只是触发点更早）。
  // 代价为零：`close()` 在 `configureApp` 失败时本来就该跑（连接已经建了）。
  onReady?.(app);
  configureApp(app, { isProduction: process.env.NODE_ENV === 'production' });
  await app.listen(Number(process.env.PORT ?? 3000));
  return app;
}

/**
 * 关掉一个可能根本没建起来的应用：**有界、且自身失败不改变方向**。
 *
 * 三种情况都要继续往「以非零码退出」走，因此这里从不 rethrow：
 * 没有应用（`NestFactory.create` 就失败了）、关停抛错、关停超时。
 * 后两种各记一行——它们是**独立于引导失败**的另一个事实，
 * 只留在同一个「引导失败」行里会让运维少看到一件事。
 */
async function closeQuietly(
  app: INestApplication | undefined,
  logger: BootstrapLogger,
  timeoutMs: number,
): Promise<void> {
  if (!app) return;

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const outcome = await Promise.race([app.close().then(() => 'closed' as const), timedOut]);
    if (outcome === 'timeout') {
      logger.error({ app: 'bootstrap' }, `应用关停超过 ${timeoutMs}ms，不再等待，直接退出`);
      logger.flush();
    }
  } catch (error: unknown) {
    logger.error({ err: error }, '应用关停失败（引导本身已失败），继续以退出码 1 结束');
    logger.flush();
  } finally {
    // 不清掉的话这个定时器会在退出路径上多活 `timeoutMs` 毫秒；
    // 虽然紧接着就 `process.exit()` 了，但关停成功的那条路径不该留下一个待触发的定时器。
    if (timer) clearTimeout(timer);
  }
}

/**
 * 引导入口：失败**绝不静默，也绝不挂住**。
 *
 * 三条要求各自对应一种失效形态（少任何一条都会漏掉一类事故）：
 *
 * - **经应用 logger 记原始错误**：`{ err: error }` 让 pino 的序列化器输出
 *   `name`/`message`/`stack`。只记一句「引导失败」等于把栈扔掉——那正是
 *   「吞掉原始错误」的定义；
 * - **真的以非零码退出**：不改退出码时，编排系统/CI/`&&` 链条会把一次失败的引导
 *   当成成功（旧代码就是如此：`void bootstrap()` 没有 `.catch`，未处理拒绝打印完照旧退出 0）；
 * - **不 rethrow**：顶层调用点是 `void runBootstrap()`，rethrow 只会变成一次**未处理拒绝**，
 *   于是同一个错误被打印两遍（一遍结构化、一遍 Node 默认格式），而结构化那份反而是多余的。
 *   错误本身没有被丢：它已经被完整记进日志，且进程以非零码结束。
 *
 * ## 修复轮 2：为什么必须是 `process.exit(1)`，而不是 `process.exitCode = 1`
 *
 * 上一版只设 `process.exitCode = 1` 就返回了。但 `NestFactory.create` **已经构造了
 * `RedisModule` 的 provider**（`new Redis(url)`），而 ioredis 在构造时就建连并持有
 * **活跃的 socket 句柄**（`db/redis.module.ts` 的文件头注释记载的正是这件事：
 * 「Node 的事件循环只要还有活跃句柄就不会自己退出」）。
 *
 * 于是在**主失效模式**——`listen()` 失败（端口被占：应用已经建好，只是没能监听）——
 * 旧实现只写一行日志、把退出码标志置上，然后进程**永远停在那里**：编排系统看到的是一个
 * **健康存活**的容器，而不是一次崩溃。这正是 Ruling 3 要防的形态，所以
 * 「以非零码退出」在真正要紧的那条路径上**没有交付**。
 *
 * 实测（子进程跑 `apps/api/dist/main.js`，端口先被父进程占住）：
 * 旧实现 15 秒后仍然活着（只有 SIGKILL 能收），修复后 1 秒内以码 1 退出。
 *
 * ## 为什么先 `close()` 再 `exit()`（两件事都做，而不是二选一）
 *
 * 两者解决的是**不同**的问题，缺任何一个都会留下一个洞：
 *
 * 1. **`await app.close()`（有界 2 秒）** —— 走 Nest 的关停流程，
 *    `RedisLifecycle.onApplicationShutdown` 会 `disconnect()` 那个 socket、
 *    Prisma 的 `onModuleDestroy` 会断开连接池。少了它，即使进程最终退出，
 *    一次失败的引导也会在退出前把连接晾在那里（而且 `listen` 成功之后才失败的那些路径
 *    ——比如后续接线抛错——更需要它）。
 *    它**不能**作为唯一手段：`close()` 本身可能挂住或抛错（Redis 从没连上、
 *    关停钩子里有别的模块），而那时进程照样会挂着——正是本修复要消灭的形态。
 * 2. **`process.exit(1)`** —— 保证终止，与事件循环里还剩什么句柄**无关**。
 *    它**不能**作为唯一手段：那会把连接直接晾掉（见上一条）。
 *
 * `close()` 用 `Promise.race` 限时，超时就记一行「关停超时」继续退出：
 * 一个挂住的关停流程不该把一个必然失败的引导变回「永远活着」。
 * 关停自身的失败也**单独记一行**——否则「Redis 没能断开」这件事只表现为
 * 一次正常的失败引导，而那是两条不同的故障。
 */
export async function runBootstrap(options: RunBootstrapOptions = {}): Promise<void> {
  const {
    createApp = defaultAppFactory,
    logger = bootstrapLogger,
    exit = process.exit,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = options;

  let app: INestApplication | undefined;
  try {
    // 句柄经 `onReady` 在 `listen()` **之前**取到：`listen()` 失败时
    // `bootstrap()` 的返回值根本不会产生（见 `bootstrap` 的说明），
    // 没有这一步 `closeQuietly` 会拿到 `undefined` 并直接返回——实测踩到过。
    app = await bootstrap(createApp, (created) => {
      app = created;
    });
  } catch (error: unknown) {
    logger.error({ err: error }, '应用引导失败，进程以退出码 1 结束');
    // 先把已排队的日志同步写出去，再让下面的 `exit(1)` 终结进程：
    // `exit()` 不等任何未完成的写入，不刷的话这一行可能只存在于缓冲区里。
    logger.flush();
    await closeQuietly(app, logger, shutdownTimeoutMs);
    exit(1);
  }
}
