import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * `exchange` 的**数据库强制点**（P3 / Task 2）。
 *
 * ## 两节课的分工（与 P2 的 `ledger-enforcement.test.ts` 同一结构）
 *
 * 属性测试断言的是**模型**；它证明不了 CHECK / 唯一索引 / REVOKE 是否真的存在。
 * 因此每一条强制点都有一条**对着真库跑、绕过应用直接写 SQL** 的用例——
 * 唯一索引只在应用出 bug 时才触发，不主动行使它就等于没有。
 *
 * ## 本文件的判据是「行为 + 授权事实」两条腿
 *
 * 行为（`DELETE` 被拒）证明的是**这台库现在**如此；授权（`has_table_privilege` /
 * `aclexplode(relacl)`）证明的是**配置**如此。两者互补：授权对了而某台库上被人手工
 * GRANT 过，行为用例不会红；反过来只查授权，则证明不了 REVOKE 真的被 PostgreSQL 认作有效
 * （属主场景下 REVOKE 是空操作）。
 *
 * ## ★ 手写 DDL 的存在性**只能**由这一层证明（Task 2 实测，与 P2 同一条结论）
 *
 * 计划 Step 2 的注释里写着「本迁移的**全部**表 / 列 / 索引 / 唯一约束都是 Prisma 建得出来的
 * （没有 plpgsql 函数、没有约束触发器、没有条件化 CHECK），因此本迁移整体是那条零漂移门的
 * 见证对象」。**那半句是错的**：本迁移的手写段里恰好有一条**条件化 CHECK**
 * （`swap_contracts_top_up_payer_bound`）与四条取值域 CHECK——`prisma migrate diff`
 * 对它们**结构性失明**（P2 Task 1 的决定性实测；Task 2 的探针 S-2 在本迁移上重测了一次：
 * 删掉 `swap_contracts_status_check` 之后 `migrate diff --exit-code` **照样以 0 退出**）。
 * 因此下面的 `pg_get_constraintdef` 目录断言**不是**锦上添花：它是那五条 CHECK 唯一的机器见证。
 */

/** `exchange` 三张表的精确能力集合（控制器裁定：三张都是状态机表，没有删任何东西的路径）。 */
const EXPECTED_TABLE_PRIVS = [
  { relname: 'swap_contracts', privs: 'INSERT,SELECT,UPDATE' },
  { relname: 'swap_obligations', privs: 'INSERT,SELECT,UPDATE' },
  { relname: 'swap_offers', privs: 'INSERT,SELECT,UPDATE' },
];

