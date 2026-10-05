import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import {
  assertRuntimeDbRole,
  RuntimeDbRoleError,
  type RuntimeRoleVerdict,
} from '@vca/api/db/runtime-role.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * **运行期数据库角色检查**（最终评审 C-2）——用真库证明它真的会区分。
 *
 * ## 这条门守的是什么
 *
 * append-only（不变式 #5 / C7）成立的前提是「运行期连接用的角色与表属主**不是同一个**」。
 * 而应用把 `DATABASE_URL` 原样交给 driver adapter，**此前没有任何东西检查过这条连接是谁**：
 * 一次把 `DATABASE_URL` 写成 `MIGRATE_DATABASE_URL` 的复制粘贴失误，会让
 * `REVOKE UPDATE, DELETE ON audit.audit_logs` 重新变成空操作，而所有测试照旧全绿。
 *
 * ## 为什么必须用真库（不能 mock）
 *
 * 判据全是 PostgreSQL 的权限语义：`current_user`、`has_table_privilege`、`pg_roles.rolsuper`
 * 与「属主永远保有全部权限」这条规则。一个替身能证明的只有「我实现的假对象说了算」。
 * 因此这里起真 Postgres，跑 `roles.sql → migrate deploy → apply-grants.sql`（`startPostgres`），
 * 然后**用两个真实连接**各跑一次检查：
 *
 * 1. `app_user`（运行期角色，迁移后已撤权）⇒ **通过**；
 * 2. `vca_owner`（迁移属主，也是 testcontainer 的超级用户）⇒ **拒绝**。
 *
 * 反向那一半是关键：如果检查在任何情况下都通过，它就只是一段注释。
 */
describe('运行期数据库角色检查（C-2 / 不变式 #5）', () => {
  let pg: TestPg;
  const opened: PrismaService[] = [];

  /** 造一个指向指定连接串的 PrismaService（与 `DbModule` 的工厂同一形状）。 */
  function clientFor(uri: string): PrismaService {
    const client = new PrismaService(uri);
    opened.push(client);
    return client;
  }

  beforeAll(async () => {
    pg = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    for (const client of opened) await client.$disconnect().catch(() => undefined);
    await pg?.stop();
  });

  it('运行期角色 app_user 通过：它不是特权角色，且对审计表没有 UPDATE/DELETE', async () => {
    const verdict = await assertRuntimeDbRole(clientFor(pg.appUri));

    expect(verdict.status, '运行期角色被误判成不合格：正常部署会起不来').toBe('ok');
    expect((verdict as { role: string }).role).toBe('app_user');
  });

  it('属主角色 vca_owner 被拒绝：append-only 的撤权在它身上是空操作', async () => {
    let thrown: unknown;
    try {
      await assertRuntimeDbRole(clientFor(pg.ownerUri));
    } catch (err: unknown) {
      thrown = err;
    }

    expect(
      thrown,
      '把 DATABASE_URL 指向迁移属主时检查仍然通过：变更审计表的连接被放行了（C-2 未生效）',
    ).toBeInstanceOf(RuntimeDbRoleError);

    const message = (thrown as Error).message;
    // 报错必须**可据以行动**：指出是哪个变量、以及它会造成的后果。
    expect(message, '失败信息没有点名 DATABASE_URL，运维不知道该改哪个变量').toContain('DATABASE_URL');
    expect(message, '失败信息没有说明后果（append-only 失效）').toContain('append-only');
    // 归属：说清是哪个角色、以及为什么（属主/特权）。
    expect(message).toContain('vca_owner');
  });

  it('检查本身只读：跑完之后连接的角色与权限都没有被改动（阴性对照）', async () => {
    // 这条防的是「检查顺手做了点什么」——例如为了探测权限而 GRANT/REVOKE 一遍。
    // 判据：连跑两次，第二次的结论与第一次逐字相同，且 app_user 仍能通过。
    const first = await assertRuntimeDbRole(clientFor(pg.appUri));
    const second: RuntimeRoleVerdict = await assertRuntimeDbRole(clientFor(pg.appUri));

    expect(first).toEqual(second);
    expect(second.status).toBe('ok');
  });
});
