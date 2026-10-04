import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { INestApplication, NestMiddleware } from '@nestjs/common';
import { AppModule } from '@vca/api';
import { PolicyGuard, type PolicyCondition } from '@vca/api/common/policy/policy.guard.js';

/**
 * Express 的三个中间件参数（`req` / `res` / `next`）的**类型**，从 Nest 自己的签名里取。
 *
 * 为什么绕这一下：`@types/express` **没有**声明在 `tests/package.json` 里（`superagent`/`supertest`
 * 通过类型传递用到它，但直接 `import type { Request } from 'express'` 在 `tests` 这个包下
 * 解析不到——`tsc -p tests` 会报 TS2307）。为一个测试文件新增一条运行时依赖之外的
 * `@types` 依赖（并改 lockfile）不值得，而 Nest 的 `NestMiddleware['use']` 就是这三个参数，
 * 从它派生既不需要新增依赖，也不会与 express 的版本漂移。
 */
export type ExpressRequest = Parameters<NestMiddleware['use']>[0];
export type ExpressResponse = Parameters<NestMiddleware['use']>[1];
export type ExpressNext = Parameters<NestMiddleware['use']>[2];

/**
 * 与 `apps/api/src/main.ts` 保持一致的引导顺序。
 *
 * ## 为什么这里也要 `cookieParser()`
 *
 * `/auth/**` 的处理器与 `SessionMiddleware` 都读 `req.cookies`，而它由 cookie-parser
 * 填充。少了这一步，测试里「登录成功」后面的每一次请求都会被判成匿名——
 * 于是集成测试会**以通过的形式**骗人（403 断言全绿，200 断言全红），
 * 而生产是好的。测试助手必须复现真实的中间件栈，否则测的不是同一个应用。
 *
 * 顺序也与生产一致：`app.use` 注册在 express 实例上，先于 `app.init()` 建立的
 * Nest 中间件链执行，因此 cookie-parser 在 `TraceMiddleware`/`SessionMiddleware` 之前。
 *
 * ## 为什么暴露 `builder` 给调用方改（`overrides`）
 *
 * `overrideProvider(X).useValue(...)` **不**修改模块的静态元数据，而是记进
 * `TestingModuleBuilder` 内部的 `_overrides`，在 `compile()` 时按查询键替换。
 * 因此想「改一个 provider 再编译一个新应用」时，**必须**在 `compile()` 之前拿到 builder；
 * 对已编译过的模块再 `overrideProvider` 会抛
 * `Cannot override providers on an already compiled module`。
 *
 * 这不是提前抽象，而是为了让调用方能做**确定性**的故障注入：
 * `tests/unit/auth/session-middleware.test.ts` 用它把 `SessionService` 换成
 * 「`verify` 直接抛 `TypeError`」的坏依赖，验证会话中间件在「依赖写坏」时的可观测降级。
 *
 * ## 为什么这不是「第二套引导路径」
 *
 * 测试与生产**只在两处**不同：测试不调 `listen()`，且不读 `.env`（由 `tests/helpers/env.ts`
 * 夹具提供）。`AppModule`、中间件接线与顺序、全局守卫全部共用同一个模块，
 * 因此这里刻意**不**复刻一份接线，免得「测试接线是否正确」变成「抄件是否正确」。
 */
export interface CreateTestAppOptions {
  /**
   * 覆盖 provider（`PrismaService` / `REDIS` / …）。
   *
   * `TestingModuleBuilder.overrideProvider` 是**两步**签名（`(token) => OverrideBy`，
   * `.useValue(v)` 才返回 builder），所以这里直接借用它的类型。
   */
  overrides?: readonly ((builder: TestingModuleBuilder) => TestingModuleBuilder)[];
  /** 是否挂 `cookieParser()`（默认 `true`，与 `main.ts` 一致）。 */
  withCookieParser?: boolean;
  /**
   * `PolicyGuard` 的命名条件，在 `init()` 之前注册。
   *
   * 必须作用在**注入进来的那个守卫实例**上（`useExisting` 接线）——它才是拦截请求的那个，
   * 理由见 `app.module.ts`。未注册的条件一律拒绝（fail-closed），因此漏注册的表现是
   * 「本模块路由全部 403」。
   */
  conditions?: ReadonlyArray<{ name: string; fn: PolicyCondition }>;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const apply of options.overrides ?? []) builder = apply(builder);

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  if (options.withCookieParser !== false) app.use(cookieParser());
  for (const { name, fn } of options.conditions ?? []) {
    app.get(PolicyGuard).registerCondition(name, fn);
  }
  await app.init();
  return app;
}
