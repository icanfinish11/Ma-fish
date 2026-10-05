import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { uuidv7 } from '@vca/shared';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { LedgerService } from '@vca/api/modules/ledger/ledger.service.js';
import { TRANSACTION_KINDS } from '@vca/api/modules/ledger/core/types.js';
import { ACCOUNT_KINDS, USER_ACCOUNT_KINDS } from '@vca/api/modules/ledger/core/account-kind.js';
import { InsufficientFundsError, IdempotencyKeyReusedError } from '@vca/api/modules/ledger/core/errors.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 过账（P2 / Task 6；设计 §8.2 / §8.3 / §8.5，计划 D8 / D9 / D10）。
 *
 * 这个文件是**四条实测结论**的落点，每一组用例都成对给出「接受」与「拒绝」：
 *   * C25/D8 —— 余额扣减的并发权威是**条件更新的受影响行数**（不是读-判断-写）；
 *   * C26/D9 —— 幂等键是数据库唯一约束，三态（重放 / 异腿 409 / 新键）；
 *   * C28    —— 应用侧显式平衡断言是唯一稳定的错误通道（触发器只是回退防线）；
 *   * D10    —— 一笔过账一行审计，且**写在同一个事务里**（Task 2 的 `tx` 参数）。
 *
 * 每个用例用新的 `uuidv7()` 当事人，因此互不干扰、也不需要清理（账户行是惰性建的）。
 */
const topup = { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null } as const;
const escrow = { kind: ACCOUNT_KINDS.PLATFORM_ESCROW, ownerUserId: null } as const;
const available = (userId: string) => ({ kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: userId }) as const;
const frozen = (userId: string) => ({ kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: userId }) as const;

/** 某个账户的当前余额（读库，不经应用缓存）。系统账户的 `ownerUserId` 是 NULL。 */
async function balanceOf(kind: string, ownerUserId: string | null): Promise<bigint> {
  const rows = await prisma.ledgerAccount.findMany({ where: { kind, ownerUserId }, select: { balance: true } });
  return rows[0]?.balance ?? 0n;
}
/** 一笔过账留下的行数两件套（分录 / 审计）。 */
async function footprintOf(transactionId: string) {
  const [entries, audits] = await Promise.all([
    prisma.ledgerEntry.count({ where: { transactionId } }),
    prisma.auditLog.count({ where: { action: 'ledger.posted', resourceId: transactionId } }),
  ]);
  return { entries, audits };
}
/**
 * 审计行的第二种判据：按**审计 metadata 里的幂等键**找它。
 *
 * 为什么要跟 `footprintOf` 分开写：它俩是**两条独立的证据链**。`resourceId` 来自
 * `post` 的返回值，而 `metadata.idempotencyKey` 是 `post` 自己写进审计的内容——
 * 后者若没写，只有这一条能发现。
 */
async function auditRowsFor(key: string): Promise<number> {
  return prisma.auditLog.count({ where: { metadata: { path: ['idempotencyKey'], equals: key } } });
}

