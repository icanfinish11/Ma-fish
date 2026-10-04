import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { AppLoggerModule } from './common/logging/logger.module.js';
import { TraceMiddleware } from './common/logging/trace.middleware.js';
import { PolicyGuard } from './common/policy/policy.guard.js';
import { PolicyModule } from './common/policy/policy.module.js';
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
  imports: [ConfigModule, AppLoggerModule, DbModule, PolicyModule, HealthModule],
  providers: [{ provide: APP_GUARD, useExisting: PolicyGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
