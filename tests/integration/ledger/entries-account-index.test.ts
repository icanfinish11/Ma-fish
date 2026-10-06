import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { LedgerReconciliationService } from '@vca/api/modules/ledger/reconciliation.service.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * `ledger.entries(account_id)` 索引的**使能见证**（P3 / Task 5；D4 / 控制器裁定 ⑥）。
 *
 * ## 为什么这条索引的「用上了没有」需要单独一个文件
 *
 * 它需要**足够多的行**——而 PostgreSQL 在小表上**正确地**选择 `Seq Scan`（4 000 条分录
 * 时索引也已经被选中，见下），所以判据不能靠小样本上的 `EXPLAIN` 结论。本文件造 20 万条
 * 分录（照抄 P2 预检的做法：属主在事务里 `SET LOCAL session_replication_role = replica`，
 * 一次性绕过延迟约束触发器与外键，一个事务插完），只在造完之后读计划。
 *
 * ## ★ 判据取两条腿，而且第二条腿**有反面对照**（否则它是一条不可能失败的断言）
 *
 * 1. **目录断言**：`pg_indexes` 里那条索引的定义**逐字**对
 *    （`CREATE INDEX entries_account_id_idx ON ledger.entries USING btree (account_id)`）。
 *    这条只证明索引**存在**。索引存在 ≠ 它被用上——一个「加了索引但查询写法用不到它」
 *    的实现照样绿。
 * 2. **执行计划断言**：逐账户 drill-down（`reconciliation.service.ts` 的 `driftOf`
 *    那条 SQL 的形状）在 20 万行上**落到那条索引上**（`Bitmap Index Scan on entries_account_id_idx`），
 *    且计划文本里**没有** `Seq Scan on entries`。
 *    **反面对照**：把索引 `DROP` 掉之后，**同一条查询**必须变成 `Seq Scan on entries`
 *    —— 没有这一半，「计划里没有 Seq Scan」这句话在一个「索引根本不影响它」的查询上
 *    同样成立（本项目反复抓到的那一类）。
 *
 * ## ★ 与计划 Step 5 的一处**实测冲突**（据实记载，以实测为准）
 *
 * 计划预期的是「`reconcilePerAccount()` 那条全表查询在 20 万行之后不再 `Seq Scan on entries`」。
 * **实测不会**，而且**加不加索引逐字相同**（`evidence/t5-plan-probe-attempt4.txt`：
 * 40.112 ms / `Seq Scan on entries` + `HashAggregate`，删掉索引之后计划与耗时不变）。
 * 原因：那条查询要的是**全表** `Σ entries.amount`（按 `account_id` 分组），
 * 分组必须读每一行——索引对它没有帮助。**索引的落点是逐账户的那条读法**，也就是这条判据
 * 测的形状。⇒ 计划里那句话与「为一个已交付功能加索引是它的使能条件」都成立，
 * 只是**使能的是哪一条查询**记错了；这一点写进报告，不改判据的方向。
 */
let pg: TestPg;
let prisma: PrismaService;
let recon: LedgerReconciliationService;
let owner: Client;

/** 造数据的规模。与预检 §A.2 的实测同一量级（20 万条 / 1 万账户）。 */
const ACCOUNTS = 10_000;
const ENTRIES = 200_000;
/** 被 drill-down 点名的账户（`000…001`）。 */
const TARGET = '00000000-0000-7000-8000-000000000001';
/** 每个账户恰好多少条分录（`g % ACCOUNTS` ⇒ 均匀）。 */
const PER_ACCOUNT = ENTRIES / ACCOUNTS;

/**
 * 与 `driftOf` **同一形状**的 SQL，但把账户 id 写成**字面量**。
 *
 * 为什么必须写字面量：`EXPLAIN` 是工具语句，**不接受绑定参数**（实测：
 * `there is no parameter $1`）。`driftOf` 用的是 `${accountId}::uuid` 参数形式，
 * 而两条查询的**计划形状**在这里只取决于「能不能用索引按 account_id 取行」——
 * 计划里出现的 `Index Cond: (account_id = '…'::uuid)` 就是证据。
 * 这处差异由下面 `driftOf` 的行为断言兜住（它真的调服务、真的拿到数）。
 */
const drillSql = (id: string): string => `
      SELECT a.id::text                                                              AS account_id,
             COALESCE(a.balance, 0)::text                                            AS materialized,
             COALESCE((SELECT sum(e.amount) FROM ledger.entries e WHERE e.account_id = a.id), 0)::text AS derived,
             (COALESCE(a.balance, 0)
                - COALESCE((SELECT sum(e.amount) FROM ledger.entries e WHERE e.account_id = a.id), 0))::text AS drift
        FROM ledger.accounts a
       WHERE a.id = '${id}'::uuid`;

