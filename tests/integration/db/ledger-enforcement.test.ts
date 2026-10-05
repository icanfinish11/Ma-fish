import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 账本的**数据库强制点**（P2 / Task 4）。
 *
 * ## 为什么这一层必须独立存在（预检 §D.7 的原话）
 *
 * 属性测试断言的是**模型**，不是**约束**；它证明不了触发器/CHECK/REVOKE 是否真的存在。
 * 因此三条强制点各自要有**对着真库跑**的用例，而且这些用例**绕过应用**直接写 SQL——
 * 触发器只在应用出 bug 时才触发，不主动行使它就等于没有。
 *
 * ## 这里的判据全部是「行为 + 授权事实」两条腿
 *
 * 行为（`UPDATE` 被拒）证明的是**这台库现在**如此；授权（`has_table_privilege` /
 * `aclexplode(relacl)`）证明的是**配置**如此。两者互补：授权对了而某台库上被人手工
 * GRANT 过，行为用例不会红；反过来只查授权，则证明不了 REVOKE 真的被 PostgreSQL
 * 认作有效（属主场景）。
 *
 * ## 手写对象的存在性**只能**由这一层证明（Task 1 的决定性实测）
 *
 * `prisma migrate diff` 对 plpgsql 函数 / `DEFERRABLE` 约束触发器 / `CHECK`
 * **结构性失明**：库里挂着它们时它照样报 `No difference detected.`
 * （`docs/superpowers/notes/2026-10-06-p2-migration-drift.md` §3 的原始输出）。
 * 因此下面那条 `pg_proc` / `pg_trigger` / `pg_get_constraintdef` 的目录断言**不是**
 * 锦上添花：它是这三类手写对象**唯一**的机器见证。
 */
