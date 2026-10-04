import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { AppModule } from '@vca/api';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS, SessionService } from '@vca/api/modules/auth/session.service.js';
import { PasswordService } from '@vca/api/modules/auth/password.service.js';
import { currentContext } from '@vca/api/common/context/request-context.js';
import { PolicyGuard } from '@vca/api/common/policy/policy.guard.js';
import { Policy } from '@vca/api/common/policy/policy.decorator.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { GithubOauthService } from '@vca/api/modules/auth/github-oauth.service.js';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import type { User } from '@vca/api/generated/prisma/client.js';

/**
 * 认证管线的**端到端接线**验证（本任务 Step 0 的交付物，不在 brief 里）。
 *
 * ## 为什么这个文件必须存在
 *
 * Task 5 的 `PolicyGuard` 对**任何**非 `@Public()` 声明都要求身份（方案 B），
 * 而 `/auth/me`、`/auth/logout` 声明的正是**无 condition** 的策略
 * （`@Policy({ resource: 'Session', action: 'read' })`）。因此在 Task 6 之前，
 * 这两条路由对**任何**请求都返回 403——包括带着合法会话的请求。
 *
 * 把身份填进 `RequestContext` 的中间件就是这里要验证的东西。它一旦缺失或顺序错位，
 * 表现不是「报错」而是**静默 403**，所以必须有一条会红的断言钉住它。
 *
 * ## 为什么跑真实 `AppModule` 而不是照抄一份接线
 *
 * 中间件顺序由 `AppModule.configure` 决定（`TraceMiddleware` 在前、`SessionMiddleware` 在后），
 * 照抄一份等于把「生产接线是否正确」换成「抄件是否正确」。这里 `imports: [AppModule]`，
 * 只把**两个外部依赖**换掉：
 *
 * - `PrismaService` → 内存假实现（本文件验证的是会话/鉴权/中间件，不是 Prisma 的 SQL；
 *   Task 3 的 schema 与双角色权限已由 `tests/integration/db/**` 覆盖）。
 *   用假实现也带来了一个真实库给不了的能力：能直接断言 `AuditService.record` 究竟写了什么。
 * - `REDIS` → **真** Redis testcontainer。会话、TTL、滑动过期在这里都是真语义，
 *   用假 Redis 会把「会话真的过期了吗」变成「我实现的假对象说了算吗」。
 *
 * `AuthController`、`AuthService`、`SessionService`、`AuditService`、`PolicyGuard`、
 * cookie-parser 与两个中间件**全部是真的**，走的也是真实 HTTP 管线。
 *
 * ## 时间安全的登录路径怎么验
 *
 * `AuthService.login` 在用户不存在时也要执行一次哈希校验（避免计时侧信道）。
 * 断言「哈希被调用过」需要观察 `PasswordService`，因此这里另起一个只覆盖
 * **该方法**的 spy 应用（见最后一个 describe），不干扰上面那些走真实哈希的用例。
 */

/**
 * 关停顺序：`app.close()` → 容器 stop。**测试不自己关那条 Redis 连接。**
 *
 * 为什么不让测试 `quit()`：`overrideProvider(REDIS)` 把这个客户端交给了应用，
 * 因此它的生命周期属于应用——`app.close()` 会触发 `RedisLifecycle.onApplicationShutdown`
 * 去 `quit()` 它。测试再关一次是**重复关闭**，而重复关闭的报错很难看：
 * 实测 `status` 在那一刻仍是 `'ready'`（ioredis 只是在 `closeHandler` 里**排队**
 * 一条 `quit` 命令），于是第二发 `quit()` 排进去的命令被 `flushQueue` 以
 * **`Error: Connection is closed.`** 拒绝——表现为 15 条用例全绿、suite 级红、退出码 1。
 *
 * 顺序不能反：`container.stop()` 必须在 `app.close()` **之后**。反过来会让应用在
 * 关停时对着一个已经消失的 Redis 发 `QUIT`（虽然已被 `RedisLifecycle` 兜住，
 * 但那是在测试一个不该发生的场景）。
 *
 * 容器必须**显式**停：它不属于应用，没有钩子会替你收。
 */
