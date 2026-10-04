import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { AuthService } from '@vca/api/modules/auth/auth.service.js';
import { REDIS } from '@vca/api/modules/auth/session.service.js';
import { CsrfGuard } from '@vca/api/common/security/csrf.guard.js';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { createTestApp } from '../helpers/app.js';
import { startTestRedis, type TestRedis } from '../helpers/redis.js';

/**
 * CSRF 双提交令牌（威胁 #10 / C13）。
 *
 * ## 为什么四条断言都是「拒绝」
 *
 * 双提交令牌最危险的失效形态是**假绿**：令牌检查写坏了、或者写请求根本没走守卫，
 * 表现都是「请求都成功了」——那看起来跟「一切正常」一模一样。所以本文件的骨架是
 * 「不给令牌 ⇒ 403」「给了不匹配的令牌 ⇒ 403」「所有写路由逐一探测 ⇒ 一律 403」。
 *
 * 但**只有拒绝**也不够：一个把**所有**写操作都 403 的实现（比如守卫里 `return false`）
 * 同样能让上面全部通过，而系统完全不可用。因此最后一组用例断言**正**方向：
 * GET 先拿到可读的 `vca_csrf` cookie，带着它回填请求头的写操作**到达处理器**（201）。
 * 这两侧合起来才把「双提交令牌」这件事钉死。
 *
 * ## 为什么拒绝是 403 而不是 401/419
 *
 * `ForbiddenException`（403）是本仓库既有的判权语义（`PolicyGuard` 也用 403）。
 * CSRF 失败与「身份不够」在状态码上同形、在**消息**上可分（`CSRF 令牌…` vs `需要登录`）——
 * 用状态码区分会引入一个新的状态码语义，代价大于收益。
 *
 * ## 修复轮 1 / C-1：本文件每个 describe 一个自己的 Redis 容器
 *
 * 这些用例打的是真实 `/auth/login`（拿 403 来断言 CSRF），而**限流守卫排在 CSRF 之前**，
 * 因此每个请求都会真的写进 Redis 里的桶（登录层 `by: 'ip+account'`，5 次/15 分钟，
 * 桶键含固定邮箱 ⇒ 跨运行累积）。用测试进程默认的 compose Redis 时，
 * 同一刻钟内跑到第 6 次就会在 CSRF 之前被 429 掉——断言变成随机失败。
 * 每个 describe 一个一次性容器（`tests/helpers/redis.ts`）让预算从零开始：
 * 第一个 describe 用掉登录层 4 次、注册层 1 次，都有余量。
 */

/**
 * `AuthService` 的替身，**只**用在与 CSRF 无关的正向用例里。
 *
 * 本文件验证的是「请求是否可信」，不是口令校验与会话落库（那两件事由 Task 6 的集成套件
 * 用真实 Redis + 真实 Argon2id 覆盖）。不替换的话，写请求会去连库/连 Redis，
 * 失败形态是 500——那会把「CSRF 放行了」与「基础设施没接上」压成同一个观察结果，
 * 断言就不再指向被测行为。
 */
const stubAuth = {
  register: async () => ({ sessionId: 'csrf-probe-session', userId: 'csrf-probe-user' }),
  login: async () => ({ sessionId: 'csrf-probe-session', userId: 'csrf-probe-user' }),
  logout: async () => undefined,
  me: async () => ({ id: 'csrf-probe-user' }),
} as unknown as AuthService;

/** 从 `set-cookie` 里取出某个 cookie 的值（测试侧解析，不引 express 的类型）。 */
function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const line = list.find((entry: string) => entry.startsWith(`${name}=`));
  if (!line) return undefined;
  return decodeURIComponent(line.slice(name.length + 1).split(';')[0] ?? '');
}

/** 从 `set-cookie` 里取出某个 cookie 的完整属性行。 */
function cookieLine(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((entry: string) => entry.startsWith(`${name}=`));
}

const SAFE = ['GET', 'HEAD', 'OPTIONS'] as const;