describe('exchange 的数据库强制点（P3 / Task 2）', () => {
  let pg: TestPg;
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    pg = await startPostgres();
    owner = new Client({ connectionString: pg.ownerUri });
    app = new Client({ connectionString: pg.appUri });
    await owner.connect();
    await app.connect();
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await pg?.stop();
  });

  /**
   * 把「故意制造失败的语句」之后留在连接上的事务状态清干净（照 `ledger-enforcement` 的
   * 同一条理由）：`afterEach` 兜底，免得一条用例的 `current transaction is aborted`
   * 让后面每一条以**别人的原因**变红，那会把判据的**条数**变成假的。
   */
  async function resetTx(client: Client): Promise<void> {
    await client.query('ROLLBACK').catch(() => undefined);
  }

  afterEach(async () => {
    await resetTx(owner);
    await resetTx(app);
  });

  /** 造一件作品（`asset.assets` 今天只有 id / owner_id / locked_at / created_at）。 */
  async function makeAsset(ownerId: string): Promise<string> {
    const r = await owner.query<{ id: string }>(
      `INSERT INTO asset.assets (id, owner_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [ownerId],
    );
    return r.rows[0]!.id;
  }

  /** 一份 `SENT` 要约（`status` 的默认值就是它）。 */
  async function makeOffer(proposerId: string, counterpartyId: string): Promise<string> {
    const offered = await makeAsset(proposerId);
    const target = await makeAsset(counterpartyId);
    const r = await owner.query<{ id: string }>(
      `INSERT INTO exchange.swap_offers
         (id, proposer_id, offered_asset_id, target_asset_id, counterparty_id, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now() + interval '72 hours') RETURNING id`,
      [proposerId, offered, target, counterpartyId],
    );
    return r.rows[0]!.id;
  }

  /** 一份合约（`PENDING_BOTH_LOCK`，补差默认 0 / 无付款人）。 */
  async function makeContract(offerId: string): Promise<string> {
    const r = await owner.query<{ id: string }>(
      `INSERT INTO exchange.swap_contracts
         (id, offer_id, party_a_id, party_b_id, asset_a_id, asset_b_id, lock_deadline_at)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
               gen_random_uuid(), now() + interval '24 hours') RETURNING id`,
      [offerId],
    );
    return r.rows[0]!.id;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ① 状态闭集（§6.3 的两张状态机）
  // ══════════════════════════════════════════════════════════════════════════

  it('要约状态闭集：合法的 `WITHDRAWN` 被接受（验收面），拼错的 `status` 被 CHECK 拒绝（23514）', async () => {
    const id = await makeOffer(randomUUID(), randomUUID());
    // 验收对照**先跑**：没有它，一个「怎么都拒」的实现（例如把 CHECK 写成 `false`）也能
    // 骗过下面那条拒绝断言——而那样状态机一个字都写不进去。
    await expect(
      owner.query(`UPDATE exchange.swap_offers SET status = 'WITHDRAWN' WHERE id = $1`, [id]),
    ).resolves.toBeDefined();
    await expect(
      owner.query(`UPDATE exchange.swap_offers SET status = 'NOT_A_STATUS' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    // 拒绝之后那一行仍然是**合法取值**：CHECK 拒绝的是这一次 UPDATE，不是把行弄坏。
    const after = await owner.query<{ status: string }>(
      `SELECT status FROM exchange.swap_offers WHERE id = $1`,
      [id],
    );
    expect(after.rows[0]!.status).toBe('WITHDRAWN');
  });

  it('合约状态闭集：合法的 `RELEASED` 被接受（验收面），拼错的 `status` 被 CHECK 拒绝（23514）', async () => {
    const c = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    await expect(
      owner.query(`UPDATE exchange.swap_contracts SET status = 'RELEASED' WHERE id = $1`, [c]),
    ).resolves.toBeDefined();
    await expect(
      owner.query(`UPDATE exchange.swap_contracts SET status = 'NOT_A_STATUS' WHERE id = $1`, [c]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('义务状态闭集：`LOCKED` / `SETTLED` 两个取值（验收面 + 拒绝面各一）', async () => {
    const c = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    const r = await owner.query<{ id: string }>(
      `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
       VALUES (gen_random_uuid(), 'swap', $1, $2, 1000) RETURNING id`,
      [`obligation:${c}`, c],
    );
    await expect(
      owner.query(`UPDATE exchange.swap_obligations SET state = 'SETTLED' WHERE id = $1`, [
        r.rows[0]!.id,
      ]),
    ).resolves.toBeDefined();
    await expect(
      owner.query(`UPDATE exchange.swap_obligations SET state = 'REVERSED' WHERE id = $1`, [
        r.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('六条 CHECK 的**定义原文**在目录里，且两张状态机的取值集合逐字（`migrate diff` 对它们结构性失明）', async () => {
    const r = await owner.query<{ conname: string; def: string }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class     t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'exchange' AND c.contype = 'c'
        ORDER BY c.conname`,
    );
    // 六条，一条不多一条不少：这条断言本身就是「手写段没有静默丢失」的见证。
    expect(r.rows.map((x) => x.conname)).toEqual([
      'swap_contracts_status_check',
      'swap_contracts_top_up_nonneg',
      'swap_contracts_top_up_payer_bound',
      'swap_obligations_amount_nonneg',
      'swap_obligations_state_check',
      'swap_offers_status_check',
    ]);
    const byName = new Map(r.rows.map((x) => [x.conname, x.def]));

    /**
     * 从 `pg_get_constraintdef` 的原文里抽出被引号包起来的**取值**。
     *
     * 为什么不直接钉住整段字符串：PostgreSQL 的渲染形式（`= ANY (ARRAY[...])` 的括号、
     * 空格的写法）是**实现细节**，它会随版本变；而这个判据真正要钉的是**取值集合本身**
     * （「一个拼错的状态不能落库」）。抽取值既精确又与渲染无关。
     */
    const valuesOf = (def: string): string[] =>
      [...def.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);

    expect(valuesOf(byName.get('swap_offers_status_check') as string)).toEqual([
      'DRAFT',
      'SENT',
      'ACCEPTED',
      'REJECTED',
      'WITHDRAWN',
      'EXPIRED',
    ]);
    expect(valuesOf(byName.get('swap_contracts_status_check') as string)).toEqual([
      'PENDING_BOTH_LOCK',
      'VALIDATING',
      'RELEASED',
      'DISPUTED',
      'SETTLED',
      'CANCELLED',
    ]);
    expect(valuesOf(byName.get('swap_obligations_state_check') as string)).toEqual([
      'LOCKED',
      'SETTLED',
    ]);

    expect(byName.get('swap_contracts_top_up_nonneg')).toMatch(/top_up_amount\s*>=\s*0/);
    expect(byName.get('swap_obligations_amount_nonneg')).toMatch(/amount\s*>=\s*0/);

    // 条件化 CHECK 的两支逐字：`= 0 / IS NULL` 与 **`<> 0`** / `IS NOT NULL`。
    // ★ 第二支写成 `<> 0`（而不是计划 Step 2 里的 `> 0`）是一次**有实测理由的偏离**：
    //   写成 `> 0` 时，「负数 + 有付款人」会同时违反两条 CHECK，于是
    //   `swap_contracts_top_up_nonneg` **没有任何一条用例能单独行使它**（把非负那条删掉，
    //   行为一条都不红 —— 它成了一条不可能失败的断言）。改成 `<> 0` 之后两条约束**强制
    //   的行集合逐行相同**（配合非负那条：`<> 0 ∧ >= 0` ⇔ `> 0`），但各自有了独立的见证
    //   （探针 S-2 删条件化那条 ⇒ 两条拒绝变红；探针 S-2b 删非负那条 ⇒ 「负数 + 有付款人」
    //   变红）。这一行断言把那次决定钉住：谁把它改回 `> 0`，这条会红并读到这段理由。
    const payerBound = byName.get('swap_contracts_top_up_payer_bound') as string;
    expect(payerBound).toMatch(/top_up_amount\s*=\s*0/);
    expect(payerBound).toMatch(/top_up_payer_id\s+IS\s+NULL/);
    expect(payerBound).toMatch(/top_up_amount\s*<>\s*0/);
    expect(payerBound).toMatch(/top_up_payer_id\s+IS\s+NOT\s+NULL/);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ② 金额与义务的取值域（C3 / D2 / 不变式 #4 的右式）
  // ══════════════════════════════════════════════════════════════════════════

  it('补差非负：负金额被拒（23514），且**配一个付款人**也拒（那一格把「非负」这条 CHECK 单独行使到）', async () => {
    const c = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    // ★ 这一格是刻意的：`top_up_payer_id` 非空时，那条**条件化** CHECK 是放行的
    //    （它只要求「有顾客就要有付款人」），因此负数在这里**只可能**被
    //    `swap_contracts_top_up_nonneg` 拦下 —— 两条 CHECK 的判别力因此互不遮蔽。
    //    （计划 Step 2 把条件化 CHECK 的第二支写成 `top_up_amount > 0`；那样写时
    //     「负数 + 有付款人」会同时撞两条，于是非负那条 CHECK **没有任何一条用例
    //     能单独行使它**——Task 2 据此把那支改成 `<> 0`，语义集合不变，见报告。）
    await expect(
      owner.query(
        `UPDATE exchange.swap_contracts SET top_up_amount = -1, top_up_payer_id = $2 WHERE id = $1`,
        [c, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // 验收对照：同一句、金额取 `1` ⇒ 接受（否则上面那条拒绝可能只是「这张表改不动」）。
    await expect(
      owner.query(
        `UPDATE exchange.swap_contracts SET top_up_amount = 1, top_up_payer_id = $2 WHERE id = $1`,
        [c, randomUUID()],
      ),
    ).resolves.toBeDefined();
  });

  it('义务金额非负：`amount = -1` 被拒（23514），`amount = 0` 被接受（等价互换的零义务）', async () => {
    const c = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    await expect(
      owner.query(
        `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
         VALUES (gen_random_uuid(), 'swap', $1, $2, -1)`,
        [`neg:${c}`, c],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(
        `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
         VALUES (gen_random_uuid(), 'swap', $1, $2, 0)`,
        [`zero:${c}`, c],
      ),
    ).resolves.toBeDefined();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ③ 条件化 CHECK：「有补差」与「有付款人」必须同时成立（两个方向各一条 + 两条对照）
  // ══════════════════════════════════════════════════════════════════════════

  it('「有补差」与「有付款人」必须同时成立：两个方向各一条拒绝 + 两条验收对照', async () => {
    // 方向 ①：有钱却没有付款人 ⇒ 那笔钱无人可扣，而不变式 #4 的右式会把它算成一份义务
    //          ⇒ 那条 `≥` 永远差这一笔。
    const c1 = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    await expect(
      owner.query(`UPDATE exchange.swap_contracts SET top_up_amount = 100 WHERE id = $1`, [c1]),
      '金额 > 0 而 top_up_payer_id 为空 ⇒ 必须被拒（那笔钱无人可扣）',
    ).rejects.toMatchObject({ code: '23514' });

    // 方向 ②：有付款人却没有钱 ⇒ 一份空的义务（`payerId` 与金额是同一个事实的两面）。
    const c2 = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    await expect(
      owner.query(`UPDATE exchange.swap_contracts SET top_up_payer_id = $2 WHERE id = $1`, [
        c2,
        randomUUID(),
      ]),
      '有付款人而金额为 0 ⇒ 必须被拒',
    ).rejects.toMatchObject({ code: '23514' });

    // 验收对照 ①：等价互换（0 + NULL，插入时的默认形状）本来就合法。
    const c3 = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    const zero = await owner.query<{ top_up_amount: string; top_up_payer_id: string | null }>(
      `SELECT top_up_amount::text, top_up_payer_id FROM exchange.swap_contracts WHERE id = $1`,
      [c3],
    );
    expect(zero.rows[0]).toEqual({ top_up_amount: '0', top_up_payer_id: null });

    // 验收对照 ②：**两个方向一起改**（金额 100 + 付款人）⇒ 接受。
    // 没有它，上面两条拒绝可能只是「这张表的这两列根本改不动」。
    await expect(
      owner.query(
        `UPDATE exchange.swap_contracts SET top_up_amount = 100, top_up_payer_id = $2 WHERE id = $1`,
        [c3, randomUUID()],
      ),
    ).resolves.toBeDefined();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ④ 控制器裁定 ⑤：`(producer, key)` 唯一索引（义务链的执行点）
  // ══════════════════════════════════════════════════════════════════════════

  it('★ `(producer, key)` 唯一索引与 `contract_id` 唯一索引**各有一条独立的拒绝面**（裁定 ⑤ 的见证）', async () => {
    // ## 裁定 ⑤ 逐字
    // `settle:` 前缀今天**五处全是注释、零检查**，而**唯一索引由数据库检查**，且它顺带
    // 吸收命名空间问题。把它换成「前缀约定」时下面 (b) 那句 INSERT 会**成功**，
    // 库里于是静默多出一行义务——「这份合约欠多少钱」有两个互不相干的答案。
    //
    // ## ★ 为什么 (b) 必须换一份**别的合约**（探针 S-3 逼出来的修正）
    // 第一版写成「同一份合约 + 同一个 key 插两次」。那条断言**不判别**：`swap_obligations`
    // 上还有一条 `contract_id` 唯一索引（D2 的 1:1），因此把 `(producer, key)` 那条索引
    // **删掉**之后，第二次 INSERT 照样以 23505 被**另一条**索引拒掉——
    // 探针 S-3 实测退出码 **0**（用例照旧全绿），而报告里会写着「裁定 ⑤ 有见证」。
    // 这就是本项目反复抓到的那一类：**一条红在别的机制上（或绿在别的机制上）的断言**。
    // 修法：让两条约束各自有一条**只有它能拒**的用例。
    const c1 = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    const c2 = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    const c3 = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    const key = `swap:${c1}`;

    // (a) 第一行义务。
    await expect(
      owner.query(
        `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
         VALUES (gen_random_uuid(), 'swap', $1, $2, 1000)`,
        [key, c1],
      ),
    ).resolves.toBeDefined();

    // (b) **同一个 (producer, key) + 另一份合约** ⇒ 只可能被 `swap_obligations_producer_key_key` 拒。
    await expect(
      owner.query(
        `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
         VALUES (gen_random_uuid(), 'swap', $1, $2, 1000)`,
        [key, c2],
      ),
      '同一对 (producer, key) 出现在第二份合约上 ⇒ 必须被唯一索引拒（裁定 ⑤ 的执行点）',
    ).rejects.toMatchObject({ code: '23505' });

    // (c) 验收对照：(b) 那份合约换一个 `producer` ⇒ **接受**。这证明被强制的是 `(producer, key)`
    //     **这一对**，而不是「key 全局唯一」——命名空间真的由这一对承载（裁定 ⑤ 的后半句）。
    await expect(
      owner.query(
        `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
         VALUES (gen_random_uuid(), 'auction', $1, $2, 1000)`,
        [key, c2],
      ),
    ).resolves.toBeDefined();

    // (d) **同一份合约 + 另一个 key** ⇒ 只可能被 `swap_obligations_contract_id_key` 拒（D2 的 1:1）。
    await expect(
      owner.query(
        `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
         VALUES (gen_random_uuid(), 'swap', $1, $2, 1000)`,
        [`other:${c1}`, c1],
      ),
      '一份合约只能有一行义务（1:1）⇒ 必须被 contract_id 唯一索引拒',
    ).rejects.toMatchObject({ code: '23505' });

    // (e) 验收对照：第三份合约 + 一个新 key ⇒ 接受（否则 (d) 的拒绝可能只是「这张表写不进去」）。
    await expect(
      owner.query(
        `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
         VALUES (gen_random_uuid(), 'swap', $1, $2, 1000)`,
        [`third:${c3}`, c3],
      ),
    ).resolves.toBeDefined();

    // (f) 缺失的**行**（而不是「缺失的约束」）：库里恰好三行义务，每份合约一行。
    const rows = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM exchange.swap_obligations WHERE contract_id = ANY($1::uuid[])`,
      [[c1, c2, c3]],
    );
    expect(rows.rows[0]!.n).toBe(3);

    // (g) 并发的同一句话：三条**独立连接**（node-postgres 的单个 client 会把查询排队串行执行，
    //     那样测的是「先后三次插入」而不是并发 —— 本仓库的既定纪律）。
    //     ★ 用**一份全新的合约**：上面那三份都已经有义务行了，在旧合约上并发插三次会让三条
    //     **全部**以 23505 被拒（三条都与已存在的那一行冲突 ⇒ 「0 成功」），而它要证的是
    //     「并发下恰好一行胜出」。第一次跑就红在这里（`expected [] to have a length of 1`），
    //     修法是换一份干净合约——**不是**放宽断言。
    const c4 = await makeContract(await makeOffer(randomUUID(), randomUUID()));
    const key4 = `swap4:${c4}`;
    const extra = await Promise.all(
      [1, 2, 3].map(async () => {
        const cl = new Client({ connectionString: pg.ownerUri });
        await cl.connect();
        return cl;
      }),
    );
    try {
      const results = await Promise.allSettled(
        extra.map((cl) =>
          cl.query(
            `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
             VALUES (gen_random_uuid(), 'swap', $1, $2, 7)`,
            [key4, c4],
          ),
        ),
      );
      // **据实说明，不夸大**：在全新合约上两条唯一索引的判别力重合（三行写的是同一个 key、
      // 同一份合约），因此「1 成功 / 2 × 23505」这条形状对两条都成立。这一条证的是
      // 「并发下唯一性成立」；指名道姓归给哪一条索引，是 (b)/(d) 的活。
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected.map((r) => (r.reason as { code?: string }).code)).toEqual(['23505', '23505']);
      const n = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM exchange.swap_obligations WHERE contract_id = $1`,
        [c2],
      );
      expect(n.rows[0]!.n, '并发之后这张合约上**恰好一行**义务').toBe(1);
    } finally {
      await Promise.all(extra.map((cl) => cl.end()));
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ⑤ 运行期角色的能力（拒绝面 + 验收面）
  // ══════════════════════════════════════════════════════════════════════════

  it('运行期角色**改得动状态**（验收面）：三张表的 UPDATE 都成功', async () => {
    // 与下面那条拒绝用例成对。只写拒绝面时，「把 INSERT/UPDATE 一起撤掉」的实现也能骗过它，
    // 而那样状态机第一次转状态就 `permission denied` —— 一个只在生产上暴露的缺陷。
    const offerId = await makeOffer(randomUUID(), randomUUID());
    const contractId = await makeContract(offerId);
    const obligation = await app.query<{ id: string }>(
      `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
       VALUES (gen_random_uuid(), 'swap', $1, $2, 500) RETURNING id`,
      [`app:${contractId}`, contractId],
    );
    await expect(
      app.query(`UPDATE exchange.swap_offers SET status = 'SENT' WHERE id = $1`, [offerId]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`UPDATE exchange.swap_contracts SET status = 'VALIDATING' WHERE id = $1`, [
        contractId,
      ]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`UPDATE exchange.swap_obligations SET state = 'LOCKED' WHERE id = $1`, [
        obligation.rows[0]!.id,
      ]),
    ).resolves.toBeDefined();
    // INSERT 也由 app_user 自己发过（上面那条 obligations 的 INSERT）——三张表都要能写。
    await expect(
      app.query(
        `INSERT INTO exchange.swap_offers
           (id, proposer_id, offered_asset_id, target_asset_id, counterparty_id, expires_at)
         VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                 gen_random_uuid(), now() + interval '72 hours')`,
      ),
    ).resolves.toBeDefined();
  });

  it('运行期角色**删不掉**要约 / 合约 / 义务（拒绝面三条，且行还在）', async () => {
    // 每一条都断言两件事：DELETE 被拒（`permission denied`），**且那一行还在**。
    // 「拒绝」本身不是判据 —— 一句 `WHERE false` 也会「影响 0 行」。
    //
    // ## ★ 三条目标行都必须是**没有子行的行**（探针 S-1 逼出来的修正）
    //
    // 第一版拿「一份要约 + 它的合约 + 它的义务」来做这三条。探针 S-1（把 `apply-grants.sql`
    // 里那三条 `REVOKE DELETE` 注释掉）跑出来的是**另一条**拒绝理由：
    //
    // ```
    // swap_offers 的 DELETE 必须被拒（reason ②…）: expected [Function] to throw error matching
    //   /permission denied/i but got 'update or delete on table "swap_offer…'
    // ```
    //
    // 即：`swap_contracts_offer_id_fkey`（`ON DELETE RESTRICT`）先把这条 DELETE 挡下了——
    // **与 ACL 无关**。那条用例因此是一条「红在别的机制上」的断言：ACL 被撤掉时它照样红，
    // 于是它证明不了自己声称的那件事（P2 在 `ledger.accounts` 上正是用「没有分录的账户」
    // 避开这个坑的；这里逐条照做）。⇒ 三张表各用一行**没有子行**的数据：
    // offers 用一份**没有合约**的要约、contracts 用一份**没有义务**的合约、
    // obligations 天然没有子行。于是唯一的拒绝理由只可能是权限。
    const lonelyOffer = await makeOffer(randomUUID(), randomUUID()); // 没有合约指向它
    const lonelyContract = await makeContract(await makeOffer(randomUUID(), randomUUID())); // 没有义务指向它
    const obligation = await owner.query<{ id: string }>(
      `INSERT INTO exchange.swap_obligations (id, producer, key, contract_id, amount)
       VALUES (gen_random_uuid(), 'swap', $1, $2, 500) RETURNING id`,
      [`del:${lonelyContract}`, lonelyContract],
    );
    const targets: Array<[string, string, string]> = [
      ['swap_offers', lonelyOffer, 'exchange.swap_offers'],
      ['swap_contracts', lonelyContract, 'exchange.swap_contracts'],
      ['swap_obligations', obligation.rows[0]!.id, 'exchange.swap_obligations'],
    ];
    for (const [table, id, qualified] of targets) {
      await expect(
        app.query(`DELETE FROM ${qualified} WHERE id = $1`, [id]),
        `${table} 的 DELETE 必须被拒（reason ②：删掉的合约无法被恢复，义务会随契约消失）`,
      ).rejects.toThrow(/permission denied/i);
      const after = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${qualified} WHERE id = $1`,
        [id],
      );
      expect(after.rows[0]!.n, `${table} 的那一行必须还在`).toBe(1);
    }
    // 反面对照（同一形状的语句、**同一个角色**）：属主删得掉这三行 —— 证明上面那三条拒绝
    // 来自 ACL，而不是「这三张表根本删不动」或「外键挡住了」（这三行都没有子行）。
    await owner.query(`DELETE FROM exchange.swap_obligations WHERE id = $1`, [
      obligation.rows[0]!.id,
    ]);
    await owner.query(`DELETE FROM exchange.swap_contracts WHERE id = $1`, [lonelyContract]);
    await owner.query(`DELETE FROM exchange.swap_offers WHERE id = $1`, [lonelyOffer]);
  });

  it('ACL 的确切证据：`has_table_privilege` 与 `aclexplode(relacl)` 两条腿都说三张表恰好 INSERT,SELECT,UPDATE', async () => {
    /**
     * ## ★ 三条断言，两条先走**字符串**（探针 S-1 逼出来的呈现方式）
     *
     * 对象断言在失败时会被 vitest **缩写**成 `expected { o_s: true, …(11) } to deeply equal
     * { … }`——被改坏的那一格**根本不出现在输出里**。于是探针 S-1（把 `apply-grants.sql`
     * 里那三条 `REVOKE DELETE` 注释掉）虽然如期让本用例变红，探针驱动却在输出里找不到
     * 「ACL 被改坏」的证据，只好以「未命中正则」把整个矩阵作废——**驱动是对的，
     * 是用例的呈现方式不对**。字符串断言失败时会打印**整串**，因此：
     *
     *   ① `relacl` 的字符串投影放在**最前**（S-1 下它会打印
     *      `swap_contracts=DELETE,INSERT,SELECT,UPDATE|…`，与 CI 第三条腿同形）；
     *   ② `has_table_privilege` 的十三格先走一个 `o_d=f` 形状的字符串（可读、不缩写），
     *      再用对象断言逐格精确定位；
     *   ③ `relacl` 的对象数组最后（逐表能力集合的精确形状）。
     * 三条都留着：字符串给人看，对象给 diff 看；谁也不会因为「另一条已经断言过了」而被删。
     */
    const acl = await owner.query<{ relname: string; privs: string }>(
      `SELECT c.relname,
              COALESCE(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '(none)') AS privs
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN aclexplode(c.relacl) a ON a.grantee = 'app_user'::regrole
        WHERE n.nspname = 'exchange' AND c.relkind = 'r'
        GROUP BY c.relname
        ORDER BY c.relname`,
    );
    const aclText = acl.rows.map((r) => `${r.relname}=${r.privs}`).join('|');
    expect(aclText, 'exchange 三张表的能力集合（relacl 的字符串投影）').toBe(
      'swap_contracts=INSERT,SELECT,UPDATE|swap_obligations=INSERT,SELECT,UPDATE|swap_offers=INSERT,SELECT,UPDATE',
    );

    const priv = await owner.query(
      `SELECT has_table_privilege('app_user','exchange.swap_offers','SELECT')        AS o_s,
              has_table_privilege('app_user','exchange.swap_offers','INSERT')        AS o_i,
              has_table_privilege('app_user','exchange.swap_offers','UPDATE')        AS o_u,
              has_table_privilege('app_user','exchange.swap_offers','DELETE')        AS o_d,
              has_table_privilege('app_user','exchange.swap_contracts','SELECT')     AS c_s,
              has_table_privilege('app_user','exchange.swap_contracts','INSERT')     AS c_i,
              has_table_privilege('app_user','exchange.swap_contracts','UPDATE')     AS c_u,
              has_table_privilege('app_user','exchange.swap_contracts','DELETE')     AS c_d,
              has_table_privilege('app_user','exchange.swap_obligations','SELECT')   AS b_s,
              has_table_privilege('app_user','exchange.swap_obligations','INSERT')   AS b_i,
              has_table_privilege('app_user','exchange.swap_obligations','UPDATE')   AS b_u,
              has_table_privilege('app_user','exchange.swap_obligations','DELETE')   AS b_d,
              has_schema_privilege('app_user','exchange','USAGE')                    AS usage`,
    );
    const privText = Object.entries(priv.rows[0] as Record<string, boolean>)
      .map(([key, value]) => `${key}=${value ? 't' : 'f'}`)
      .join(' ');
    expect(privText, '十三格权限事实（o=offers / c=contracts / b=obligations）').toBe(
      'o_s=t o_i=t o_u=t o_d=f c_s=t c_i=t c_u=t c_d=f b_s=t b_i=t b_u=t b_d=f usage=t',
    );
    expect(priv.rows[0]).toEqual({
      o_s: true, o_i: true, o_u: true, o_d: false,
      c_s: true, c_i: true, c_u: true, c_d: false,
      b_s: true, b_i: true, b_u: true, b_d: false,
      usage: true,
    });

    // 第三条：`relacl` 的**对象数组**——逐表能力集合的精确形状（字符串投影在上面，
    // 它给人看；这一条给 diff 看：多一张表、少一档权限都会被逐格指出）。
    // 「schema 级 `ALL TABLES` 广播过（那条广播连 DELETE 一起授出）、随后被逐表收回」
    // 这段历史因此被钉在证据里 —— P2 实测过广播之后 app_user **真的**改写/删掉了数据。
    expect(acl.rows).toEqual(EXPECTED_TABLE_PRIVS);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ⑥ 序列那条坑（`GRANT … ON ALL TABLES` **不覆盖** SEQUENCE）
  // ══════════════════════════════════════════════════════════════════════════

  it('exchange 里没有任何 SEQUENCE（所以不需要 GRANT USAGE ON SEQUENCES）', async () => {
    // 预检实测的坑：`GRANT … ON ALL TABLES` **不覆盖** SEQUENCE，带 bigserial 的表即便
    // 拿到 INSERT 也会 `permission denied for sequence`。三张表全是 UUIDv7 主键（C4），
    // 因此这里应当为 0；将来谁加了自增主键，这一条会先红，而不是等到生产上第一次写入。
    //
    // ★ 先证明**schema 真的在**：不然这条断言在「schema 不存在」时**照样绿**——
    // 一条为错误的理由通过的断言（本项目反复抓的那一类）。下面那条同名的一行是
    // schema-isolation 的补充，不是重复：那条查的是表，这条查的是命名空间。
    const ns = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'exchange'`,
    );
    expect(ns.rows[0]!.n, 'exchange schema 必须存在，否则下面那条期望 0 的断言是真空的').toBe(1);
    const r = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = 'exchange'`,
    );
    expect(r.rows[0]!.n).toBe(0);
  });

  it('序列那条坑的两个方向：临时 bigserial 表 ⇒ 授权不足时被拒、补授权后被接受', async () => {
    // 两半都必须有：只测拒绝时，「怎么都拒」也能骗过它（而那样表根本写不进去）。
    await owner.query(`CREATE TABLE exchange.probe_seq (id bigserial PRIMARY KEY, note text)`);
    try {
      const seq = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = 'exchange'`,
      );
      expect(seq.rows[0]!.n).toBe(1); // ← 上面那条「没有 SEQUENCE」的前提被这条临时表打破，说明它有判别力

      // ① 拒绝方向：`ALL TABLES` 授权**不覆盖**序列。
      await expect(
        app.query(`INSERT INTO exchange.probe_seq (note) VALUES ('x')`),
      ).rejects.toThrow(/permission denied for sequence/i);

      // ② 接受方向：补上序列授权之后同一句 INSERT 成功。
      await owner.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA exchange TO app_user`);
      await expect(
        app.query(`INSERT INTO exchange.probe_seq (note) VALUES ('y')`),
      ).resolves.toBeDefined();
    } finally {
      // 无论断言成败都要清掉：它会让 `schema-isolation` 与「没有 SEQUENCE」两条用例红，
      // 而那种红会指向**错误的原因**。
      await owner.query(`DROP TABLE IF EXISTS exchange.probe_seq`);
    }
    const after = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = 'exchange'`,
    );
    expect(after.rows[0]!.n).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ⑦ 同一迁移里改的两处**既有** schema（P1 的 asset / P2 的 ledger）
  // ══════════════════════════════════════════════════════════════════════════

  it('★ `asset.assets.locked_at`：可空 `timestamptz(3)`，且运行期角色锁得动、放得开', async () => {
    // D10：锁必须落在**作品**行上（§6.3:284 那三个谓词的作用对象是作品）。
    const col = await owner.query<{ data_type: string; is_nullable: string; datetime_precision: number }>(
      `SELECT data_type, is_nullable, datetime_precision
         FROM information_schema.columns
        WHERE table_schema = 'asset' AND table_name = 'assets' AND column_name = 'locked_at'`,
    );
    expect(col.rows).toEqual([
      { data_type: 'timestamp with time zone', is_nullable: 'YES', datetime_precision: 3 },
    ]);

    // 两个方向（`app_user` 是运行期角色，锁/解锁走的是它）：
    const asset = await makeAsset(randomUUID());
    const locked = await app.query<{ locked_at: Date | null }>(
      `UPDATE asset.assets SET locked_at = now() WHERE id = $1 RETURNING locked_at`,
      [asset],
    );
    expect(locked.rows[0]!.locked_at).toBeInstanceOf(Date);
    const unlocked = await app.query<{ locked_at: Date | null }>(
      `UPDATE asset.assets SET locked_at = NULL WHERE id = $1 RETURNING locked_at`,
      [asset],
    );
    expect(unlocked.rows[0]!.locked_at).toBeNull();
  });

  it('★ `ledger.entries(account_id)` 索引在（裁定 ⑥：逐账户对账的**使能条件**）', async () => {
    // 预检实测：逐账户对账已经可行（20 万行 40 ms），**但执行计划是 `Seq Scan on entries`**。
    // 这条索引是 Task 5 的使能条件，DDL 在本迁移里，因此见证也留在这里。
    const idx = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'ledger' AND tablename = 'entries' AND indexname = 'entries_account_id_idx'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]!.indexdef).toBe(
      'CREATE INDEX entries_account_id_idx ON ledger.entries USING btree (account_id)',
    );
  });
});