async function teardown(app: INestApplication | undefined, container: StartedRedisContainer | undefined): Promise<void> {
  await app?.close();
  await container?.stop();
}

/**
 * 测试态 Redis 客户端：**关掉自动重连**（`retryStrategy: () => null`）。
 *
 * 为什么必须关：容器在 `teardown` 里被停掉之后，ioredis 默认会不断重连，而第一次重连
 * 的 `INFO`（ready check）正好写向一个已经消失的 socket，于是打出
 * `[ioredis] Unhandled error event: Error: write EPIPE`。实测它**不影响任何断言**
 * （32 条全绿），但会污染输出——而本仓库要求输出 pristine，理由很实际：
 * 一个总是伴随失败噪音的套件，真正的失败就淹在里面了。
 *
 * 关掉重连之后，「容器没了 ⇒ 客户端放弃」是安静且确定的。
 * 生产侧不这样设：运行期 Redis 抖动时**必须**重连（那正是 `RedisLifecycle` 之外的默认行为）。
 */
function newTestRedis(url: string): Redis {
  const client = new Redis(url, { retryStrategy: () => null, maxRetriesPerRequest: 1 });
  // 显式接管 `error` 事件：ioredis 在**没有**监听者时会把错误打成
  // `[ioredis] Unhandled error event: …`（见其 `silentEmit`）。
  // 本文件里唯一会出现的这类错误是「容器已停、客户端还在收尾」——它是**预期**的收尾噪音，
  // 不该被当成未处理错误。接住它，但把**非预期**的错误照旧打到 stderr，
  // 免得这个监听器变成把所有连接问题都吞掉的静音开关。
  client.on('error', (err: Error) => {
    if (!/EPIPE|ECONNRESET|Connection is closed/.test(err.message)) {
      process.stderr.write(`[test-redis] ${err.message}\n`);
    }
  });
  return client;
}

/** 会话 cookie 的字段形状（超集断言，避免把 express 的 CookieOptions 抄进测试）。 */
interface SetCookieFlags {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string | boolean;
  path?: string;
  maxAge?: number;
}

/** 从 `set-cookie` 响应头里取出某个 cookie 的完整属性。 */
function readSetCookie(res: request.Response, name: string): SetCookieFlags {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const line = list.find((c: string) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`响应里没有 ${name} cookie（实际：${list.join(' | ') || '无'}）`);
  const attrs: Record<string, string | true> = {};
  for (const part of line.split(';').slice(1)) {
    const [k, v] = part.trim().split('=');
    if (k) attrs[k.toLowerCase()] = v ?? true;
  }
  return {
    httpOnly: 'httponly' in attrs,
    secure: 'secure' in attrs,
    sameSite: attrs.samesite as string | undefined,
    path: attrs.path as string | undefined,
    maxAge: attrs['max-age'] === undefined ? undefined : Number(attrs['max-age']),
  };
}

/** 从 `set-cookie` 里取出 cookie 的**值**（会话 id）。 */
function cookieValue(res: request.Response, name: string): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const line = list.find((c: string) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`响应里没有 ${name} cookie`);
  return decodeURIComponent(line.slice(name.length + 1).split(';')[0] ?? '');
}

/**
 * 内存版 Prisma（**只实现本任务真正调用到的方法**，见 `UsedPrisma` 的类型约束）。
 *
 * `UsedPrisma` 依赖 `Pick<PrismaService, …>`：`AuthService` 将来若改用别的方法（或换签名），
 * 这里的实现类型会先红——而不是测试静默地继续用假数据通过。真实库的语义由
 * `tests/integration/db/**` 覆盖，这里只负责「登录/注册这条链路的编排」。
 */
interface UsedPrisma {
  user: {
    findUnique: (args: { where: { id?: string; email?: string | null }; select?: unknown }) => Promise<unknown>;
    create: (args: { data: { email?: string | null; passwordHash?: string | null } }) => Promise<User>;
  };
  auditLog: {
    create: (args: { data: AuditRow }) => Promise<unknown>;
  };
}

interface AuditRow {
  actorId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  traceId?: string | null;
  metadata?: unknown;
}