/** 读一次计划文本（`EXPLAIN (ANALYZE, BUFFERS)`）。 */
async function planOf(sql: string): Promise<string> {
  const rows = await owner.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  return rows.rows.map((r) => r['QUERY PLAN']).join('\n');
}

/** 一次 drill-down 的**墙钟**耗时（同一条 SQL 跑 `times` 遍取最小，去掉首次的暖机噪声）。 */
async function fastestDrillMs(sql: string, times: number): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < times; i += 1) {
    const t0 = performance.now();
    await owner.query(sql);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  recon = new LedgerReconciliationService(prisma);
  owner = new Client({ connectionString: pg.ownerUri });
  await owner.connect();

  // ── 造 20 万条分录 / 1 万个账户 ────────────────────────────────────────────────
  // `session_replication_role = replica`：绕过延迟约束触发器与外键。**只有属主做得到**
  // （运行期角色 `app_user` 不行），因此这不是「测试放宽了生产约束」，而是「用属主权限
  // 造一批生产里要跑很久才攒得出来的数据」——P2 预检用的是同一个做法。
  const t0 = performance.now();
  await owner.query('BEGIN');
  await owner.query(`SET LOCAL session_replication_role = replica`);
  await owner.query(
    `INSERT INTO ledger.accounts (id, kind, owner_user_id, balance, created_at)
     SELECT ('00000000-0000-7000-8000-' || lpad(g::text, 12, '0'))::uuid, 'USER_AVAILABLE', NULL, 0, now()
       FROM generate_series(1, $1) g`,
    [ACCOUNTS],
  );
  await owner.query(
    `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1::uuid, 'PROBE', 'idx-witness')`,
    ['00000000-0000-7000-8000-000000000001'],
  );
  await owner.query(
    `INSERT INTO ledger.entries (id, transaction_id, account_id, amount, created_at)
     SELECT ('00000000-0000-7fff-8000-' || lpad(g::text, 12, '0'))::uuid,
            $1::uuid,
            ('00000000-0000-7000-8000-' || lpad(((g % $2) + 1)::text, 12, '0'))::uuid,
            1, now()
       FROM generate_series(1, $3) g`,
    ['00000000-0000-7000-8000-000000000001', ACCOUNTS, ENTRIES],
  );
  await owner.query('COMMIT');
  // `ANALYZE` 不能省：规划器靠统计信息决定用不用索引，没有统计信息时它按默认假设走
  // （那会让这条判据测的是「统计信息在不在」而不是「索引在不在」）。
  await owner.query('ANALYZE ledger.entries');
  await owner.query('ANALYZE ledger.accounts');
  process.stderr.write(
    `[索引见证] 造数据 ${ENTRIES} 条分录 / ${ACCOUNTS} 个账户耗时 ${Math.round(performance.now() - t0)} ms\n`,
  );
}, 600_000);

afterAll(async () => {
  await owner?.end().catch(() => undefined);
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
});

