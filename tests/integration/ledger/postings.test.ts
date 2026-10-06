import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { uuidv7 } from '@vca/shared';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { AdminDirectory } from '@vca/api/modules/auth/admin-directory.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { LedgerService } from '@vca/api/modules/ledger/ledger.service.js';
import { TRANSACTION_KINDS } from '@vca/api/modules/ledger/core/types.js';
import { ACCOUNT_KINDS, USER_ACCOUNT_KINDS } from '@vca/api/modules/ledger/core/account-kind.js';
import { InsufficientFundsError, IdempotencyKeyReusedError, SystemAccountMissingError, UnbalancedPostingError, UnknownAccountKindError } from '@vca/api/modules/ledger/core/errors.js';
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
 * 把 `(userId, USER_AVAILABLE)` 与 `(userId, USER_FROZEN)` 两行**先建出来**（一个来回，余额复原）。
 *
 * 为什么必须：账户行是惰性创建的，而创建那条 `INSERT … ON CONFLICT DO NOTHING` 在一行
 * 正被另一个事务占用时会**等那个事务结束**（实测见「条件更新是并发权威」用例里的逐字证据）。
 * 不先把两行建出来的话，并发用例里后来的那个请求会在 **INSERT** 上排队，等第一个提交之后
 * 才读快照——于是「唯一索引」那条路与「条件更新」那条路**都走不到**。
 * 这不是推测：探针 **p15a**（把幂等判别器改成恒 `false`，即 P2002 不再被重试）跑出来
 * 幂等③ 照样绿，说明它当时一次都没撞到唯一索引。
 */
async function materializeAccounts(userId: string): Promise<void> {
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
}

/**
 * 给某个用户发 `amount` 分，并返回**手工构造腿**所需要的两个账户 `id`。
 *
 * 为什么直接腿的用例需要它：`post` 收的是**引用**（`AccountRef`），引用→`id` 的解析
 * （含惰性创建、kind/owner 绑定、系统账户只查不建）是 `post` 那扇门的活。
 * `postLegs` 那扇门拿到的已经是 `id`——这正是一条「腿集不来自 `movesToLegs`」的路径。
 */
