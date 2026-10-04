import type { CookieOptions } from 'express';

/** 会话 cookie 名。**只有它一个** cookie 承载凭证，且是 HttpOnly 的。 */
export const SESSION_COOKIE = 'vca_sid';

/** 空闲 7 天（与 `SessionService` 的 Redis TTL 同值——两处必须一起改）。 */
const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * 会话 cookie 策略（C13）。
 *
 * 三个属性各自挡一类攻击，逐条都**不是**可选的美化：
 *
 * - `httpOnly` —— 挡住 XSS 读凭证。这是「本地存储里没有任何令牌」（C13）的技术前提：
 *   前端**拿不到**这个 cookie，因此也就没有任何地方可以把它误存进 `localStorage`。
 * - `secure` —— 只在 HTTPS 上发送，挡住明文网络里的 cookie 窃取。参数化而不是写死 `true`：
 *   本地开发走 http，写死会让开发环境**根本收不到** cookie（表现为「登录成功但立刻掉线」）。
 *   生产必须为 `true`，由调用方传入 `NODE_ENV === 'production'`。
 * - `sameSite: 'lax'` —— 跨站请求不带 cookie，挡住 CSRF 的**绝大多数**入口。
 *   刻意**不**用 `'strict'`：`strict` 会让「从外部链接跳到本站」的第一次请求不带 cookie，
 *   用户表现为「点开链接永远是未登录状态」。写操作另有 Task 7 的双提交令牌兜底，
 *   因此这里的 `lax` 是纵深防御的一层而**不是**唯一防线。
 *
 * `path: '/'` 是显式写出的：默认值虽然是 `/`，但清 cookie 时必须与设置时**逐字一致**，
 * 否则 `clearCookie` 清不掉它（`clearCookie` 只按 name+path+domain 匹配）。
 */
export function sessionCookieOptions(isProduction: boolean, maxAgeMs = SESSION_MAX_AGE_MS): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}