describe('★ `ledger.entries(account_id)` 索引：目录断言 + 执行计划（含反面对照）', () => {
  it('两条腿：`pg_indexes` 里定义逐字对，且 20 万行之后 drill-down **落到索引上**、没有 `Seq Scan on entries`', async () => {
    // ── 腿 ①：目录断言 ──────────────────────────────────────────────────────────
    const catalog = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'ledger' AND tablename = 'entries' AND indexname = 'entries_account_id_idx'`,
    );
    expect(catalog.rows, '`entries_account_id_idx` 不存在（裁定 ⑥ 的 DDL 未落地）').toHaveLength(1);
    expect(catalog.rows[0]!.indexdef).toBe(
      'CREATE INDEX entries_account_id_idx ON ledger.entries USING btree (account_id)',
    );

    // 前提：数据真的造出来了（否则下面那条计划断言在一个空表上同样成立）。
    const [counts] = await prisma.$queryRaw<{ entries: bigint; accounts: bigint }[]>`
      SELECT (SELECT count(*) FROM ledger.entries)::bigint  AS entries,
             (SELECT count(*) FROM ledger.accounts)::bigint AS accounts`;
    expect(counts!.entries, '造数据这一步没成立——这条用例的规模前提没有满足').toBe(BigInt(ENTRIES));
    // +3 = 迁移种子化的三个系统账户（`EXTERNAL_TOPUP` / `PLATFORM_ESCROW` / `PLATFORM_REVENUE`，
    // D2）。它们是**迁移**造的，不是本文件造的，因此这里加上而不是改 `ACCOUNTS`——
    // 后者会让上面那条 `g % ACCOUNTS` 的分布断言跟着变。
    expect(counts!.accounts, '账户数 = 我造的 1 万个 + 迁移种子的 3 个系统账户').toBe(BigInt(ACCOUNTS + 3));

    // ── 腿 ②：执行计划 ──────────────────────────────────────────────────────────
    const plan = await planOf(drillSql(TARGET));
    expect(plan, `计划里出现了 \`Seq Scan on entries\` ⇒ 索引没有被用上。\n${plan}`).not.toContain(
      'Seq Scan on entries',
    );
    expect(plan, `计划没有落到那条索引上 ⇒ 「索引存在」与「索引被用上」是两件事。\n${plan}`).toContain(
      'entries_account_id_idx',
    );
    // 「估算行数远小于全表」是「真的按 account_id 定位而不是扫全表」的第二个独立读数。
    // 断言的是**估算**（`rows=`）而不是实际：规划器的选择就是由它决定的。
    const estRowCounts = [...plan.matchAll(/\(cost=[\d.]+\.\.([\d.]+) rows=(\d+) width/g)].map((m) =>
      Number(m[2]),
    );
    expect(
      estRowCounts.some((n) => n > 0 && n < ENTRIES / 10),
      `计划里没有任何一处「估算行数 << ${ENTRIES}」⇒ 它没有走「按一个账户取行」的形状。\n${plan}`,
    ).toBe(true);

    // ── 服务那一侧的行为（证明 `driftOf` 真的算对了，而不只是「计划好看」）──────────
    // 这一格是**非空转**的一半：`driftOf` 在 20 万行上必须给出这个账户真正的差。
    // 造的数据里每个账户恰好 `PER_ACCOUNT` 条 `+1`，而物化余额是 0 ⇒ derived = PER_ACCOUNT。
    const drift = await recon.driftOf(TARGET);
    expect(drift, '`driftOf` 对一个存在的账户必须返回读数（null 只留给不存在的 id）').not.toBeNull();
    expect(drift).toEqual({
      accountId: TARGET,
      materialized: 0n,
      derived: BigInt(PER_ACCOUNT),
      drift: -BigInt(PER_ACCOUNT),
    });

    // ── ★ 反面对照：把索引 DROP 掉，**同一条查询**必须落到 `Seq Scan on entries` ──────
    // 没有这一半，上面那句「计划里没有 Seq Scan」在一条「索引根本不影响它」的查询上
    // 也会通过——而计划 Step 5 原本要测的那条**全表**查询恰恰就是这种查询
    // （见文件头：它的计划加不加索引逐字相同）。这一半把「这条索引承重」变成可判定的。
    const withIndexMs = await fastestDrillMs(drillSql(TARGET), 5);
    await owner.query('DROP INDEX ledger.entries_account_id_idx');
    await owner.query('ANALYZE ledger.entries');
    try {
      const planWithout = await planOf(drillSql(TARGET));
      expect(
        planWithout,
        `删掉索引之后同一条查询仍然没用 \`Seq Scan on entries\` ⇒ 这条计划断言测的不是索引。\n${planWithout}`,
      ).toContain('Seq Scan on entries');
      // 时间也要真的分开（否则「计划文本不同」可能只是排版差别）。
      const withoutIndexMs = await fastestDrillMs(drillSql(TARGET), 5);
      process.stderr.write(
        `[索引见证] drill-down 最快一次：索引在 ${withIndexMs.toFixed(3)} ms / 索引删掉 ${withoutIndexMs.toFixed(3)} ms（${(withoutIndexMs / withIndexMs).toFixed(1)}×）\n`,
      );
      expect(
        withoutIndexMs,
        `删掉索引之后并没有变慢（${withIndexMs.toFixed(3)} ms → ${withoutIndexMs.toFixed(3)} ms）⇒ 这条索引在 drill-down 上不承重`,
      ).toBeGreaterThan(withIndexMs * 2);
    } finally {
      // 复原索引：本文件自己造的库，但 `afterAll` 之前仍保持形状一致（且后续断言依赖它）。
      await owner.query('CREATE INDEX "entries_account_id_idx" ON "ledger"."entries"("account_id")');
      await owner.query('ANALYZE ledger.entries');
    }
    expect((await planOf(drillSql(TARGET))), '复原之后必须回到索引上').not.toContain('Seq Scan on entries');
  }, 600_000);
});
