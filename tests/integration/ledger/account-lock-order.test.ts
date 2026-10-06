import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { uuidv7 } from '@vca/shared';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { AdminDirectory } from '@vca/api/modules/auth/admin-directory.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { LedgerService } from '@vca/api/modules/ledger/ledger.service.js';
import { TRANSACTION_KINDS } from '@vca/api/modules/ledger/core/types.js';
import { ACCOUNT_KINDS } from '@vca/api/modules/ledger/core/account-kind.js';
import { InsufficientFundsError } from '@vca/api/modules/ledger/core/errors.js';
import { isRetryableConflictError, withBoundedConflictRetry } from '@vca/api/common/db/retryable-conflict.js';
import { rowLockOrder } from '@vca/api/common/db/lock-order.js';
import type { Prisma } from '@vca/api/generated/prisma/client.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 账户行锁序与两档重试判别式（P3 / Task 4；C35 / C36）。
 *
 * ## 三条用例各自的判别力（真库 + 真服务）
 *
 * 1. **账户行按升序取锁**（`★` 那条）。它是这一组里**唯一确定性**的判别式：第三方连接
 *    先锁住**较小的那个** id，观察那一笔**卡在哪一条语句上**，再用 `FOR UPDATE NOWAIT`
 *    从另一条连接试锁**较大的那个**——那一句必须立刻成功，因为按升序取锁的实现
 *    **还没碰过它**。反向取锁的实现会先锁住它 ⇒ `NOWAIT` 报 55P03 ⇒ 红。
 *    （探针实测：`P-ORDER-DESC` 把比较器反过来 ⇒ 这一条的**第二档**红；
 *      `P-LOCK-REMOVED` 删掉取锁调用 ⇒ **第一档**红，实测卡住的是 `INSERT INTO entries`。）
 *
 * 2. **两笔相反方向的真实过账都成功**。**据实记载：这条的判别力不是确定性的**——
 *    修之前那两笔要**恰好交错**到各自的 `createMany` 才会 ABBA（预检实测的 P2034/40P01
 *    就是这样撞出来的），而交错取决于调度。它是一条**结果**判据（修之后必然成立），
 *    不是一条路径判据；路径那一半由上面第 1 条与探针 `P-LOCK-REMOVED` 负责。
 *
 * 3. **两档死锁各造一次真死锁**（`$queryRaw` ⇒ P2010；Prisma 委托 ⇒ P2034），并各用
 *    `withBoundedConflictRetry` 走一次**真重试**（`onRetry` 恰好一次 + 最终成功）。
 *    C36 要防的正是「只认 P2034」：那样一来 P1 的 `FOR UPDATE` 路径**永远不重试**，
 *    而这条用例会在探针 `P-DISC-P2010` 下变红。
 *
 * 4. **不可重试的错误不重试**（真路径上的领域错误：余额不足 ⇒ 调用一次、原样抛出）。
 */
const available = (userId: string) => ({ kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: userId }) as const;
const frozen = (userId: string) => ({ kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: userId }) as const;
const topupRef = { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null } as const;

let pg: TestPg;
let prisma: PrismaService;
let ledger: LedgerService;

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  ledger = new LedgerService(prisma, new AuditService(prisma), new AdminDirectory(prisma));
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
});

/**
 * 给用户发 `amount` 分，并把**两行账户都先建出来**（`USER_AVAILABLE` 与 `USER_FROZEN`），
 * 返回它们的 id。
 *
 * 为什么必须先把两行建出来（P2 的 `materializeAccounts` 逐字同源）：账户行是惰性创建的，
 * 而创建那条 `INSERT … ON CONFLICT DO NOTHING` 会在一行被别的连接占用时**等**——不先建出来，
 * 并发用例里后来的那一笔会卡在 **INSERT** 上，于是「锁序」这件事根本没有被行使。
 */
async function seed(userId: string, amount: bigint) {
  await prisma.$transaction((tx) =>
    ledger.post(tx, {
      kind: TRANSACTION_KINDS.TOPUP,
      idempotencyKey: `lock-seed:${userId}`,
      moves: [{ from: topupRef, to: available(userId), amount }],
    }),
  );
  await prisma.$transaction((tx) =>
    ledger.post(tx, {
      kind: TRANSACTION_KINDS.FREEZE,
      idempotencyKey: `lock-seed-freeze:${userId}`,
      moves: [{ from: available(userId), to: frozen(userId), amount: 1n }],
    }),
  );
  const rows = await prisma.ledgerAccount.findMany({
    where: { OR: [{ ownerUserId: userId }, { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null }] },
    select: { id: true, kind: true },
  });
  const idOf = (kind: string): string => {
    const row = rows.find((r) => r.kind === kind);
    if (!row) throw new Error(`构造失败：账户 ${kind} 不存在（这一步的时序前提不成立）`);
    return row.id;
  };
  return { available: idOf(ACCOUNT_KINDS.USER_AVAILABLE), frozen: idOf(ACCOUNT_KINDS.USER_FROZEN) };
}

