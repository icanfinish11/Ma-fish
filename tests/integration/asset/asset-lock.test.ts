import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { uuidv7 } from '@vca/shared';
import { AssetLockService } from '@vca/api/modules/asset/asset-lock.service.js';
import { AssetLockedByContractError } from '@vca/api/modules/asset/asset-lock.service.js';
import { AssetNotFoundError } from '@vca/api/modules/asset/ownership.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { rowLockOrder } from '@vca/api/common/db/lock-order.js';
import { withBoundedConflictRetry } from '@vca/api/common/db/retryable-conflict.js';
import type { Prisma } from '@vca/api/generated/prisma/client.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { waitForBlockedStatement } from '../../helpers/db-lock.js';

/**
 * 作品的**交换锁定**（P3 / Task 7；§6.3:284 / D10 / C35）。
 *
 * ## 这一节判的是哪一层
 *
 * `AssetLockService`（**服务层**，真库、真事务）。§6.3:284 的三个谓词
 * （「资产变为不可编辑 / 不可另行上架 / 不可删除」）的作用对象是**作品行**，
 * 锁的存储与判定因此留在 `asset`（D10）。
 *
 * ## 「行锁」与「列值」是**两件事**，这一节分开证明它们（计划 Step 1 的验收）
 *
 * | 承重的东西 | 它保证什么 | 本节的见证 |
 * |---|---|---|
 * | `SELECT … FOR UPDATE` | **并发互斥**：两个事务不会同时把同一件作品锁给两份合约 | ①（★ 那一条：服务端观察到第二条连接真的**卡在那条 FOR UPDATE 上**） |
 * | `locked_at` / `holder_contract_id` | **持久状态**：事务提交之后仍然查得到、且知道是谁锁的 | ①（列值）+ ②（解锁）+ ⑤（真库形状） |
 *
 * **只证明列值的实现（读-判断-写）会让 ① 那一条通过吗？** 不会——这正是它存在的理由：
 * 读-判断-写的那条路径**先读**（读到 `locked_at IS NULL`，因为第一条还没提交），
 * 然后 `UPDATE`（在行锁上等），等到了之后**照样写**（它没有任何条件），
 * 于是两条都「成功」，而作品被两份合约同时锁着。`FOR UPDATE` 的读在拿到锁之后
 * 会**重新求值**（READ COMMITTED 的 EvalPlanQual）⇒ 它读到的是**已提交**的锁定 ⇒ 拒绝。
 * 这条差别就是 `P-T7-lock-forupdate` 探针（把 `FOR UPDATE` 删掉）要打红的那一条。
 *
 * ## 并发用例一律用**服务端事实**对齐，不用 `sleep`
 *
 * 见 `tests/helpers/db-lock.ts` 的文件头（P3 / Task 4 为 `sleep` 付过一次代价）。
 */
let pg: TestPg;
let prisma: PrismaService;
let locks: AssetLockService;

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  // 直接构造：本文件判的是**锁服务本身**（没有 HTTP、没有 Nest 装配）。
  // 「它在 APP 里被 provide 出来了」这件事由 `double-lock.test.ts` 经真实 DI 见证。
  locks = new AssetLockService();
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
});

/** 一个用户（`asset.assets.owner_id` 今天没有外键，但用真用户更接近生产形状）。 */
async function makeUser(): Promise<string> {
  return (await prisma.user.create({ data: {} })).id;
}

/** 一件**没有版本**的作品。锁的判据只读作品行，因此本文件不需要版本与元数据。 */
async function makeAsset(ownerId: string): Promise<string> {
  return (await prisma.asset.create({ data: { ownerId } })).id;
}

/** 一件作品的两列（锁判据的全部输入）。 */
async function lockColumns(assetId: string): Promise<{ lockedAt: Date | null; holderContractId: string | null }> {
  return (await prisma.asset.findUniqueOrThrow({
    where: { id: assetId },
    select: { lockedAt: true, holderContractId: true },
  })) as { lockedAt: Date | null; holderContractId: string | null };
}

/** 一条交互式事务里跑一段（`maxWait` / `timeout` 显式给足：并发用例要**等**到构造成立）。 */
function inTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { maxWait: 15_000, timeout: 30_000 });
}

/** 把错误压成一行（断言失败时打出**实测形状**，而不是只说「不相等」）。 */
function shapeOf(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  return `name=${String(e?.name)} code=${String(e?.code)} message=${String(e?.message).replace(/\s+/g, ' ').slice(0, 200)}`;
}

