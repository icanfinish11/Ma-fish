import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS, SessionService } from '@vca/api/modules/auth/session.service.js';
import { PasswordService } from '@vca/api/modules/auth/password.service.js';
import { currentContext } from '@vca/api/common/context/request-context.js';
import { Policy } from '@vca/api/common/policy/policy.decorator.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { GithubOauthService } from '@vca/api/modules/auth/github-oauth.service.js';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { Prisma } from '@vca/api/generated/prisma/client.js';
import type { User } from '@vca/api/generated/prisma/client.js';
import { createTestApp } from '../../helpers/app.js';
import { csrfHeaders, fetchCsrfToken } from '../../helpers/csrf.js';
import { disableRateLimit } from '../../helpers/rate-limit.js';

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
  $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
}

interface AuditRow {
  actorId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  traceId?: string | null;
  metadata?: unknown;
}

/**
 * 假 Prisma 的两个**可注入行为**，只为覆盖真实库才有、而内存数组天然没有的路径。
 *
 * 两者都不是「为了测试方便而放宽实现」，而是让测试能模拟**真实数据库确实会发生**的时序：
 * `create` 撞唯一约束（并发注册）、以及批量插入时审计行随业务行进同一个事务。
 */
interface FakePrismaBehaviour {
  /**
   * 唯一约束是否生效。**默认 `false`**：本文件绝大多数用例用的是「先查再建」的
   * 正常时序，让假实现也生效不会改变它们的结果（它们本来就不会插重复邮箱），
   * 但会让别的假设（例如误插）立刻暴露。需要竞态语义的用例显式打开。
   */
  uniqueEmail?: boolean;
  /**
   * `user.create` 之前执行的钩子（可抛错）。用来模拟「预检查与 `create` 之间，
   * 另一个并发请求已经插入了同一个邮箱」这一刻。
   */
  beforeUserCreate?: () => Promise<void> | void;
  /** 审计行是否随业务行一起落库（见 `runTx` 注释）。默认 `true`。 */
  auditInTransaction?: boolean;
}

