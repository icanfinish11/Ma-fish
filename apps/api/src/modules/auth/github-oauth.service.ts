import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

/**
 * GitHub OAuth：Authorization Code + PKCE（§4.2）。
 * state 与 code_verifier 由调用方存入短期存储，回调时校验，防 CSRF 与授权码注入。
 *
 * ## 为什么用 PKCE（一个「机密客户端」也要用）
 *
 * 本服务是机密客户端（有 `client_secret`），PKCE 在规范上不是必需的。仍然加上的理由：
 * `client_secret` 一旦泄露（日志、镜像、配置库），授权码就是**可直接兑换**的；
 * 而 PKCE 把兑换绑死在**发起授权的那个浏览器会话**持有的 `code_verifier` 上，
 * 使得「偷到授权码」不再等于「拿到令牌」。成本是两次哈希，收益是一整类泄漏场景。
 *
 * ## 为什么凭据走构造函数而不是直接读 `process.env`
 *
 * 由 `AuthModule` 用 `ConfigService` 构造（与 `DbModule`/`RedisModule` 同一形状）：
 * 密钥只从环境变量来（C10），且本服务因此是**纯函数式的**——测试能给它任意凭据，
 * 不必污染进程环境。三个参数没有默认值：缺配置时希望它**炸在启动期**，
 * 而不是发一个 `client_id=` 的授权 URL 出去，让用户在 GitHub 那边看到一句
 * 「Application not found」。
 */
@Injectable()
export class GithubOauthService {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly callbackUrl: string,
  ) {}

  /** 生成 PKCE 对：`challenge = BASE64URL(SHA256(verifier))`。 */
  static newPkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  /** 生成 `state`：一次性随机值，回调时必须逐字比对（防 CSRF / 授权码注入）。 */
  static newState(): string {
    return randomBytes(16).toString('base64url');
  }

  buildAuthorizeUrl(state: string, codeChallenge: string): string {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', this.callbackUrl);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  /**
   * 用授权码换取访问令牌（服务端到服务端）。
   *
   * `client_secret` **只**出现在这里（请求体里），绝不进授权 URL。
   * 两类失败都抛错而不返回空令牌：调用方拿到 `undefined` 再往下走，
   * 就会以「匿名用户」的身份继续——一个把失败变成身份降级的形态。
   */
  async exchange(code: string, codeVerifier: string): Promise<{ accessToken: string }> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) throw new Error(`GitHub 令牌交换失败：${res.status}`);
    const json = (await res.json()) as { access_token?: string; error?: string };
    if (!json.access_token) throw new Error(`GitHub 未返回令牌：${json.error ?? 'unknown'}`);
    return { accessToken: json.access_token };
  }
}
