import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client } from 'pg';
import type { INestApplication } from '@nestjs/common';
import { ROLES, uuidv7 } from '@vca/shared';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';
import { LedgerService } from '@vca/api/modules/ledger/ledger.service.js';
import { TRANSACTION_KINDS } from '@vca/api/modules/ledger/core/types.js';
import { ACCOUNT_KINDS, type AccountKind } from '@vca/api/modules/ledger/core/account-kind.js';
import { UnknownAccountKindError } from '@vca/api/modules/ledger/core/errors.js';
import { createTestApp } from '../../helpers/app.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { disableRateLimit } from '../../helpers/rate-limit.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';

/**
 * 管理员额度发放路由的**端到端**判据（P2 / Task 10；§2.1 / §8.1 / C22）。
 *
 * ## 四条判据各自问的东西
 *
 * | 判据 | 用例 | 它挡的缺陷形态 |
 * |---|---|---|
 * | C22：金额在 HTTP 边界是十进制字符串，**`number` 一律拒绝** | ① ② | 预检 A.2 实测：`JSON.parse('{"a":9007199254740993}')` → `…992`，写库**成功、少 1 分、无异常** |
 * | D9/C26：幂等三态（新键 / 异腿 409 / 重放） | ③ ④ | 重试把同一笔发放记两次（外部可达的造钱路径上，这是最贵的缺陷） |
 * | D10/§13.2：审计可**完整重建**这次资金变动 | ⑤ | 「有审计行」但重建不出「谁发给了谁、多少」 |
 * | C30：§8.1 之外的 kind 必须由**应用**拒绝 | ⑥ | Task 9 实测：DB 的条件化 CHECK 枚举不了 kind，伪造 kind 只要非负就被放行并计入 Σ |
 *
 * ## 为什么响应体里**从不**出现 `bigint`
 *
 * `JSON.stringify(1n)` 直接抛 `TypeError`（预检 A.2），而 Nest 的响应链路对 `bigint`
 * 的行为是预检 §G.3 明确留白的**未验证面**。这条路由**结构性绕开**它：
 * 进出都是字符串（`formatMinorUnits` / `parseMinorUnits`），因此那条未验证面在 P2 里不可达。
 * 判别性见证见探针 `p-number-balance`（把 `formatMinorUnits(balance)` 换成 `Number(balance)`）。
 *
 * ## 装置
 *
 * 真 Postgres + 真 Redis；管理员是一个**真的** `role='ADMIN'` 用户，凭 `SessionService.create`
 * 造出的真会话 + 双提交 CSRF 令牌发请求（与 `tests/security/ledger/authz-matrix.test.ts`
 * 同一套手法，那条矩阵负责「四种角色各自放不放行」，本文件负责「放行之后发生的事」）。
 */