function createFakePrisma(): { prisma: PrismaService; users: User[]; audits: AuditRow[] } {
  const users: User[] = [];
  const audits: AuditRow[] = [];
  let seq = 0;

  const impl: UsedPrisma = {
    user: {
      findUnique: async (args) => {
        const { id, email } = args.where;
        const hit = users.find((u) => (id !== undefined ? u.id === id : u.email === email)) ?? null;
        if (!hit) return null;
        // **必须实现 `select` 的投影语义。** 这不是细节：真实的 Prisma 会按 `select`
        // 裁剪字段，而一个忽略它的假实现会把**全部列**（含 `passwordHash`）交回调用方——
        // 于是「口令哈希是否被泄露到 `/auth/me` 的响应里」这件事就永远测不出来，
        // 假实现本身成了泄露源。实测踩到过：本文件的第一版正是这样，
        // `/auth/me` 的响应体里带着完整的 Argon2id 哈希。
        if (args.select) {
          const keys = Object.keys(args.select as Record<string, boolean>);
          return Object.fromEntries(keys.map((k) => [k, (hit as Record<string, unknown>)[k]]));
        }
        return hit;
      },
      create: async (args) => {
        seq += 1;
        const now = new Date('2026-10-04T00:00:00.000Z');
        const user: User = {
          id: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
          email: args.data.email ?? null,
          passwordHash: args.data.passwordHash ?? null,
          role: 'USER',
          creditScore: 100,
          createdAt: now,
          updatedAt: now,
        };
        users.push(user);
        return user;
      },
    },
    auditLog: {
      create: async (args) => {
        audits.push(args.data);
        return args.data;
      },
    },
  };

  // 唯一的类型逃逸点，且是**刻意的**：`PrismaService` 的方法签名是 Prisma 的泛型重载
  // （`XOR<CreateInput, UncheckedCreateInput>` + 每查询的 `select/include` 推导），
  // 手写一个结构化假实现无法在不抄整套泛型的情况下与之兼容。`as unknown as` 把
  // 「这里只实现了一部分」这件事限制在**一个**表达式里；上面 `UsedPrisma` 的成员签名
  // 仍然与调用点逐字对应，所以 `AuthService` 一旦改用别的方法，这里会先红。
  const prisma = impl as unknown as PrismaService;
  return { prisma, users, audits };
}

/**
 * 探针路由：把**处理器内部**读到的上下文回显出来。
 *
 * 它同时承担两件事：
 * 1. 证明身份确实被写进了 ALS（`userId` 有值），而不是被守卫从别处拿到；
 * 2. 证明 `traceId` 在被 SessionMiddleware 改写后**仍然存在且未被重置**
 *    ——若两个中间件的顺序写反，处理器读到的 `traceId` 会是 `undefined`
 *    （SessionMiddleware 自己 `run({sessionId})` 的上下文里没有它）。
 *
 * 用条件 `alwaysAllow` 而不是无 condition 的声明：本探针要验的是「身份进了上下文」，
 * 若用无 condition 声明，未认证时会被守卫以「需要登录」提前拦掉，反而看不到上下文的真值。
 * 条件注册在**注入进来的那个守卫实例**上（`useExisting` 接线，见 `app.module.ts`）。
 */
@Controller('__auth-wiring-probe')
class WiringProbeController {
  @Policy({ resource: 'Session', action: 'read', condition: 'alwaysAllow' })
  @Get()
  probe(): { userId?: string; sessionId?: string; traceId?: string } {
    const ctx = currentContext();
    return { userId: ctx?.userId, sessionId: ctx?.sessionId, traceId: ctx?.traceId };
  }
}

@Module({ controllers: [WiringProbeController] })
class WiringProbeModule {}

