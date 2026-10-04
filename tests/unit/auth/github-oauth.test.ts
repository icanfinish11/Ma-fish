import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { GithubOauthService } from '@vca/api/modules/auth/github-oauth.service.js';

/**
 * GitHub OAuth 的 PKCE 与授权 URL（§4.2）。
 *
 * ## 为什么这些断言值得存在（而不是「照着实现抄一遍」）
 *
 * 这一段代码是**安全协议**，不是业务逻辑：失败模式全都是「静默地不设防」。
 * 下面每条针对一种具体的静默失败：
 *
 * - `code_challenge` 不是 verifier 的 SHA-256 ⇒ GitHub 只当没传 challenge，
 *   PKCE 形同虚设（授权码被截获即可兑换），而**授权流程照样能跑通**，没有任何报错；
 * - 少了 `code_challenge_method=S256` ⇒ 同上，challenge 被按 `plain` 处理；
 * - `state` 可预测或重复 ⇒ CSRF 防护失效（威胁 #10 的 OAuth 变体）；
 * - `redirect_uri` 与 `client_id` 不带上 ⇒ 回调必然失败（这类错误至少是响亮的）。
 *
 * 因此这里**重新独立算一遍** SHA-256（用 `node:crypto`，不复用被测代码的算法），
 * 而不是把实现里的表达式抄进断言——抄的话，实现和断言会一起错。
 */
describe('GitHub OAuth PKCE（§4.2）', () => {
  const svc = new GithubOauthService('cid-123', 'secret-456', 'https://api.example.com/auth/github/callback');

  it('authorize URL 指向 GitHub、带上 state/challenge/S256 与最小 scope', () => {
    const url = new URL(svc.buildAuthorizeUrl('state-abc', 'challenge-xyz'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');

    const q = url.searchParams;
    expect(q.get('client_id')).toBe('cid-123');
    expect(q.get('redirect_uri')).toBe('https://api.example.com/auth/github/callback');
    expect(q.get('state')).toBe('state-abc');
    expect(q.get('code_challenge')).toBe('challenge-xyz');
    // 没有这一项，GitHub 会按 `plain` 解读 challenge ⇒ PKCE 退化成「明文回显 verifier」
    expect(q.get('code_challenge_method')).toBe('S256');
    // scope 只要身份所需的两项：多要一项就是多一份授权面
    expect(q.get('scope')).toBe('read:user user:email');
    // 授权码流不使用 implicit：换成 token 就直接把令牌暴露在 URL 里了
    expect(q.get('response_type')).not.toBe('token');
  });

  it('newPkce 的 challenge 是 verifier 的 SHA-256（base64url），且每次不同', () => {
    const { verifier, challenge } = GithubOauthService.newPkce();

    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);

    // 43 字符 = 32 字节的 base64url；URL 安全字符集（verifier 会出现在表单里）
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 两个 verifier 相同时 challenge 必然相同，所以「不同」这条检验的正是随机源在工作
    expect(GithubOauthService.newPkce().verifier).not.toBe(verifier);
  });

  it('newState 每次不同且 URL 安全（防 CSRF / 授权码注入）', () => {
    const a = GithubOauthService.newState();
    const b = GithubOauthService.newState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 字节 base64url
    expect(a).not.toBe(b);
  });

  /**
   * `client_secret` 绝不能出现在授权 URL 里（C11 的推论，也是 OAuth 的硬性要求）。
   *
   * 它出现在浏览器地址栏、Referer、以及任何中间代理的日志里。断言比较的是**整个 URL 字符串**
   * 而不仅仅是 query：`client_secret` 若被拼进 fragment 或 path 同样算泄露。
   */
  it('授权 URL 不携带 client_secret（它只出现在服务端到服务端的令牌交换里）', () => {
    const raw = svc.buildAuthorizeUrl('s', 'c');
    expect(raw).not.toContain('secret-456');
    expect(raw.toLowerCase()).not.toContain('client_secret');
  });
});

/** 记录每次 `fetch` 调用的入参，供断言检查「我们发出去的是什么」。 */
type FetchCall = { input: unknown; init: RequestInit | undefined };

/**
 * 把 `fetch` 替换成**记录入参 + 返回给定响应**的替身。
 *
 * 替换的是边界（`fetch`），喂进去的是真实的 `Response`（Node 内置），
 * 因此断言的是「我们发出的请求」与「我们如何解读响应」，**没有任何网络调用**。
 */
function stubFetch(respond: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return respond();
  });
  return calls;
}

/** 真实的 `Response` 对象（`ok` 由 status 推导，不由测试自己编）。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 取唯一一次 `fetch` 调用，缺失即视为接线断了（而不是让断言在 undefined 上飘）。 */
function onlyCall(calls: FetchCall[]): FetchCall {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (!call) throw new Error('exchange() 没有调用 fetch');
  return call;
}

