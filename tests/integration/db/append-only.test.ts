import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { startPostgres } from '../../helpers/db.js';

describe('append-only 在数据库层强制（C7 / 不变式 #5）', () => {
  let owner: Client;      // 迁移属主：拥有表
  let app: Client;        // 运行时角色：最小权限
  let stop: () => Promise<void>;

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
});