describe('认证管线接线（Step 0：会话中间件 + 顺序）', () => {
  let container: StartedRedisContainer;
  let redisClient: Redis;
  let app: INestApplication;
  let fake: ReturnType<typeof createFakePrisma>;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redisClient = newTestRedis(container.getConnectionUrl());
    fake = createFakePrisma();

    const mod = await Test.createTestingModule({ imports: [AppModule, WiringProbeModule] })
      .overrideProvider(PrismaService)
      .useValue(fake.prisma)
      .overrideProvider(REDIS)
      .useValue(redisClient)
      .compile();
    app = mod.createNestApplication();
    // 与 `main.ts` 逐字一致：`/auth/**` 的处理器读 `req.cookies`，没有这一步全会 401。
    // （顺序不是承重点：`app.use` 注册在 Nest 中间件链**之前**，已由下一个用例断言
    //   SessionMiddleware 确实读到了 cookie。）
    const { default: cookieParser } = await import('cookie-parser');
    app.use(cookieParser());
    app.get(PolicyGuard).registerCondition('alwaysAllow', () => true);
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await teardown(app, container);
  });

  it('已登录请求到达 /auth/me 返回 200（而非 fail-closed 的 403）', async () => {
    // 注册一个真实用户：走真实 Argon2id 哈希 + 真实 SessionService + 真 Redis
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'me-200@example.com', password: 'a-strong-passphrase' });
    expect(reg.status).toBe(201);

    const res = await request(app.getHttpServer()).get('/auth/me').set('Cookie', reg.headers['set-cookie'] as unknown as string[]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'me-200@example.com', role: 'USER', creditScore: 100 });

    // 返回面**恰好**是 AuthService.me 里 `select` 的那四个字段。
    // 用精确的键集合而不是「不含某几个词」：后者只能挡住已知的泄露字段，
    // 前者能挡住「select 被删掉后 Prisma 返回整行」——那正是把 `passwordHash` 送出去的方式。
    // 实测踩到过：本文件的内存假实现起初忽略 `select`，响应体里真的带着 Argon2id 哈希。
    expect(Object.keys(res.body).sort()).toEqual(['creditScore', 'email', 'id', 'role']);
    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('匿名请求访问 /auth/me 返回 403（无 condition 的声明要求身份，方案 B）', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: '需要登录' });
  });

  it('伪造 / 过期的会话 cookie 一律视为匿名（403，且不抛错）', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me').set('Cookie', `${SESSION_COOKIE}=forged-not-a-real-session`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: '需要登录' });
  });

  it('会话中间件把 userId/sessionId 写进上下文，且 traceId 存活（中间件顺序）', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'probe@example.com', password: 'a-strong-passphrase' });
    const cookies = reg.headers['set-cookie'] as unknown as string[];
    const sid = cookieValue(reg, SESSION_COOKIE);

    // 调用方传入的 trace id：它必须**原样**出现在处理器读到的上下文里。
    // 若两个中间件顺序写反（SessionMiddleware 在外层），处理器会看到 undefined ——
    // 因为 SessionMiddleware 若要自己 run 一个上下文，那个上下文里只有 sessionId。
    const res = await request(app.getHttpServer())
      .get('/__auth-wiring-probe')
      .set('x-trace-id', 'trace-step0-ordering')
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      traceId: 'trace-step0-ordering',
      sessionId: sid,
    });
    expect(res.body.userId).toMatch(/^[0-9a-f-]{36}$/);
    // 响应头也要回显同一个 id（TraceMiddleware 的既有契约）
    expect(res.headers['x-trace-id']).toBe('trace-step0-ordering');
  });

  /**
   * 匿名请求下**会话中间件必须放行**，最终 403 来自守卫而不是它。
   *
   * 探针路由声明了 `condition: 'alwaysAllow'`，而 `PolicyGuard` 对**任何**非 `@Public()`
   * 的声明都先要求身份（方案 B），因此匿名的正确结果是 403——这不是中间件在拦。
   *
   * 区分「谁拦的」靠两条可观测证据，而不是靠读代码：
   * 1. 响应体是守卫的措辞 `需要登录`（若中间件自己抛错，会是 500 或另一条消息）；
   * 2. `x-trace-id` **照常回写**——说明请求正常穿过 `TraceMiddleware` 与
   *    `SessionMiddleware` 到达了守卫。中间件若「自己 403」，第 2 条仍可能成立，
   *    所以第 1 条不可省；两条一起才能把「中间件不参与授权判定」这件事钉住。
   */
  it('匿名请求下会话中间件放行，403 来自守卫（措辞与 trace 头可区分）', async () => {
    const res = await request(app.getHttpServer()).get('/__auth-wiring-probe').set('x-trace-id', 'trace-anon');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: '需要登录' });
    expect(res.headers['x-trace-id']).toBe('trace-anon');
  });

  it('会话 cookie：HttpOnly + SameSite=Lax + Path=/ + 7 天 Max-Age（C13）', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'cookie-flags@example.com', password: 'a-strong-passphrase' });
    const flags = readSetCookie(reg, SESSION_COOKIE);

    expect(flags.httpOnly).toBe(true);
    // express 把 `sameSite` 归一成首字母大写的 `Lax`，因此比较时忽略大小写——
    // 这条断言要钉的是「值是 lax」，不是「express 的大小写风格」。
    expect(String(flags.sameSite).toLowerCase()).toBe('lax');
    expect(flags.path).toBe('/');
    // `Max-Age` 的单位是**秒**（express 把 `maxAge` 选项的毫秒换算成秒再写头），
    // 所以这里断言的是 7 天 = 604800 秒，而不是毫秒。
    expect(flags.maxAge).toBe(7 * 24 * 3600);
    // 测试环境非 HTTPS：`secure` 关掉，否则本地开发根本收不到 cookie。
    // 生产必须为 true（由 `sessionCookieOptions(isProduction)` 的另一个分支覆盖，见单测）。
    expect(flags.secure).toBe(false);
    // 响应体里没有令牌：会话 id 只在 HttpOnly cookie 里（C13「不得用 localStorage」）
    expect(JSON.stringify(reg.body)).not.toContain(cookieValue(reg, SESSION_COOKIE));
  });

  it('登出后会话在服务端被销毁，同一 cookie 不再可用', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'logout@example.com', password: 'a-strong-passphrase' });
    const cookies = reg.headers['set-cookie'] as unknown as string[];
    const sid = cookieValue(reg, SESSION_COOKIE);
    const SERVICE = app.get(SessionService);

    await expect(SERVICE.verify(sid)).resolves.not.toBeNull();

    const out = await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookies);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    // 服务端记录已删（不是「只清了客户端 cookie」）
    await expect(SERVICE.verify(sid)).resolves.toBeNull();
    // 清 cookie 的响应头也带上（双保险）
    expect(String(out.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);

    const after = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookies);
    expect(after.status).toBe(403);
  });

  it('重复邮箱注册返回 409，且不创建第二个用户', async () => {
    const body = { email: 'dup@example.com', password: 'a-strong-passphrase' };
    const first = await request(app.getHttpServer()).post('/auth/register').send(body);
    expect(first.status).toBe(201);
    const usersAfterFirst = fake.users.length;
    const second = await request(app.getHttpServer()).post('/auth/register').send(body);
    expect(second.status).toBe(409);
    expect(fake.users.length).toBe(usersAfterFirst);
  });

  /**
   * 非法入参必须是 **400**，不能是 500（实测修复的缺陷）。
   *
   * 为什么这条值得单独占一个用例：`ZodError` 不是 `HttpException`，若直接在控制器里
   * `schema.parse(body)`，Nest 的默认异常过滤器会把它当成**未预期错误**回
   * `500 Internal server error`。实测三种非法输入（口令过短、邮箱格式错、请求体为空）
   * 全部是 500。
   *
   * 后果具体而不只是「状态码不好看」：一个脚本刷弱口令就能持续制造 500 告警；
   * 客户端拿到 `Internal server error` 无从知道是哪个字段错了；而「口令至少 12 位」
   * 这条约束在对外契约上等于不存在。变异探针见任务报告（把 `parseOrBadRequest`
   * 换回 `schema.parse` 时本用例变红）。
   */
  it('非法入参返回 400 并指出出错字段，而不是 500', async () => {
    const weak = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'weak@example.com', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.message).toBe('请求参数校验失败');
    expect(weak.body.errors).toContainEqual(
      expect.objectContaining({ path: 'password' }),
    );
    // 回显里**不得**出现用户提交的口令本身（C11 的边界）
    expect(JSON.stringify(weak.body)).not.toContain('short');

    const badEmail = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'a-strong-passphrase' });
    expect(badEmail.status).toBe(400);

    // 空请求体同样不能变成 500，且要一次列全所有问题字段（运维不必「修一个报一个」）
    const empty = await request(app.getHttpServer()).post('/auth/login').send({});
    expect(empty.status).toBe(400);
    expect(empty.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['email', 'password']);
  });

  it('登录：正确口令 200 并下发新会话；错误口令 401 且不下发 cookie', async () => {
    const body = { email: 'login@example.com', password: 'a-strong-passphrase' };
    await request(app.getHttpServer()).post('/auth/register').send(body);

    const bad = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ ...body, password: 'wrong-passphrase-here' });
    expect(bad.status).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();

    const ok = await request(app.getHttpServer()).post('/auth/login').send(body);
    expect(ok.status).toBe(201);
    const me = await request(app.getHttpServer()).get('/auth/me').set('Cookie', ok.headers['set-cookie'] as unknown as string[]);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'login@example.com' });
  });

  it('审计：登录成功/失败都留痕，且 traceId 取自请求上下文（Task 8 之前唯一的落库审计）', async () => {
    fake.audits.length = 0;
    const body = { email: 'audit@example.com', password: 'a-strong-passphrase' };
    await request(app.getHttpServer()).post('/auth/register').send(body);
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('x-trace-id', 'trace-audit-login')
      .send(body);
    await request(app.getHttpServer()).post('/auth/login').send({ ...body, password: 'nope-nope-nope' });

    const actions = fake.audits.map((a) => a.action);
    expect(actions).toContain('auth.register');
    expect(actions).toContain('auth.login');
    expect(actions).toContain('auth.login_failed');

    const login = fake.audits.find((a) => a.action === 'auth.login');
    // traceId 由 `AuditService.record` 从 `currentContext()` 盖戳：这条同时证明
    // 「审计拿得到请求上下文」与「中间件建立的那个上下文贯穿到了 handler 之后」
    expect(login?.traceId).toBe('trace-audit-login');
    expect(login?.resource).toBe('User');
    expect(login?.resourceId).toBeTruthy();

    // C11：失败审计里的邮箱不能原样落库
    const failed = fake.audits.find((a) => a.action === 'auth.login_failed');
    expect(JSON.stringify(failed?.metadata ?? {})).not.toContain('audit@example.com');
    // 审计行里绝不出现口令或口令哈希
    expect(JSON.stringify(fake.audits)).not.toContain('a-strong-passphrase');
    expect(JSON.stringify(fake.audits)).not.toContain('argon2');
  });

  it('断言真的落在可注入的 PrismaService 上（override 生效，而不是连了库）', async () => {
    // 没有这条，上面所有 `fake.users` 断言都可能是在断言一个**没人用过**的数组。
    expect(app.get(PrismaService)).toBe(fake.prisma);
    expect(app.get(REDIS)).toBe(redisClient);
  });
});