/**
 * 等到至少 n 个后端卡在锁上（`wait_event_type = 'Lock'`），并返回它们正在执行的语句。
 *
 * 返回**语句文本**不是装饰：本文件第一档判据的全部内容就是「卡在哪一句上」。
 * 窗口 2 s（远小于 Prisma 交互式事务的 5 s 默认超时）：超时说明**构造**没成立，
 * 因此抛的是构造失败，不是断言失败。
 * 观察者与 Prisma 用同一个 `app_user` 连接（`pg_stat_activity` 的 `wait_event_type` /
 * `query` 只对本会话属主可见；两边同角色才看得见，否则读到的是 NULL 而已）。
 */
async function waitForLockWaiters(client: Client, n: number): Promise<string[]> {
  for (let i = 0; i < 80; i += 1) {
    const r = await client.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (r.rows.length >= n) return r.rows.map((row) => row.query);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('2 s 内没有观察到等待锁的后端 —— 这条用例的时序前提不成立（构造失败，不是断言失败）');
}

/** 把错误对象压成一行可读文本（断言失败时把**实测形状**打出来，而不是只说「不相等」）。 */
function shapeOf(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown; meta?: unknown; cause?: unknown };
  return `code=${String(e?.code)} meta=${JSON.stringify(e?.meta)} cause=${JSON.stringify(e?.cause)} message=${String(e?.message).replace(/\s+/g, ' ').slice(0, 200)}`;
}

/**
 * 造一次**真死锁**（SQLSTATE `40P01`），并让**被重试的那一笔**当牺牲者。
 *
 * ## 构造（它是确定性的，不靠 sleep 猜时序）
 * ```
 * 竞争者（一条裸 pg 连接）: BEGIN; SELECT y FOR UPDATE;                    ← 先持有 y
 * 牺牲者（withBoundedConflictRetry 包住的那笔）: 取 x（成功）→ 取 y（卡住）
 * 竞争者（150 ms 之后）                       : SELECT x FOR UPDATE          ← 环在这一刻形成
 * ```
 * 牺牲者随后被 PostgreSQL 的死锁探测器中止（`deadlock_timeout` 默认 1 s），
 * 竞争者拿到 x、回滚、释放 ⇒ 重试那一次一路上到 COMMIT。
 *
 * ## 为什么那 150 ms 是**承重**的
 * 死锁探测器在每个进程**自己开始等待**之后 `deadlock_timeout` 到点时才跑，跑的时候发现环
 * 就把**自己**中止掉。牺牲者先开始等待（它在竞争者要 x 之前就在等 y），因此它的计时器总是
 * 先到点 ⇒ 它总是牺牲者。若两者**同时**开始等待，谁是牺牲者就成了竞态（两条计时器几乎同时
 * 到期），而那条用例会变成一条偶发红。**据实记载**：预检两次实测的 1.1 s / 1.28 s 正是这个
 * 1 s 的探测器（不是「大概卡一秒」）。
 *
 * ## 两道 `lock` 的形状由调用方给（这就是两档错误的来源）
 * `$queryRaw` ⇒ **P2010**；Prisma 委托 ⇒ **P2034**（预检 §0.4 实测）。两档都带 `40P01`。
 */
