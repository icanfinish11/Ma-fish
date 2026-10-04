import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../../config/env.schema.js';

/** CSRF cookie 名。**刻意**不是 HttpOnly（前端必须读得到它，见下）。 */
export const CSRF_COOKIE = 'vca_csrf';

/** 回填令牌的请求头名。 */
export const CSRF_HEADER = 'x-csrf-token';

/** 令牌字节数：256 位随机（与 `SessionService` 的会话 id 同量级）。 */
const TOKEN_BYTES = 32;

/**
 * 不需要令牌的方法（RFC 9110 的 safe methods）。
 *
 * **只此一处定义**，`csrf.guard.ts` 从本文件导入同一个集合。曾写成两份字面量并靠注释
 * 要求「必须逐字一致」——那正是最容易被改坏的一类约定：中间件按它决定**要不要下发**
 * 令牌，守卫按它决定**要不要校验**。两处一旦不一致，失效形态是静默的
 * （例如中间件把 `PUT` 当安全方法而不下发令牌，守卫却要求校验 ⇒ 某个方法的所有写操作
 * 都 403，而代码里两处看起来都「对」）。
 */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 双提交令牌的**下发端**（威胁 #10 / C13）。
 *
 * ## 为什么是双提交令牌，而不是「校验 Origin 头」
 *
 * C13 明确选了「Cookie 会话 + SameSite=Lax + 双提交令牌」。双提交令牌的优势是
 * **不依赖浏览器对来源头的承诺**：攻击者能让浏览器发出跨站写请求（SameSite=Lax 挡不住
 * 顶层表单 POST 之类的场景），但他**读不到**本站在受害者浏览器里的 cookie 值
 * （同源策略），因此无法把它回填进请求头。签发端与校验端的这条非对称性就是全部安全性。
 *
 * ## 三个属性各自的理由（都不是美化）
 *
 * - `httpOnly: false` —— **必须**。令牌要由前端 JS 读出来回填请求头；写成 HttpOnly
 *   会让整条机制失效，且表现为「所有写操作 403，而会话 cookie 明明带着」这种
 *   指不出原因的故障。它**不是**凭证：拿到它并不能冒充用户，只是「证明你能读到本站 cookie」。
 * - `sameSite: 'lax'` —— 与会话 cookie 同策略（见 `common/http/cookie.ts`）：跨站请求不带它，
 *   于是「cookie 与头都拿不到」这一侧也被堵住。
 * - `secure` 只在生产打开 —— 本地开发是 http，写死 true 会让开发环境收不到 cookie，
 *   于是本地所有写操作 403。与 `AuthController.cookieOptions()` 同一条理由。
 *
 * `NODE_ENV` 走 `ConfigService` 而不是直读 `process.env`：同一个进程里「这份配置的值」
 * 只能有一个来源（`ConfigModule` 的校验与缓存），直读会绕开它；测试里尤其明显，
 * 夹具（`tests/helpers/env.ts`）写的是 `test`，而 shell 里可能是别的值。
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService<Env, true>) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      // 只在**没有**令牌时下发：已有令牌的请求原样透传，前端可以在整个会话里复用同一个值
      // （每次安全请求都换一个令牌会让「并发页面」互相覆盖，表现为随机的 403）。
      const existing = req.cookies?.[CSRF_COOKIE];
      if (typeof existing !== 'string' || existing.length === 0) {
        const token = randomBytes(TOKEN_BYTES).toString('base64url');
        res.cookie(CSRF_COOKIE, token, {
          httpOnly: false,
          secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
          sameSite: 'lax',
          path: '/',
        });
        // 让**同一个请求**里后续的守卫/处理器也能看到它（`res.cookie` 只写响应头）。
        // 不写这一步时，同一请求内需要读它的代码会看到 `undefined`。
        req.cookies = { ...(req.cookies ?? {}), [CSRF_COOKIE]: token };
      }
    }
    next();
  }
}
