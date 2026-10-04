import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { AuthService } from '@vca/api/modules/auth/auth.service.js';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { RATE_LIMITS, trackerFor } from '@vca/api/common/security/throttler.js';
import { runInContext } from '@vca/api/common/context/request-context.js';
import { createTestApp } from '../helpers/app.js';

/**
 * 分层限流（威胁 #13 / C12）。
 *
 * ## brief 里那条「429 用例」为什么必须被换掉
 *
 * brief 的第二个用例是 `expect([200, 429]).toContain(last)`——**恒真**。
 * 它在「限流完全没接线」时照样通过，因此它证明的东西是零：删掉 `ThrottlerGuard`
 * 的注册、删掉 `forRoot`、甚至把 `@nestjs/throttler` 整个卸掉，它都不会变红。
 * 本文件保留 brief 那条**实质性**断言（限流表逐条等于设计文档），
 * 并把恒真的那一条换成真正会红的用例（Ruling 5）：在真实路由上把某一层打满，
 * 断言 429 + `Retry-After`。变异探针见报告（去掉守卫 → 本文件立刻红）。
 *
 * ## 为什么三个用例各起一个应用
 *
 * 限流计数在**进程内**（`ThrottlerStorageService` 的 Map，每个应用实例一份），
 * 且键是「控制器-处理器-层-分桶」。三个用例若共用应用实例，计数会互相污染，
 * 断言就变成顺序相关的——那种测试在单独跑时绿、全量跑时红，最难查。
 *
 * ## 为什么桩掉 `AuthService`
 *
 * 这些用例要打满的是**限流层**，不是注册/登录本身。用真实现时请求会去连库/连 Redis，
 * 失败形态是 500——于是「第 4 次被限流」这条断言会被基础设施错误干扰（而且输出会被
 * 一堆连接错误污染，本仓库要求 pristine）。桩掉之后，每个请求的结果只由限流决定。
 */

const stubAuth = {
  register: async () => ({ sessionId: 'rl-probe-session', userId: 'rl-probe-user' }),
  login: async () => ({ sessionId: 'rl-probe-session', userId: 'rl-probe-user' }),
  logout: async () => undefined,
  me: async () => ({ id: 'rl-probe-user' }),
} as unknown as AuthService;

/** 每个请求带上一对**合法**的双提交令牌：这样 429 只可能来自限流，不可能来自 CSRF。 */
const CSRF_TOKEN = 'rate-limit-probe-token-0123456789';
const withCsrf = { Cookie: `${CSRF_COOKIE}=${CSRF_TOKEN}`, [CSRF_HEADER]: CSRF_TOKEN } as const;