describe('登录的计时侧信道（§4.2 / 威胁 #13）', () => {
  let container: StartedRedisContainer;
  let redisClient: Redis;
  let app: INestApplication;
  let fake: ReturnType<typeof createFakePrisma>;
  const verifyCalls: { hash: string; plain: string }[] = [];

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redisClient = newTestRedis(container.getConnectionUrl());
    fake = createFakePrisma();

    // 只替换 `verify` 一个方法：其余（哈希、会话、审计、守卫）全真。
    // 每次校验固定睡 60ms，让「有没有走哈希」变成一个可观测的**量**，而不是靠读代码判断。
    const spy = vi.spyOn(PasswordService.prototype, 'verify').mockImplementation(async (hash, plain) => {
      verifyCalls.push({ hash, plain });
      await new Promise((r) => setTimeout(r, 60));
      return hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$') && plain === 'a-strong-passphrase';
    });

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(fake.prisma)
      .overrideProvider(REDIS)
      .useValue(redisClient)
      .compile();
    app = mod.createNestApplication();
    const { default: cookieParser } = await import('cookie-parser');
    app.use(cookieParser());
    await app.init();

    // 建一个真实存在的用户（其口令哈希来自真实 Argon2id）
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'timing@example.com', password: 'a-strong-passphrase' });
    expect(reg.status).toBe(201);
    verifyCalls.length = 0;
    spy.mockClear();
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await teardown(app, container);
  });

  it('用户不存在时**同样**执行一次口令校验（不是 `if (!user) return`）', async () => {
    verifyCalls.length = 0;
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody-here@example.com', password: 'a-strong-passphrase' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ message: '邮箱或密码不正确' });
    // 关键断言：即便用户不存在，哈希校验也被调用了一次
    expect(verifyCalls).toHaveLength(1);
    // 用的是**占位**哈希（不是数据库里的任何东西），参数与真实哈希逐位相同
    // ——若拿数据库里某个真实用户的哈希来「空跑」，就会把该用户的哈希暴露给任意邮箱的登录尝试。
    expect(verifyCalls[0]?.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('「用户不存在」与「口令错误」两条路径耗时同阶（真实 HTTP，允许 ≥25ms 抖动）', async () => {
    // 用真实的 60ms 固定开销把两条路径的**结构性**差异放大：若其中一条根本不走哈希，
    // 差异就是 60ms 量级，远大于下面 25ms 的容差；反之两条都走哈希时差异≈0。
    const password = 'a-strong-passphrase';
    const measure = async (email: string, pw: string): Promise<number> => {
      const t0 = performance.now();
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: pw });
      const dt = performance.now() - t0;
      expect(res.status).toBe(401);
      return dt;
    };

    const unknownUser = await measure('still-nobody@example.com', password);
    const wrongPassword = await measure('timing@example.com', 'definitely-wrong-pw');

    expect(Math.abs(unknownUser - wrongPassword)).toBeLessThan(25);
  });
});