/**
 * 等到有 n 个后端卡在锁上（`wait_event_type = 'Lock'`），并**返回它们正在执行的语句**。
 *
 * 它只被「条件更新是并发权威」那条用例用到。返回语句这件事不是装饰，而是那条用例的
 * **构造见证**——见用例里 ★ 的说明：光看见「有后端在等锁」推不出「它在等那把行锁」。
 *
 * 窗口取 2 s（远小于 Prisma 交互式事务的 5 s 默认超时）：超时说明**构造**没成立，
 * 因此这里抛的是构造失败，不是断言失败。
 *
 * 观察者与 Prisma 用**同一个** `app_user` 连接：`pg_stat_activity` 的
 * `wait_event_type` / `query` 只对「本会话属主（或 pg_read_all_stats）」可见，
 * 而两边同角色，所以这两列看得见。（若换成属主角色去看 app_user 的会话，反而会读到
 * NULL——那会让这条构造**静默**失效。）
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

let pg: TestPg;
let prisma: PrismaService;
let ledger: LedgerService;

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  ledger = new LedgerService(prisma, new AuditService(prisma));
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
});

describe('过账：LedgerService.post（C25 / C26 / C28 / D9 / D10）', () => {
  it('额度发放：系统账户为负、用户账户为正、账平（§8.2 第一行）', async () => {
    const userId = uuidv7();
    const result = await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: `topup:${userId}`,
        moves: [{ from: topup, to: available(userId), amount: 10_000n }],
      }),
    );
    expect(result.created).toBe(true);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 10_000n, frozen: 0n });
    expect(await balanceOf(ACCOUNT_KINDS.EXTERNAL_TOPUP, null)).toBeLessThan(0n);
    // 分录是**两条**：EXTERNAL_TOPUP −10000 / USER_AVAILABLE +10000（不变式 #1）。
    expect(await footprintOf(result.transactionId)).toEqual({ entries: 2, audits: 1 });
  });

  it('**充值路径不被守卫钉死**：EXTERNAL_TOPUP 余额为 0 时仍能被扣（系统账户天然为负）', async () => {
    // ★ 判别力：若把 `balance >= x` 守卫**无条件**加到所有借方上，这里会以
    // InsufficientFundsError 失败（系统账户余额可能恰好是 0，而它要扣 10000）。
    // 预检 B.3 对 CHECK 说过同一句话：「无条件 CHECK 会钉死充值路径」——
    // 这与迁移里那条**条件化** CHECK 是同一条规则的两个落点。
    const before = await balanceOf(ACCOUNT_KINDS.EXTERNAL_TOPUP, null);
    const userId = uuidv7();
    await expect(
      prisma.$transaction((tx) =>
        ledger.post(tx, {
          kind: TRANSACTION_KINDS.TOPUP,
          idempotencyKey: `topup:${userId}`,
          moves: [{ from: topup, to: available(userId), amount: 10_000n }],
        }),
      ),
    ).resolves.toMatchObject({ created: true });
    expect(await balanceOf(ACCOUNT_KINDS.EXTERNAL_TOPUP, null)).toBe(before - 10_000n);
  });

  it('幂等①：同键同腿重放 ⇒ created=false，且**不新增任何行**', async () => {
    const userId = uuidv7();
    const request = {
      kind: TRANSACTION_KINDS.TOPUP,
      idempotencyKey: `replay:${userId}`,
      moves: [{ from: topup, to: available(userId), amount: 777n }],
    } as const;
    const first = await prisma.$transaction((tx) => ledger.post(tx, request));
    const mark = await footprintOf(first.transactionId);
    expect(mark).toEqual({ entries: 2, audits: 1 });

    const second = await prisma.$transaction((tx) => ledger.post(tx, request));
    expect(second.created).toBe(false);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await footprintOf(first.transactionId)).toEqual(mark); // 分录与审计都没有第二份
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: request.idempotencyKey } })).toBe(1);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 777n, frozen: 0n }); // 余额没有翻倍
  });

  it('幂等②：同键**不同腿** ⇒ 抛 IdempotencyKeyReusedError（HTTP 层是 409），且库里没有新行', async () => {
    const userId = uuidv7();
    const key = `conflict:${userId}`;
    const first = await prisma.$transaction((tx) =>
      ledger.post(tx, { kind: TRANSACTION_KINDS.TOPUP, idempotencyKey: key, moves: [{ from: topup, to: available(userId), amount: 100n }] }),
    );
    await expect(
      prisma.$transaction((tx) =>
        ledger.post(tx, { kind: TRANSACTION_KINDS.TOPUP, idempotencyKey: key, moves: [{ from: topup, to: available(userId), amount: 200n }] }),
      ),
    ).rejects.toThrow(IdempotencyKeyReusedError);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 100n, frozen: 0n });
    expect(await prisma.ledgerEntry.count({ where: { transactionId: first.transactionId } })).toBe(2);
  });

  it('幂等③：3 个并发同键请求 ⇒ 恰好 1 个 created=true、其余 created=false、库里恰好 1 笔交易', async () => {
    // 这一条行使的是 `runWithIdempotentRetry` 的 P2002 路径（预检 C.5 实测的真实并发形态：
    // 3 并发 → 1 成功 / 2 × P2002，最终 1 行）。不加那一层重试时，另外两个请求会以
    // P2002 冒到 HTTP 层变成 500 —— 幂等路由在并发下退化成「一个 200 + 两个 500」。
    const userId = uuidv7();
    const request = {
      kind: TRANSACTION_KINDS.TOPUP,
      idempotencyKey: `concurrent:${userId}`,
      moves: [{ from: topup, to: available(userId), amount: 300n }],
    } as const;
    const results = await Promise.all(
      [1, 2, 3].map(() => ledger.runWithIdempotentRetry((tx) => ledger.post(tx, request))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: request.idempotencyKey } })).toBe(1);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 300n, frozen: 0n });
  });

  it('并发扣款：初始 10000 分、两笔并发各冻结 6000 ⇒ 恰好一笔成功、余额 4000', async () => {
    // ★ 这条用例是 C25 的判据。预检实测的两种失败形态：读-判断-写 ⇒ 两笔都成功、
    // 库里剩 4000（实际扣了 12000）；无条件 decrement ⇒ 余额 −2000。变异探针见 Step 6。
    const userId = uuidv7();
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: `seed:${userId}`,
        moves: [{ from: topup, to: available(userId), amount: 10_000n }],
      }),
    );

    const freeze = (n: number) =>
      ledger.runWithIdempotentRetry((tx) =>
        ledger.post(tx, {
          kind: TRANSACTION_KINDS.FREEZE,
          idempotencyKey: `freeze:${userId}:${String(n)}`,
          moves: [{ from: available(userId), to: frozen(userId), amount: 6_000n }],
        }),
      );
    const results = await Promise.allSettled([freeze(1), freeze(2)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InsufficientFundsError);
    // ★ **不要**在这里断言某一个 stage**（自审第 10 条）**：两笔都读到旧快照时，拦下败者的
    //   是条件更新的受影响行数（`conditional-update`，并发权威）；而败者若在胜者**提交之后**
    //   才读快照，纯核心的预判就先拦下了它（`predicted`）。**两条都是正确的拒绝**，落在哪一条
    //   取决于提交交错——那是调度事实、不是语义，钉死它等于埋一条偶发红。
    //   「`conditional-update` 那条路真的被走到过」由下面那条**确定性**用例单独负责。
    expect(['predicted', 'conditional-update']).toContain((rejected.reason as InsufficientFundsError).stage);
    expect(await balanceOf(ACCOUNT_KINDS.USER_AVAILABLE, userId)).toBe(4_000n);
    expect(await balanceOf(ACCOUNT_KINDS.USER_FROZEN, userId)).toBe(6_000n);
    expect(await prisma.ledgerTransaction.count({ where: { kind: 'FREEZE', idempotencyKey: { startsWith: `freeze:${userId}:` } } })).toBe(1);
  });

  it('★ 条件更新是**并发权威**（确定性构造：预判放行、由受影响行数拦下 ⇒ stage = conditional-update）', async () => {
    // 上一条证明的是**结果**（恰好一笔成功）；这条证明的是**路径**——`conditional-update`
    // 那个分支真的被走到过。构造是确定性的，不靠 sleep 猜时序：
    //   W：一笔**合法的**冻结，扣款之后把事务挂住 ⇒ 那一行的写锁已持有、改动未提交（对别人不可见）；
    //   A：另一笔冻结，读到的快照是旧的 10000 ⇒ 预判放行，然后卡在那把行锁上；
    //   放行 W ⇒ A 的条件更新重新求值（4000 >= 6000 为假）⇒ count = 0 ⇒ conditional-update。
    const userId = uuidv7();
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: `seed:${userId}`,
        moves: [{ from: topup, to: available(userId), amount: 10_000n }],
      }),
    );
    // ★ 把 `USER_FROZEN` 这一行**先建出来**（一个来回，余额回到 10000/0）。
    //   为什么必须：账户行是**惰性创建**的，而「创建」这条路径本身会等锁——实测
    //   （`pg_stat_activity` 的 `query` 逐字，见报告 §「构造的见证」）：
    //   `INSERT … ON CONFLICT DO NOTHING` 撞上一行正被另一个事务插入/更新时，
    //   唯一索引的冲突检测会按该行的 `xmin` **等那个事务结束**（`wait_event = 'transactionid'`）。
    //   不先建出来的话，W 就是 `USER_FROZEN` 的创建者，而 A 会在**那条 INSERT** 上等
    //   W——于是 A 等到 W 提交之后才读快照，由纯核心的预判拦下（`predicted`），
    //   `conditional-update` 那条路**一次都走不到**。这条构造要的是「A 的第一个锁点是
    //   借方守卫」，因此两行都必须先存在。
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.FREEZE,
        idempotencyKey: `materialize-out:${userId}`,
        moves: [{ from: available(userId), to: frozen(userId), amount: 1n }],
      }),
    );
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.UNFREEZE,
        idempotencyKey: `materialize-back:${userId}`,
        moves: [{ from: frozen(userId), to: available(userId), amount: 1n }],
      }),
    );

    let writerHoldsTheRow!: () => void;
    const writerLocked = new Promise<void>((resolve) => { writerHoldsTheRow = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = prisma.$transaction(
      async (tx) => {
        const result = await ledger.post(tx, {
          kind: TRANSACTION_KINDS.FREEZE,
          idempotencyKey: `hold:${userId}:1`,
          moves: [{ from: available(userId), to: frozen(userId), amount: 6_000n }],
        });
        writerHoldsTheRow(); // `post` 里的 updateMany 已经发过 ⇒ 这一行的写锁已持有
        await gate;          // 事务保持打开：锁不放、改动不提交
        return result;
      },
      { timeout: 20_000 },   // Prisma 交互式事务默认 5 s 超时；显式放宽，免得慢 CI 把它变成超时
    );
    await writerLocked;

    const blocked = ledger.runWithIdempotentRetry((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.FREEZE,
        idempotencyKey: `hold:${userId}:2`,
        moves: [{ from: available(userId), to: frozen(userId), amount: 6_000n }],
      }),
    );

    // 等到它**真的**卡在锁上再放行，并且**核对它卡在哪条语句上**。
    // 后者是这条用例的构造见证，不能省：计划原本写着「观察到等待者 ⇒ 它的快照已经读过、
    // 预判已经放行」——**实测那句话是错的**（第一版探针：等锁的语句是 `resolveAccounts`
    // 里的 `INSERT … ON CONFLICT DO NOTHING`，于是 A 等到 W 提交后才读快照、走 `predicted`）。
    // 只看「有人等锁」会得到一个**看起来构造成功、实际测了另一条路**的绿。
    const observer = new Client({ connectionString: pg.appUri });
    await observer.connect();
    let blockedStatements: string[];
    try {
      blockedStatements = await waitForLockWaiters(observer, 1);
    } finally {
      await observer.end();
    }
    const guardedUpdate = blockedStatements.filter(
      (sql) => /UPDATE\s+"ledger"\."accounts"[\s\S]*"balance" >=/.test(sql),
    );
    expect(
      guardedUpdate,
      `等锁的语句必须**是那条带余额守卫的条件更新**（否则这条用例证明的不是并发权威）。实测等锁语句：${JSON.stringify(blockedStatements)}`,
    ).toHaveLength(1);

    release();
    const rejected = await blocked.then(() => null, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(InsufficientFundsError);
    expect((rejected as InsufficientFundsError).stage).toBe('conditional-update');
    await expect(writer).resolves.toMatchObject({ created: true });
    expect(await balanceOf(ACCOUNT_KINDS.USER_AVAILABLE, userId)).toBe(4_000n);
    expect(await balanceOf(ACCOUNT_KINDS.USER_FROZEN, userId)).toBe(6_000n);
    expect(await prisma.ledgerTransaction.count({ where: { kind: 'FREEZE', idempotencyKey: { startsWith: `hold:${userId}:` } } })).toBe(1);
  }, 120_000);

  it('账本回滚 ⇒ 审计行 0 行（Task 2 的 tx 参数在账本路径上真的被传了）', async () => {
    // ★ 这是**独立断言**，控制器裁定过：**不并进任何「总数」检查**。
    //   它是 Task 2 那处 `record(input, tx?)` 改动的承重见证——`tx?` 是可选的，
    //   而 `PrismaService` 在结构上满足 `Prisma.TransactionClient`，所以
    //   `audit.record(input, this.prisma)` **编译得过**。「账本路径必须传 tx」这条规则
    //   在类型层没有守卫，只有这条用例有牙。
    const userId = uuidv7();
    const key = `rollback:${userId}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await ledger.post(tx, {
          kind: TRANSACTION_KINDS.TOPUP,
          idempotencyKey: key,
          moves: [{ from: topup, to: available(userId), amount: 1n }],
        });
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');

    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(await auditRowsFor(key)).toBe(0);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 0n, frozen: 0n });

    // ★ **接受方向**（同一个判据的另一半，缺了它上面那句什么都证明不了）：
    //   `auditRowsFor(key) === 0` 有两种解释——(a) 审计确实与账本同生共死；
    //   (b) 那个 JSON path 过滤器**根本匹配不到任何行**（路径写错、metadata 没落库）。
    //   只有让**同一形状**的查询在一次已提交的过账上返回 1，才能把 (b) 排掉。
    const witness = uuidv7();
    const witnessKey = `rollback-witness:${witness}`;
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: witnessKey,
        moves: [{ from: topup, to: available(witness), amount: 1n }],
      }),
    );
    expect(await auditRowsFor(witnessKey)).toBe(1);
  });

  it('readBalances：没有账户行 = 余额 0（D2）', async () => {
    expect(await ledger.readBalances(prisma, uuidv7())).toEqual({ available: 0n, frozen: 0n });
    expect(USER_ACCOUNT_KINDS).toEqual(['USER_AVAILABLE', 'USER_FROZEN']);
    expect(escrow.kind).toBe(ACCOUNT_KINDS.PLATFORM_ESCROW);
  });
});
