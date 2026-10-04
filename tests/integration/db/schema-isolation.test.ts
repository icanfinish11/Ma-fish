import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { startPostgres } from '../../helpers/db.js';

describe('每模块独占 schema（C5）', () => {
  let owner: Client;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await stop?.();
  });

  /**
   * C5 的要害是「**哪张表在哪个 schema**」，不是「三个 schema 存在」。
   *
   * 此前这里只断言 `auth` / `audit` 各**至少有一张表**（且根本没提 `notify`），
   * 于是把 `users` 或 `outbox_events` 挪进别人的 schema 可以被静默放过——而 C5 正是
   * 「每模块独占 schema，不做跨模块表访问」。已改成对整个 `(table_schema, table_name)`
   * 集合做**精确**断言：多一张、少一张、换一个 schema，都会红。
   *
   * 为什么连 `public` 一起断言：真实的失败模式不只是「表串到别的模块 schema」，还有
   * 「表掉进 `public`」。后者**不会**在引导期报错——`GRANT ... ON ALL TABLES IN SCHEMA auth`
   * 对一个空 schema 是静默授予零个对象，不报错——所以只能靠这条断言兜住。
   * `public` 里唯一允许存在的是 Prisma 自己的迁移台账 `_prisma_migrations`。
   */
  it('五张业务表各归其模块 schema，且 public 里没有业务表（C5）', async () => {
    const r = await owner.query(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_schema IN ('auth','audit','notify','public')
        ORDER BY table_schema, table_name`,
    );
    expect(r.rows.map((x) => `${x.table_schema}.${x.table_name}`)).toEqual([
      'audit.audit_logs',
      'auth.identities',
      'auth.users',
      'notify.outbox_events',
      'notify.processed_jobs',
      'public._prisma_migrations',
    ]);
  });
});
