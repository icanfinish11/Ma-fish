import { describe, it, expect } from 'vitest';
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
