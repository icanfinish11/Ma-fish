import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
// 跨模块引用**一律**经对方的 `index.ts`（设计 §3.3 第 2 条）。深引 `../audit/audit.module.js`
// 曾经能工作，但那绕过了模块的对外接口；由 `.dependency-cruiser.cjs` 的
// `no-cross-module-internals` 守着（Task 9）。
import { AuditModule } from '../audit/index.js';
import { RedisModule } from '../../db/redis.module.js';
import { AdminDirectory } from './admin-directory.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GithubOauthService } from './github-oauth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/**
 * 认证模块（Ruling 2：brief 的 Files 列表漏了本文件，其代码块又要求它存在）。
 *
 * ## 为什么**不再**是 `@Global()`（Fix 2：移除后实测，结论是「不承重」）
 *
 * 本模块曾标 `@Global()`，理由是「中间件的依赖解析看不见子模块的 providers」。
 * 该理由经**受控实验**检验后不成立，标注已移除（C16：全局 provider 命名空间是真实成本，
 * 不承重就不该有）。实测证据：
 *
 * - 移除 `@Global()` 后 `pnpm vitest run` 全绿（18 文件 / 104 用例，含用真实 Redis
 *   启动应用并走完登录→`/auth/me` 200 的集成用例）；
 * - 用**生产引导路径**（`NestFactory.create(AppModule)` + 真实 HTTP + 真实 Redis）启动：
 *   `/health` 200、`/auth/me` 无 cookie 403、`/auth/me` 带伪造 cookie 403（而不是 500）
 *   ——后者说明 `SessionMiddleware` 确实解析到了 `SessionService` 并查了 Redis。
 *
 * ## 中间件的依赖到底从哪来（读 Nest 12.1.2 源码 + 三组受控变体实测）
 *
 * `Injector.loadMiddleware` 传给解析器的是**该模块的中间件集合**，不是它的 providers
 * （`injector.js` 第 87–94 行）；失败后走 `lookupComponentInParentModules` →
 * `lookupComponentInImports`（第 343–385 行），只在该模块 **imports** 里的模块的
 * **exports** 中查找。因此中间件的依赖只有两个来源：
 *
 * 1. **注册它的那个模块自己的 providers**（实测变体：模块自己注册中间件、依赖是自己的
 *    provider、非全局 → 依赖被正常注入，断言的是真实拿到的实例而不是「启动没报错」）；
 * 2. **该模块 import 进来的模块所 exports 的 providers**（实测变体 A）。
 *
 * 两者都不满足才会抛错（阴性对照变体 E：
 * `Nest can't resolve dependencies of the Mw (?). Please make sure that the argument Dep
 * at index [0] is available in the FeatureE module.`）。
 *
 * **本模块属于第 2 种**：`SessionMiddleware` 由 `AppModule.configure` 注册，而
 * `AppModule` import 了本模块、本模块又 `exports: [SessionService]`——这条边已经足够，
 * 不需要全局可见性。**请勿**为了「少写一行 imports」把本模块重新标成 `@Global()`：
 * 那会重新引入下面的顺序陷阱。
 *
 * ## 顺序：为什么 `SessionMiddleware` **不**在本模块 `configure` 里注册
 *
 * `MiddlewareModule.registerMiddleware` 按 `moduleRef.distance` 排序，**非全局模块**按
 * distance 升序、**全局模块被显式排到最前**（`middleware-module.js` 第 82–97 行）。
 * 而 distance 是**距根模块的图深度**，全局模块在计算时被跳过、因而恒为
 * `Number.MAX_VALUE`（`scanner.js` 第 219–224 行）。
 *
 * 于是把 `SessionMiddleware` 写进任何**子模块**的 `configure` 都会让它排到根模块的
 * `TraceMiddleware` **之后**——注意这条推论与全局与否无关，是「子模块 distance > 0」造成的；
 * 而若那个子模块还是 `@Global()`，它会排到根模块**之前**，更糟：`SessionMiddleware` 在
 * 没有 `traceId` 的上下文里 `run()` 自己的上下文，**把 trace id 整个丢掉**
 * （Task 4 的验收 13.4 直接失效）。
 *
 * 放在 `AppModule.configure` 里则没有这个歧义：根模块 `distance === 0` 排第一，
 * 两条中间件的相对顺序就是**书写顺序**。并且它把「身份必须建立在 trace 之后」
 * 这条语义留在了能看到全局顺序的那一个文件里。
 *
 * ## `SessionService` 为何导出（现在它是**承重**的）
 *
 * 一是上文的中间件解析路径（`AppModule` 通过 export 拿它）；二是会话本身是**跨模块**的
 * 能力（Task 7 的限流按 `userId` 分桶、Task 8 的审计按会话追溯），它们拿到的必须是同一个
 * Redis 连接与同一套键规则——在 `imports` 里写上本模块即可，比让每个模块自己
 * `new Redis(...)` 少一类「键规则漂移」的故障。
 */
@Module({
  imports: [RedisModule, AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    // P2 / Task 10：auth 对外的**唯一**新增能力（判管理员）。它住在 auth 里是因为
    // `role` 列归 auth（C5：禁止跨模块直接读对方表），而 ledger 的额度发放路由必须
    // 知道「这个人是不是管理员」。判定细节与最小披露的理由见那个文件的头注释。
    AdminDirectory,
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
  exports: [SessionService, PasswordService, AdminDirectory],
})
export class AuthModule {}
