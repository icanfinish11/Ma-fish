import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { startPostgres } from '../../helpers/db.js';

describe('append-only 在数据库层强制（C7 / 不变式 #5）', () => {
  let owner: Client;      // 迁移属主：拥有表
  let app: Client;        // 运行时角色：最小权限
  let stop: () => Promise<void>;
  /** `asset` 侧的基线数据（P1 Task 7 新增）：一个作品与它的一行所有权记录。 */
  let assetId: string;
  let historyId: string;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    owner = new Client({ connectionString: pg.ownerUri });
    app = new Client({ connectionString: pg.appUri });
    await owner.connect();
    await app.connect();
    // 先放入一行基线数据。**这里的理由曾经写错，已在修复轮更正**：
    //   * 原注释称「PostgreSQL 在没有匹配行时不会报权限错」——**不成立**。权限检查是
    //     **关系级**的，在任何行扫描之前就完成，所以哪怕表是空的、哪怕 `WHERE false` 匹配
    //     零行，无权限角色照样拿到 `permission denied for table ...`。「零行时静默」是
    //     **RLS** 的性质，不是 ACL 的。「零行能过」曾被我当成风险，其实 ACL 从不依赖行数。
    //   * 已实测（真实 postgres:16-alpine，`app_user` 对 `public._prisma_migrations` 无权限）：
    //     `DELETE FROM public._prisma_migrations WHERE false` → `ERROR: permission denied`。
    // 基线行的**真实价值**因此在别处：它让 DELETE 那条用例证明**真实存在的行**会被抹掉。
    // 一旦将来有人把 audit 的授权改回可读写（变异探针 A 的情形），红灯的含义就从
    // 「空表上的理论错误」变成「一行真实审计记录被删」，判别力落在**数据损失**上。
    await owner.query(`INSERT INTO audit.audit_logs (id, action, resource, created_at)
                       VALUES (gen_random_uuid(), 'seed', 'seed', now())`);

    // `asset` 侧的基线同理（P1 Task 7）：一行**真实的所有权记录**。
    // 为什么它必须真的存在而不是靠一条空表的 UPDATE 去撞权限：ACL 是关系级的（见上），
    // 所以空表也能判红；但**数据损失**才是这条不变式要防的事——DELETE 用例因此断言
    // 「那行还在」，UPDATE 用例断言「属主真的改掉了它的值」。两者都不是空话。
    const asset = await owner.query(
      `INSERT INTO asset.assets (id, owner_id, created_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), now())
       RETURNING id`,
    );
    assetId = asset.rows[0].id as string;
    const history = await owner.query(
      `INSERT INTO asset.ownership_history
         (id, asset_id, from_user_id, to_user_id, reason, created_at)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(), 'seed', now())
       RETURNING id`,
      [assetId],
    );
    historyId = history.rows[0].id as string;
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await stop?.();
  });

  it('属主角色对 append-only 表的 REVOKE 无效（记录这一事实，防止误用）', async () => {
    await owner.query(`INSERT INTO audit.audit_logs (id, action, resource, created_at)
                       VALUES (gen_random_uuid(), 'x', 'y', now())`);
    await owner.query(`REVOKE UPDATE, DELETE ON audit.audit_logs FROM PUBLIC`);
    // PostgreSQL 中属主始终保有权限，REVOKE 对属主是空操作
    await expect(
      owner.query(`UPDATE audit.audit_logs SET action = 'tampered'`),
    ).resolves.toBeDefined();
    // 断言「确实改动了」而不只是「没抛错」：不变式的反例必须是真实发生的篡改，
    // 否则这条用例在「一行都没更新」时也会绿——那就没有记录下任何事实。
    const r = await owner.query(
      `SELECT count(*)::int AS n FROM audit.audit_logs WHERE action = 'tampered'`,
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it('运行时角色 UPDATE 被拒绝', async () => {
    await expect(app.query(`UPDATE audit.audit_logs SET action = 'tampered'`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('运行时角色 DELETE 被拒绝', async () => {
    await expect(app.query(`DELETE FROM audit.audit_logs`)).rejects.toThrow(/permission denied/i);
  });

  it('运行时角色 INSERT 与 SELECT 被允许（正常业务不受影响）', async () => {
    await expect(
      app.query(`INSERT INTO audit.audit_logs (id, action, resource, created_at)
                 VALUES (gen_random_uuid(), 'ok', 'asset', now())`),
    ).resolves.toBeDefined();
    const r = await app.query(`SELECT count(*)::int AS n FROM audit.audit_logs`);
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // P1 Task 7：第二张 append-only 表 `asset.ownership_history`（所有权史，D11）
  //
  // 判据 10 说的就是下面这一组。它与上面 audit 那三条**同款但不同表**：`audit` 的授权
  // 由 schema 级语句统一发（`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit`），
  // 而 `asset` 是普通可读写 schema，`ownership_history` 靠**逐表**那对 GRANT/REVOKE
  // 例外出来。因此「audit 是 append-only」不能推出「ownership_history 也是」——
  // 这两张表的能力来源不同，必须各有一条回归。
  // ══════════════════════════════════════════════════════════════════════════

  it('属主角色对 asset.ownership_history 的 REVOKE 同样无效（记录这一事实）', async () => {
    // 与 audit 那条同款：属主永远保有全部权限，`REVOKE ... FROM PUBLIC` 对它是空操作。
    // 这条用例的价值是**防止误用**——若有人以为「撤权就够了」，它会指出真正起作用的是
    // 「属主与运行期角色是两个角色」。
    await owner.query(`REVOKE UPDATE, DELETE ON asset.ownership_history FROM PUBLIC`);
    await expect(
      owner.query(`UPDATE asset.ownership_history SET reason = 'tampered-by-owner' WHERE id = $1`, [historyId]),
    ).resolves.toBeDefined();
    const r = await owner.query(
      `SELECT count(*)::int AS n FROM asset.ownership_history WHERE reason = 'tampered-by-owner'`,
    );
    // 断言「确实改动了」而不只是「没抛错」：不变式的反例必须是真实发生的篡改。
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it('运行时角色对 asset.ownership_history 的 INSERT 与 SELECT 被允许（转让要能落一行）', async () => {
    // 这一条是**反面对照**，缺了它「怎么都拒」的实现也能骗过下面两条：撤权不能把
    // 正常写入一起挡掉——转让的追加行正是运行期角色写的。
    await expect(
      app.query(
        `INSERT INTO asset.ownership_history
           (id, asset_id, from_user_id, to_user_id, reason, created_at)
         VALUES (gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(), 'runtime-append', now())`,
        [assetId],
      ),
    ).resolves.toBeDefined();
    const r = await app.query(
      `SELECT count(*)::int AS n FROM asset.ownership_history WHERE reason = 'runtime-append'`,
    );
    expect(r.rows[0].n).toBe(1);
  });

  it('运行时角色 UPDATE 被拒绝（所有权史不可改写）', async () => {
    await expect(app.query(`UPDATE asset.ownership_history SET reason = 'tampered'`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('运行时角色 DELETE 被拒绝，且那一行**确实还在**', async () => {
    await expect(app.query(`DELETE FROM asset.ownership_history`)).rejects.toThrow(/permission denied/i);
    const r = await owner.query(`SELECT count(*)::int AS n FROM asset.ownership_history WHERE id = $1`, [historyId]);
    expect(r.rows[0].n).toBe(1);
  });

  it('ACL 的确切证据：app_user 在 asset.ownership_history 上只有 SELECT / INSERT', async () => {
    // 上面的用例问的是「实际执行会怎样」，这一条问的是**授权本身**。两者互补：
    // 授权对了而某台库上被人手工 GRANT 过，上面那几条不会红；这里会。
    const r = await owner.query(
      `SELECT has_table_privilege('app_user', 'asset.ownership_history', 'SELECT') AS s,
              has_table_privilege('app_user', 'asset.ownership_history', 'INSERT') AS i,
              has_table_privilege('app_user', 'asset.ownership_history', 'UPDATE') AS u,
              has_table_privilege('app_user', 'asset.ownership_history', 'DELETE') AS d`,
    );
    expect(r.rows[0]).toEqual({ s: true, i: true, u: false, d: false });
  });
});
