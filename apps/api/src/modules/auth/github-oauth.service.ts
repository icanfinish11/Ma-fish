import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

/**
 * GitHub OAuth：Authorization Code + PKCE（§4.2）。
 * state 与 code_verifier 由调用方存入短期存储，回调时校验，防 CSRF 与授权码注入。
 *
 * ## ⚠️ 延后项（最终评审 I-3 的裁定：**记录**，不在 P0 实现）
 *
 * 本服务是一条**尚无调用方的适配器**：`auth.controller.ts` 只有
 * register / login / logout / me 四条路由，**没有** authorize 路由、**没有** callback 路由、
 * **没有** state / code_verifier 的短期存储，也**没有任何地方写 `auth.identities`**。
 * 因此 §4.2 那句「校验 `state` 与 `nonce`」与 D4 的发布者门禁，目前在**实质**上尚未满足：
 * 这里交付的是「交换与 PKCE 的计算」，不是「一条能走通的登录流」。
 *
 * 要让这条链路成立，至少还缺三件东西，且必须与 P1 的发布功能**同时**落地：
 *
 * 1. **`GET /auth/github/authorize`** —— 生成 `newState()` + `newPkce()`，把
 *    `state → code_verifier` 写进一个**短期**（分钟级）的 Redis 键，然后 302 到
 *    `buildAuthorizeUrl(state, challenge)`；
 * 2. **`GET /auth/github/callback`** —— 按 `state` **取出并删除**那个键（一次性），
 *    取不到就拒绝（这正是「校验 state」的执行点），再 `exchange(code, verifier)`；
 * 3. **`Identity` 的 upsert** —— 按 `(provider, externalId)` 唯一约束找到或创建用户，
 *    并在**同一个事务**里落一条审计（沿用 `AuditService`，写入路径唯一）。
 *
 * ### 为什么现在**不**建（而不是「顺手补上」）
 *
 * P0 里**没有任何发布功能**，所以 D4 的「发布者门禁」没有可守的对象：现在造出三条路由、
 * 一个 state 存储与一次 identity 写入，全部只会被测试用到——那正是 C16 禁止的
 * 「投机性抽象」，而且它们一旦无人使用就不会随 P1 的真实需求演进（回调的错误分支、
 * 账号合并策略、`nonce` 的存放位置都要按那时候的规格决定）。评审已把这一项追到
 * **计划**（计划只圈定了这个服务），不是实现的缺陷。
 *
 * ### 因此本服务的现状是
 *
 * - 已被单元测试逐条钉住的能力：`newPkce` / `newState` 的形状、`buildAuthorizeUrl` 的参数、
 *   `exchange` 的两类失败（`tests/unit/auth/github-oauth.test.ts`）；
 * - 接线：`AuthModule` 用 `ConfigService` 构造它（`auth-pipeline.test.ts` 有接线用例）；
 * - **尚未接线的**：上面 1–3。P1 落地时必须**同时**接上，否则 D4 的门禁仍然只是文档。
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