describe('GitHub OAuth 服务的接线（不做外部网络调用）', () => {
  it('AuthModule 用 ConfigService 的凭据构造 GithubOauthService（no speculative fallback）', async () => {
    const container = await new RedisContainer('redis:7-alpine').start();
    const redisClient = newTestRedis(container.getConnectionUrl());
    const fake = createFakePrisma();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(fake.prisma)
      .overrideProvider(REDIS)
      .useValue(redisClient)
      .compile();
    const app = mod.createNestApplication();
    await app.init();
    try {
      const svc = app.get(GithubOauthService);
      // 凭据来自 env 夹具（GITHUB_CLIENT_ID=test-client-id / GITHUB_CALLBACK_URL=…）
      const url = new URL(svc.buildAuthorizeUrl('st', 'ch'));
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/github/callback');
      // 服务的私有字段不导出，这里改为断言「构造它需要凭据」——
      // 若 DI 把三个空串塞进去，上面的 client_id 就会是空串。
    } finally {
      await teardown(app, container);
    }
  }, 180_000);
});

describe('AuditService（Ruling 1：本任务交付的最小实现）', () => {
  it('record() 落一行 append-only 审计，traceId 取自当前上下文', async () => {
    const fake = createFakePrisma();
    const container = await new RedisContainer('redis:7-alpine').start();
    const redisClient = newTestRedis(container.getConnectionUrl());
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(fake.prisma)
      .overrideProvider(REDIS)
      .useValue(redisClient)
      .compile();
    const app = mod.createNestApplication();
    await app.init();
    try {
      const audit = app.get(AuditService);
      const { runInContext } = await import('@vca/api/common/context/request-context.js');

      await runInContext({ traceId: 'trace-audit-direct' }, () =>
        audit.record({ actorId: null, action: 'test.action', resource: 'Test', resourceId: 'r-1', metadata: { k: 1 } }),
      );

      expect(fake.audits).toHaveLength(1);
      expect(fake.audits[0]).toMatchObject({
        action: 'test.action',
        resource: 'Test',
        resourceId: 'r-1',
        traceId: 'trace-audit-direct',
        metadata: { k: 1 },
      });

      // 上下文之外调用不得抛错（启动期/定时任务会这样用），traceId 为 null
      await audit.record({ action: 'test.noctx', resource: 'Test' });
      expect(fake.audits[1]).toMatchObject({ action: 'test.noctx', traceId: null });
    } finally {
      await teardown(app, container);
    }
  }, 180_000);
});