async function withApp<T>(options: Parameters<typeof createTestApp>[0], fn: (app: INestApplication) => Promise<T>): Promise<T> {
  const app = await createTestApp({ overrides: [(b) => b.overrideProvider(AuthService).useValue(stubAuth)], ...options });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

describe('分层限流（威胁 #13 / C12）', () => {
  it('限流表与设计文档 §4.1 威胁 #13 逐条一致', () => {
    expect(RATE_LIMITS.login).toEqual({ limit: 5, ttlMs: 15 * 60_000, by: 'ip+account' });
    expect(RATE_LIMITS.register).toEqual({ limit: 3, ttlMs: 60 * 60_000, by: 'ip' });
    expect(RATE_LIMITS.bid).toEqual({ limit: 30, ttlMs: 60_000, by: 'user' });
    expect(RATE_LIMITS.upload).toEqual({ limit: 10, ttlMs: 24 * 60 * 60_000, by: 'user' });
    expect(RATE_LIMITS.search).toEqual({ limit: 60, ttlMs: 60_000, by: 'ip' });
  });

  it('注册层（3 次/小时，按 IP）：第 4 次返回 429，且带 Retry-After', async () => {
    await withApp({ withSecurity: true }, async (app) => {
      const statuses: number[] = [];
      const responses: request.Response[] = [];
      for (let i = 0; i < 4; i++) {
        responses.push(
          await request(app.getHttpServer())
            .post('/auth/register')
            .set(withCsrf)
            .send({ email: `rl-register-${i}@example.com`, password: 'a-strong-passphrase' }),
        );
        statuses.push(responses[responses.length - 1]!.status);
      }
      // 前 3 次必须**真的成功**：只断言第 4 次是 429 的话，「所有请求都 429」也算通过。
      expect(statuses).toEqual([201, 201, 201, 429]);

      // `@nestjs/throttler` 6.7.1 给**具名**层加后缀：`Retry-After-register`（实测 guard 源码
      // `handleRequest`：`name === 'default' ? '' : '-' + name`）。这里断言库实际给出的头，
      // 而不是我们希望的 `retry-after`——后者在本层永远不会出现。
      const retryAfter = responses[3]!.headers['retry-after-register'];
      expect(retryAfter, '被限流的响应里没有 Retry-After-register').toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThan(0);
      expect(Number(retryAfter)).toBeLessThanOrEqual(RATE_LIMITS.register.ttlMs / 1000);
    });
  });

  it('登录层（5 次/15 分钟，按 IP+账号）：第 6 次 429，换个账号仍然放行', async () => {
    await withApp({ withSecurity: true }, async (app) => {
      const attempt = (email: string) =>
        request(app.getHttpServer())
          .post('/auth/login')
          .set(withCsrf)
          .send({ email, password: 'a-strong-passphrase' });

      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await attempt('rl-same@example.com')).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);

      // 这一条是 `by: 'ip+account'` 的**判别器**：若分桶只按 IP（实现偷懒写成默认 tracker），
      // 同一 IP 上换一个账号也会被 429 —— 那正是「攻击者可以把别人的账号锁死」的形态。
      const other = await attempt('rl-other@example.com');
      expect(other.status, '分桶没有包含账号：换个账号仍被同一个 IP 桶拦下').toBe(200);
    });
  });

  it('未被任何层声明的路由不受限流（/health 连打 6 次仍是 200）', async () => {
    // 这条替换了 brief 里那条恒真的 `expect([200, 429]).toContain(last)`，而且方向相反：
    // 它断言**不该被限流的路由确实没被限流**。
    //
    // 为什么这条有用（实测，见 `throttlerOptions()` 的注释）：`ThrottlerGuard.canActivate`
    // 会对**每一个**已配置的层求值**每一个**未跳过的路由，`@Throttle` 只覆盖**同名**那一层。
    // 因此若不按「本路由是否声明了该层」过滤，/health 会被 5 层里最严的
    // 「注册 3 次/小时」压住——第 4 次就 429，健康探针会把整个实例判死（LB 探活失败）。
    await withApp({ withSecurity: true }, async (app) => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await request(app.getHttpServer()).get('/health')).status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    });
  });
});

/**
 * 分桶维度（`by`）的纯函数断言。
 *
 * 表里的 `by` 不是注释：`ip` / `ip+account` / `user` 三种语义各自对应一个 tracker。
 * 少了这一组，把 login 的 tracker 写成默认的「只按 IP」时，限流**看起来**仍然工作
 * （一样会 429），差别只在「谁的桶被填满」——那正是安全语义所在。
 */
describe('限流分桶维度（RATE_LIMITS[*].by）', () => {
  /** 一个最小的「请求」形状：tracker 只读 `ip` 与 `body.email`。 */
  const req = (over: { ip?: string; body?: unknown } = {}): Record<string, unknown> => ({
    ip: '203.0.113.7',
    body: {},
    ...over,
  });

  /** tracker 的第二个入参是 ExecutionContext；本实现不读它，但签名要求传。 */
  const ctx = undefined as unknown as ExecutionContext;

  it('ip：同一 IP 同桶，不同 IP 不同桶', async () => {
    const track = trackerFor('ip');
    expect(await track(req(), ctx)).toBe(await track(req(), ctx));
    expect(await track(req({ ip: '203.0.113.8' }), ctx)).not.toBe(await track(req(), ctx));
  });

  it('ip+account：同 IP 下按账号分开，且桶键里**不含明文邮箱**（C11）', async () => {
    const track = trackerFor('ip+account');
    const a = await track(req({ body: { email: 'user-a@example.com' } }), ctx);
    const aAgain = await track(req({ body: { email: 'USER-A@example.com' } }), ctx); // 大小写不敏感
    const b = await track(req({ body: { email: 'user-b@example.com' } }), ctx);
    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
    // 桶键会被写进限流存储（内存/Redis），而 C11 要求日志与存储里不出现完整邮箱。
    expect(a).not.toContain('user-a@example.com');
    expect(a).not.toContain('example.com');
  });

  it('user：已认证时按 userId 分桶；匿名时退回按 IP（不能把所有匿名用户并成一个桶）', async () => {
    const track = trackerFor('user');
    const identified = await runInContext({ traceId: 'rl-probe', userId: 'user-1' }, () => track(req(), ctx));
    expect(identified).toBe('user-1');

    const anonymousA = await track(req(), ctx);
    const anonymousB = await track(req({ ip: '203.0.113.9' }), ctx);
    expect(anonymousA).not.toBe(identified);
    expect(anonymousA).not.toBe(anonymousB);
  });
});
