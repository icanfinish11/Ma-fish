import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public, Policy } from '../../common/policy/policy.decorator.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../../common/http/cookie.js';
import { RateLimited, SkipRateLimit } from '../../common/security/throttler.js';
import type { Env } from '../../config/env.schema.js';
import { AuthService } from './auth.service.js';
import { loginSchema, parseOrBadRequest, registerSchema, type LoginDto, type RegisterDto } from './dto.js';

/**
 * 认证入口（§4.2）。
 *
 * ## 策略声明与它们的**后果**
 *
 * `register` / `login` 必须是 `@Public()`——它们正是「还没有身份」时唯一的入口。
 * `logout` / `me` 声明为 `@Policy({ resource: 'Session', … })` 且**不带 condition**：
 * 按 Task 5 的方案 B，无 condition 的声明语义是「登录即可」，**仍然要求身份**。
 * 这正是 Step 0 那个会话中间件存在的理由——没有它，这两条路由对任何人都 403。
 *
 * ## 认证状态一律走 cookie，响应体里没有任何令牌（C13）
 *
 * `register` / `login` 成功后只回 `{ userId }`：令牌在 `Set-Cookie` 里，且是 HttpOnly，
 * 前端 JS **读不到**它，因此也不存在「把它存进 localStorage」这条路径。
 * 这是「不得使用本地存储保存令牌」的技术实现，而不是一条靠自觉遵守的约定。
 *
 * `NODE_ENV` 走 `ConfigService` 而不是 `process.env`（K6 的一致性要求）：
 * 同一个进程里「这份配置的值」只有一个来源，直读 `process.env` 会绕过
 * `ConfigModule` 的校验与缓存，在测试里还会读到被覆写后的值。
 *
 * ## 限流声明（Task 7 / 威胁 #13）
 *
 * `register` 与 `login` 是本模块里**唯一**两条按设计文档 §4.1 限流的路由
 * （`RATE_LIMITS.register` 3 次/小时按 IP；`RATE_LIMITS.login` 5 次/15 分钟按 IP+账号）。
 * `@RateLimited(...)` 同时写入「本路由属于哪一层」与那一层的数值覆盖；
 * **漏写它 = 该路由不限流**（见 `throttler.ts` 里对 `skipIf` 的实测说明），
 * 因此每条新加的写路由都该问一次「它属于哪一层」。
 *
 * 修复轮 1 / C-4 起这个问题有了强制答案：本模块的 `logout` 与 `me` 显式标了
 * `@SkipRateLimit()`（有意不限流），而覆盖率门
 * （`tests/security/rate-limit-coverage.test.ts`）要求**每条**路由二选一，
 * 漏写会让 CI 变红并点名到方法。上面那句「都该问一次」不再依赖自觉。
 *
 * 端到端判别性断言在 `tests/security/rate-limit.test.ts`：注册第 4 次必须 429，
 * 登录第 6 次必须 429，而**换一个账号必须仍然放行**（证明分桶真的含账号）。
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** `secure` 只在生产打开：本地 http 下写死 true 会让开发环境根本收不到 cookie。 */
  private cookieOptions() {
    return sessionCookieOptions(this.config.get('NODE_ENV', { infer: true }) === 'production');
  }

  @Public()
  @RateLimited('register')
  @Post('register')
  async register(
    @Body() body: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ userId: string }> {
    // `@Body()` 拿到的是**未校验**的原始值，zod 在这里才是真正的校验点。
    // 用 `parseOrBadRequest` 而不是 `schema.parse`：后者抛出的 `ZodError` 会变成 500
    // （实测），理由见 dto.ts 的注释。
    const parsed = parseOrBadRequest(registerSchema, body);
    const { sessionId, userId } = await this.auth.register(parsed, req);
    res.cookie(SESSION_COOKIE, sessionId, this.cookieOptions());
    return { userId };
  }

  @Public()
  @RateLimited('login')
  // 与 `logout` 同一条理由（修复轮 2 补齐）：POST 的 Nest 默认状态码是 **201 Created**，
  // 而登录没有创建任何**可寻址的资源**——它换回的是一个会话，凭证在 `Set-Cookie` 里。
  // 201 会让「按状态码分支」的客户端与日志/监控把它当成一次资源创建。
  // `register` **保留 201**：那条路径确实新建了一个 User 资源。
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ userId: string }> {
    const parsed = parseOrBadRequest(loginSchema, body);
    const { sessionId, userId } = await this.auth.login(parsed, req);
    res.cookie(SESSION_COOKIE, sessionId, this.cookieOptions());
    return { userId };
  }

  @Policy({ resource: 'Session', action: 'destroy' })
  // 修复轮 1 / C-4：登出**不在** §4.1 威胁 #13 点名的五类端点里（登录/注册/出价/上传/搜索），
  // 且它已经要求会话（`PolicyGuard`）。因此这里显式写「有意不限流」——
  // 不写的话，「作者想过并决定不限流」与「作者忘了写」在代码里长得一模一样，
  // 而覆盖率门（`tests/security/rate-limit-coverage.test.ts`）正是要区分这两者。
  @SkipRateLimit()
  // POST 的 Nest 默认状态码是 **201 Created**，而登出没有创建任何资源——
  // 返回 201 会让「用状态码判断成败」的客户端把它当成功的同时，
  // 也让日志/监控里每次登出都记成一个「创建」事件。显式改成 200。
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    // 清 cookie 的 path 必须与设置时**逐字一致**（`clearCookie` 只按 name+path+domain 匹配）。
    // 少了 `path` 会让浏览器留下一个自己清不掉的同名 cookie，表现为「登出后刷新又是登录态」。
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Policy({ resource: 'Session', action: 'read' })
  // 读自己的会话：同样不在威胁 #13 的名单里，显式声明「有意不限流」（理由见 `logout`）。
  @SkipRateLimit()
  @Get('me')
  me(@Req() req: Request) {
    return this.auth.me(req.cookies?.[SESSION_COOKIE]);
  }
}