async function deadlockThenRetry(opts: {
  readonly x: string;
  readonly y: string;
  readonly lock: (tx: Prisma.TransactionClient, accountId: string) => Promise<unknown>;
}): Promise<{ attempts: number; retries: Array<[number, unknown]>; firstError: unknown; finalError: unknown }> {
  const rival = new Client({ connectionString: pg.appUri });
  await rival.connect();
  await rival.query('BEGIN');
  await rival.query('SELECT id FROM ledger.accounts WHERE id = $1::uuid FOR UPDATE', [opts.y]);

  let victimIsWaiting!: () => void;
  const waitingReached = new Promise<void>((resolve) => { victimIsWaiting = resolve; });
  let attempts = 0;
  let firstError: unknown = null;
  const retries: Array<[number, unknown]> = [];

  const victim = withBoundedConflictRetry(
    async () => {
      attempts += 1;
      const nth = attempts;
      try {
        await prisma.$transaction(
          async (tx) => {
            await opts.lock(tx, opts.x);
            victimIsWaiting();
            await opts.lock(tx, opts.y); // ← 竞争者持有它 ⇒ 卡住
          },
          { timeout: 20_000 },
        );
      } catch (error) {
        // **第一次**那个错误单独留下：判别式若把它判成「不可重试」，`onRetry` 一次都不会被调用、
        // 整笔直接以原错误失败——而「实测到的错误形状」恰恰是那一刻最需要出现在失败信息里的东西
        // （探针 `P-DISC-P2010-INT` 就是靠这一句把它逐字打出来的）。
        if (nth === 1) firstError = error;
        throw error;
      }
    },
    { onRetry: (attempt, error) => retries.push([attempt, error]) },
  );

  await waitingReached;
  await new Promise((resolve) => setTimeout(resolve, 150));
  // 这一句会阻塞到牺牲者被中止（环形成 ⇒ 探测器把牺牲者干掉 ⇒ x 的锁归竞争者）。
  await rival.query('SELECT id FROM ledger.accounts WHERE id = $1::uuid FOR UPDATE', [opts.x]);
  await rival.query('ROLLBACK');
  await rival.end();

  // 重试那一次：两行这时都空了。**不在这里抛**——收敛与否是**用例**要断言的东西
  // （判别式漏档时它会是一个错误对象，而不是一条被驱动装置吞掉的异常）。
  const finalError = await victim.then(() => null, (e: unknown) => e);
  return { attempts, retries, firstError, finalError };
}

