import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { AuditModule } from '../audit/audit.module.js';
import { RedisModule } from '../../db/redis.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GithubOauthService } from './github-oauth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/**
 * 认证模块（Ruling 2：brief 的 Files 列表漏了本文件，其代码块又要求它存在）。
 *
 * ## 为什么 `@Global()`，以及它是**被实测逼出来的**而不是顺手加的
 *
 * `SessionMiddleware` 由 `AppModule.configure` 注册（见下「顺序」一节），而
 * `forRoutes('*')` 会让 Nest 把它当作**根模块**的中间件提供者去**静态**解析依赖
 * （`MiddlewareContainer` → `Injector.lookupComponentInParentModules`，从根模块向上找）。
 * 根模块的注入器**看不见子模块的 providers**——即使 `AuthModule` 把 `SessionService`
 * 导出也看不见（导出只影响「谁可以 import 我」的解析，不影响这条向上查找的路径）。
 *
 * 实测症状（**不是**猜测）：应用**根本起不来**，`Test.createTestingModule` 抛
 * `Nest can't resolve dependencies of the SessionMiddleware (?)`。
 * 把 `AuthModule` 标 `@Global()` 后，`SessionService` 进入「全局可见」集合，
 * 这条向上查找才命中它。这与 `DbModule`/`RedisModule` 用 `@Global()` 是**同一个理由**
 * （横切依赖不该逼每个使用方都 import 一次），只是这里的驱动力来自中间件的解析路径。
 *
 * ## 顺序：为什么 `SessionMiddleware` **不**在本模块 `configure` 里注册
 *
 * 直觉写法是在这里 `consumer.apply(SessionMiddleware).forRoutes('*')`，但那样顺序不可控：
 * `MiddlewareModule.registerMiddleware` 按 `moduleRef.distance` 排序，
 * 而**全局模块的 `distance` 是 `Number.MAX_VALUE`，排序时被显式提到最前**
 * （`middleware-module.js` 第 82–97 行）。`AuthModule` 一旦是 `@Global()`，
 * 它注册的中间件就会排到根模块的 `TraceMiddleware` **之前**——于是
 * `SessionMiddleware` 在没有 `traceId` 的上下文里 `run()` 自己的上下文，
 * **把 trace id 整个丢掉**（Task 4 的验收 13.4 直接失效）。
 *
 * 放在 `AppModule.configure` 里则没有这个歧义：根模块 `distance === 0`，排第一，
 * 两条中间件的相对顺序就是**书写顺序**。并且它把「身份必须建立在 trace 之后」
 * 这条语义留在了能看到全局顺序的那一个文件里。
 *
 * ## `SessionService` 为何导出
 *
 * 会话是**跨模块**的能力（Task 7 的限流按 `userId` 分桶、Task 8 的审计按会话追溯），
 * 但它们拿到的必须是同一个 Redis 连接与同一套键规则。导出一个服务比让每个模块
 * 自己 `new Redis(...)` 少一类「键规则漂移」的故障。
 */
@Global()
@Module({
  imports: [RedisModule, AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    {
      provide: GithubOauthService,
      inject: [ConfigService],
      // 三个凭据没有默认值：缺配置时希望它炸在启动期，而不是发一个空 client_id 的
      // 授权 URL 出去（见 github-oauth.service.ts）。
      useFactory: (cfg: ConfigService<Env, true>) =>
        new GithubOauthService(
          cfg.get('GITHUB_CLIENT_ID', { infer: true }),
          cfg.get('GITHUB_CLIENT_SECRET', { infer: true }),
          cfg.get('GITHUB_CALLBACK_URL', { infer: true }),
        ),
    },
  ],
  exports: [SessionService, PasswordService],
})
export class AuthModule {}
