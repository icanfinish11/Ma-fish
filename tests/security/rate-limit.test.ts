import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthService } from '@vca/api/modules/auth/auth.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { RATE_LIMITS, trackerFor } from '@vca/api/common/security/throttler.js';
import {
  RedisThrottlerStorage,
  THROTTLE_KEY_PREFIX,
} from '@vca/api/common/security/redis-throttler.storage.js';
import { runInContext } from '@vca/api/common/context/request-context.js';
import { createTestApp } from '../helpers/app.js';
import { startTestRedis, type TestRedis } from '../helpers/redis.js';

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
 * ## 修复轮 1 / C-1：桶搬进 Redis 之后，测试的隔离方式**必须**跟着改
 *
 * 此前每个 `createTestApp()` 天生带一份干净的进程内桶，所以「一个用例起一个应用」
 * 就等于「一个用例一份干净计数」。现在桶在 Redis（这正是 C-1 要的），
 * 计数**跨应用、跨运行**共享，于是：
 *
 * - 每个应用通过 `REDIS` 覆盖拿到**自己的客户端**，且指向本文件**自己的容器**
 *   （`tests/helpers/redis.ts`）。用测试进程默认的 `REDIS_URL`（本机 compose 那个）
 *   会让注册层的桶（TTL 1 小时）在两次运行之间累积，第二次跑就变成随机红；
 * - 三个用例走的是**不同的路由**（⇒ 不同的桶键：`generateKey` 里含控制器+处理器+层名），
 *   因此同一个容器里它们互不污染；
 * - 需要「两个实例共用同一个桶」的用例（见下）必须**另起一个容器**——
 *   它打的正是注册层，与第一个用例的桶键完全相同。
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