async function fundAvailable(userId: string, amount: bigint) {
  await prisma.$transaction((tx) =>
    ledger.post(tx, {
      kind: TRANSACTION_KINDS.TOPUP,
      idempotencyKey: `legs-seed:${userId}`,
      moves: [{ from: topup, to: available(userId), amount }],
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
  return { available: idOf(ACCOUNT_KINDS.USER_AVAILABLE), topup: idOf(ACCOUNT_KINDS.EXTERNAL_TOPUP) };
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
  ledger = new LedgerService(prisma, new AuditService(prisma), new AdminDirectory(prisma));
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

  it('★ 幂等②′：同键、**同一组腿**、但 `kind` 不同 ⇒ 抛 IdempotencyKeyReusedError（D9 的判别式里 kind 是承重的）', async () => {
    // ## 它挡的缺陷形态（P2 最终全分支审查的 I2，`sameLegs` 只看 `(accountId, amount)`）
    //
    // `postLegs` 的重放判定此前只比**腿**，而 `findUnique` 连 `kind` 都没 select。于是
    // **同键 + 同腿 + 不同 kind** 会被判成一次「重放」，返回**库里那一笔的 id** 与
    // `created:false`——调用方以为自己的 `FORFEIT` 已经落账，而账本里躺着的是 `TOPUP`。
    // 五个原语到不了这里（它们的腿形状两两不同），但**通用 `post` 到得了**：§8.2 第 3/6 行
    // 正是 P4 用调用方自选的键走这条门（D12），而 D9 的契约原文是「**同一个键 + 同一个请求**」
    // ——`kind` 是这个「请求」里的一部分，缺了它，判别式就少一个维度。
    //
    // 两条方向都在：拒绝（异 kind）之后紧跟**接受**（同 kind 同腿 ⇒ 真的重放），否则
    // 上面那条 409 也可能只是「这个键怎么都拒」。
    const userId = uuidv7();
    const key = `kind-conflict:${userId}`;
    const moves = [{ from: topup, to: available(userId), amount: 100n }] as const;
    const first = await prisma.$transaction((tx) =>
      ledger.post(tx, { kind: TRANSACTION_KINDS.TOPUP, idempotencyKey: key, moves }),
    );
    const mark = await footprintOf(first.transactionId);
    expect(mark).toEqual({ entries: 2, audits: 1 });

    // ① **拒绝方向**：腿逐条相同，只有 kind 不同。
    await expect(
      prisma.$transaction((tx) =>
        ledger.post(tx, { kind: TRANSACTION_KINDS.FORFEIT, idempotencyKey: key, moves }),
      ),
    ).rejects.toThrow(IdempotencyKeyReusedError);
    // 库里那一笔**仍是 TOPUP**、行数一元未增（没有第二笔，也没有被改写）：
    const stored = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: key }, select: { kind: true, id: true } });
    expect(stored?.kind).toBe(TRANSACTION_KINDS.TOPUP);
    expect(stored?.id).toBe(first.transactionId);
    expect(await footprintOf(first.transactionId)).toEqual(mark);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 100n, frozen: 0n });

    // ② **接受方向**（同一形状的请求、同一个 entry point）：同键 + 同腿 + **同 kind** ⇒ 重放。
    //    没有这一句，「同键必拒」也能骗过上面那条。
    const replay = await prisma.$transaction((tx) =>
      ledger.post(tx, { kind: TRANSACTION_KINDS.TOPUP, idempotencyKey: key, moves }),
    );
    expect(replay).toMatchObject({ created: false, transactionId: first.transactionId });
    expect(await footprintOf(first.transactionId)).toEqual(mark);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 100n, frozen: 0n });
  });

  it('幂等③：3 个并发同键请求 ⇒ 恰好 1 个 created=true、其余 created=false、库里恰好 1 笔交易', async () => {
    // **这一条断言的是结果，不是路径。** 计划原本写着它「行使的是 runWithIdempotentRetry 的
    // P2002 路径（预检 C.5：3 并发 → 1 成功 / 2 × P2002）」——**实测不是**：这里用的是全新的
    // 当事人，账户行还不存在，于是三笔都先去做那次 `INSERT … ON CONFLICT DO NOTHING`，
    // 后两笔在第一笔的账户行上等到它提交，等完再读快照就已经能看见那一行了 ⇒ 它们走的是
    // `findUnique` 的**重放**路径，唯一索引一次都没被撞到。证据是探针 **p15a**：把判别器改成
    // 恒 `false`（P2002 不再重试）之后，这一条**照样绿**。
    // 那条路因此由下面那条**确定性**用例单独负责；这里保留的是并发下的**结果**判据。
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

  it('★ 并发同键**真的**会撞 P2002，且重试一次后走重放（确定性构造：后来的那个卡在幂等键的唯一索引上）', async () => {
    // 上一条证明的是结果；这一条证明的是**路径**——`isIdempotencyConflict` 认出真库上那条
    // 约束、`runWithIdempotentRetry` 真的重试了、重试后真的走了重放。构造是确定性的：
    //   W：一笔过账，`ledger.transactions` 那一行已插入、事务挂住不提交；
    //   A：同一幂等键的另一笔 ⇒ 它的 `findUnique` **看不见** W 那行（未提交）⇒ 一路走到
    //      `ledgerTransaction.create` ⇒ 卡在唯一索引上（等 W 的 xid）；
    //   放行 W ⇒ A 拿到 23505 / P2002 ⇒ 重试一次 ⇒ 重放（created:false）。
    // 判别力（两条探针实测）：p15a（判别器恒 false）与 p9（不重试）都会让这条变红。
    const userId = uuidv7();
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: `seed:${userId}`,
        moves: [{ from: topup, to: available(userId), amount: 500n }],
      }),
    );
    await materializeAccounts(userId);

    const request = {
      kind: TRANSACTION_KINDS.FREEZE,
      idempotencyKey: `p2002:${userId}`,
      moves: [{ from: available(userId), to: frozen(userId), amount: 100n }],
    } as const;

    let winnerWroteTheRow!: () => void;
    const winnerInserted = new Promise<void>((resolve) => { winnerWroteTheRow = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const winner = prisma.$transaction(
      async (tx) => {
        const result = await ledger.post(tx, request);
        winnerWroteTheRow(); // transactions 那一行已插入、未提交 ⇒ 唯一索引会挡住后来的同键插入
        await gate;
        return result;
      },
      { timeout: 20_000 },
    );
    await winnerInserted;

    const loser = ledger.runWithIdempotentRetry((tx) => ledger.post(tx, request));

    const observer = new Client({ connectionString: pg.appUri });
    await observer.connect();
    let blockedStatements: string[];
    try {
      blockedStatements = await waitForLockWaiters(observer, 1);
    } finally {
      await observer.end();
    }
    expect(
      blockedStatements.filter((sql) => /INSERT INTO "ledger"\."transactions"/.test(sql)),
      `等锁的语句必须是那条幂等键的 INSERT（否则撞的不是唯一索引，这条用例证明的不是它想证明的事）。实测：${JSON.stringify(blockedStatements)}`,
    ).toHaveLength(1);

    release();
    const winnerResult = await winner;
    await expect(loser).resolves.toEqual({ transactionId: winnerResult.transactionId, created: false });
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: request.idempotencyKey } })).toBe(1);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 400n, frozen: 100n });
  }, 120_000);

  it('并发扣款：初始 10000 分、两笔并发各冻结 6000 ⇒ 恰好一笔成功、余额 4000', async () => {
    // ★ 这条用例是 C25 的判据。预检实测的两种失败形态：读-判断-写 ⇒ 两笔都成功、
    // 库里剩 4000（实际扣了 12000）；无条件 decrement ⇒ 余额 −2000。变异探针见 Step 6。
    // ★ 判别力是**量出来的**（探针 p1 / p2）：只有在两行账户都**已经存在**时，这两笔才是
    // 真并发的；否则它们被账户创建那条 INSERT 串行化，两种坏实现都能骗过这条用例。
    // 改完之后的实测：p1（无条件 decrement）与 p2（读-判断-写）都让**这一条**红。
    const userId = uuidv7();
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: `seed:${userId}`,
        moves: [{ from: topup, to: available(userId), amount: 10_000n }],
      }),
    );
    // ★ 两行都要先建出来，否则这两笔**根本不是并发的**（探针 p1/p2 实测）：
    //   `USER_FROZEN` 那一刻还不存在 ⇒ 先到的那个请求建它，后到的那个卡在那条 INSERT 上，
    //   等前者提交之后才读快照 ⇒ 由纯核心的预判拦下。于是把 `applyBalances` 改成
    //   **无条件 decrement** 之后，这条用例**照样绿**——它当时证明的不是「条件更新挡住了
    //   第二笔」，而是「账户创建那条 INSERT 把两笔串行化了」。这不改变结论（钱确实没被
    //   重复冻结），但它让「并发权威」这句话在这条用例里**没有见证**。
    await materializeAccounts(userId);

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
    // ★ 把 `USER_FROZEN` 这一行**先建出来**（`materializeAccounts`，一个来回、余额不变）。
    //   理由逐字见那个 helper 的注释：不先建出来，W 就是 `USER_FROZEN` 的创建者，而 A 会在
    //   **那条 INSERT** 上等 W——于是 A 等到 W 提交之后才读快照，由纯核心的预判拦下
    //   （`predicted`），`conditional-update` 那条路**一次都走不到**。这条构造要的是
    //   「A 的第一个锁点是借方守卫」，因此两行都必须先存在。
    await materializeAccounts(userId);

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
    //
    // ★ P3 / Task 4 更新了这条见证的**具体语句**（构造见证必须跟着取锁点走，否则它守的是
    //   一个已经不存在的形状）：C35 的账户行锁序在 `createMany`/`applyBalances` 之前多了一句
    //   `SELECT … ORDER BY id FOR UPDATE`，于是 A 现在卡在**那一句**上。它卡的位置仍然满足
    //   这条用例要的前提——**在 `applyBalances` 之前、且在快照读取之后**（`loadSnapshots` /
    //   `findUnique` 都是纯读、不取锁）——只是标识语句从「带守卫的 UPDATE」变成了「有序的
    //   FOR UPDATE」。**语义断言 `stage === 'conditional-update'` 一字未动**（它是这条用例的
    //   本体，也是计划 Step 6 明写「必须仍然成立、否则停下来报控制器」的那一条）。
    //   判别力：探针 `P-PLACE-EARLY`（把取锁点挪回计划 Step 4 的字面位置）实测让**下面那句**
    //   `stage` 变成 `predicted` 变红——也就是「锁序把败者挡在了快照读取之前」那件事真的会发生。
    const observer = new Client({ connectionString: pg.appUri });
    await observer.connect();
    let blockedStatements: string[];
    try {
      blockedStatements = await waitForLockWaiters(observer, 1);
    } finally {
      await observer.end();
    }
    const blockedAtAccountLock = blockedStatements.filter(
      (sql) => /FROM "?ledger"?\."?accounts"?[\s\S]*ORDER BY id FOR UPDATE/.test(sql),
    );
    expect(
      blockedAtAccountLock,
      `等锁的语句必须是那条**按 id 升序取全部账户行锁**的 SELECT（C35 的取锁点，且它在余额更新之前）。实测等锁语句：${JSON.stringify(blockedStatements)}`,
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
    const committed = await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: witnessKey,
        actorId: witness,
        moves: [{ from: topup, to: available(witness), amount: 1n }],
      }),
    );
    expect(await auditRowsFor(witnessKey)).toBe(1);

    // 审计行的三个字段必须与这次业务写入对得上——§13.2 要求「审计日志可完整重建任一次
    // 资金变动的链路」，而这条链路的三个扣件就是 (actorId, resource, resourceId)。
    // 这一句是 `actorId: request.actorId ?? null` 的**唯一**见证（把它改成恒 null，
    // 别的用例一条都不会红）。
    const row = await prisma.auditLog.findFirst({
      where: { metadata: { path: ['idempotencyKey'], equals: witnessKey } },
      select: { actorId: true, resource: true, resourceId: true },
    });
    expect(row).toEqual({ actorId: witness, resource: 'LedgerTransaction', resourceId: committed.transactionId });
  });

  it('余额不足（顺序）⇒ **预判**先拦下（stage = predicted），且库里一行都不留', async () => {
    // 这条用例是「`post` 真的调用了纯核心的 `applyPosting`」的**唯一**见证。
    // 删掉 `post` 里那句 `applyPosting(snapshots, legs)` 之后，这条会以
    // `stage === 'conditional-update'` 变红——顺序场景下条件更新**也**拦得住，
    // 所以「两笔并发各冻结 6000」那条（它只断言 stage 落在两元素集合里）**指不出**
    // 预判这条路有没有被走到。与 errors.ts 里 `stage` 那段注释是同一条理由。
    const userId = uuidv7();
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: `seed:${userId}`,
        moves: [{ from: topup, to: available(userId), amount: 1_000n }],
      }),
    );
    const key = `insufficient:${userId}`;
    const error = await prisma
      .$transaction((tx) =>
        ledger.post(tx, {
          kind: TRANSACTION_KINDS.FREEZE,
          idempotencyKey: key,
          moves: [{ from: available(userId), to: frozen(userId), amount: 1_001n }],
        }),
      )
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientFundsError);
    expect((error as InsufficientFundsError).stage).toBe('predicted');
    // 被拒的那笔在库里不留任何痕迹（同一个事务，全部回滚）。
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 1_000n, frozen: 0n });
  });

  it('kind 与 owner 的绑定写反 ⇒ UnknownAccountKindError（两个方向，库里不得出现第二行系统账户）', async () => {
    // `resolveAccounts` 里那句 `isSystem !== (ref.ownerUserId === null)` 的见证。
    // 写歪的后果**只有对账看得见**：`(owner_user_id, kind)` 的唯一索引把 NULL 视为互不相同，
    // 因此「给系统 kind 安一个 owner」会静默建出第二个 PLATFORM_ESCROW 账户（预检 §B.2 实测过）。
    const id = uuidv7();
    await expect(
      prisma.$transaction((tx) =>
        ledger.post(tx, {
          kind: TRANSACTION_KINDS.TOPUP,
          idempotencyKey: `badref-user-null:${id}`,
          moves: [{ from: topup, to: { kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: null }, amount: 1n }],
        }),
      ),
    ).rejects.toThrow(UnknownAccountKindError);
    await expect(
      prisma.$transaction((tx) =>
        ledger.post(tx, {
          kind: TRANSACTION_KINDS.ESCROW_LOCK,
          idempotencyKey: `badref-system-owned:${id}`,
          moves: [{ from: { kind: ACCOUNT_KINDS.PLATFORM_ESCROW, ownerUserId: uuidv7() }, to: available(id), amount: 1n }],
        }),
      ),
    ).rejects.toThrow(UnknownAccountKindError);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: { contains: `badref-` } } })).toBe(0);
  });

  it('系统账户缺失 ⇒ SystemAccountMissingError —— **不得**惰性创建（D2 的另一半）', async () => {
    // `if (!row) throw new SystemAccountMissingError(...)` 的见证，同时是 D2
    // 「系统账户只由迁移种子化」的**机器判据**：若把系统 kind 也放进惰性创建，
    // 这个用例会变成「过账成功」——因为 `(NULL, kind)` 上没有唯一性，库里会出现第二行。
    // 只有属主能删账户行（运行期角色被 REVOKE DELETE，Task 5 的 Item 0）。
    const owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
    try {
      const removed = await owner.query(
        `DELETE FROM "ledger"."accounts" WHERE "kind" = $1 AND "owner_user_id" IS NULL`,
        [ACCOUNT_KINDS.PLATFORM_ESCROW],
      );
      expect(removed.rowCount, '构造失败：PLATFORM_ESCROW 那一行没被删掉（它是不是被分录引用了？）').toBe(1);

      await expect(
        prisma.$transaction((tx) =>
          ledger.post(tx, {
            kind: TRANSACTION_KINDS.ESCROW_LOCK,
            idempotencyKey: `no-escrow:${uuidv7()}`,
            moves: [{ from: available(uuidv7()), to: escrow, amount: 1n }],
          }),
        ),
      ).rejects.toThrow(SystemAccountMissingError);
    } finally {
      // 复原（新 id、余额 0；此刻它还没有任何分录，所以删/建都是无损的）。
      await owner.query(
        `INSERT INTO "ledger"."accounts" ("id", "kind", "owner_user_id", "balance") VALUES ($1::uuid, $2, NULL, 0)`,
        [uuidv7(), ACCOUNT_KINDS.PLATFORM_ESCROW],
      );
      await owner.end();
    }
    expect(await prisma.ledgerAccount.count({ where: { kind: ACCOUNT_KINDS.PLATFORM_ESCROW, ownerUserId: null } })).toBe(1);
  });

  it('readBalances：没有账户行 = 余额 0（D2），且大写拼写同样读得到余额', async () => {
    expect(await ledger.readBalances(prisma, uuidv7())).toEqual({ available: 0n, frozen: 0n });
    expect(USER_ACCOUNT_KINDS).toEqual(['USER_AVAILABLE', 'USER_FROZEN']);
    expect(escrow.kind).toBe(ACCOUNT_KINDS.PLATFORM_ESCROW);

    // ★ 大小写这一条是**契约断言**，不是 `readBalances` 里 `.toLowerCase()` 的见证：
    //   探针 **p19**（把那句 `.toLowerCase()` 删掉）跑出来**一条都不红**——`owner_user_id`
    //   的类型是 `uuid`，PostgreSQL 在输入时就把大小写归一化了，`'ABC…'` 与 `'abc…'`
    //   在库里本来就是同一个值。它钉住的是**对外契约**（大写拼写必须读得到余额，
    //   而不是静默读成 0），那是调用方真正会遇到的那种错。
    const userId = uuidv7();
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: `case:${userId}`,
        moves: [{ from: topup, to: available(userId), amount: 10_000n }],
      }),
    );
    expect(await ledger.readBalances(prisma, userId.toUpperCase())).toEqual({ available: 10_000n, frozen: 0n });
  });

  /**
   * ★ **直接腿入口**（`postLegs`）—— C28 那条显式平衡断言真正的门。
   *
   * 为什么需要这扇门：`post` 的腿永远来自 `movesToLegs`，而它**按构造**总是平衡的
   * （每一条转移同时产生 −a 与 +a，和恒为 0）。探针 **p7** 实测：把 `post` 里那次
   * `assertBalanced` 删掉，**一条用例都不红**——在那条路上它是装饰。
   * 于是控制器裁定：保留它，把理由改成「它是为**腿集不来自 `movesToLegs`** 的路径准备的」，
   * 并给它一条真见证（`progress.md` 的 p7 裁定）。下面三条就是那条见证。
   */
  it('直接腿入口①：手工构造的**不平衡**腿 ⇒ UnbalancedPostingError，且库里一行都不留', async () => {
    const userId = uuidv7();
    const ids = await fundAvailable(userId, 100n);
    const key = `legs-unbalanced:${userId}`;
    const error = await prisma
      .$transaction((tx) =>
        ledger.postLegs(tx, {
          kind: TRANSACTION_KINDS.TOPUP,
          idempotencyKey: key,
          legs: [{ accountId: ids.available, amount: -100n }], // 和 = −100 ≠ 0：手工构造出来的不平衡腿集
        }),
      )
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(UnbalancedPostingError);
    expect((error as UnbalancedPostingError).sum).toBe(-100n);
    // 拒绝方向的三条独立判据；它们的**接受对侧**在下一条（同一查询形状必须返回 1 / 2 / 1）。
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(await auditRowsFor(key)).toBe(0);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 100n, frozen: 0n });
  });

  it('★ 直接腿入口②：不平衡的腿**先于幂等判定**被拒（这一条是那次 `assertBalanced` 的**判别性**见证）', async () => {
    // 为什么需要这一条：下一条（接受方向）与上一条都是「删掉那次 assertBalanced 也照样绿」的
    // ——`applyPosting` 的第一句也是 `assertBalanced`，任何不平衡的腿集它都会抛同一个错。
    // 唯一能把这**两处**分开的观测量是**顺序**：`post` 里那次断言在 `findUnique` **之前**，
    // 而 `applyPosting` 那次在它**之后**。因此这里让幂等键**真的存在**：
    //   有那次 assertBalanced ⇒ UnbalancedPostingError（结构错误先报）；
    //   删掉它（探针 p7'）    ⇒ 一路走到 findUnique、比腿不同 ⇒ IdempotencyKeyReusedError。
    // 这句顺序不是任意的：一笔**结构上就是错的**请求不该被当成「一次幂等重放/冲突」来回答。
    const userId = uuidv7();
    const ids = await fundAvailable(userId, 100n);
    const key = `legs-precedence:${userId}`;
    const first = await prisma.$transaction((tx) =>
      ledger.post(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: key,
        moves: [{ from: topup, to: available(userId), amount: 7n }],
      }),
    );

    const error = await prisma
      .$transaction((tx) =>
        ledger.postLegs(tx, {
          kind: TRANSACTION_KINDS.TOPUP,
          idempotencyKey: key, // ← 同一个键，且腿集与已存在的那笔**不同**
          legs: [{ accountId: ids.available, amount: -3n }],
        }),
      )
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(UnbalancedPostingError);
    expect(error).not.toBeInstanceOf(IdempotencyKeyReusedError);
    // 已存在的那笔**一字未动**（不是「报错但写坏了」）：
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { transactionId: first.transactionId } })).toBe(2);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 107n, frozen: 0n });
  });

  it('★ 直接腿入口③（**接受方向**）：手工构造的**平衡**腿被接受 —— 交易 / 分录 / 审计 = 1 / 2 / 1', async () => {
    const userId = uuidv7();
    const ids = await fundAvailable(userId, 100n);
    const key = `legs-balanced:${userId}`;
    const result = await prisma.$transaction((tx) =>
      ledger.postLegs(tx, {
        kind: TRANSACTION_KINDS.TOPUP,
        idempotencyKey: key,
        actorId: userId,
        legs: [
          { accountId: ids.topup, amount: -50n }, // 借：系统账户（天然为负）
          { accountId: ids.available, amount: 50n }, // 贷：用户可用
        ],
      }),
    );

    expect(result.created).toBe(true);
    // 三条判据与入口①逐条同形（否则入口①那三个 0 只能证明「查询写错了」）：
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { transactionId: result.transactionId } })).toBe(2);
    expect(await auditRowsFor(key)).toBe(1);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 150n, frozen: 0n });
  });
});
