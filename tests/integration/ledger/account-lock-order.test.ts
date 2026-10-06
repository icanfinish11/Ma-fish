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
 * 1. **账户行按升序取锁**（`★` 那条）。它由**两个按序的守卫**组成，各自的红灯形状不同：
 *    ① **第一档（观察）**：第三方连接先锁住**较小的那个** id，观察那一笔**卡在哪一条语句上**
 *       —— 必须卡在那条 `SELECT … ORDER BY id FOR UPDATE` 上。这是**唯一**让本组用例能**确定性**红的
 *       守卫：探针 `P-LOCK-REMOVED`（删掉取锁调用）实测它红，且把**实际**在等的语句原样打出来
 *       （实测是 `INSERT INTO "ledger"."entries" …`）。
 *    ② **第二档（`NOWAIT` 探针）**：再用 `FOR UPDATE NOWAIT` 从另一条连接试锁**较大的那个**，
 *       那一句必须立刻成功。
 *
 *    **★ 第二档不能单独变红（本条注释此前写错了机制，据实更正；结论见第 5 条）**：它此前被写成
 *    「反向取锁的实现会先锁住它 ⇒ `NOWAIT` 报 55P03 ⇒ 红」，并把那条判别力归给「把比较器反过来」。
 *    **这两句话都不对**：探针 `P-ORDER-DESC-INT`（比较器反过来）下这条用例**照样绿**
 *    （`evidence/t4-probe-matrix.txt` 与 `t5-nowait-discriminating-power.txt` 的 ② 格：
 *    `Tests 1 failed | 5 passed`，红的是「两种介质上的同一条规则」）。原因是账户侧的物理取锁
 *    顺序由那条 SQL 的 `ORDER BY id` 决定（`LedgerService.lockAccountRows` 的长注释记着同一件事）。
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
 *
 * 5. **★ 据实记载：第 1 条里 `NOWAIT` 那一档无法被单独行使**（P3 / Task 5 的实测结论，
 *    取代了此前那句没有见证的注释）。三次实验（`evidence/t5-nowait-discriminating-power.txt`、
 *    `t5-nowait-exhaustive.txt`、`t5-nowait-diag.txt`），四格：
 *
 *    | 变异 | 锁序那条用例 | `NOWAIT` 那一档 |
 *    |---|---|---|
 *    | 基线（升序判据 + `ORDER BY id`） | 绿 | 绿（`SUCCESS`，未被持有） |
 *    | 只有 `rowLockOrder` 比较器反过来（= `P-ORDER-DESC-INT`） | **绿**（红的是「两种介质」那条） | 绿 |
 *    | 只有 SQL 的 `ORDER BY id` 删掉 | **红在第一档**（3 s 观察超时） | **根本走不到** |
 *    | 两者同时 | 红在第一档 | 走不到 |
 *
 *    **机制（插桩实测，`t5-nowait-diag.txt`）**：那一笔卡住那一刻，`pg_locks` 里它对**两行**
 *    都已经持有 tuple 锁（`locktype = tuple` / `mode = AccessExclusiveLock` / `granted = true`），
 *    它真正在等的是**持有者的事务 id**（`transactionid` / `ShareLock` / `granted = false`）。
 *    `LockRows` 是**先把所有目标行锁住、之后**才因为拿不到事务快照而等——因此「它还没碰过第二个
 *    账户」这个**前提本身不成立**。反面对照（构造一条把第三方连接锁在**较大的** id 上、
 *    从而让第一档保持绿的用例，已实测后删除）：四格**全绿**——因为那时**两行**在探针眼里都已被持有。
 *    ⇒ **任何**在「实现把全部目标行都锁住」这一形状下的 `NOWAIT` 探测都无法区分取锁顺序；
 *    要让它红必须先删掉 `ORDER BY id`，而那一格又红在第一档。**这是结构性遮蔽，不是参数没调好。**
 *    它作为第 1 条的**附带观测**仍然承重（它直接证明那一笔确实持有两个账户行，而紧随其后的
 *    `resolves.toMatchObject({ created: true })` 只证明它最终成功）；但**不要**把它当成
 *    「取锁顺序」的独立见证——那个见证是第一档与探针 `P-LOCK-REMOVED`。
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
 * 等到**服务端**真的有一条语句卡在锁上（`wait_event_type = 'Lock'`）且它的文本匹配 `pattern`，
 * 并返回那一句。
 *
 * ## ★ 为什么这里不能 `sleep` 猜时序（实测教训）
 * 第一版用的是「受害者发出信号 ⇒ sleep 150 ms ⇒ 竞争者去要 x」。它在**单独跑**时稳定，
 * 而在 `pnpm test`（5 个 project + 一堆 testcontainers 同时跑）下**红了一次**：竞争者自己成了
 * 牺牲者（`error: deadlock detected` 落在**竞争者**那条连接上、测试文件耗时 57 s）。
 * 根因是那句 sleep 量错了对象——事件循环拥塞时「**先发起**」与「服务端**先开始等待**」不是
 * 同一件事；而死锁探测器中止的是**等待计时先到点**的那一个。⇒ 现在改成观察**服务端的事实**：
 * 受害者的等待已经在 `pg_stat_activity` 里看得见了，竞争者才去要 x。这样 δ>0 由构造保证。
 *
 * 窗口 3 s：超时说明**构造**没成立（不是断言失败），照本项目既定纪律响亮地抛。
 * 观察者与 Prisma 用同一个 `app_user` 连接（`pg_stat_activity` 的 `wait_event_type` / `query`
 * 只对本会话属主可见；两边同角色才看得见，否则读到的是 NULL 而已）。
 */