describe('分层限流（威胁 #13 / C12）', () => {
  let redis: TestRedis;

  beforeAll(async () => {
    redis = await startTestRedis();
  }, 180_000);

  afterAll(async () => {
    await redis?.stop();
  });

  /** 每个用例一个应用；应用自带一个指向本文件容器的 Redis 客户端（生命周期属于应用）。 */
  async function withApp<T>(fn: (app: INestApplication) => Promise<T>): Promise<T> {
    const app = await createTestApp({
      overrides: [
        (b) => b.overrideProvider(AuthService).useValue(stubAuth),
        (b) => b.overrideProvider(REDIS).useValue(redis.newClient()),
      ],
    });
    try {
      return await fn(app);
    } finally {
      // `app.close()` → `RedisLifecycle.onApplicationShutdown` 会 disconnect 那个客户端；
      // 重复关闭会在输出里留下 ioredis 的 `Connection is closed.`（见 integration 套件的实测）。
      await app.close();
    }
  }

  it('限流表与设计文档 §4.1 威胁 #13 逐条一致', () => {
    expect(RATE_LIMITS.login).toEqual({ limit: 5, ttlMs: 15 * 60_000, by: 'ip+account' });
    expect(RATE_LIMITS.register).toEqual({ limit: 3, ttlMs: 60 * 60_000, by: 'ip' });
    expect(RATE_LIMITS.bid).toEqual({ limit: 30, ttlMs: 60_000, by: 'user' });
    expect(RATE_LIMITS.upload).toEqual({ limit: 10, ttlMs: 24 * 60 * 60_000, by: 'user' });
    expect(RATE_LIMITS.search).toEqual({ limit: 60, ttlMs: 60_000, by: 'ip' });
  });

  it('注册层（3 次/小时，按 IP）：第 4 次返回 429，且带 Retry-After', async () => {
    await withApp(async (app) => {
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
    await withApp(async (app) => {
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
    await withApp(async (app) => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await request(app.getHttpServer()).get('/health')).status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    });
  });
});

/**
 * **判别性用例**（修复轮 1 / C-1）：限流桶在 Redis，因此两个独立的 Nest 应用实例
 * 共用同一个计数。
 *
 * 内存存储下这条用例**必红**：`ThrottlerStorageService` 的 Map 是每个应用实例一份，
 * 两个实例各自有 3 次/小时的额度，于是 B 的两次请求都会是 201，
 * 而实际阈值会随实例数变成 3N 次——这正是「声明了但没执行」的失效形态。
 *
 * 这也是唯一能区分「桶在 Redis」与「桶在进程内」的测试形态：单实例的
 * 「打满仍然返回 429」在两种存储上都通过，证明不了任何新东西。
 *
 * 另起一个容器：本用例打的是注册层（按 IP 分桶），与上面第一个用例的桶键完全相同。
 */
describe('限流桶在 Redis：两个应用实例共享同一个计数（修复轮 1 / C-1）', () => {
  let redis: TestRedis;
  let inspector: Redis;
  let instanceA: INestApplication;
  let instanceB: INestApplication;

  const bootInstance = (client: Redis) =>
    createTestApp({
      overrides: [
        (b) => b.overrideProvider(AuthService).useValue(stubAuth),
        (b) => b.overrideProvider(REDIS).useValue(client),
      ],
    });

  beforeAll(async () => {
    redis = await startTestRedis();
    // **两个独立客户端**（不是一个客户端被两个应用借用）：各自的生命周期属于各自的实例，
    // 关掉 A 不会顺手掐断 B 的连接。它们指向**同一个** Redis。
    inspector = redis.newClient();
    instanceA = await bootInstance(redis.newClient());
    instanceB = await bootInstance(redis.newClient());
  }, 180_000);

  afterAll(async () => {
    await instanceA?.close();
    await instanceB?.close();
    // `inspector` 不属于任何应用，没有钩子会替你收（ioredis 的活跃 socket 会让 worker 不退出）。
    inspector?.disconnect();
    await redis?.stop();
  });

  it('实例 A 用掉 2 次额度后，实例 B 的第 2 次就是全局第 4 次 ⇒ 429', async () => {
    const register = (app: INestApplication, i: number) =>
      request(app.getHttpServer())
        .post('/auth/register')
        .set(withCsrf)
        .send({ email: `shared-bucket-${i}@example.com`, password: 'a-strong-passphrase' });

    const onA = [(await register(instanceA, 1)).status, (await register(instanceA, 2)).status];
    expect(onA, '实例 A 自己就把 3 次/小时的额度用完了，后面的断言无从谈起').toEqual([201, 201]);

    // 实例 B 的**第 1 次**是全局第 3 次 ⇒ 仍然放行（证明 B 确实在看同一个桶，而不是碰巧坏了）；
    // 第 2 次是全局第 4 次 ⇒ 429。
    // 内存存储下这里是 [201, 201]（每个实例各有 3 次额度）⇒ 用例变红。
    const onB = [(await register(instanceB, 3)).status, (await register(instanceB, 4)).status];
    expect(onB, '两个实例没有共用同一个桶：各自放行了 3 次（阈值被实例数放大）').toEqual([201, 429]);

    // 直接证明「桶确实落在 Redis 里」而不是某个模块级共享 Map：
    // 前者能与进程外的实例共享、能在重启后存活，后者两条都做不到。
    const keys = await inspector.keys(`${THROTTLE_KEY_PREFIX}*`);
    expect(keys.length, `Redis 里没有任何 ${THROTTLE_KEY_PREFIX}* 键：计数没落在这里`).toBeGreaterThan(0);

    // **两个键都要有过期时间**（修复轮 3 改正：原来只查 `keys[0]`）。
    // 一个桶由两个键组成：记录键（哈希，存 `blockedUntil`）与它旁边的有序集合 `:hits`。
    // 修复轮 2 的真实回归就是「只给 `:hits` 设了 TTL、记录键变成永不过期（PTTL = -1）」，
    // 而当时之所以**当场**被抓到，靠的是这条断言恰好取到了记录键——那是 `KEYS` 的返回顺序，
    // 不是我们指定的事实。按**内容**把两个都找出来并逐个断言，这条用例才在钉住这件事
    // （顺序变了、或只给其中一个设 TTL，都必须变红）。
    const bucketRoot = keys.find((k) => !k.endsWith(':hits'));
    const hitsKey = keys.find((k) => k.endsWith(':hits'));
    expect(bucketRoot, `桶里没有记录键（只有有序集合）：${keys.join(', ')}`).toBeDefined();
    expect(hitsKey, `桶里没有有序集合键：${keys.join(', ')}`).toBeDefined();

    for (const [label, key] of [
      ['记录键', bucketRoot!],
      ['有序集合', hitsKey!],
    ] as const) {
      const pttl = await inspector.pttl(key);
      // 有过期时间 ⇒ 桶不会永久留在库里（注册层 TTL 1 小时，封锁期同为 1 小时）。
      expect(pttl, `${label}（${key}）没有过期时间：它会永久占住 Redis`).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(RATE_LIMITS.register.ttlMs);
    }
  });
});

/**
 * 故障语义：**fail-closed**（修复轮 1 / C-1 的第二半）。
 *
 * 决定与理由写在 `RedisThrottlerStorage.increment` 的注释里，这里只固定**后果**：
 * 存储不可用时受限路由返回 500，**绝不放行**。若有人把 storage 改成
 * 「catch 住错误、返回一个 `isBlocked: false` 的记录」（最诱人的写法），
 * 下面两条都会红：第一条（`increment` 不再 reject）与第二条（请求变成 201）。
 */
describe('限流存储不可用：fail-closed，不放行（修复轮 1 / C-1）', () => {
  /**
   * 一个「命令必定失败」的 Redis 替身。
   *
   * 为什么不用「指向一个死端口的真客户端」：那会带来 ioredis 的重连与
   * `[ioredis] Unhandled error event` 噪音（本仓库要求输出 pristine），
   * 而本用例要观察的是「存储报错之后限流器怎么办」，不是「ioredis 怎么报连接错误」。
   * `status`/`disconnect` 是 `RedisLifecycle` 关停路径会用到的两个成员。
   */
  const failingRedis = {
    status: 'ready',
    eval: () => Promise.reject(new Error('ECONNREFUSED（探针替身：模拟限流存储不可用）')),
    disconnect: () => undefined,
  } as unknown as Redis;

  it('存储命令失败时 increment 抛错，而不是返回一个「未拦截」的记录', async () => {
    const storage = new RedisThrottlerStorage(failingRedis);
    await expect(storage.increment('probe-key', 60_000, 3, 60_000, 'register')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('存储故障时受限路由的请求被拒（500），不会被放行', async () => {
    const app = await createTestApp({
      overrides: [
        (b) => b.overrideProvider(AuthService).useValue(stubAuth),
        (b) => b.overrideProvider(REDIS).useValue(failingRedis),
      ],
    });
    try {
      // 这一条**故意**造成一次 500，而 Nest 的异常过滤器会把未捕获异常的栈打到控制台
      // （测试进程里 pino 是静音的，但 Nest 的 ConsoleLogger 不是）。
      // `useLogger(false)` 是 Nest 官方的「关掉框架日志」入口（`Logger.overrideLogger(false)`
      // → `staticInstanceRef = undefined`，实测见修复轮报告），这里只为了让
      // 「预期中的失败」不污染 pristine 输出。它作用在该 worker 的静态 logger 上，
      // 因此本用例被放在文件末尾，不影响其他用例。
      app.useLogger(false);

      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .set(withCsrf)
        .send({ email: 'fail-closed@example.com', password: 'a-strong-passphrase' });

      // fail-closed 的形态：请求被拒（500 而不是 201）。Redis 故障时**放行**才是缺陷。
      expect(res.status, failClosedHint(res.status)).toBe(500);
    } finally {
      await app.close();
    }
  });
});

function failClosedHint(status: number): string {
  return status < 400
    ? `限流存储不可用时请求仍然被放行（${status}）：这是 fail-open`
    : `预期 500（fail-closed），实际 ${status}`;
}

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
