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
}

/** 与 `AppLoggerModule` 同一份配置的引导期日志器（见文件头）。 */
export const bootstrapLogger: BootstrapLogger = pino(buildLoggerOptions(process.env));

/** 应用工厂：默认是真引导；测试可注入一个必然失败的工厂来覆盖失败路径。 */
export type AppFactory = () => Promise<INestApplication>;

const defaultAppFactory: AppFactory = () => NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

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
 *    必须放在 `listen()` 之前：`bufferLogs: true` 会把 Nest 启动期（含路由映射）的日志
 *    缓冲起来，`useLogger` 一设好就 flush 进 pino；晚了那批日志会走 ConsoleLogger。
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
 */
export async function bootstrap(createApp: AppFactory = defaultAppFactory): Promise<INestApplication> {
  const app = await createApp();
  configureApp(app, { isProduction: process.env.NODE_ENV === 'production' });
  await app.listen(Number(process.env.PORT ?? 3000));
  return app;
}

/**
 * 引导入口：失败**绝不静默**。
 *
 * 三条要求各自对应一种失效形态（少任何一条都会漏掉一类事故）：
 *
 * - **经应用 logger 记原始错误**：`{ err: error }` 让 pino 的序列化器输出
 *   `name`/`message`/`stack`。只记一句「引导失败」等于把栈扔掉——那正是
 *   「吞掉原始错误」的定义；
 * - **`process.exitCode = 1`**：不改退出码时，编排系统/CI/`&&` 链条会把一次失败的引导
 *   当成成功（旧代码就是如此：`void bootstrap()` 没有 `.catch`，未处理拒绝打印完照旧退出 0）；
 * - **不 rethrow**：顶层调用点是 `void runBootstrap()`，rethrow 只会变成一次**未处理拒绝**，
 *   于是同一个错误被打印两遍（一遍结构化、一遍 Node 默认格式），而结构化那份反而是多余的。
 *   错误本身没有被丢：它已经被完整记进日志，且进程以非零码结束。
 */
export async function runBootstrap(
  createApp: AppFactory = defaultAppFactory,
  logger: BootstrapLogger = bootstrapLogger,
): Promise<void> {
  try {
    await bootstrap(createApp);
  } catch (error: unknown) {
    logger.error({ err: error }, '应用引导失败，进程以退出码 1 结束');
    process.exitCode = 1;
  }
}
