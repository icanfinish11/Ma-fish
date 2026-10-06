import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ROLES } from '@vca/shared';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';
import { createTestApp } from '../../helpers/app.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { disableRateLimit } from '../../helpers/rate-limit.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';

/**
 * **额度发放路由的越权矩阵**（P2 / Task 10；设计 §2.1 + §8.1 + §9；判据 11）。
 *
 * ## 为什么这条路由的授权面比别的路由更要紧
 *
 * 它是 P2 里**唯一一条外部可达的造钱路径**：`POST /ledger/credits` 能把 `EXTERNAL_TOPUP`
 * 记成负数、把用户可用余额记成正数——凭空创造额度。因此这里的判据不是「算术对不对」
 * （那是 `postings.test.ts` 的事），而是**授权面**：
 *
 * | 问题 | 由谁回答 |
 * |---|---|
 * | 「没声明策略的路由会不会被放行」 | `tests/security/policy-default-deny.test.ts`（探针路由） |
 * | 「每条已注册路由有没有声明」 | `tests/security/policy-route-coverage.test.ts`（覆盖率门） |
 * | **「这条路由在每种角色下到底放不放行」** | **本文件** |
 *
 * ## 四种角色（每一种都走**真实**路径，没有一处「削弱守卫」）
 *
 * - **匿名**：只有 CSRF 令牌（浏览器拿得到它），**没有**会话 cookie；
 * - **已登录非管理员**：真用户 + 真会话（`SessionService.create`），角色是 `USER`；
 * - **管理员**：`role = 'ADMIN'` 的**真**用户 + 真会话；
 * - **管理员同键重放**：同一个人、同一个幂等键、同一个金额 ⇒ 必须**不**再记一笔。
 *
 * 两个 `403` 的来源不同，判据按**响应体**把它们分开（只看状态码会把「没登录」与
 * 「登了但不是管理员」读成同一件事）：前者是 `需要登录`，后者是 `该资源未被授权访问`。
 *
 * ## 每个用例自带当事人（不依赖用例之间的执行顺序）
 *
 * 每个用例用**新**的**真实**目标用户（C1：`grantCredit` 的收款人必须存在于 `auth.users`）与
 * **新**的幂等键，因此 `-t` 单独点一条也能过。
 * 余额断言因此永远是「这一条注入之后的绝对值」，不是跨用例累加出来的数。
 *
 * ## 限流在**本文件**被显式关掉（复用 P0 的开关，不是发明一个）
 *
 * 这里打的是授权判定，而 `search` 层是 60 次/分钟；矩阵会把桶打满时状态码会变成 429
 * （那是限流在正常工作，不是越权结论）。`tests/helpers/rate-limit.ts` 的
 * `disableRateLimit` 是 P0 就有的那个开关，且它只替换 `ThrottlerStorage` 一个 provider——
 * 层定义、`skipIf`、分桶维度全部保持真身。这条路由的**限流归属**由
 * `tests/security/rate-limit-coverage.test.ts` 逐条断言（`rateLimit: 'search'`）。
 */