/** 断言 promise 以 Error 拒绝并把它取出来（一次调用，避免 `rejects` 重复执行被测代码）。 */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const settled = await promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (settled.ok) throw new Error(`期望抛错，实际返回了 ${JSON.stringify(settled.value)}`);
  expect(settled.error).toBeInstanceOf(Error);
  return settled.error as Error;
}

/**
 * `exchange()` 的请求构造与两条失败路径（§4.2）。
 *
 * ## 为什么这些断言不是「只证明了 mock 被调用」
 *
 * 上一轮把 `exchange` 列为「无自动化测试」，理由是真调用 GitHub 需要网络与真实的 OAuth 应用，
 * 而 mock 只能证明 mock 自己。这个理由对**协议另一端**成立，但对**本侧的请求构造与错误处理**
 * 不成立：URL、方法、请求头、请求体字段、以及两条 `throw` 分支全部是我们的代码，
 * 且都能在进程内被确定性地执行。这一段代码此前**一行都没跑过**。
 *
 * 每条断言针对一种具体的静默失败（都是「流程照样能跑通、防护却没了」的那一类）：
 *
 * - 漏掉 `code_verifier` ⇒ PKCE 形同虚设：授权码被截获即可兑换，而 GitHub 端不报错；
 * - 漏掉 `accept: application/json` ⇒ GitHub 以 form-urlencoded 应答，`res.json()` 抛
 *   `SyntaxError`，错误信息指向「解析失败」而不是「请求头写错了」；
 * - `redirect_uri` 与授权时不一致 ⇒ 兑换被拒（响亮失败，但此刻才可能被发现）；
 * - 不检查 `res.ok` ⇒ 401/500 的响应体被当成成功响应继续处理；
 * - 不检查 `access_token` ⇒ 返回 `{ accessToken: undefined }`，调用方以**匿名身份**继续往下走。
 */
describe('GitHub OAuth 令牌交换 exchange()（§4.2）', () => {
  const svc = new GithubOauthService('cid-123', 'secret-456', 'https://api.example.com/auth/github/callback');

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功路径：向令牌端点发 POST，请求体带 code/verifier/redirect_uri，返回 access_token', async () => {
    const calls = stubFetch(() => jsonResponse(200, { access_token: 'gho_token_abc', token_type: 'bearer' }));

    await expect(svc.exchange('code-xyz', 'verifier-abc')).resolves.toEqual({ accessToken: 'gho_token_abc' });

    const { input, init } = onlyCall(calls);

    // 1) 端点与方法。换错端点（例如把 /authorize 当令牌端点）会拿回一个 HTML 页面，
    //    报错会指向 JSON 解析——离真正的原因很远。
    expect(String(input)).toBe('https://github.com/login/oauth/access_token');
    expect(init?.method).toBe('POST');

    // 2) 请求头：`accept` 决定 GitHub 用 JSON 还是 form-urlencoded 应答。
    const headers = init?.headers as Record<string, string>;
    expect(headers.accept).toBe('application/json');
    expect(headers['content-type']).toBe('application/json');

    // 3) 请求体：`toEqual` 同时钉住「值」与「键集合」（多一个字段就是多一份泄露面）。
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: 'cid-123',
      client_secret: 'secret-456',
      code: 'code-xyz',
      redirect_uri: 'https://api.example.com/auth/github/callback',
      code_verifier: 'verifier-abc',
    });

    // 4) 凭据一律走请求体，不出现 URL 上（URL 会进地址栏、Referer 与代理日志，C11）。
    expect(String(input)).not.toContain('secret-456');
    expect(String(input).toLowerCase()).not.toContain('client_secret');
  });

  it('非 2xx 响应抛错，消息里带状态码（不能把 401/500 当成功）', async () => {
    const calls = stubFetch(() => jsonResponse(401, { error: 'bad_verification_code' }));

    const err = await rejectionOf(svc.exchange('code-xyz', 'verifier-abc'));

    expect(err.message).toMatch(/GitHub 令牌交换失败/);
    expect(err.message).toContain('401');
    expect(onlyCall(calls).init?.method).toBe('POST');
  });

  it('200 但没有 access_token 时抛错，并把 GitHub 的 error 字段带进消息', async () => {
    stubFetch(() => jsonResponse(200, { error: 'incorrect_client_credentials' }));
    const withError = await rejectionOf(svc.exchange('code-xyz', 'verifier-abc'));
    expect(withError.message).toMatch(/未返回令牌/);
    expect(withError.message).toContain('incorrect_client_credentials');

    // 既没有 access_token 也没有 error：消息里必须有一个可读的占位，而不是 `undefined`。
    stubFetch(() => jsonResponse(200, {}));
    expect((await rejectionOf(svc.exchange('code-xyz', 'verifier-abc'))).message).toContain('unknown');

    // 空字符串不是令牌：`!json.access_token` 必须把它判为失败，而不是回一个空令牌。
    stubFetch(() => jsonResponse(200, { access_token: '' }));
    expect(await rejectionOf(svc.exchange('code-xyz', 'verifier-abc'))).toBeInstanceOf(Error);
  });
});