describe('额度发放路由：POST /ledger/credits（C22 / D9 / D10 / C30）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let csrf = '';
  let adminCookie = '';
  let adminId = '';

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    app = await createTestApp({
      overrides: [
        disableRateLimit,
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
      ],
    });
    ledger = app.get(LedgerService);
    csrf = await fetchCsrfToken(app);
    const admin = await prisma.user.create({ data: { role: ROLES.ADMIN } });
    adminId = admin.id;
    const { sessionId } = await app.get(SessionService).create(adminId, { ip: '127.0.0.1', userAgent: 'vitest' });
    adminCookie = `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect().catch(() => undefined);
    await pg?.stop();
    await redis?.stop();
  });

  /** 以管理员身份发一次额度发放。 */
  function post(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer()).post('/ledger/credits').set('Cookie', adminCookie).set(CSRF_HEADER, csrf).send(body);
  }

  /**
   * 一个**真的**存在于 `auth.users` 的用户（C1：发放的收款人必须存在）。
   *
   * 本文件此前把 `uuidv7()` 当目标用户——那正是 P2 最终审查 C1 指出的**被测试锁住的缺陷**：
   * 那些用例断言 200 / `created:true`，于是「给不存在的 uuid 发额度」被写成了正确行为。
   * 修好之后它们必须发给真用户（见下面那条 C1 用例的两个方向）。
   */
  async function realUser(): Promise<string> {
    const user = await prisma.user.create({ data: {} });
    return user.id;
  }

  it('★ 合同之内但**超出 int8** 的金额 ⇒ 400（不是 500）：I3 —— 声明的上界必须是库的上界', async () => {
    // ## 它挡的缺陷形态（P2 最终全分支审查 I3）
    //
    // `grantCreditsSchema` 的金额上限此前是 `MINOR_UNITS_MAX_DIGITS = 100`（一个**防 DoS**
    // 的位数上限），而 `accounts.balance` / `entries.amount` 都是 `BIGINT`（int8，上界
    // `9223372036854775807`，19 位）。于是「合同说可以、库说不行」的那一段被放进服务层，
    // 由 PostgreSQL 以 **22003** 拒绝，而 `ledger-error-map.ts` 没有这一档 ⇒
    // **唯一一条造钱路由上，一个调用方的输入错误变成 500**。
    //
    // 判据是「状态码 + 库里一行都没有」两件事。400（不是 422）：这是**调用方给的数不对**，
    // 与「库里的数据不可接受」是两回事（`ledger-error-map.ts` 的分档表）。
    const userId = await realUser();
    const key = `int8-over:${userId}`;
    const topupBefore = await prisma.ledgerAccount.findFirst({
      where: { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null },
      select: { balance: true },
    });
    const res = await post({ userId, amount: '9223372036854775808', idempotencyKey: key }); // int8 上界 + 1，19 位

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body.errors?.[0]?.path).toBe('amount');
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(await prisma.ledgerAccount.count({ where: { ownerUserId: userId } })).toBe(0);
    // 系统账户那一列也一分未动（契约拒绝发生在任何 SQL 之前）。
    expect(
      await prisma.ledgerAccount.findFirst({
        where: { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null },
        select: { balance: true },
      }),
    ).toEqual(topupBefore);
    // 20 位同样 400（旧的上限允许它进来，位数上限与存储上界是两条不同的界）。
    const wide = await post({ userId, amount: '12345678901234567890', idempotencyKey: `int8-wide:${userId}` });
    expect(wide.status, `status=${String(wide.status)} body=${JSON.stringify(wide.body)}`).toBe(400);
    expect(wide.body.errors?.[0]?.path).toBe('amount');

    // ★ 接受方向的同伴证据（同一形状的请求、同一条路由）：一个**在合同之内**的金额照常 200。
    //   边界那一对（恰好 int8 上界 ⇒ 接受 / 上界 + 1 ⇒ 拒绝）落在单元层
    //   （`tests/unit/ledger/dto.test.ts`）：在真库上发放 int8 上界会把**全局共享**的
    //   EXTERNAL_TOPUP 推到 int8 下界，本文件后续每一条发放都会以 22003 溢出——
    //   那会让这条断言的代价落到别人的用例头上。
    const ok = await post({ userId, amount: '100', idempotencyKey: `int8-ok:${userId}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ created: true, balance: '100' });
  });

  it('★ 锁争用超出事务预算 ⇒ 503 LEDGER_TX_TIMEOUT（不是 500）：同一幂等键重试是安全的（M3）', async () => {
    // ## 它挡的缺陷形态（P2 最终全分支审查 M3）
    //
    // 请求路径的事务用 Prisma 的**默认**预算（`maxWait` 2 s / `timeout` 5 s），而测试里那些
    // 持锁的用例显式放宽到 20 s ⇒ 争用超过 5 s 时生产路径抛 `P2028`，而它此前**没有翻译**
    // ⇒ 500。**安全但不可用**：调用方拿到 500 后无法区分「别重试」与「重试是安全的」，
    // 而这里的事实恰好是**重试安全**（同一个幂等键走重放 ⇒ `created:false`，不记第二笔）。
    // ⇒ 修法是把它翻成 **503**（服务暂时不可用 + 可重试），而不是改事务预算——
    // 后者要在一个**没有测量**的数字上做决定，正是 D8 裁定里被否掉的那种赌注。
    //
    // ## ★ 构造的前提是**实测**的，不是照抄审查那句话
    //
    // 审查的原话是「争用下生产预算会产出 P2028」。**第一版按那句话写（持锁不放、等 5 s 看它
    // 变红）实测：请求根本不会在 5 s 时返回——它一直卡在行锁上，60 s 撞测试超时**
    // （证据 `evidence/fix-m3-step3-route-measure.txt`）。原因是 Prisma 的定时器起爆之后要向
    // **同一条连接**发 ROLLBACK，而那条连接正被阻塞的语句占着。
    // ⇒ 被量出来的形状是两条：
    //   ① 事务预算**不是**锁等待的 deadline（一条可用性事实，据实记载，本任务不改它）；
    //   ② `P2028` 在**阻塞语句结束之后**才到手 ⇒ 那条翻译在真实路径上确有其事。
    // 构造因此改成：持锁 6 s（让 5 s 预算在锁还被持有时过期）⇒ 放锁 ⇒ 断言 503。
    // 断言耗时 > 5 s 是刻意的：它把①也钉住，免得下一个人以为「5 s 预算兜住了延迟」。
    const userId = await realUser();
    await post({ userId, amount: '100', idempotencyKey: `tx-timeout-seed:${userId}` }).expect(200); // 先把那一行造出来
    const locker = new Client({ connectionString: pg.appUri });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        `SELECT id FROM ledger.accounts WHERE owner_user_id = $1 AND kind = 'USER_AVAILABLE' FOR UPDATE`,
        [userId],
      );
      const started = Date.now();
      // `post()` 返回的是 supertest 的 `Test`（惰性）：`.then()` 才会真的把请求发出去。
      const pending = post({ userId, amount: '100', idempotencyKey: `tx-timeout:${userId}` }).then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 6_000)); // 让 5 s 预算**在锁还被持有时**过期
      await locker.query('ROLLBACK');                             // 放锁：被阻塞的 UPDATE 这才完成
      const res = await pending;
      const elapsed = Date.now() - started;

      expect(elapsed, '没有真的等过事务预算（这条用例的时序前提不成立，不是断言失败）').toBeGreaterThan(5_000);
      expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)} elapsed=${String(elapsed)}`).toBe(503);
      expect(res.body).toEqual({ code: 'LEDGER_TX_TIMEOUT' });
      // 事务被回滚 ⇒ 那一笔一行都没留下，余额仍是种下去的那 100。
      expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `tx-timeout:${userId}` } })).toBe(0);
      expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 100n, frozen: 0n });
      // ★ 接受方向的同伴证据：**同一个幂等键**在争用消失之后重试 ⇒ 成功（这正是 503 想告诉
      //   调用方的那件事：重试安全）。没有这一句，「503」也可能只是「怎么都失败」。
      const retry = await post({ userId, amount: '100', idempotencyKey: `tx-timeout:${userId}` });
      expect(retry.status, `重试应当安全：status=${String(retry.status)} body=${JSON.stringify(retry.body)}`).toBe(200);
      expect(retry.body).toMatchObject({ created: true, balance: '200' });
      expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `tx-timeout:${userId}` } })).toBe(1);
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
    }
  }, 90_000);

  it('★ 未知用户 ⇒ 404 LEDGER_UNKNOWN_USER 且库里 0 行（C1：唯一造钱端点上的一次手误不再静默销毁额度）', async () => {
    // ## 它挡的缺陷形态（P2 最终全分支审查的 C1）
    //
    // 这条路由是 P2 里**唯一一条外部可达的造钱路径**，而它此前对 `userId` 只校验**格式**
    // （`z.uuid()`）——`ee85cee` 那两条新见证因此是**格式**见证，不是**存在性**见证。
    // 于是一个「形状合法、库里没有」的 uuid 会走完全程：200 + `created:true` + 库里多两行，
    // 而**没有任何路由或任务能花掉那笔钱**。管理员的一次手误（UUID 差一个字符）静默销毁额度。
    //
    // 判据三条，缺一不可：
    //   ① 状态码 404（**资源不存在**，不是 400 参数格式错、不是 422 数据不可接受——
    //      格式是对的，缺的是那一行）；
    //   ② 响应体**只有** `code` 一个键（C11 的边界：不回显余额、不吐内部 id）；
    //   ③ 库里那**两行**（账户 + 交易）一行都没被造出来。
    const ghost = uuidv7();
    const key = `ghost:${ghost}`;
    const res = await post({ userId: ghost, amount: '100', idempotencyKey: key });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(404);
    expect(res.body).toEqual({ code: 'LEDGER_UNKNOWN_USER' });
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(await prisma.ledgerAccount.count({ where: { ownerUserId: ghost } })).toBe(0);
    expect(await ledger.readBalances(prisma, ghost)).toEqual({ available: 0n, frozen: 0n });

    // ★ 接受方向的同伴证据（同一形状的请求、同一条路由、同一个管理员）：真用户 ⇒ 200。
    //   没有它，上面那个 404 也可能只是「这条路由怎么都拒」。
    const real = await realUser();
    const okKey = `ghost-ok:${real}`;
    const ok = await post({ userId: real, amount: '100', idempotencyKey: okKey });

    expect(ok.status, `status=${String(ok.status)} body=${JSON.stringify(ok.body)}`).toBe(200);
    expect(ok.body).toMatchObject({ created: true, balance: '100' });
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: okKey } })).toBe(1);
    expect(await prisma.ledgerAccount.count({ where: { ownerUserId: real } })).toBe(1);
  });

  it('★ >2^53：请求体是字符串、响应体的余额也是字符串，且**库里那一列**逐分无损（预检 A.2 / §G.3）', async () => {
    const userId = await realUser();
    const amount = '9007199254740993'; // 2^53 + 1 —— JSON number 装不下的那个数
    const res = await post({ userId, amount, idempotencyKey: `big:${userId}` });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(200);
    // ↓ 这两条一起把预检 §G.3 的未验证面（bigint 在 Nest 响应链路上的行为）**结构性绕开**：
    //   我们从不把 bigint 放进响应体，因此那条未验证面在 P2 里不可达。
    expect(typeof res.body.balance).toBe('string');
    expect(res.body.balance).toBe(amount);
    // 而真正的判据在库里：字符串 → bigint → int8 列 → 再读回来，**一分不差**。
    // 预检实测的那条静默路径（少 1 分且无异常）只有这一句看得见。
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 9007199254740993n, frozen: 0n });
  });

  it('同一个金额写成 JSON **number** ⇒ 400，且库里余额不变（C22 的执行点）', async () => {
    const userId = await realUser();
    const res = await post({ userId, amount: 9007199254740993, idempotencyKey: `n:${userId}` });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body.errors?.[0]?.path).toBe('amount');
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `n:${userId}` } })).toBe(0);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 0n, frozen: 0n });

    // ★ 接受方向的同伴证据：同一形状的查询对一次**被接受**的发放必须返回 1，
    //   否则上面那个 0 也可能只是「查询写错了」。
    await post({ userId, amount: '1', idempotencyKey: `n-ok:${userId}` }).expect(200);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `n-ok:${userId}` } })).toBe(1);
  });

  it('入参契约：非 UUID 的 `userId` ⇒ 400（不能让它走到库上变成 500，也不能被静默接受）', async () => {
    // 这一条问的是 DTO 的另外两个字段里那一个**有数据库后果**的：`owner_user_id` 是 `uuid` 列，
    // 一个非 UUID 的字符串打到 Postgres 会以 `22P02` 失败 ⇒ 500。而这是**调用方**的错误，
    // 因此必须在 DTO 这一层变成 400（与 `asset.controller.ts` 用 `UUID_IDENTIFIER` 在碰库
    // 之前回 404 是同一条理由）。
    // 判别力：把 `z.uuid()` 换成 `z.string()`（探针 `p-dto-loose-uuid`）⇒ 这条红（500 ≠ 400）。
    const res = await post({ userId: 'not-a-uuid', amount: '100', idempotencyKey: `bad-uuid:${uuidv7()}` });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body.errors?.[0]?.path).toBe('userId');
  });

  it('入参契约：空的 `idempotencyKey` ⇒ 400（一个空的幂等键会让「重放」与「新发放」再也分不开）', async () => {
    // 幂等键是这条路由**唯一**的重复保护（D9/C26），而空串在库里是合法的一行
    // （`idempotency_key` 是 `TEXT NOT NULL`，没有非空约束）——也就是说，放它进来不会报错，
    // 只会让「第二次发放」看起来像一次重放（或反过来）。因此必须在 400 这一层拒绝。
    // 判别力：把 `.min(1)` 换成 `.min(0)`（探针 `p-dto-empty-key`）⇒ 这条红（200 ≠ 400）。
    const userId = await realUser();
    const res = await post({ userId, amount: '100', idempotencyKey: '' });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body.errors?.[0]?.path).toBe('idempotencyKey');
  });

  it('同键**不同金额** ⇒ 409 LEDGER_IDEMPOTENCY_KEY_REUSED，且库里没有新行、余额不变（幂等②）', async () => {
    const userId = await realUser();
    const key = `diff:${userId}`;
    await post({ userId, amount: '100', idempotencyKey: key }).expect(200);

    const res = await post({ userId, amount: '200', idempotencyKey: key });

    expect(res.status, `status=${String(res.status)} body=${JSON.stringify(res.body)}`).toBe(409);
    expect(res.body.code).toBe('LEDGER_IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 100n, frozen: 0n });
  });

  it('同键同额重放 ⇒ 200 created=false，余额不翻倍、交易一笔、审计一行（幂等①）', async () => {
    const userId = await realUser();
    const key = `replay:${userId}`;
    const first = await post({ userId, amount: '100', idempotencyKey: key }).expect(200);
    expect(first.body).toMatchObject({ created: true, balance: '100' });
    expect(await prisma.auditLog.count({ where: { resourceId: first.body.transactionId as string } })).toBe(1);

    const replay = await post({ userId, amount: '100', idempotencyKey: key });

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ created: false, balance: '100' }); // ← 不是 200
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    // ★ 重放**不写**第二行审计：审计与业务同生共死（D10），而重放没有产生新的业务写入。
    expect(await prisma.auditLog.count({ where: { resourceId: first.body.transactionId as string } })).toBe(1);
  });

  it('★ 审计行能**完整重建**这次发放：谁（actorId）/ 发给谁（分录）/ 多少（分录）/ 哪个幂等键', async () => {
    // §13.2 要求「审计日志可完整重建任一次资金变动的链路」。这条链路是：
    //   审计行 --resourceId--> ledger.transactions --entries--> ledger.accounts
    // 因此判据不是「审计行里有几个字段」，而是**顺着这条链真的走得回去**。
    const userId = await realUser();
    const key = `audit:${userId}`;
    const res = await post({ userId, amount: '1234', idempotencyKey: key }).expect(200);
    const transactionId = res.body.transactionId as string;

    const audit = await prisma.auditLog.findFirst({
      where: { resourceId: transactionId },
      select: { actorId: true, action: true, resource: true, metadata: true },
    });
    expect(audit).not.toBeNull();
    // 谁：发起这次发放的管理员（不是被发放的人，也不是 null）。
    expect(audit?.actorId).toBe(adminId);
    expect(audit?.action).toBe('ledger.posted');
    expect(audit?.resource).toBe('LedgerTransaction');
    // 哪个幂等键（审计 metadata 里那一个，与请求逐字相同）。
    expect(audit?.metadata).toMatchObject({ kind: TRANSACTION_KINDS.TOPUP, idempotencyKey: key });

    // 发给谁 / 多少：顺着 resourceId → transactions → entries → accounts 读回来。
    const transaction = await prisma.ledgerTransaction.findUnique({
      where: { id: transactionId },
      select: {
        kind: true,
        idempotencyKey: true,
        entries: { select: { amount: true, account: { select: { kind: true, ownerUserId: true } } } },
      },
    });
    expect(transaction?.kind).toBe(TRANSACTION_KINDS.TOPUP);
    expect(transaction?.idempotencyKey).toBe(key);
    const decoded = (transaction?.entries ?? [])
      .map((entry) => ({ kind: entry.account.kind, owner: entry.account.ownerUserId, amount: entry.amount }))
      .sort((a, b) => (a.kind < b.kind ? -1 : 1));
    expect(decoded).toEqual([
      // 借：充值对手方账户（系统账户，天然为负）——§8.1 明写 MVP 由管理员发放虚拟额度
      { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, owner: null, amount: -1234n },
      // 贷：被发放人的**可用**账户（to whom + how much 都在这一行上）
      { kind: ACCOUNT_KINDS.USER_AVAILABLE, owner: userId, amount: 1234n },
    ]);
  });

  it('★ C30 的应用侧执行点：写路径拒绝 §8.1 之外的 kind，且**碰库之前**就拒绝', async () => {
    // 为什么这条必须有：Task 9 用真库实测过，迁移里那条**条件化** CHECK
    // （I1 之后的条件是 `kind = 'EXTERNAL_TOPUP' OR balance >= 0`）**枚举不了五个 kind**——
    // 它只知道「允许为负的恰好是注入端」这一个取值，因此一个伪造 kind 只要**非负**就会被
    // 收下并计入 Σ（`ledger-enforcement.test.ts` 的「不变式 #4 的数据库侧」把这两个方向
    // 都量了一遍）。也就是说：**执行 kind 集合是应用层的工作**，数据库挡不住。
    //
    // 观测量的选择是承重的：`resolveAccounts` 里有**五处** `assertAccountKind`
    // （入参引用、读回的行、快照），它们抛的是**同一个**错误类，因此「抛没抛」分不开它们。
    // 能分开的只有**顺序**：入参那一处在**任何 SQL 之前**。于是判据是——在同一个事务里，
    // 捕获异常之后再查一次库：拒绝发生时，那个伪造 kind 的账户行**一行都不该存在**。
    // 把第一处断言删掉（探针 `p-kind-gate`）时，`post` 会先 INSERT 那一行、再由读回时
    // 的断言抛出：错误类型完全相同，而这一句会红。
    const userId = await realUser();
    const key = `foreign-kind:${userId}`;
    // 这个值模拟「来自类型系统之外的数据」（库里的行、JSON、别的服务的入参）：
    // `AccountKind` 是编译期类型，而 §8.1 是**运行期**契约。
    const foreign = 'SELLER_AVAILABLE' as unknown as AccountKind;

    let observedForeignRows: string[] = [];
    const error = await prisma
      .$transaction(async (tx) => {
        try {
          await ledger.post(tx, {
            kind: TRANSACTION_KINDS.TOPUP,
            idempotencyKey: key,
            moves: [
              { from: { kind: foreign, ownerUserId: userId }, to: { kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: userId }, amount: 1n },
            ],
          });
          return null;
        } catch (thrown: unknown) {
          // 在**同一个事务**里读：上一条语句有没有真的写进去过。
          const rows = await tx.ledgerAccount.findMany({ where: { kind: 'SELLER_AVAILABLE' }, select: { kind: true } });
          observedForeignRows = rows.map((row) => row.kind);
          throw thrown; // 让事务回滚（否则那个伪造账户会被提交进库）
        }
      })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UnknownAccountKindError);
    expect((error as UnknownAccountKindError).kind).toBe('SELLER_AVAILABLE');
    expect(observedForeignRows, '拒绝之前已经往库里写过那一行 ⇒ 这道门没有挡住（C30 的应用侧执行点失效）').toEqual([]);
    // 拒绝方向：那笔交易不存在、那个 kind 一行都没有。
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(await prisma.ledgerAccount.count({ where: { kind: 'SELLER_AVAILABLE' } })).toBe(0);

    // ★ 接受方向的同伴证据（同一形状的查询 + 同一个入口）：一个**合法**的 kind 走同一条路时，
    //   账户行与交易行都真的被建出来了。没有这一句，上面那两个 0 也可能只是查询写错了。
    const ok = uuidv7();
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: `ok-kind:${ok}`,
        moves: [{ from: { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null }, to: { kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: ok }, amount: 1n }],
      }),
    );
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ok-kind:${ok}` } })).toBe(1);
    expect(await prisma.ledgerAccount.count({ where: { kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: ok } })).toBe(1);
  });
});