async function waitForBlockedStatement(client: Client, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 120; i += 1) {
    const r = await client.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    const hit = r.rows.map((row) => row.query).filter((sql) => pattern.test(sql));
    if (hit.length > 0) return hit[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // ★ 超时时把**实际**在等的语句原样带出来：否则「构造失败」这四个字没有任何证据，
  //   而下一个人只能自己重跑一遍才知道那一笔到底卡在哪一句上（本项目对「装置给出假绿」
  //   的既定处置就是把原始事实打出来）。这条消息也是探针 `P-LOCK-REMOVED` /
  //   `P-PLACE-AFTER-CREATEMANY` 的证据来源：那两条探针下它会显示出 `INSERT INTO …entries`。
  const all = await client.query<{ query: string; wait_event_type: string | null }>(
    `SELECT query, wait_event_type FROM pg_stat_activity WHERE datname = current_database()`,
  );
  const waiting = all.rows.filter((r) => r.wait_event_type === 'Lock').map((r) => r.query);
  throw new Error(
    `3 s 内没有观察到匹配 ${String(pattern)} 的等锁语句 —— 这条用例的时序前提不成立（构造失败，不是断言失败）。` +
      `此刻**实际**在等锁的语句：${JSON.stringify(waiting)}`,
  );
}

/** 把错误对象压成一行可读文本（断言失败时把**实测形状**打出来，而不是只说「不相等」）。 */
function shapeOf(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown; meta?: unknown; cause?: unknown };
  return `code=${String(e?.code)} meta=${JSON.stringify(e?.meta)} cause=${JSON.stringify(e?.cause)} message=${String(e?.message).replace(/\s+/g, ' ').slice(0, 200)}`;
}