function createFakePrisma(behaviour: FakePrismaBehaviour = {}): {
  prisma: PrismaService;
  users: User[];
  audits: AuditRow[];
} {
  const users: User[] = [];
  const audits: AuditRow[] = [];
  const auditInTransaction = behaviour.auditInTransaction ?? true;
  let seq = 0;
  // 事务期间**暂存**的审计行：只有 `$transaction` 正常返回才并入 `audits`。
  let stagedAudits: AuditRow[] = [];

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
        await behaviour.beforeUserCreate?.();
        // 唯一约束用**真实的** Prisma 错误类构造：`AuthService` 按 `code === 'P2002'` 识别，
        // 而这个对象是从应用实际使用的生成客户端里 `new` 出来的，不是手搓的 `{code:'P2002'}`。
        if (behaviour.uniqueEmail && users.some((u) => u.email === args.data.email)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
            code: 'P2002',
            clientVersion: '7.10.0',
            meta: { modelName: 'User', target: ['email'] },
          });
        }
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
        (auditInTransaction ? audits : stagedAudits).push(args.data);
        return args.data;
      },
    },
    $transaction: async (fn) => {
      // 真实的 `$transaction` 语义：回调正常返回才提交。**刻意不实现回滚**——
      // 假实现里没有「写一半」的中间态可回滚（数组 push 要么发生要么没发生），
      // 而回滚本身是 Prisma 的职责，由 Task 3 的真库用例覆盖。
      const result = await fn(impl as unknown as Prisma.TransactionClient);
      audits.push(...stagedAudits);
      stagedAudits = [];
      return result;
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
  /**
   * 双提交令牌（Task 7 / C13）：全局 `CsrfGuard` 要求**所有**写操作都带它。
   * 本文件里所有 `POST` 都通过 `csrfHeaders(csrf)` 带上「cookie + 请求头」这一对，
   * 与真实前端做的事逐字一致——CSRF 校验本身**没有**被关掉（见 `helpers/csrf.ts`）。
   */
  let csrf: string;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redisClient = newTestRedis(container.getConnectionUrl());
    fake = createFakePrisma();

    // Task 7 起这条引导走**共用**的 helper（`tests/helpers/app.ts`）：
    // 它跑真实 `AppModule` + 生产同款的安全中间件栈（每请求 nonce/helmet + cookie-parser）
    // + 全局守卫链（限流 → CSRF → 授权）。此前这里是**手抄**的一份引导
    // （`Test.createTestingModule` + 手工 `app.use(cookieParser())`），
    // 那份抄件不会随生产接线演进——评审点名过这种重复。
    //
    // `disableRateLimit`：本文件在**同一个 IP** 上注册十几个真实用户，而注册层是
    // 「3 次/小时，按 IP」——真实阈值下从第 4 次起会 429（限流按设计生效）。
    // 关掉的只是**这一个套件**的计数；限流本身由 `tests/security/rate-limit.test.ts`
    // 用真实存储断言（第 4 次注册必须 429）。理由与取舍见 `helpers/rate-limit.ts`。
    app = await createTestApp({
      extraModules: [WiringProbeModule],
      overrides: [
        disableRateLimit,
        (b) => b.overrideProvider(PrismaService).useValue(fake.prisma),
        (b) => b.overrideProvider(REDIS).useValue(redisClient),
      ],
      conditions: [{ name: 'alwaysAllow', fn: () => true }],
    });
    csrf = await fetchCsrfToken(app);
  }, 180_000);

  afterAll(async () => {
    await teardown(app, container);
  });

  it('已登录请求到达 /auth/me 返回 200（而非 fail-closed 的 403）', async () => {
    // 注册一个真实用户：走真实 Argon2id 哈希 + 真实 SessionService + 真 Redis
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .set(csrfHeaders(csrf))
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
      .set(csrfHeaders(csrf))
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
   * 区分「谁拦的」**靠的是响应体是守卫的措辞 `需要登录`**——这一条才有判别力。
   * `x-trace-id` **不**承担这个职责（修复轮 2 收窄上一版的过度声明）：
   * 它由 `TraceMiddleware` 写在请求最外层，即便会话中间件自己短路掉请求它**照样**会被回写，
   * 因此它只能证明「请求穿过了 trace 中间件」，不能证明「它穿过了会话中间件并到达守卫」。
   * 保留它是因为它还有第二个用途：钉住 trace 头在每个响应上都存在（Task 4 的契约）。
   */
  it('匿名请求下会话中间件放行，403 来自守卫（措辞可区分）', async () => {
    const res = await request(app.getHttpServer()).get('/__auth-wiring-probe').set('x-trace-id', 'trace-anon');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: '需要登录' });
    expect(res.headers['x-trace-id']).toBe('trace-anon');
  });

  it('会话 cookie：HttpOnly + SameSite=Lax + Path=/ + 7 天 Max-Age（C13）', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .set(csrfHeaders(csrf))
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
      .set(csrfHeaders(csrf))
      .send({ email: 'logout@example.com', password: 'a-strong-passphrase' });
    const cookies = reg.headers['set-cookie'] as unknown as string[];
    const sid = cookieValue(reg, SESSION_COOKIE);
    const SERVICE = app.get(SessionService);

    await expect(SERVICE.verify(sid)).resolves.not.toBeNull();

    const out = await request(app.getHttpServer()).post('/auth/logout').set(csrfHeaders(csrf, cookies));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    // 服务端记录已删（不是「只清了客户端 cookie」）
    await expect(SERVICE.verify(sid)).resolves.toBeNull();
    // 清 cookie 的响应头也带上（双保险）
    expect(String(out.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);

    // **审计里不得出现会话 id**（修复轮 2）：`audit_log` 是 append-only、不可 UPDATE/DELETE 的
    // 表，写进去就永久留档，而 `sessionId` 是完整的 bearer 凭证（C11）。
    // 归属人由 `actorId` 承载，`resourceId` 放的是**用户**。
    // 这一条同时给出「修复前后有区别」的证据：修复前这里会是那个 43 字符的会话 id。
    const logoutRow = fake.audits.find((a) => a.action === 'auth.logout');
    expect(logoutRow).toBeDefined();
    expect(logoutRow?.actorId).toBe(reg.body.userId);
    expect(logoutRow?.resourceId).toBe(reg.body.userId);
    expect(JSON.stringify(fake.audits)).not.toContain(sid);

    const after = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookies);
    expect(after.status).toBe(403);
  });

  it('重复邮箱注册返回 409，且不创建第二个用户', async () => {
    const body = { email: 'dup@example.com', password: 'a-strong-passphrase' };
    const first = await request(app.getHttpServer()).post('/auth/register').set(csrfHeaders(csrf)).send(body);
    expect(first.status).toBe(201);
    const usersAfterFirst = fake.users.length;
    const second = await request(app.getHttpServer()).post('/auth/register').set(csrfHeaders(csrf)).send(body);
    expect(second.status).toBe(409);
    expect(fake.users.length).toBe(usersAfterFirst);
  });

  /**
   * **check-then-create 的竞态**：并发注册同一个邮箱时，败者的 `create` 撞唯一约束并抛
   * Prisma `P2002`。`P2002` 不是 `HttpException`，若不显式映射，Nest 会回
   * `500 Internal server error`——一个客户端可触发的输入冲突被报成服务端故障，
   * 与 409 契约不一致，还凭空制造 500 告警。
   *
   * ## 这条用例为什么是**确定性**的，而不是「两个并发请求碰运气」
   *
   * 真正并发发两个请求既慢又不稳（取决于调度，可能两个都撞上预检查、也可能不撞），
   * 红/绿会随机器变化。这里改成**把竞态的那一瞬间直接摆出来**：在预检查返回 `null`
   * **之后**、`create` **之前**插入重复行——正是另一个请求在这两行之间提交。
   *
   * 三个条件都必须在同一次请求里成立，缺一不可，因此它测的确实是那条 catch 分支：
   * 1. 预检查必须**返回 null**，否则走的是上面那条 409 分支，根本到不了 `create`；
   * 2. `create` 必须**真的抛 P2002**（由假实现的 `uniqueEmail` 用真实 Prisma 错误类构造）；
   * 3. 响应必须是 **409 且消息与预检查逐字相同**（同因同果，不泄露走了哪条路径）。
   *
   * 为了排除「这一枪打空」的可能，本用例**单独编译一个应用**并断言每个前置条件：
   * 预检查被绕过（「竞争者」确实是在它之后写入的）、`create` 确实抛了 P2002、最终 409。
   * 本 describe 的主应用**不**开 `uniqueEmail`，因此其余用例的假数据库行为一字未变。
   */
  it('并发注册撞唯一约束：P2002 映射为 409（而不是 500）', async () => {
    const fakeRace = createFakePrisma({ uniqueEmail: true });
    const containerRace = await new RedisContainer('redis:7-alpine').start();
    const redisRace = newTestRedis(containerRace.getConnectionUrl());

    const body = { email: 'race@example.com', password: 'a-strong-passphrase' };
    // 「竞争者」：模拟另一个并发请求在本请求的预检查**之后**插入同一个邮箱。
    let preCheckMissed = false;
    let createThrew = false;
    fakeRace.users.push({
      id: '00000000-0000-7000-8000-0000000000ff',
      email: body.email,
      passwordHash: null,
      role: 'USER',
      creditScore: 100,
      createdAt: new Date('2026-10-04T00:00:00.000Z'),
      updatedAt: new Date('2026-10-04T00:00:00.000Z'),
    });

    // 手工替换方法（而不是 `vi.spyOn(...).mockImplementation(...)`）。
    // 两个原因，都是实测踩出来的：
    // ① `vi.spyOn(X).mockImplementation(fn)` 让 `fn` 的参数被推断成 `never`
    //    （Prisma 的方法是泛型重载，一个具体函数签名无法满足它），直接写是 TS2345；
    // ② 在 `mockImplementation` 里调用「原方法」时必须**先**把原方法绑定到局部变量，
    //    否则调用的是那个已被替换的属性——即自己，实测报
    //    `RangeError: Maximum call stack size exceeded`，整个 worker 以退出码 7 崩掉
    //    （不是一条红用例，而是套件不可用）。这里用一个可换的委托变量把这件事写死。
    type Delegating = (...args: never[]) => Promise<unknown>;
    const userTable = fakeRace.prisma.user as unknown as Record<string, Delegating>;
    const findOriginal = (fakeRace.prisma.user.findUnique as unknown as Delegating).bind(fakeRace.prisma.user);
    const createOriginal = (fakeRace.prisma.user.create as unknown as Delegating).bind(fakeRace.prisma.user);
    const findDelegate: { fn: Delegating } = { fn: findOriginal };
    const createDelegate: { fn: Delegating } = { fn: createOriginal };

    userTable.findUnique = async (args) => {
      // 只在**按邮箱查**的那次上放行一次「未命中」：那正是竞态窗口的入口。
      // （`findUnique` 还被 `me()` 用 id 查，不能一概返回 null。）
      if ((args as { where: { email?: string | null } }).where.email === body.email) {
        preCheckMissed = true;
        return null;
      }
      return findDelegate.fn(args);
    };
    userTable.create = async (args) => {
      try {
        return await createDelegate.fn(args);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') createThrew = true;
        throw err;
      }
    };

    const raceApp = await createTestApp({
      overrides: [
        (b) => b.overrideProvider(PrismaService).useValue(fakeRace.prisma),
        (b) => b.overrideProvider(REDIS).useValue(redisRace),
      ],
    });

    try {
      // 每个应用实例的令牌是独立的：raceApp 是另一个应用，必须重新取一次。
      const raceCsrf = await fetchCsrfToken(raceApp);
      const res = await request(raceApp.getHttpServer()).post('/auth/register').set(csrfHeaders(raceCsrf)).send(body);

      // 前置条件（防止这条用例静默地测了别的东西）：
      expect(preCheckMissed).toBe(true);
      expect(createThrew).toBe(true);
      // 断言本身：同因同果的 409，且不创建第二个用户
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ message: '该邮箱无法注册' });
      expect(fakeRace.users).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await raceApp.close();
      await containerRace.stop();
    }
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
      .set(csrfHeaders(csrf))
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
      .set(csrfHeaders(csrf))
      .send({ email: 'not-an-email', password: 'a-strong-passphrase' });
    expect(badEmail.status).toBe(400);

    // 空请求体同样不能变成 500，且要一次列全所有问题字段（运维不必「修一个报一个」）
    const empty = await request(app.getHttpServer()).post('/auth/login').set(csrfHeaders(csrf)).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['email', 'password']);
  });

  it('登录：正确口令 200 并下发新会话；错误口令 401 且不下发 cookie', async () => {
    const body = { email: 'login@example.com', password: 'a-strong-passphrase' };
    await request(app.getHttpServer()).post('/auth/register').set(csrfHeaders(csrf)).send(body);

    const bad = await request(app.getHttpServer())
      .post('/auth/login')
      .set(csrfHeaders(csrf))
      .send({ ...body, password: 'wrong-passphrase-here' });
    expect(bad.status).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();

    const ok = await request(app.getHttpServer()).post('/auth/login').set(csrfHeaders(csrf)).send(body);
    // **200 而不是 201**（修复轮 2）：登录没有创建可寻址资源，凭证在 Set-Cookie 里。
    // 这条断言此前把 201 钉死了——那正是「用测试把缺陷固化下来」的形态。
    // `register` 仍是 201（它确实新建了一个 User），见本文件第一条用例。
    expect(ok.status).toBe(200);
    const me = await request(app.getHttpServer()).get('/auth/me').set('Cookie', ok.headers['set-cookie'] as unknown as string[]);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'login@example.com' });
  });

  it('审计：登录成功/失败都留痕，且 traceId 取自请求上下文（Task 8 之前唯一的落库审计）', async () => {
    fake.audits.length = 0;
    const body = { email: 'audit@example.com', password: 'a-strong-passphrase' };
    await request(app.getHttpServer()).post('/auth/register').set(csrfHeaders(csrf)).send(body);
    await request(app.getHttpServer())
      .post('/auth/login')
      .set(csrfHeaders(csrf))
      .set('x-trace-id', 'trace-audit-login')
      .send(body);
    await request(app.getHttpServer()).post('/auth/login').set(csrfHeaders(csrf)).send({ ...body, password: 'nope-nope-nope' });

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

  /**
   * **本 describe 的最后一条**：它会把假的用户表清空（模拟「账号被删」）。
   * 放在这里而不是中间，是因为 `fake` 在整个 describe 内共享——
   * 清空用户表会让后面所有依赖已注册用户的用例一起变红，而那种红是指向测试自身的，
   * 不是产品缺陷。
   *
   * 语义：会话有效但**用户已不存在**时必须 401，而不是 200 空响应体。
   * `AuthService.me` 里 `findUnique` 可能返回 `null`，而 Nest 在处理器返回 `undefined` 时
   * 回的是 **200 + 空 body**——调用方拿到「成功但没有内容」，会继续认为自己已登录
   * 并渲染一张空白页。这条用例把那个分支钉住。
   */
  it('会话有效但用户已不存在：401（而非 200 空响应体）', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .set(csrfHeaders(csrf))
      .send({ email: 'ghost@example.com', password: 'a-strong-passphrase' });
    const cookies = reg.headers['set-cookie'] as unknown as string[];
    // 会话仍然有效（Redis 里还在）
    expect(await app.get(SessionService).verify(cookieValue(reg, SESSION_COOKIE))).not.toBeNull();
    // 但用户记录消失了（只在用户表里删，不清会话——这正是本用例要区分的状态）
    fake.users.length = 0;

    const res = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookies);
    expect(res.status).toBe(401);
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
  /** 本 describe 自己那个应用的双提交令牌（每个应用实例的令牌是独立的）。 */
  let csrf: string;

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

    const mod = await createTestApp({
      overrides: [
        (b) => b.overrideProvider(PrismaService).useValue(fake.prisma),
        (b) => b.overrideProvider(REDIS).useValue(redisClient),
      ],
    });
    app = mod;
    csrf = await fetchCsrfToken(app);

    // 建一个真实存在的用户（其口令哈希来自真实 Argon2id）
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .set(csrfHeaders(csrf))
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
      .set(csrfHeaders(csrf))
      .send({ email: 'nobody-here@example.com', password: 'a-strong-passphrase' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ message: '邮箱或密码不正确' });
    // 关键断言：即便用户不存在，哈希校验也被调用了一次
    expect(verifyCalls).toHaveLength(1);
    // 用的是**占位**哈希（不是数据库里的任何东西），参数与真实哈希逐位相同
    // ——若拿数据库里某个真实用户的哈希来「空跑」，就会把该用户的哈希暴露给任意邮箱的登录尝试。
    expect(verifyCalls[0]?.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  /**
   * **两次采样 → 三条采样取中位数**（修复轮 2）。
   *
   * 上一版每条路径只测**一次**、容差 25ms。假绿方向守得住（真有一条路径不走哈希时，
   * 差异是 60ms 量级），但**假红方向没有任何防护**：单次采样只要撞上一次 GC 停顿或
   * 宿主机抢占，差就超过 25ms，套件在负载高的 CI 上会随机变红——而随机变红的测试
   * 比没有测试更糟（它会训练人忽略红）。
   *
   * 现在每条路径采样 3 次取**中位数**：中位数对单次离群值免疫，而两条路径的结构性差异
   * （60ms）远大于中位数抖动（个位数 ms）。容差同时放宽到 40ms——
   * 仍然**低于**注入的 60ms 固定开销，因此「其中一条路径根本不走哈希」这种退化照旧会红。
   */
  it('「用户不存在」与「口令错误」两条路径耗时同阶（各 3 次取中位数，容差 40ms）', async () => {
    const password = 'a-strong-passphrase';
    const measure = async (email: string, pw: string): Promise<number> => {
      const t0 = performance.now();
      const res = await request(app.getHttpServer()).post('/auth/login').set(csrfHeaders(csrf)).send({ email, password: pw });
      const dt = performance.now() - t0;
      expect(res.status).toBe(401);
      return dt;
    };
    const median = async (email: string, pw: string): Promise<number> => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i += 1) samples.push(await measure(email, pw));
      samples.sort((a, b) => a - b);
      return samples[1] ?? 0;
    };

    const unknownUser = await median('still-nobody@example.com', password);
    const wrongPassword = await median('timing@example.com', 'definitely-wrong-pw');

    // 容差 40ms < 注入的 60ms：任一条路径退化成「不跑哈希」，中位数差就是 60ms 量级 ⇒ 变红。
    expect(Math.abs(unknownUser - wrongPassword)).toBeLessThan(40);
  });
});