describe('越权矩阵：ledger 的额度发放路由 × 每个角色（§9 / 判据 11）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let csrf = '';
  /** 三个角色的 Cookie（会话 + CSRF 双提交令牌）。 */
  const cookies = { anonymous: '', stranger: '', admin: '' };

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    app = await createTestApp({
      overrides: [
        // 注意 `disableRateLimit` 是 **builder → builder** 的变换，因此它是 `overrides`
        // 数组里的一项，**不是** `disableRateLimit(app)` 这种调用形状。
        disableRateLimit,
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
      ],
    });
    csrf = await fetchCsrfToken(app);

    const sessions = app.get(SessionService);
    const login = async (userId: string): Promise<string> => {
      const { sessionId } = await sessions.create(userId, { ip: '127.0.0.1', userAgent: 'vitest' });
      return `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`;
    };
    const admin = await prisma.user.create({ data: { role: ROLES.ADMIN } });
    const stranger = await prisma.user.create({ data: { role: ROLES.USER } });
    cookies.admin = await login(admin.id);
    cookies.stranger = await login(stranger.id);
    // 「匿名」= 只带 CSRF 令牌，**不带**会话 cookie。
    cookies.anonymous = `${CSRF_COOKIE}=${csrf}`;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect().catch(() => undefined);
    await pg?.stop();
    await redis?.stop();
  });

  /**
   * 一个**真的**存在于 `auth.users` 的用户（C1：额度发放的收款人必须存在）。
   *
   * 本文件此前把 `uuidv7()` 当目标用户，并在「管理员 ⇒ 200 created=true」与那条重放用例里
   * 断言 `created:true`——**那正是把缺陷写成正确行为**（审查 C1）。拒绝那两条（匿名 / 非管理员）
   * 的目标用户是谁都不影响（守卫在处理器之前就拒了），但为了整份矩阵只有一种当事人形状，
   * 这里一律用真用户：这样「被拒绝不留行」那几句也不会因为目标用户不存在而变成同义反复。
   */
  async function realUser(): Promise<string> {
    const user = await prisma.user.create({ data: {} });
    return user.id;
  }

  /** 发一次额度发放（写路由必须带 CSRF 头，双提交令牌两处都要有）。 */
  function grant(cookie: string, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer()).post('/ledger/credits').set('Cookie', cookie).set(CSRF_HEADER, csrf).send(body);
  }

  /**
   * 负断言的**同伴证据**：同一形状的查询必须能对一次**已提交**的发放返回非零。
   *
   * 缺了它，「被拒的请求没有留下行」这句有两种解释：(a) 守卫真的在处理器之前拦下了；
   * (b) 那个查询根本匹配不到任何行（键名写错、表名写错）。只有让管理员真的发一次、
   * 再用同一形状查一次，才能把 (b) 排掉。这也是 `postings.test.ts` 的回滚用例里
   * 那句「接受方向」的同一处置。
   */
  async function countTransactionsFor(idempotencyKey: string): Promise<number> {
    return prisma.ledgerTransaction.count({ where: { idempotencyKey } });
  }

  it('匿名 ⇒ 403 需要登录（守卫要求身份，资源判定还没开始）', async () => {
    const target = await realUser();
    const key = `m-anon:${target}`;
    const res = await grant(cookies.anonymous, { userId: target, amount: '100', idempotencyKey: key });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(403);
    expect(res.body.message).toBe('需要登录');
    // 被拒的请求不留任何痕迹（守卫在处理器之前）。
    expect(await countTransactionsFor(key)).toBe(0);
  });

  it('已登录非管理员 ⇒ 403（条件 `ledgerAdminGrant` 为假），库里没有任何行', async () => {
    const target = await realUser();
    const key = `m-stranger:${target}`;
    const res = await grant(cookies.stranger, { userId: target, amount: '100', idempotencyKey: key });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(403);
    // 与「未登录」分开：这是**资源级判定为否**，不是身份缺失。
    expect(res.body.message).toBe('该资源未被授权访问');
    expect(await countTransactionsFor(key)).toBe(0);
    // ★ 同伴证据（同一查询形状，一次**被接受**的发放）：
    const control = await realUser();
    const controlKey = `m-stranger-control:${control}`;
    await grant(cookies.admin, { userId: control, amount: '100', idempotencyKey: controlKey }).expect(200);
    expect(await countTransactionsFor(controlKey), '那个查询形状本身是坏的（对已提交的发放也返回 0）').toBe(1);
  });

  it('管理员 ⇒ 200，created=true，余额增加（正面对照：矩阵不能「怎么都拒」）', async () => {
    const target = await realUser();
    const key = `m-admin:${target}`;
    const res = await grant(cookies.admin, { userId: target, amount: '100', idempotencyKey: key });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body).toMatchObject({ created: true, balance: '100' });
    // UUIDv7（C4）：形状判据，而不是「看起来像个 id」。
    expect(res.body.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await countTransactionsFor(key)).toBe(1);
  });

  it('管理员同键重放 ⇒ 200 created=false，余额**没有翻倍**，且只有一笔交易与一行审计', async () => {
    const target = await realUser();
    const key = `m-replay:${target}`;
    const first = await grant(cookies.admin, { userId: target, amount: '100', idempotencyKey: key }).expect(200);
    expect(first.body).toMatchObject({ created: true, balance: '100' });

    const replay = await grant(cookies.admin, { userId: target, amount: '100', idempotencyKey: key });

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ created: false, balance: '100' }); // ← 不是 200
    expect(replay.body.transactionId).toBe(first.body.transactionId); // 同一个交易，不是新的一笔
    expect(await countTransactionsFor(key)).toBe(1);
    expect(await prisma.auditLog.count({ where: { resourceId: first.body.transactionId as string } })).toBe(1);
    // 金额侧的独立判据：库里那一笔分录恰好两条（DR EXTERNAL_TOPUP / CR USER_AVAILABLE）。
    expect(await prisma.ledgerEntry.count({ where: { transactionId: first.body.transactionId as string } })).toBe(2);
  });
});