describe('账本的数据库强制点（不变式 #1 / #3 / #5）', () => {
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

  it('系统账户恰好三个（D2：只有迁移创建它们）', async () => {
    const r = await owner.query(
      `SELECT kind FROM ledger.accounts WHERE owner_user_id IS NULL ORDER BY kind`,
    );
    expect(r.rows.map((x) => x.kind)).toEqual([
      'EXTERNAL_TOPUP',
      'PLATFORM_ESCROW',
      'PLATFORM_REVENUE',
    ]);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 手写 DDL 的**存在性**（先验再做 (b)）：目录断言。
  //
  // 为什么不能只留行为用例：行为用例证明的是「现在这台库上会发生什么」，
  // 而「对象叫什么名字、是不是 DEFERRABLE、在哪些 DML 分支上触发」只有目录能回答。
  // 尤其 `tgtype` 的 UPDATE/DELETE 两位——它们正是 `COALESCE(NEW, OLD)` 那段代码服务的
  // 分支，也是预检**没有**跑过的分支（本文件下面另有一条行为用例行使它们）。
  // ══════════════════════════════════════════════════════════════════════════

  it('手写对象存在性：pg_proc / pg_trigger / pg_get_constraintdef 三条目录取证', async () => {
    // ① 函数：plpgsql，返回 trigger。
    const fn = await owner.query(
      `SELECT p.proname, l.lanname, p.prorettype::regtype::text AS returns
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language  l ON l.oid = p.prolang
        WHERE n.nspname = 'ledger' AND p.proname = 'assert_tx_balanced'`,
    );
    expect(fn.rows).toEqual([
      { proname: 'assert_tx_balanced', lanname: 'plpgsql', returns: 'trigger' },
    ]);

    // ② 约束触发器：必须是 CONSTRAINT + DEFERRABLE + INITIALLY DEFERRED + FOR EACH ROW，
    //    且 INSERT / UPDATE / DELETE 三个分支**都**在（`tgtype` 的位含义见 PG 文档：
    //    1=ROW, 2=BEFORE, 4=INSERT, 8=DELETE, 16=UPDATE）。
    const trg = await owner.query(
      `SELECT t.tgname, t.tgdeferrable, t.tginitdeferred,
              t.tgconstraint <> 0 AS is_constraint, t.tgtype, p.proname
         FROM pg_trigger t
         JOIN pg_class     c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc      p ON p.oid = t.tgfoid
        WHERE n.nspname = 'ledger' AND c.relname = 'entries' AND NOT t.tgisinternal`,
    );
    expect(trg.rows).toHaveLength(1);
    const t = trg.rows[0] as { tgname: string; tgdeferrable: boolean; tginitdeferred: boolean; is_constraint: boolean; tgtype: number; proname: string };
    expect({
      tgname: t.tgname,
      tgdeferrable: t.tgdeferrable,
      tginitdeferred: t.tginitdeferred,
      isConstraint: t.is_constraint,
      proname: t.proname,
      forEachRow: (t.tgtype & 1) !== 0,
      after: (t.tgtype & 2) === 0,
      onInsert: (t.tgtype & 4) !== 0,
      onDelete: (t.tgtype & 8) !== 0,
      onUpdate: (t.tgtype & 16) !== 0,
    }).toEqual({
      tgname: 'entries_tx_balanced',
      tgdeferrable: true,
      tginitdeferred: true,
      isConstraint: true,
      proname: 'assert_tx_balanced',
      forEachRow: true,
      after: true,
      onInsert: true,
      onDelete: true,
      onUpdate: true,
    });

    // ③ 两条 CHECK：定义原文里必须**看得见**它们各自的条件。
    //    `accounts_nonneg_by_kind` 的定义里出现那两个 kind，正是「条件化」本身——
    //    把 CHECK 改成无条件的 `balance >= 0` 会让这条断言红（而行为用例那两条也会红）。
    const checks = await owner.query(
      `SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class     t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ledger'
          AND c.conname IN ('accounts_nonneg_by_kind', 'entries_amount_nonzero')
        ORDER BY c.conname`,
    );
    expect(checks.rows.map((r) => r.conname)).toEqual([
      'accounts_nonneg_by_kind',
      'entries_amount_nonzero',
    ]);
    expect(checks.rows.map((r) => r.contype)).toEqual(['c', 'c']);
    const byName = new Map(checks.rows.map((r) => [r.conname as string, r.def as string]));
    expect(byName.get('accounts_nonneg_by_kind')).toContain('USER_AVAILABLE');
    expect(byName.get('accounts_nonneg_by_kind')).toContain('USER_FROZEN');
    expect(byName.get('accounts_nonneg_by_kind')).toMatch(/balance\s*>=\s*0/);
    expect(byName.get('entries_amount_nonzero')).toMatch(/amount\s*<>\s*0/);
  });

  it('ledger 里没有任何 SEQUENCE（所以不需要 GRANT USAGE ON SEQUENCES）', async () => {
    // 预检实测的坑：`GRANT … ON ALL TABLES` **不覆盖** SEQUENCE，带 bigserial 的表即便
    // 拿到 INSERT 也会 `permission denied for sequence`。今天全用 UUIDv7，因此这里应当为 0；
    // 将来谁加了自增主键，这条会先红，而不是等到生产上第一次写入。
    const r = await owner.query(
      `SELECT count(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = 'ledger'`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it('序列那条坑的两个方向：临时 bigserial 表 ⇒ 授权不足时被拒、补授权后被接受', async () => {
    // 这一条把上面那句注释变成**实测**（预检 §0.4 只量过拒绝那一半）。它同时是
    // `apply-grants.sql` 里「本 schema 没有 SEQUENCE，因此不需要序列授权」那句话的
    // 常驻见证：一旦有人在这里加了 bigserial，本用例会指出**必须**同时加
    // `GRANT USAGE ON SEQUENCES`。
    //
    // 两半都必须有：只测拒绝时，「怎么都拒」也能骗过它（而那样账本根本写不进去）。
    await owner.query(`CREATE TABLE ledger.probe_seq (id bigserial PRIMARY KEY, note text)`);
    try {
      const seq = await owner.query(
        `SELECT count(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = 'ledger'`,
      );
      expect(seq.rows[0].n).toBe(1); // ← 上一条断言的前提被这条临时表打破，说明它有判别力

      // ① 拒绝方向：`ALL TABLES` 授权**不覆盖**序列。
      await expect(
        app.query(`INSERT INTO ledger.probe_seq (note) VALUES ('x')`),
      ).rejects.toThrow(/permission denied for sequence/i);

      // ② 接受方向：补上序列授权之后同一句 INSERT 成功。
      await owner.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ledger TO app_user`);
      await expect(
        app.query(`INSERT INTO ledger.probe_seq (note) VALUES ('y')`),
      ).resolves.toBeDefined();
    } finally {
      // 无论断言成败都要把临时对象清掉：它会让 schema-isolation 与「没有 SEQUENCE」
      // 两条用例红，而那种红会指向错误的原因。
      await owner.query(`DROP TABLE IF EXISTS ledger.probe_seq`);
    }
    const after = await owner.query(
      `SELECT count(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = 'ledger'`,
    );
    expect(after.rows[0].n).toBe(0);
  });

  it('不变式 #1：平衡的两腿在 COMMIT 被接受', async () => {
    const tx = randomUUID();
    await owner.query('BEGIN');
    await owner.query(
      `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1,'TOPUP',$2)`,
      [tx, `probe-${tx}`],
    );
    const user = await owner.query(
      `INSERT INTO ledger.accounts (id, kind, owner_user_id, balance) VALUES (gen_random_uuid(),'USER_AVAILABLE',gen_random_uuid(),0) RETURNING id`,
    );
    const escrow = await owner.query(`SELECT id FROM ledger.accounts WHERE kind='EXTERNAL_TOPUP'`);
    await owner.query(
      `INSERT INTO ledger.entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(),$1,$2,-500),(gen_random_uuid(),$1,$3,500)`,
      [tx, escrow.rows[0].id, user.rows[0].id],
    );
    await expect(owner.query('COMMIT')).resolves.toBeDefined();
  });

  it('不变式 #1：**单腿**在 COMMIT 被拒，SQLSTATE 23514（跳过应用直接写——它就是回退防线）', async () => {
    const tx = randomUUID();
    await owner.query('BEGIN');
    await owner.query(
      `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1,'TOPUP',$2)`,
      [tx, `probe-${tx}`],
    );
    const escrow = await owner.query(`SELECT id FROM ledger.accounts WHERE kind='EXTERNAL_TOPUP'`);
    // INSERT 此刻**成功**（触发器是 DEFERRED）——这一句本身就是「检查发生在 COMMIT」的见证。
    await owner.query(
      `INSERT INTO ledger.entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(),$1,$2,-7000)`,
      [tx, escrow.rows[0].id],
    );
    await expect(owner.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
  });

  it('不变式 #1 的触发器在 **UPDATE / DELETE** 分支上同样会拒（预检只跑过 INSERT；这两条只有属主走得到）', async () => {
    // 为什么要测：预检 §B.2 只行使了 INSERT 的接受/拒绝，触发器里那段
    // `COALESCE(NEW.transaction_id, OLD.transaction_id)` 正是为 UPDATE/DELETE 写的——
    // **没人跑过的分支在本项目里等于不存在**。运行期角色被 ACL 挡着（见下面的 append-only 用例），
    // 因此这两条只对属主可达：它们是纵深防御，不是主路径。
    const tx = randomUUID();
    const user = await owner.query(
      `INSERT INTO ledger.accounts (id, kind, owner_user_id, balance)
       VALUES (gen_random_uuid(),'USER_AVAILABLE',gen_random_uuid(),500) RETURNING id`,
    );
    const escrow = await owner.query(`SELECT id FROM ledger.accounts WHERE kind='EXTERNAL_TOPUP' LIMIT 1`);
    await owner.query(
      `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1,'TOPUP',$2)`,
      [tx, `probe-${tx}`],
    );
    await owner.query(
      `INSERT INTO ledger.entries (id, transaction_id, account_id, amount)
       VALUES (gen_random_uuid(),$1,$2,-500),(gen_random_uuid(),$1,$3,500)`,
      [tx, escrow.rows[0].id, user.rows[0].id],
    );

    // UPDATE 分支：把贷方腿从 +500 改成 +600 ⇒ 该交易 sum = 100 ≠ 0 ⇒ COMMIT 被拒
    await owner.query('BEGIN');
    await owner.query(`UPDATE ledger.entries SET amount = 600 WHERE transaction_id = $1 AND amount = 500`, [tx]);
    await expect(owner.query('COMMIT')).rejects.toMatchObject({ code: '23514' });

    // 反面对照（先证明这一对腿**本来是平衡的**）：什么都不改，同一事务里空转一次 ⇒ 放行。
    // 没有这一条，上面那条 UPDATE 拒绝可能只是因为「犯了别的错」。
    await owner.query('BEGIN');
    await owner.query(`UPDATE ledger.entries SET amount = 500 WHERE transaction_id = $1 AND amount = 500`, [tx]);
    await expect(owner.query('COMMIT')).resolves.toBeDefined();

    // DELETE 分支：删掉借方腿 ⇒ 剩余 sum = 500 ≠ 0 ⇒ COMMIT 被拒
    await owner.query('BEGIN');
    await owner.query(`DELETE FROM ledger.entries WHERE transaction_id = $1 AND amount = -500`, [tx]);
    await expect(owner.query('COMMIT')).rejects.toMatchObject({ code: '23514' });

    // 反面对照：把两条腿一起删掉 ⇒ 该交易**没有分录**（sum=0）⇒ 触发器放行。
    // 这一条钉住触发器的边界：它强制的是「已提交分录之和为 0」，**不是**「这笔交易真的发生过」
    // （预检 §B.2 场景 4 已实测，这里把它变成常驻用例）。
    await owner.query('BEGIN');
    await owner.query(`DELETE FROM ledger.entries WHERE transaction_id = $1`, [tx]);
    await expect(owner.query('COMMIT')).resolves.toBeDefined();

    await owner.query(`DELETE FROM ledger.transactions WHERE id = $1`, [tx]);
  });

  it('不变式 #3：**用户**账户扣成负被拒（条件化 CHECK 的正面）', async () => {
    await expect(
      owner.query(
        `INSERT INTO ledger.accounts (id, kind, owner_user_id, balance)
         VALUES (gen_random_uuid(),'USER_AVAILABLE',gen_random_uuid(),-1)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('不变式 #3：**系统**账户扣到负被接受（条件化的证明——无条件 CHECK 会钉死充值路径）', async () => {
    const r = await owner.query(
      `UPDATE ledger.accounts SET balance = balance - 12345 WHERE kind = 'EXTERNAL_TOPUP' RETURNING balance`,
    );
    expect(BigInt(r.rows[0].balance)).toBeLessThan(0n);
    // 复原：这条 UPDATE 只在这条用例里发生（对账用例的 Σ=0 不能被它污染）
    await owner.query(`UPDATE ledger.accounts SET balance = balance + 12345 WHERE kind = 'EXTERNAL_TOPUP'`);
  });

  it('0 金额的腿被拒（③ 的行级 CHECK；自带一笔交易，不依赖前面用例留下的数据）', async () => {
    const tx = randomUUID();
    await owner.query(
      `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1,'TOPUP',$2)`,
      [tx, `probe-${tx}`],
    );
    const account = await owner.query(`SELECT id FROM ledger.accounts WHERE kind='EXTERNAL_TOPUP' LIMIT 1`);
    await expect(
      owner.query(
        `INSERT INTO ledger.entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(),$1,$2,0)`,
        [tx, account.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // 反面对照：**非零**金额的同一条 INSERT 在同一张表上成功——否则上面那条拒绝可能
    // 只是「这张表根本写不进去」。
    //
    // 必须包在显式事务里再 `ROLLBACK`：**自动提交**下延迟触发器的检查点在语句提交那一刻
    // 就会跑，单腿 amount=7 的 sum=7≠0 会以 23514 被拒——那条错误来自**另一条**约束，
    // 用它当反面对照会得出错误结论（「非零也被拒」）。显式事务把检查推到 COMMIT，
    // 于是「INSERT 这一句成功」就恰好证明行级 CHECK 放行了非零值。
    await owner.query('BEGIN');
    await expect(
      owner.query(
        `INSERT INTO ledger.entries (id, transaction_id, account_id, amount) VALUES (gen_random_uuid(),$1,$2,7)`,
        [tx, account.rows[0].id],
      ),
    ).resolves.toBeDefined();
    await owner.query('ROLLBACK');

    // 清理：这笔交易没有任何分录了，删干净（每个用例自足，不依赖别人留下的行数）。
    await owner.query(`DELETE FROM ledger.entries WHERE transaction_id = $1`, [tx]);
    await owner.query(`DELETE FROM ledger.transactions WHERE id = $1`, [tx]);
  });

  it('幂等键唯一约束在真并发下成立（预检 §C.5 实测：3 并发 → 1 成功 / 2 × 23505）', async () => {
    // **三条独立连接**，不是同一个 client 上 `Promise.all`：node-postgres 的单个 client
    // 会把查询排队串行执行，那样测的是「先后三次插入」而不是并发（本仓库的既定纪律：
    // 并发结论只能来自真并发，预检 §D.7）。
    const key = `probe-idem-${randomUUID()}`;
    const clients = await Promise.all(
      [1, 2, 3].map(async () => {
        const c = new Client({ connectionString: pg.appUri });
        await c.connect();
        return c;
      }),
    );
    try {
      const results = await Promise.allSettled(
        clients.map((c) =>
          c.query(
            `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES (gen_random_uuid(),'TOPUP',$1)`,
            [key],
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected).toHaveLength(2);
      // 判别「为什么被拒」而不只是「被拒了」：两条都必须是唯一键冲突（23505）。
      expect(rejected.map((r) => (r.reason as { code?: string }).code)).toEqual(['23505', '23505']);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    const n = await owner.query(
      `SELECT count(*)::int AS n FROM ledger.transactions WHERE idempotency_key = $1`,
      [key],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('append-only：运行期角色对 entries / transactions 的 UPDATE 与 DELETE 被真实拒绝', async () => {
    // 基线行：让下面的 DELETE 用例证明的是**真实存在的行**会被抹掉，而不是「空表上的理论错误」
    // （ACL 是关系级的，空表也会拒——见 append-only.test.ts 的更正注释）。判别力因此落在**数据损失**上。
    const tx = randomUUID();
    const user = await owner.query(
      `INSERT INTO ledger.accounts (id, kind, owner_user_id, balance)
       VALUES (gen_random_uuid(),'USER_AVAILABLE',gen_random_uuid(),500) RETURNING id`,
    );
    const escrow = await owner.query(`SELECT id FROM ledger.accounts WHERE kind='EXTERNAL_TOPUP' LIMIT 1`);
    await owner.query(
      `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1,'TOPUP',$2)`,
      [tx, `probe-${tx}`],
    );
    await owner.query(
      `INSERT INTO ledger.entries (id, transaction_id, account_id, amount)
       VALUES (gen_random_uuid(),$1,$2,-500),(gen_random_uuid(),$1,$3,500)`,
      [tx, escrow.rows[0].id, user.rows[0].id],
    );

    await expect(app.query(`UPDATE ledger.entries SET amount = 999`)).rejects.toThrow(/permission denied/i);
    await expect(app.query(`DELETE FROM ledger.entries`)).rejects.toThrow(/permission denied/i);
    await expect(app.query(`UPDATE ledger.transactions SET kind = 'x'`)).rejects.toThrow(/permission denied/i);
    await expect(app.query(`DELETE FROM ledger.transactions`)).rejects.toThrow(/permission denied/i);

    // 拒绝之后那两行**确实还在**、金额**确实没变**：拒绝本身不是判据，数据没被动才是。
    const after = await owner.query(
      `SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::text AS s FROM ledger.entries WHERE transaction_id = $1`,
      [tx],
    );
    expect(after.rows[0].n).toBe(2);
    expect(after.rows[0].s).toBe('0');
  });

  it('反面对照：运行期角色**能**写 entries 与 accounts（撤权没有把正常业务一起挡掉）', async () => {
    const tx = randomUUID();
    await app.query('BEGIN');
    await app.query(
      `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1,'TOPUP',$2)`,
      [tx, `probe-${tx}`],
    );
    await app.query(
      `INSERT INTO ledger.entries (id, transaction_id, account_id, amount)
       SELECT gen_random_uuid(), $1, id, 7 FROM ledger.accounts WHERE kind='EXTERNAL_TOPUP' LIMIT 1`,
      [tx],
    );
    // 单腿 ⇒ COMMIT 会被触发器拒；这条用例断言的是 **INSERT 权限**，因此回滚掉。
    await app.query('ROLLBACK');
    // accounts 的 UPDATE 是允许的（余额是物化值，过账就是改它）；这里不真改任何值。
    await expect(app.query(`UPDATE ledger.accounts SET balance = balance WHERE false`)).resolves.toBeDefined();
  });

  it('ACL 的确切证据：app_user 在 ledger 三张表上的能力（授权层面的第二条腿）', async () => {
    const r = await owner.query(
      `SELECT has_table_privilege('app_user','ledger.accounts','SELECT') AS a_s,
              has_table_privilege('app_user','ledger.accounts','INSERT') AS a_i,
              has_table_privilege('app_user','ledger.accounts','UPDATE') AS a_u,
              has_table_privilege('app_user','ledger.accounts','DELETE') AS a_d,
              has_table_privilege('app_user','ledger.entries','SELECT') AS e_s,
              has_table_privilege('app_user','ledger.entries','INSERT') AS e_i,
              has_table_privilege('app_user','ledger.entries','UPDATE') AS e_u,
              has_table_privilege('app_user','ledger.entries','DELETE') AS e_d,
              has_table_privilege('app_user','ledger.transactions','SELECT') AS t_s,
              has_table_privilege('app_user','ledger.transactions','INSERT') AS t_i,
              has_table_privilege('app_user','ledger.transactions','UPDATE') AS t_u,
              has_table_privilege('app_user','ledger.transactions','DELETE') AS t_d`,
    );
    expect(r.rows[0]).toEqual({
      // accounts 是**可写**的（物化余额），append-only 不适用于它。
      // 注意 DELETE 在这里是 `true`：`apply-grants.sql` 只对 entries / transactions 逐表撤权，
      // 这是本计划 Step 3 明写的形状。它与「余额只能由账本推导」（C27）的张力记在
      // Task 4 报告的 self-review 里（有 entries 外键挡着删账户，且不变式 #2 会抓到差额）。
      a_s: true, a_i: true, a_u: true, a_d: true,
      e_s: true, e_i: true, e_u: false, e_d: false,
      t_s: true, t_i: true, t_u: false, t_d: false,
    });

    // 同一件事的第二条腿：直接读 `relacl`（**不是** `has_table_privilege` 的另一个调用）。
    // 它证明的是「授权记录本身」而不仅是「PostgreSQL 现在怎么回答那个问题」——
    // 也顺手把「`ALL TABLES` 广播过、随后被逐表收回」这段历史钉在证据里。
    const acl = await owner.query(
      `SELECT c.relname,
              COALESCE(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '(none)') AS privs
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN aclexplode(c.relacl) a ON a.grantee = 'app_user'::regrole
        WHERE n.nspname = 'ledger' AND c.relkind = 'r'
        GROUP BY c.relname
        ORDER BY c.relname`,
    );
    expect(acl.rows).toEqual([
      { relname: 'accounts', privs: 'DELETE,INSERT,SELECT,UPDATE' },
      { relname: 'entries', privs: 'INSERT,SELECT' },
      { relname: 'transactions', privs: 'INSERT,SELECT' },
    ]);
  });
});