/**
 * 这几段**不**手工编译模块：引导序列（testcontainer + `overrideProvider`
 * + `createNestApplication` + `cookieParser` + `app.init`）此前在本文件里抄了 4 份。
 *
 * **Task 7 补记**：任务开始时这里是「两份走 helper、两份仍手抄」。现在四份**全部**
 * 走 `createTestApp()`（`tests/helpers/app.ts`）——那正是评审点名过的重复引导。
 * 手工引导的另一半代价在这一轮暴露得很清楚：它不会随生产接线演进，
 * 于是 Task 7 装上全局 `CsrfGuard` 之后，手抄引导的那两段里的写请求**照样**按旧形态发，
 * 表现为一堆 403——故障定位的成本全落在「测试与生产不是同一个栈」这件事上。
 *
 * 为什么另外两个 describe 仍各自持有自己的 testcontainer（据实记录，不是漏改）：
 * 它们验的是**不同的接线形态**——「认证管线接线」注入 `WiringProbeModule` 并给守卫注册
 * `alwaysAllow` 条件，「计时侧信道」在编译**之前** spy `PasswordService.prototype.verify`
 * 并需要一个空的 `verifyCalls`。把它们合并成一个 describe 会共享：
 * ① 一个应用与一份假 Prisma（其中有一条用例会**清空用户表**，
 * 因此它被刻意放在该 describe 的**最后**）；② `AuthController` 的注册限流会按 IP 计数。
 * 合并的收益远小于「一条用例污染其余用例」的风险——那正是最难查的测试缺陷。
 * 而且 testcontainer 的启动成本大部分被 vitest 的并行文件执行吸收
 * （实测新增一个容器对套件总时长的影响在秒级）。
 *
 * ② 那一项在 Task 7 已不再是隐患：主 describe 用 `disableRateLimit` 关掉了计数
 * （它注册十几个用户，而注册层是 3 次/小时按 IP），见 `helpers/rate-limit.ts`。
 * 「计时侧信道」describe 的注册/登录次数都在阈值以内，因此照旧带**真实**限流跑。
 */
describe('GitHub OAuth 服务的接线（不做外部网络调用）', () => {
  it('AuthModule 用 ConfigService 的凭据构造 GithubOauthService（no speculative fallback）', async () => {
    const container = await new RedisContainer('redis:7-alpine').start();
    const redisClient = newTestRedis(container.getConnectionUrl());
    const fake = createFakePrisma();
    const app = await createTestApp({
      overrides: [
        (b) => b.overrideProvider(PrismaService).useValue(fake.prisma),
        (b) => b.overrideProvider(REDIS).useValue(redisClient),
      ],
    });
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
    const app = await createTestApp({
      overrides: [
        (b) => b.overrideProvider(PrismaService).useValue(fake.prisma),
        (b) => b.overrideProvider(REDIS).useValue(redisClient),
      ],
    });
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
