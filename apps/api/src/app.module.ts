import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { RedisModule } from './db/redis.module.js';
import { AppLoggerModule } from './common/logging/logger.module.js';
import { TraceMiddleware } from './common/logging/trace.middleware.js';
import { PolicyGuard } from './common/policy/policy.guard.js';
import { PolicyModule } from './common/policy/policy.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { SessionMiddleware } from './modules/auth/session.middleware.js';
import { HealthModule } from './modules/health/health.module.js';

/**
 * 根模块。
 *
 * `TraceMiddleware` 在此注册（`NestModule.configure`），**不**在 `AppLoggerModule` 里——
 * 日志模块只负责「怎么写日志」，请求身份的建立属于请求管线。
 *
 * ## 它与 pino 中间件的相对顺序（实测结论，勿凭直觉推断）
 *
 * 实测：nestjs-pino 的 pino-http 中间件**总是**排得更外层，把 `TraceMiddleware` 改由
 * `HealthModule` 注册（更晚被扫描）也不改变这一点。判断方法是在 pino 配置里临时加
 * `customReceivedMessage`：那条「request received」由 pino 中间件体**同步**写出
 * （`pino-http/logger.js` 里 `next()` 之前），它**没有** `traceId`，反证此刻 ALS 里还没有上下文。
 *
 * 那为什么「request completed」这一行**有** `traceId`？因为它在 `res` 的 `finish` 事件里写，
 * 而该事件（同步于 `res.end()` 或其后的 tick）都发生在 `TraceMiddleware` 的 ALS 作用域内
 * ——处理器本身就跑在这个作用域里。结论：
 *
 * - 业务代码（含 Nest logger）在请求内打的日志**全部**带 `traceId`；
 * - 唯一不带的是 pino 中间件体内部那一类「入口行」，而当前配置**不产生**这种行
 *   （默认只有完成行）。
 *
 * 因此注册顺序在当下不是承重的；这里仍按「身份先于日志」的语义把它放在根模块。
 *
 * ## 顺序从 Task 6 起**是**承重的（对请求上下文而言）
 *
 * `SessionMiddleware` 会往 ALS 上下文里补 `userId`/`sessionId`，而它**继承**既有上下文
 * （`{ ...currentContext(), userId, sessionId }` 而不是替换）。这要求外层已经有一个含
 * `traceId` 的上下文——也就是 `TraceMiddleware` 必须**先**跑。
 *
 * 两条中间件都在**本文件的 `configure`** 里注册，顺序即书写顺序，理由（**实测**得出，
 * 不是从直觉推的）见 `configure` 内的注释：`MiddlewareModule` 按 `moduleRef.distance`
 * 排序，全局模块（`distance === Number.MAX_VALUE`）被显式排到最前，因此把
 * `SessionMiddleware` 写进当时还是 `@Global()` 的 `AuthModule.configure` 会让它跑到
 * `TraceMiddleware` **之前**，把 trace id 丢掉。
 *
 * 顺序由 `tests/integration/auth/auth-pipeline.test.ts` 的用例钉住：发一个带
 * `x-trace-id` 的请求，断言处理器读到的上下文里那个 id **原样存在**——顺序写反时
 * 它是 `undefined`，用例立刻红。（对照上一节：pino 中间件那种「谁在外层」的问题
 * 当年只能靠临时探针取证，这里有一条常驻回归。）
 *
 * ## 全局守卫的顺序（Task 7 起承重，先记在这里）
 *
 * `APP_GUARD` 的**数组顺序**就是执行顺序，因此未来的 `CsrfGuard` 必须排在 `PolicyGuard`
 * **之前**（计划 Task 7 原文：`[{ provide: APP_GUARD, useClass: CsrfGuard },
 * { provide: APP_GUARD, useExisting: PolicyGuard }]`）：CSRF 是「请求是否可信」，
 * 授权是「这个身份能不能」，前者更便宜也更靠前，且不该让一次跨站请求走到条件判定里。
 *
 * ## 为什么是 `useExisting` 而不是 `useClass`
 *
 * `PolicyGuard` 由 `@Global()` 的 `PolicyModule` 提供并导出，本处只是**指向同一个实例**。
 * 若写成 `useClass`，Nest 会为 `APP_GUARD` 另造一个守卫实例，而各业务模块注入到的仍是
 * `PolicyModule` 那一个——它们 `registerCondition` 注册的条件就永远到不了真正拦截请求的守卫上，
 * 表现为「条件全部未注册 ⇒ 相关路由全部 403」。该不变量由
 * `tests/security/policy-default-deny.test.ts` 的「同一实例」用例钉住。
 */
@Module({
  imports: [
    ConfigModule,
    AppLoggerModule,
    DbModule,
    RedisModule,
    PolicyModule,
    AuditModule,
    AuthModule,
    HealthModule,
  ],
  providers: [
    // `SessionMiddleware` 必须在这里声明为提供者：Nest 在**注册中间件的那个模块**里解析
    // 它的依赖（`loadMiddleware` 传的是该模块的中间件集合，见 auth.module.ts 的说明）。
    // `SessionService` 来自本模块 `imports` 里的 `AuthModule` 的 `exports`，这条边是**承重**的：
    // 删掉 `AuthModule` 的 import 或它的 export，启动期就会抛
    // `Nest can't resolve dependencies of the SessionMiddleware`。
    // （`AuthModule` 已**不再**是 `@Global()`：实测移除后全绿，见 auth.module.ts。）
    SessionMiddleware,
    { provide: APP_GUARD, useExisting: PolicyGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 顺序即语义，且这里是**唯一**能看到两者相对顺序的地方：
    // 1. `TraceMiddleware` 建立含 traceId 的 ALS 上下文；
    // 2. `SessionMiddleware` 在该上下文里补 userId/sessionId（继承而非替换）。
    //
    // 为什么 `SessionMiddleware` 不写在 `AuthModule.configure` 里（直觉写法）：
    // 中间件的执行顺序由 `MiddlewareModule` 按 `moduleRef.distance`（距根模块的图深度）
    // 排序决定——根模块排第一、子模块排其后，而**全局模块被显式排到最前**
    // （`middleware-module.js` 第 82–97 行；distance 的算法见 `scanner.js` 第 219–224 行，
    // 全局模块在计算时被跳过、恒为 `Number.MAX_VALUE`）。
    // 写进子模块时顺序就**脱离了本文件的控制**：子模块里它排在 `TraceMiddleware` 之后
    // （恰好是想要的顺序），但那个子模块一旦被标 `@Global()`——本案就发生过一次——
    // 它会翻到 `TraceMiddleware` **之前**，`SessionMiddleware` 于是在没有 traceId 的上下文里
    // `run()` 自己的上下文，trace id 被整个丢掉（Task 4 验收 13.4 静默失效）。
    // 写在这里则没有这层条件依赖：根模块 `distance === 0` 排第一，两条中间件的相对顺序
    // 就是**书写顺序**，顺序语义也留在能看到全局顺序的同一个文件里。
    consumer.apply(TraceMiddleware).forRoutes('*');
    consumer.apply(SessionMiddleware).forRoutes('*');
  }
}