describe('CSRF 双提交令牌（威胁 #10 / C13）', () => {
  let app: INestApplication;
  let redis: TestRedis;

  beforeAll(async () => {
    redis = await startTestRedis();
    app = await createTestApp({
      withSecurity: true,
      overrides: [(b) => b.overrideProvider(REDIS).useValue(redis.newClient())],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
  });

  it('不带令牌的写操作被拒绝（403）', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'a@b.co', password: 'x'.repeat(12) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: 'CSRF 令牌缺失' });
  });

  it('令牌与 Cookie 不匹配时被拒绝', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      // 两个令牌**等长**（3 字节）：这一条走的正是 `timingSafeEqual` 的比较路径，
      // 而不是被前面的长度检查挡掉。长度不等的那条路径由下一条用例覆盖。
      .set('Cookie', `${CSRF_COOKIE}=aaa`)
      .set(CSRF_HEADER, 'bbb')
      .send({ email: 'a@b.co', password: 'x'.repeat(12) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: 'CSRF 令牌不匹配' });
  });

  it('令牌与 Cookie 长度不同时同样被拒绝（不进 timingSafeEqual）', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Cookie', `${CSRF_COOKIE}=short`)
      .set(CSRF_HEADER, 'a-much-longer-token')
      .send({ email: 'a@b.co', password: 'x'.repeat(12) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: 'CSRF 令牌不匹配' });
  });

  it('安全方法（GET）无需令牌', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  });

  it('所有写路由都受保护：逐一探测，无令牌一律 403，且拒绝来自 CSRF 而不是别的守卫', async () => {
    const routes = [
      { method: 'post', path: '/auth/register' },
      { method: 'post', path: '/auth/login' },
      { method: 'post', path: '/auth/logout' },
    ] as const;
    for (const r of routes) {
      // 自检：路列表里混进安全方法会让这条用例假装通过（CSRF 对它们本来就免检）。
      expect(SAFE.includes(r.method.toUpperCase() as never)).toBe(false);
      const res = await request(app.getHttpServer())[r.method](r.path).send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path} 未受 CSRF 保护`).toBe(403);
      // **只断言 403 是不够的**（修复轮 2 改正）：`/auth/logout` 是匿名请求，
      // 即使 CSRF 完全关掉，它也会被排在后面的 `PolicyGuard` 以 403 挡下
      // （`PolicyGuard` 同样用 403，见本文件头部「为什么拒绝是 403」），
      // 于是这一行**不判别任何东西**——它绿不绿与 CSRF 无关。
      // 三个写路由的守卫顺序都是 限流 → CSRF → 授权，因此「无令牌」被拒时
      // 消息必然是 CSRF 那两条之一；断言它，三行才都真正落在 CSRF 上。
      expect(
        res.body,
        `${r.method.toUpperCase()} ${r.path} 的 403 不是 CSRF 给出的（可能是 PolicyGuard 之类的下游守卫），这一行不判别 CSRF`,
      ).toMatchObject({ message: expect.stringMatching(/^CSRF 令牌(缺失|不匹配)$/) });
    }
  });

  /**
   * 修复轮 1 / C-2：全局守卫与可注入的 `CsrfGuard` 必须是**同一个实例**。
   *
   * ## 为什么这条断言是**行为**证明，而不是 `app.get(CsrfGuard) === app.get(APP_GUARD)`
   *
   * `app.get(APP_GUARD)` 取不到东西（实测抛 `Nest could not find APP_GUARD element`，
   * 见 `policy-default-deny.test.ts` 的同一处说明）。所以这里换一个能观察的方向：
   * 只在**注入到的那个实例**上包一层计数，然后发一个真实请求。
   *
   * `useExisting` ⇒ 拦请求的就是它 ⇒ 计数为 1；
   * `useClass` ⇒ Nest 为 `APP_GUARD` 另造了一个实例，包在旧实例上的计数器**永远是 0**
   * （而请求照样 403，所以「只看状态码」区分不出来——这正是这类缺陷难查的原因）。
   */
  it('全局守卫就是 SecurityModule 导出的那个实例（C-2：useExisting 而不是 useClass）', async () => {
    const injected = app.get(CsrfGuard);
    const calls = vi.fn();
    const original = injected.canActivate.bind(injected);
    injected.canActivate = (context: ExecutionContext): boolean => {
      calls();
      return original(context);
    };

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      // 换一个邮箱：`by: 'ip+account'` 的桶键含账号，避免与本文件前几条用例共用桶
      // （登录层 5 次/15 分钟，前四条已经用掉 4 次）。
      .send({ email: 'csrf-same-instance@example.com', password: 'x'.repeat(12) });

    expect(res.status).toBe(403); // 保护照旧生效
    expect(calls, '全局 CSRF 守卫不是注入到的那个实例（`useClass` 会另造一个）').toHaveBeenCalledTimes(1);
  });
});

/**
 * 正方向（**没有**这一组，上面的全绿只说明「写操作都用不了」）。
 */
describe('CSRF：令牌下发与放行（C13 的另一半）', () => {
  let app: INestApplication;
  let redis: TestRedis;

  beforeAll(async () => {
    // 与上一个 describe **各自的**容器：注册层 3 次/小时，两个 describe 各用掉 1 次，
    // 共用容器时只有 1 次余量，任何新用例都会以 429 的形式莫名其妙地红。
    redis = await startTestRedis();
    app = await createTestApp({
      withSecurity: true,
      // `overrideProvider` 必须在 `compile()` 之前：`createTestApp` 内部顺序已是如此。
      overrides: [
        (builder) => builder.overrideProvider(AuthService).useValue(stubAuth),
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
  });

  it('安全请求下发 vca_csrf cookie，且它必须**可被 JS 读取**（HttpOnly=false）', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    const line = cookieLine(res, CSRF_COOKIE);
    expect(line, `响应里没有 ${CSRF_COOKIE} cookie`).toBeDefined();
    // 双提交令牌的前提：前端能读到它并回填请求头。写成 HttpOnly 会让这条机制直接失效
    // （表现为「所有写操作 403，而会话 cookie 明明在」），且没有任何报错指向原因。
    expect(line).not.toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(cookieValue(res, CSRF_COOKIE)).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('带合法双提交令牌的写操作到达处理器（不再被 CSRF 拒）', async () => {
    const boot = await request(app.getHttpServer()).get('/health');
    const token = cookieValue(boot, CSRF_COOKIE);
    expect(token).toBeTruthy();

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .set('Cookie', `${CSRF_COOKIE}=${token}`)
      .set(CSRF_HEADER, String(token))
      .send({ email: 'csrf-ok@example.com', password: 'a-strong-passphrase' });
    // 201 = 处理器真的跑了（`register` 创建了资源）。CSRF 若仍然拒绝，这里是 403。
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ userId: 'csrf-probe-user' });
  });
});