/**
 * 这个错误**是不是死锁那一档**（`code` 白名单 + SQLSTATE 文本）。
 *
 * 判据刻意**宽**（两档 code 与 40P01 文本都认）：它的用途是「把死锁与『已被锁定』
 * 区分开」，漏判会让一条死锁伪装成一次正常的拒绝。宽在这里的方向是安全的。
 */
function isDeadlockShaped(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  if (e?.code === 'P2010' || e?.code === 'P2034') return true;
  return /40P01|deadlock/i.test(String(e?.message ?? ''));
}

describe('作品的交换锁定（§6.3:284 / Task 7）', () => {
  it('① 锁上之后两列都非空（验收面）；**另一个合约**再锁 ⇒ AssetLockedByContractError（拒绝面）；同一份合约再锁 ⇒ 幂等放行', async () => {
    const owner = await makeUser();
    const assetId = await makeAsset(owner);
    const contractA = uuidv7();
    const contractB = uuidv7();

    // ── 验收面：第一份合约锁成功。
    await inTx((tx) => locks.lockAssets(tx, [assetId], contractA));
    const held = await lockColumns(assetId);
    expect(held.lockedAt, '锁定之后 `locked_at` 必须非空').toBeInstanceOf(Date);
    expect(held.holderContractId, '锁定之后必须记下**谁锁的**').toBe(contractA);

    // ── 幂等重放：同一次确认被重发（网络重试）⇒ **放行**，且**不**改写 locked_at。
    await inTx((tx) => locks.lockAssets(tx, [assetId], contractA));
    const replayed = await lockColumns(assetId);
    expect(replayed.lockedAt?.getTime(), '同一份合约重放不该把 `locked_at` 往后推').toBe(held.lockedAt?.getTime());
    expect(replayed.holderContractId).toBe(contractA);

    // ── 拒绝面：**另一份**合约锁同一件作品 ⇒ 409 那一档。
    const error = await inTx((tx) => locks.lockAssets(tx, [assetId], contractB)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, `另一份合约再锁必须被拒。实测：${shapeOf(error)}`).toBeInstanceOf(AssetLockedByContractError);
    expect((error as AssetLockedByContractError).holder).toBe(contractA);
    // 拒绝之后那一行**没有被改写**（拒绝的判据是「持有者是别人」，而不是「抢一次」）：
    expect(await lockColumns(assetId)).toMatchObject({ holderContractId: contractA });
  }, 120_000);

  it('★ 并发互斥：第二条连接把同一件作品锁给**另一份**合约时卡在那条 `FOR UPDATE` 上，持有者提交之后 ⇒ 拒绝（恰好一条成功）', async () => {
    const owner = await makeUser();
    const assetId = await makeAsset(owner);
    const first = uuidv7();
    const rival = uuidv7();

    // ── T1：真实服务路径锁上之后**停在那里**（事务开着 ⇒ 行锁还在）。
    //    闸门是 promise 而不是 `sleep`：什么时候放行由用例决定，与机器负载无关。
    let locked!: () => void;
    const lockedGate = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t1 = inTx(async (tx) => {
      await locks.lockAssets(tx, [assetId], first);
      locked();
      await releaseGate;
      return 'locked';
    });
    await lockedGate;

    // ── T2：**同一条**服务路径，不同的合约。
    const t2 = inTx((tx) => locks.lockAssets(tx, [assetId], rival));
    const t2Settled = t2.then(
      () => null,
      (e: unknown) => e,
    );

    try {
      const observer = new Client({ connectionString: pg.appUri });
      await observer.connect();
      let blocked: string;
      try {
        // 非空转前提：T2 必须卡在**它自己那一句**（`asset.assets` 的取锁语句）上。
        // 卡在别处（例如 Prisma 的连接获取）说明这次构造测的不是行锁。
        blocked = await waitForBlockedStatement(observer, /FROM\s+"?asset"?\."?assets"?[\s\S]*FOR UPDATE/);
      } finally {
        await observer.end();
      }
      expect(
        blocked,
        `第二条连接必须卡在 **取作品行锁** 的那一句上（卡在别处说明这次测的不是行锁）。实测：${blocked}`,
      ).toMatch(/FOR UPDATE/);
    } finally {
      // ★ 失败路径也必须放手：留在原地会让 T2 永远等下去（`afterAll` 收不掉它）。
      release();
    }

    await expect(t1).resolves.toBe('locked');
    const error = await t2Settled;
    expect(
      error,
      '持有者提交之后，后来者必须读到**已提交**的锁定并拒绝（读-判断-写的实现会在这里**也成功**）。' +
        `实测：${shapeOf(error)}`,
    ).toBeInstanceOf(AssetLockedByContractError);
    // 「恰好一条成功」的最终事实：作品**只**属于第一份合约。
    expect(await lockColumns(assetId)).toMatchObject({ holderContractId: first });
  }, 120_000);

  it('② 解锁：持有者解得了（验收面：两列回到空）、**别的合约**解不动（拒绝面，且两列不变）', async () => {
    const owner = await makeUser();
    const assetId = await makeAsset(owner);
    const holder = uuidv7();
    const other = uuidv7();

    await inTx((tx) => locks.lockAssets(tx, [assetId], holder));

    // ── 拒绝面：别的合约解不动。
    const refused = await inTx((tx) => locks.unlockAssets(tx, [assetId], other)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused, `别的合约不该解得动。实测：${shapeOf(refused)}`).toBeInstanceOf(AssetLockedByContractError);
    expect(await lockColumns(assetId), '被拒之后锁必须**原样**还在').toMatchObject({ holderContractId: holder });

    // ── 验收面：持有者解得动（没有它，上面那条拒绝可能只是「这行根本改不动」）。
    await inTx((tx) => locks.unlockAssets(tx, [assetId], holder));
    expect(await lockColumns(assetId)).toEqual({ lockedAt: null, holderContractId: null });

    // ── 解锁之后**另一份合约**锁得上（锁不是单向阀）。
    await inTx((tx) => locks.lockAssets(tx, [assetId], other));
    expect(await lockColumns(assetId)).toMatchObject({ holderContractId: other });

    // ── 幂等：已经解开的再解一次 ⇒ 空操作、不报错（`Task 10` 的终态解锁会重放）。
    await inTx((tx) => locks.unlockAssets(tx, [assetId], other));
    await inTx((tx) => locks.unlockAssets(tx, [assetId], other));
    expect(await lockColumns(assetId)).toEqual({ lockedAt: null, holderContractId: null });
  }, 120_000);

  it('③ 作品不存在 ⇒ AssetNotFoundError（锁与解锁**两个方向**），且**不伪装成已锁定**', async () => {
    const missing = uuidv7();
    const contractId = uuidv7();
    const lockError = await inTx((tx) => locks.lockAssets(tx, [missing], contractId)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(lockError, `对一件不存在的作品「锁定成功」会把一次调用方错误变成一次成功的确认。实测：${shapeOf(lockError)}`).toBeInstanceOf(
      AssetNotFoundError,
    );
    const unlockError = await inTx((tx) => locks.unlockAssets(tx, [missing], contractId)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(unlockError, `实测：${shapeOf(unlockError)}`).toBeInstanceOf(AssetNotFoundError);

    // 验收对照：**存在**的那一件同一段调用是成功的（否则上面两条可能只是「这两句永远抛」）。
    const assetId = await makeAsset(await makeUser());
    await expect(inTx((tx) => locks.lockAssets(tx, [assetId], contractId))).resolves.toBeUndefined();
  }, 120_000);

  it('④ ★ 两种介质上的**同一条规则**：SQL 的 `ORDER BY id` 与共享判据 `rowLockOrder` 逐个相同', async () => {
    // ## 为什么需要这一条（Task 4 在账户侧量到的同一件事，据实继承）
    // 物理取锁顺序其实由**那条 SQL 的 `ORDER BY id`** 决定（PostgreSQL 的 `uuid` 比较 =
    // 16 字节字典序），而 `lockAssets` 里那份数组由共享判据 `rowLockOrder` 产出。
    // 于是这条路径上有**两个介质在表达同一个决定**：JS 侧（去重 + 字节升序）与 SQL 侧。
    // 两者必须逐个相同，否则「数组准备」与「执行者」会在某个输入上分开。
    const inputs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const owner = await makeUser();
      inputs.push(await makeAsset(owner), await makeAsset(owner));
    }
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM asset.assets WHERE id = ANY(${inputs}::uuid[]) ORDER BY id
    `;
    expect(rows.map((r) => r.id)).toEqual(rowLockOrder(inputs));

    // 域外样本（大小写混合）钉住这句话的**边界**：PostgreSQL 的 `uuid` 比较与大小写无关，
    // 而 `rowLockOrder` 是**字符串**字节序。真实调用方只会传库里读回来的小写定长 id。
    const lower = inputs[0]!;
    const upper = lower.toUpperCase();
    expect(rowLockOrder([lower, upper]), '共享判据是字符串字节序：大写排在小写之前').toEqual([upper, lower]);
    const sameRow = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM asset.assets WHERE id = ANY(${[lower, upper]}::uuid[]) ORDER BY id
    `;
    expect(sameRow.map((r) => r.id)).toEqual([lower]); // 同一个 uuid 的两种拼写在库里是同一行
  }, 120_000);

  it('⑤ ★ 缺失的那件作品按**锁序**报出来：两个 id 都不存在时报**升序里第一个**（共享判据在服务里是承重的）', async () => {
    // ## 这一条为什么存在（「顺序是不是纯核心那一份」的**行为**见证）
    // 单条语句 + `ORDER BY id` 的形状下，JS 侧那份数组在**物理取锁**上是看不出来的
    // （Task 5 在账户侧量到同一件事：把比较器反过来，真库锁序的见证照样绿）。
    // 但 `lockAssets` 用它做第二件事：**报哪一个 id 缺失**（`ordered.find(...)`）。
    // 于是「服务里的顺序 = 共享判据的顺序」第一次有了一个**可观测的行为**：
    // 两个都不存在时报的是升序里小的那一个。
    // ⇒ 变异探针 `P-T7-order-shared`（把 `common/db/lock-order.ts` 的比较器反过来）
    //    会让这一条**与** `tests/unit/exchange/lock-order.test.ts`（纯核心）**同时**变红；
    //    若 `asset` 自己又排了一次序（自己写一个升序），探针只会打红纯核心那一条。
    const owner = await makeUser();
    const existing = await makeAsset(owner);
    const a = uuidv7();
    const b = uuidv7();
    const ordered_ab = rowLockOrder([a, b]);
    const smaller = ordered_ab[0]!;
    const larger = ordered_ab[1]!;

    const error = await inTx((tx) => locks.lockAssets(tx, [larger, existing, smaller], uuidv7())).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, `实测：${shapeOf(error)}`).toBeInstanceOf(AssetNotFoundError);
    expect(
      (error as AssetNotFoundError).assetId,
      `缺失的 id 必须按**锁序**报（升序里第一个 = ${smaller}）；报出别的那一个说明服务里的顺序不是共享判据给的`,
    ).toBe(smaller);
  }, 120_000);

  it('⑥ ★ 反向双锁（**同一对**作品、两笔并发、入参顺序相反）⇒ 恰好一笔成功、另一笔被**干净地拒**，而**不是**死锁', async () => {
    // ## ★ 据实记载：这里修正了计划 Step 1 第 4 条的**期望值**（首次运行就是红在这一条上）
    //
    // 计划写的是：「两笔反向的双锁并发跑，**两笔都必须成功**（修之前实测 P2010 / 40P01）」。
    // 那句话与**同一份计划**的另一条验收（「同一件作品被两份合约争抢 ⇒ 恰好一份成功」）
    // 互相矛盾：两笔双锁若指向**同一对**作品，那么「两笔都成功」就等于
    // **作品被两份合约同时锁着** —— 而那正是 §6.3:284 要禁止的事。
    // 若两笔指向**互不相交**的两对，那它们之间没有任何争用，`lockOrder` 帮不上忙，
    // 这条用例也什么都证不了。⇒ 唯一有内容的形状是**同一对 + 相反入参顺序**，
    // 而它的正确期望由两件事组成（下面两条判据）：
    //
    //   ① **没有一笔以死锁失败**：无序取锁的实现会 ABBA（预检 §B.1 第（5）条实测
    //      P2010 / 40P01），而那是一个**与「已被锁定」完全不同**的失败；
    //   ② **恰好一笔成功**，另一笔是 `AssetLockedByContractError`（互斥仍然成立）。
    //
    // 这两条一起才把 C35 的「先排好、再取」钉住：只判 ① 会漏掉「两笔都成功」的
    // 读-判断-写实现，只判 ② 会漏掉「死锁也算拒绝」的实现。
    const owner = await makeUser();
    const a = await makeAsset(owner);
    const b = await makeAsset(owner);
    const first = rowLockOrder([a, b])[0]!;
    const second = rowLockOrder([a, b])[1]!;
    expect(first, '两件作品是两个不同的 id（否则这一条什么都没测）').not.toBe(second);
    const contractOne = uuidv7();
    const contractTwo = uuidv7();

    const results = await Promise.allSettled([
      inTx((tx) => locks.lockAssets(tx, [first, second], contractOne)),
      inTx((tx) => locks.lockAssets(tx, [second, first], contractTwo)),
    ]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const deadlocks = failures.filter((r) => isDeadlockShaped(r.reason));
    expect(
      deadlocks.map((r) => shapeOf(r.reason)),
      '反向取锁必须**不成环**（C35）。无序取锁的实现在这里是 P2010 / 40P01 —— 预检 §B.1 第（5）条实测过。',
    ).toEqual([]);
    expect(
      results.filter((r) => r.status === 'fulfilled'),
      `两笔争抢**同一对**作品 ⇒ 恰好一笔成功。实测失败：${failures.map((r) => shapeOf(r.reason)).join(' | ')}`,
    ).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(
      failures[0]!.reason,
      `另一笔必须是「已被别的合约锁定」那一档（不是死锁、也不是别的什么）。实测：${shapeOf(failures[0]!.reason)}`,
    ).toBeInstanceOf(AssetLockedByContractError);

    // 结果判据的另一半：**恰好一份**合约持有它们，且它是**成功那一笔**的那一份。
    const winner = results[0]!.status === 'fulfilled' ? contractOne : contractTwo;
    const locked = await prisma.asset.findMany({
      where: { id: { in: [a, b] } },
      select: { holderContractId: true },
    });
    expect(locked.map((r) => r.holderContractId)).toEqual([winner, winner]);
  }, 120_000);

  it('⑦ ★ 真死锁（`$queryRaw` ⇒ **P2010**/40P01）被判为可重试、有界重试后收敛 —— 两档判别式在**本路径**上的第一档', async () => {
    // ## 构造（确定性：靠**观察**而不是靠 sleep 猜，与 Task 4 的 `deadlockThenRetry` 同形）
    // ```
    // 竞争者（一条裸 pg 连接）: BEGIN; SELECT b FOR UPDATE;        ← 先持有**大的**那个 id
    // 受害者（withBoundedConflictRetry 包住的服务路径）: 锁 a（成功）→ 锁 b（卡住）
    // 观察者: pg_stat_activity 里真的出现「受害者卡在那一句上」     ← 服务端事实
    // 竞争者: SELECT a FOR UPDATE                                  ← 环在这一刻形成
    // ```
    // 受害者（先开始等的那一个，先到 `deadlock_timeout`）被 PostgreSQL 中止 ⇒ 竞争者拿到 a、
    // 回滚、释放 ⇒ **重试那一次**一路上到提交。
    //
    // ★ 这一条是 `common/db/retryable-conflict.ts` 在 Task 7 上的**第一个正当消费者**
    //   （Task 6 逐字说明过它为什么不加假 import：Task 6 不取任何行锁）。
    //   探针 `P-T7-disc-p2034`（把判别式窄成只认 `P2034`）会让这一条红 —— 也就是
    //   「一个**永远不重试**的重试」，而它在生产上的表现只是「偶发 500」，没有人会去查。
    const owner = await makeUser();
    const a = await makeAsset(owner);
    const b = await makeAsset(owner);
    const x = rowLockOrder([a, b])[0]!;
    const y = rowLockOrder([a, b])[1]!;
    const holderContract = uuidv7();

    const rival = new Client({ connectionString: pg.appUri });
    await rival.connect();
    let released = false;
    const releaseRival = async (): Promise<void> => {
      if (released) return;
      released = true;
      await rival.end().catch(() => undefined);
    };
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT id FROM asset.assets WHERE id = $1::uuid FOR UPDATE', [y]);

      let attempts = 0;
      let firstError: unknown = null;
      const retries: Array<[number, unknown]> = [];
      const victim = withBoundedConflictRetry(
        async () => {
          attempts += 1;
          const nth = attempts;
          try {
            // **真的走服务路径**（不是复刻一份取锁 SQL）：受害者确实是 `lockAssets`。
            await inTx((tx) => locks.lockAssets(tx, [x, y], holderContract));
          } catch (error) {
            if (nth === 1) firstError = error;
            throw error;
          }
        },
        { onRetry: (attempt, error) => retries.push([attempt, error]) },
      );

      const observer = new Client({ connectionString: pg.appUri });
      await observer.connect();
      let blocked: string;
      try {
        // 尾部注释是**构造见证的一部分**：它与竞争者那句形状不同，观察者因此只认受害者。
        blocked = await waitForBlockedStatement(observer, /FROM\s+"?asset"?\."?assets"?[\s\S]*FOR UPDATE/);
      } finally {
        await observer.end();
      }
      expect(blocked, `受害者必须卡在**它自己那一句**上。实测：${blocked}`).toMatch(/FOR UPDATE/);

      await new Promise((resolve) => setTimeout(resolve, 50)); // 让受害者的等待计时**先**起跑一个相位
      try {
        await rival.query('SELECT id FROM asset.assets WHERE id = $1::uuid FOR UPDATE', [x]);
      } catch (error) {
        throw new Error(
          `构造失败：竞争者自己成了死锁牺牲者（${shapeOf(error)}）—— 时序前提不成立，这一轮不能据此判任何事`,
        );
      }
      await rival.query('ROLLBACK');
      await releaseRival();

      const finalError = await victim.then(
        () => null,
        (e: unknown) => e,
      );

      // 顺序是承重的：**形状**先断言（它是这一档的全部内容），收敛性放在后面。
      expect((firstError as { code?: unknown }).code, `实测形状：${shapeOf(firstError)}`).toBe('P2010');
      const text = `${String((firstError as { message?: unknown }).message)}|${JSON.stringify((firstError as { meta?: unknown }).meta)}`;
      expect(text, `真的是死锁（SQLSTATE 40P01）而不是一个长得像的对象。实测形状：${shapeOf(firstError)}`).toContain('40P01');
      expect(attempts, '含首次的尝试次数：死锁一次 + 重试一次').toBe(2);
      expect(retries, 'onRetry 必须**恰好**被调用一次（否则这条不是「真的重试了」）').toHaveLength(1);
      expect(retries[0]![1]).toBe(firstError);
      expect(finalError, `重试那一次必须成功。实测：${shapeOf(finalError)}`).toBeNull();
      // 收敛之后锁**真的**落下了（不是「重试一次什么也没做」）。
      expect(await lockColumns(x)).toMatchObject({ holderContractId: holderContract });
      expect(await lockColumns(y)).toMatchObject({ holderContractId: holderContract });
    } finally {
      await releaseRival();
    }
  }, 120_000);

  it('⑧ 判决读取 `isLocked`：未锁 / 锁着（谁锁的）/ 作品不存在 ⇒ `null`', async () => {
    const owner = await makeUser();
    const assetId = await makeAsset(owner);
    const contractId = uuidv7();

    const before = await inTx((tx) => locks.isLocked(tx, assetId));
    expect(before, '作品存在 ⇒ 必须给一个判决（不是一个为了让调用方能编译的假对象）').toEqual({
      locked: false,
      holderContractId: null,
    });

    await inTx((tx) => locks.lockAssets(tx, [assetId], contractId));
    expect(await inTx((tx) => locks.isLocked(tx, assetId))).toEqual({
      locked: true,
      holderContractId: contractId,
    });

    // 作品不存在 ⇒ `null`（**不是** `{locked:false}`：把「不存在」说成「没锁」会让
    // 唯一在用它那条路径（A-7 的版本写入）把一次调用方错误当成一次放行）。
    expect(await inTx((tx) => locks.isLocked(tx, uuidv7()))).toBeNull();
  }, 120_000);

  it('⑨ 真库形状：`holder_contract_id` 是可空 `uuid`，`locked_at` 是可空 `timestamptz(3)`（迁移的常驻见证）', async () => {
    // 迁移生成脚本（`evidence/t7-migration-gen.mjs`）是**一次性**取证；这一条是常驻回归：
    // 谁把列删掉、改成 NOT NULL、或者换成别的类型，这里先红。
    const cols = await prisma.$queryRaw<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'asset' AND table_name = 'assets'
         AND column_name IN ('locked_at', 'holder_contract_id')
       ORDER BY column_name
    `;
    expect(cols).toEqual([
      { column_name: 'holder_contract_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'locked_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);
  }, 120_000);
});