/**
 * 造一次**真死锁**（SQLSTATE `40P01`），并让**被重试的那一笔**当牺牲者。
 *
 * ## 构造（确定性的：靠**观察**而不是靠 sleep 猜，理由见 `waitForBlockedStatement`）
 * ```
 * 竞争者（一条裸 pg 连接）: BEGIN; SELECT y FOR UPDATE;              ← 先持有 y
 * 牺牲者（withBoundedConflictRetry 包住的那笔）: 取 x（成功）→ 取 y（卡住）
 * 观察者: pg_stat_activity 里真的出现「牺牲者卡在那一句上」                ← 服务端事实
 * 竞争者（+50 ms）: SELECT x FOR UPDATE                               ← 环在这一刻形成
 * ```
 * 牺牲者随后被 PostgreSQL 的死锁探测器中止（`deadlock_timeout` 默认 1 s；两次单独实测各 ~1.04 s），
 * 竞争者拿到 x、回滚、释放 ⇒ 重试那一次一路上到 COMMIT。
 *
 * ## 为什么牺牲者**一定**是牺牲者
 * 探测器的判据是「这个进程**自己**开始等待之后 `deadlock_timeout` 到点」——先开始等的那个先到点，
 * 于是先发现自己身处环里、先把自己中止掉。上面第 3 步把「牺牲者已经在等」变成**观察到的事实**，
 * 竞争者的等待因此必然晚于它（δ>0）。若竞争者反而被中止（构造失败），这里**响亮地抛**——
 * 那条用例不能据此判任何事。
 *
 * ## 两道 `lock` 的形状由调用方给（这就是两档错误的来源）
 * `$queryRaw` ⇒ **P2010**；Prisma 委托 ⇒ **P2034**（预检 §0.4 实测）。两档都带 `40P01`。
 */