describe('账户行锁序与两档重试判别式（C35 / C36；真库 + 真服务）', () => {
  it('★ 账户行按**升序**取锁：卡住的是那条有序 FOR UPDATE，而第二个账户**还没被碰过**', async () => {
    const userId = uuidv7();
    const ids = await seed(userId, 100n);
    // 期望的顺序**写在这里**（字节升序），不从实现里取——否则把实现反过来、这条用例会跟着
    // 反过来，等于什么都没测（这正是探针 P-ORDER-DESC 要能打红它的前提）。
    const first = ids.available < ids.frozen ? ids.available : ids.frozen;
    const second = first === ids.available ? ids.frozen : ids.available;
    // ★ 腿刻意按**降序**给（借大的、贷小的）：于是「按升序取锁」这件事必须由实现**归一化**
    //   出来，而不是「恰好入参就是这个顺序」。若实现直接用数组顺序取锁，这一条会红
    //   （第三方连接持有的是 `first`，而那一笔会先去锁 `second`）。
    const legs = [
      { accountId: second, amount: 1n },
      { accountId: first, amount: -1n },
    ];

    // 第三方连接先锁住**全局锁序里的第一个**（较小的那个 id）。
    const holder = new Client({ connectionString: pg.appUri });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM ledger.accounts WHERE id = $1::uuid FOR UPDATE', [first]);

    // 被观察的那一笔：两个账户都在腿上 ⇒ 它必须先取 `first`（然后才轮到 `second`）。
    const poster = prisma.$transaction(
      (tx) =>
        ledger.postLegs(tx, {
          kind: TRANSACTION_KINDS.FREEZE,
          idempotencyKey: `order:${uuidv7()}`,
          legs,
        }),
      { timeout: 20_000 },
    );

    const observer = new Client({ connectionString: pg.appUri });
    await observer.connect();
    let blocked: string[];
    try {
      blocked = await waitForLockWaiters(observer, 1);
    } finally {
      await observer.end();
    }
    expect(
      blocked.filter((sql) => /FROM "?ledger"?\."?accounts"?[\s\S]*ORDER BY id FOR UPDATE/.test(sql)),
      `那一笔必须卡在**按 id 升序取全部账户行锁**的那一句上（卡在别处说明这次测的不是锁序）。实测：${JSON.stringify(blocked)}`,
    ).toHaveLength(1);

    // 第二档：它**还没碰过** `second`。反向取锁的实现会先锁住 `second` ⇒ NOWAIT 报 55P03。
    const probe = new Client({ connectionString: pg.appUri });
    await probe.connect();
    let probeError: unknown = null;
    try {
      await probe.query('BEGIN');
      probeError = await probe
        .query('SELECT id FROM ledger.accounts WHERE id = $1::uuid FOR UPDATE NOWAIT', [second])
        .then(() => null, (e: unknown) => e);
      await probe.query('ROLLBACK');
    } finally {
      await probe.end();
    }
    expect(
      probeError,
      `第二个账户（${second}）已经被那一笔锁住了 ⇒ 取锁顺序**不是**升序（这正是 ABBA 的一半）。实测：${shapeOf(probeError)}`,
    ).toBeNull();

    // 放行第三方连接 ⇒ 那一笔应当正常完成（这不是一次「谁都没做」的空过账）。
    await holder.query('ROLLBACK');
    await holder.end();
    await expect(poster).resolves.toMatchObject({ created: true });
    expect(await ledger.readBalances(prisma, userId)).toEqual(
      first === ids.available ? { available: 98n, frozen: 2n } : { available: 100n, frozen: 0n },
    );
  }, 120_000);

  it('★ 两种介质上的**同一条规则**：SQL 的 `ORDER BY id` 与共享判据给出的顺序逐个相同', async () => {
    // 为什么需要这一条（★ 本任务的一处实测发现，见 `lockAccountRows` 的注释）：
    // 账户侧**物理**取锁顺序其实由那条 SQL 的 `ORDER BY id` 决定——探针 `P-ORDER-DESC-INT`
    // 实测：把共享判据 `rowLockOrder` 的比较器反过来，账户侧的真库锁序见证**照样绿**。
    // 于是这条路径上有**两个介质在表达同一个决定**：JS 侧（数组准备，去重 + 字节升序）
    // 与 SQL 侧（`ORDER BY id`，PostgreSQL 的 `uuid` 比较 = 16 字节字典序）。
    // 两者必须**逐个相同**，否则「数组准备」与「执行者」会在某个输入上分开。
    // **据实记载**：这条断言对「两份不同的排序规则」有判别力；对「同一份规则的两个实现」
    // 与「大小写不规范 id」这两类输入的边界，由下面那句显式的域外样本一起钉住。
    const inputs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ids = await seed(uuidv7(), 100n);
      inputs.push(ids.available, ids.frozen);
    }
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM ledger.accounts WHERE id = ANY(${inputs}::uuid[]) ORDER BY id
    `;
    expect(rows.map((r) => r.id)).toEqual(rowLockOrder(inputs));
    // 域外样本（大小写混合）：PostgreSQL 的 `uuid` 比较与大小写无关，而 `rowLockOrder` 是
    // **字符串**字节序 ⇒ 这一句钉住「两者相同」这句话的**边界**（真实调用方只会传库里读回来的
    // 小写定长 id，因此这是实现纪律而不是业务行为——不写下来，下一个人会以为它无条件成立）。
    const lower = inputs[0]!;
    const upper = lower.toUpperCase();
    expect(rowLockOrder([lower, upper]), '共享判据是字符串字节序：大写排在小写之前').toEqual([upper, lower]);
    const sameRow = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM ledger.accounts WHERE id = ANY(${[lower, upper]}::uuid[]) ORDER BY id
    `;
    expect(sameRow.map((r) => r.id)).toEqual([lower]); // 同一个 uuid 的两种拼写在库里是同一行
  }, 120_000);

  it('两笔**相反方向**的真实过账都成功（修之前实测 P2034 / 40P01；这条是**结果**判据）', async () => {
    const a = uuidv7();
    const b = uuidv7();
    await seed(a, 1_000n);
    await seed(b, 1_000n);
    const post = (from: string, to: string, key: string) =>
      ledger.runWithIdempotentRetry((tx) =>
        ledger.post(tx, {
          kind: TRANSACTION_KINDS.FORFEIT,
          idempotencyKey: key,
          moves: [{ from: available(from), to: available(to), amount: 100n }],
        }),
      );

    const results = await Promise.allSettled([post(a, b, `dir-ab:${a}`), post(b, a, `dir-ba:${b}`)]);
    const rejected = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    expect(
      rejected,
      `相反方向的两笔过账必须**都成功**（修之前预检实测 P2034 / 40P01 死锁）。实测失败：${rejected.map(shapeOf).join(' | ')}`,
    ).toEqual([]);
    // 一来一回 ⇒ 两边的余额逐项回到原值（「都成功」不是因为有一笔什么都没做）。
    expect(await ledger.readBalances(prisma, a)).toEqual({ available: 999n, frozen: 1n });
    expect(await ledger.readBalances(prisma, b)).toEqual({ available: 999n, frozen: 1n });
  }, 120_000);

  it('★ 第一档（`$queryRaw` ⇒ **P2010**）：真死锁被量到、判为可重试、有界重试后收敛', async () => {
    const ids = await seed(uuidv7(), 1_000n);
    const ordered = [ids.available, ids.frozen].sort((l, r) => (l < r ? -1 : l > r ? 1 : 0));
    const x = ordered[0]!;
    const y = ordered[1]!;

    const measured = await deadlockThenRetry({
      x,
      y,
      lock: (tx, id) => tx.$queryRaw`SELECT id FROM ledger.accounts WHERE id = ${id}::uuid FOR UPDATE`,
    });

    // 顺序是**承重**的：形状与判别式先断言（它们是这一档的全部内容），收敛性放在后面。
    // 判别式若漏了这一档，上面那个错误就永远不会被重试 ⇒ `attempts` 会停在 1，
    // 而失败信息里已经带着**实测形状**（探针 `P-DISC-P2010-INT` 逐字打出来过）。
    const error = measured.firstError;
    expect((error as { code?: unknown }).code, `实测形状：${shapeOf(error)}`).toBe('P2010');
    // 真的是**死锁**（SQLSTATE 40P01），而不是一个长得像的对象——两档都带它（预检 §0.4）。
    const text = `${String((error as { message?: unknown }).message)}|${JSON.stringify((error as { meta?: unknown }).meta)}|${JSON.stringify((error as { cause?: unknown }).cause)}`;
    expect(text, `实测形状：${shapeOf(error)}`).toContain('40P01');
    expect(isRetryableConflictError(error), `实测形状：${shapeOf(error)}`).toBe(true);

    expect(measured.attempts, '含首次的尝试次数：死锁一次 + 重试一次').toBe(2);
    expect(measured.retries, 'onRetry 必须**恰好**被调用一次（否则这条不是「真的重试了」）').toHaveLength(1);
    expect(measured.retries[0]![1]).toBe(error); // 交出来的就是第一次那个错误本身
    expect(measured.finalError, `重试那一次必须成功。实测：${shapeOf(measured.finalError)}`).toBeNull();
  }, 120_000);

  it('★ 第二档（Prisma 委托 ⇒ **P2034**）：同一构造换一条语句形状，结论必须相同', async () => {
    const ids = await seed(uuidv7(), 1_000n);
    const ordered = [ids.available, ids.frozen].sort((l, r) => (l < r ? -1 : l > r ? 1 : 0));
    const x = ordered[0]!;
    const y = ordered[1]!;

    const measured = await deadlockThenRetry({
      x,
      y,
      // Prisma 委托（不是 `$queryRaw`）：`increment: 0n` 只为拿行锁，不改任何余额。
      lock: (tx, id) => tx.ledgerAccount.updateMany({ where: { id }, data: { balance: { increment: 0n } } }),
    });

    const error = measured.firstError;
    expect((error as { code?: unknown }).code, `实测形状：${shapeOf(error)}`).toBe('P2034');
    const text = `${String((error as { message?: unknown }).message)}|${JSON.stringify((error as { meta?: unknown }).meta)}|${JSON.stringify((error as { cause?: unknown }).cause)}`;
    expect(text, `实测形状：${shapeOf(error)}`).toContain('40P01');
    expect(isRetryableConflictError(error), `实测形状：${shapeOf(error)}`).toBe(true);

    expect(measured.attempts).toBe(2);
    expect(measured.retries).toHaveLength(1);
    expect(measured.retries[0]![1]).toBe(error);
    expect(measured.finalError, `重试那一次必须成功。实测：${shapeOf(measured.finalError)}`).toBeNull();
  }, 120_000);

  it('★ 不可重试的错误**不重试**：真路径上的领域错误（余额不足）只调用一次、原样抛出', async () => {
    const userId = uuidv7();
    await seed(userId, 10n);
    let calls = 0;
    const error = await withBoundedConflictRetry(async () => {
      calls += 1;
      return prisma.$transaction((tx) =>
        ledger.post(tx, {
          kind: TRANSACTION_KINDS.FREEZE,
          idempotencyKey: `no-retry:${uuidv7()}`,
          moves: [{ from: available(userId), to: frozen(userId), amount: 999n }],
        }),
      );
    }).then(() => null, (e: unknown) => e);

    expect(error, `实测形状：${shapeOf(error)}`).toBeInstanceOf(InsufficientFundsError);
    expect(calls, '不可重试的领域错误被重试了 ⇒ 判别式过宽').toBe(1);
    // 库里不留痕（真路径上的拒绝方向）：
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: { startsWith: 'no-retry:' } } })).toBe(0);
  }, 120_000);
});
