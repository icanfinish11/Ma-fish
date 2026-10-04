import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';

/**
 * 让测试客户端具备**浏览器那一步**（Task 7 起必需）。
 *
 * ## 为什么集成测试也必须带令牌
 *
 * C13 要求「**全部**写操作校验双提交令牌」，而 `CsrfGuard` 是全局守卫——因此任何
 * 不带令牌的写请求（包括测试里那些 `request(app).post('/auth/register')`）都会 403。
 * 这不是测试需要绕过的麻烦，而是「客户端必须做的那件事」：
 * 真实前端要发一次安全请求、读出可读的 `vca_csrf` cookie，再把它回填进请求头。
 * 这里做的正是同一件事，因此集成套件跑的仍是**完整**的生产管线（CSRF 校验没有被关掉）。
 *
 * 反过来说：如果为了省事在测试里跳过校验（例如给守卫加一个「测试环境不校验」的分支），
 * 那 CSRF 这条链在集成层就再也不会被触发，而它恰恰是威胁 #10 的唯一防线。
 *
 * 负方向（不带令牌 403、令牌不匹配 403）由 `tests/security/csrf.test.ts` 用真实应用断言，
 * 那里刻意**不**用本文件的两个函数。
 */

/** 从 `set-cookie` 里取出某个 cookie 的值。 */
function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const line = list.find((entry: string) => entry.startsWith(`${name}=`));
  if (!line) return undefined;
  return decodeURIComponent(line.slice(name.length + 1).split(';')[0] ?? '');
}

/**
 * 走一遍「浏览器取令牌」：发一次安全请求，从响应里读 `vca_csrf`。
 *
 * 拿不到就抛错（而不是返回空串）：那说明中间件没下发，后续所有写请求都会 403，
 * 而那时的失败信息会是「expected 403 to be 201」——完全指不出真正的原因。
 */
export async function fetchCsrfToken(app: INestApplication): Promise<string> {
  const res = await request(app.getHttpServer()).get('/health');
  const token = cookieValue(res, CSRF_COOKIE);
  if (!token) {
    throw new Error(`安全请求没有下发 ${CSRF_COOKIE}：CSRF 中间件未挂上（Task 7 / C13）`);
  }
  return token;
}

/**
 * 写请求要带的两个头：`Cookie`（含双提交令牌与会话 cookie）与 `X-CSRF-Token`。
 *
 * 令牌必须**同时**出现在 cookie 与请求头里——这正是「双提交」的含义，
 * 只带其中一个会被 `CsrfGuard` 以 403 拒绝（两条分支各有用例覆盖）。
 *
 * `sessionCookies` 直接接 supertest 的 `headers['set-cookie']` 形态（数组），
 * 也接受单个字符串：既有用例两种写法都有。
 */
export function csrfHeaders(token: string, sessionCookies?: string | readonly string[]): Record<string, string> {
  const cookies =
    sessionCookies === undefined ? [] : typeof sessionCookies === 'string' ? [sessionCookies] : [...sessionCookies];
  cookies.push(`${CSRF_COOKIE}=${token}`);
  return { Cookie: cookies.join('; '), [CSRF_HEADER]: token };
}