async function deadlockThenRetry(opts: {
  readonly x: string;
  readonly y: string;
  readonly lock: (tx: Prisma.TransactionClient, accountId: string) => Promise<unknown>;
  /** 受害者**卡住那一句**在 `pg_stat_activity.query` 里的特征（必须只匹配受害者自己）。 */
  readonly blockedPattern: RegExp;
}): Promise<{ attempts: number; retries: Array<[number, unknown]>; firstError: unknown; finalError: unknown }> {
  const rival = new Client({ connectionString: pg.appUri });
  await rival.connect();
  // ★ 失败路径也必须**放手**（修复轮第 2 步）：这条连接在 `BEGIN` 之后持有 `y`，而
  //   「构造失败」是**抛异常**离开这个函数的。留在原地的那条连接会让受害者那一笔永远
  //   等不到 `y`，于是 `afterAll` 收不掉它——实测多花 180 s（`Hook timed out in 180000ms`），
  //   并因此多出一条会让人误判的红（报告 §15：修好之后同一条红是秒级，消息就是真那条）。
  //   `releaseRival` 是幂等的，因此成功路径上的释放时机逐字未变。
  let rivalReleased = false;
  const releaseRival = async (): Promise<void> => {
    if (rivalReleased) return;
    rivalReleased = true;
    await rival.end().catch(() => undefined);
  };
  try {
    await rival.query('BEGIN');
    await rival.query('SELECT id FROM ledger.accounts WHERE id = $1::uuid FOR UPDATE', [opts.y]);

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

    const observer = new Client({ connectionString: pg.appUri });
    await observer.connect();
    let blockedStatement: string;
    try {
      blockedStatement = await waitForBlockedStatement(observer, opts.blockedPattern);
    } finally {
      await observer.end();
    }
    expect(
      blockedStatement,
      `构造见证：受害者必须卡在**它自己那一句**上（实测：${blockedStatement}）。若它卡在别处，这条用例证明的就不是这一档。`,
    ).toMatch(opts.blockedPattern);

    await new Promise((resolve) => setTimeout(resolve, 50)); // 让牺牲者的等待计时**先**起跑一个相位
    try {
      // 这一句会阻塞到牺牲者被中止（环形成 ⇒ 探测器把牺牲者干掉 ⇒ x 的锁归竞争者）。
      await rival.query('SELECT id FROM ledger.accounts WHERE id = $1::uuid FOR UPDATE', [opts.x]);
    } catch (error) {
      // **构造失败**（而不是断言失败）：竞争者自己成了牺牲者。这说明「谁先开始等待」的时序没成立，
      // 这一轮的测量作废——响亮地抛，绝不把它当成一次「如期」。
      throw new Error(`构造失败：竞争者自己成了死锁牺牲者（${shapeOf(error)}）——时序前提不成立，这一轮不能据此判任何事`);
    }
    await rival.query('ROLLBACK');
    await releaseRival();

    // 重试那一次：两行这时都空了。**不在这里抛**——收敛与否是**用例**要断言的东西
    // （判别式漏档时它会是一个错误对象，而不是一条被驱动装置吞掉的异常）。
    const finalError = await victim.then(() => null, (e: unknown) => e);
    return { attempts, retries, firstError, finalError };
  } finally {
    // ★ 构造失败 / 断言失败 / 任何一处提前抛出：这一条必须走，否则 180 s 空挂（见上面那段注释）。
    await releaseRival();
  }
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

    // ★ 失败路径上**没有人** await `poster`（那一刻这条用例已经抛了），而 `afterAll` 的
    //   `$disconnect()` 会把仍在飞的那笔交互式事务取消 ⇒ 它会以 P2028 拒绝。实测（报告 §15）：
    //   那条拒绝出现在 `disconnect START` **之后 12 ms**、且那一笔已经跑到 `applyBalances`
    //   —— 也就是说它是**收尾**造成的，不是放锁造成的。这里挂一个处理器**只为**不让它变成
    //   一条会让人误判的 `Unhandled Rejection`（否则修好的红里会多出一行 `Errors 1 error`）；
    //   绿路径的判据仍然是下面那句 `await expect(poster).resolves.toMatchObject(...)`，未放宽。
    void poster.catch(() => undefined);

    try {
      const observer = new Client({ connectionString: pg.appUri });
      await observer.connect();
      let blocked: string;
      try {
        blocked = await waitForBlockedStatement(observer, /FROM "?ledger"?\."?accounts"?[\s\S]*ORDER BY id FOR UPDATE/);
      } finally {
        await observer.end();
      }
      expect(
        blocked,
        `那一笔必须卡在**按 id 升序取全部账户行锁**的那一句上（卡在别处说明这次测的不是锁序）。实测：${blocked}`,
      ).toMatch(/ORDER BY id FOR UPDATE/);

      // 第二档：那一句必须立刻成功。
      // ★ 据实更正（见文件头第 5 条）：**这一档不能被单独行使**——它红的条件是那一笔
      //   「还没碰过 `second`」，而实测（`t5-nowait-diag.txt` 的 `pg_locks` 快照）是：它卡住时
      //   **两行**的 tuple 锁都已经被它持有（`granted = true`），它等的是**持有者的事务 id**。
      //   `LockRows` 先锁全部目标行、之后才等 ⇒ 这个前提不成立；把第三方连接改锁在较大的 id 上
      //   也一样（四格全绿，已实测后删除）。它在这里仍然是**一条真实观测**：那一笔确实持有
      //   `first`（`probeError === null` 就是「`second` 没被它持有」这一句的直接读数）。
      //   「取锁顺序」的独立见证是上面第一档，不是这里。
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
    } finally {
      // ★ 失败路径也必须**放手**（与 `deadlockThenRetry` 同一处修复）：`holder` 持有 `first`，
      //   留在原地会让那一笔永远等不到锁 ⇒ `afterAll` 收不掉它 ⇒ 多花 180 s 并多出一条会让人
      //   误判的 `Hook timed out`（实测见报告 §15）。放行之后那一笔照旧正常完成。
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }

    // 放行第三方连接 ⇒ 那一笔应当正常完成（这不是一次「谁都没做」的空过账）。
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
      // 尾部的 SQL 注释是**构造见证的一部分**：竞争者那条连接的语句文本与这一句**逐字相同**
      // （都是 `… WHERE id = $1::uuid FOR UPDATE`），而观察者要在 `pg_stat_activity` 里
      // **只**认出受害者那一句（`blockedPattern`）。
      lock: (tx, id) => tx.$queryRaw`SELECT id FROM ledger.accounts WHERE id = ${id}::uuid FOR UPDATE /* t4-victim-p2010 */`,
      blockedPattern: /t4-victim-p2010/,
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
      // 委托生成的语句是 `UPDATE "ledger"."accounts" …`（带引号），与竞争者的 `SELECT … FOR UPDATE`
      // 形状不同 ⇒ 观察者不会把竞争者认成受害者。
      blockedPattern: /UPDATE\s+"ledger"\."accounts"/,
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
