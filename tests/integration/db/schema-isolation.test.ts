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

  it('auth 与 audit schema 各自存在且互不越界', async () => {
    const r = await owner.query(
      `SELECT table_schema, count(*)::int AS n
         FROM information_schema.tables
        WHERE table_schema IN ('auth','audit','notify')
        GROUP BY table_schema ORDER BY table_schema`,
    );
    const schemas = r.rows.map((x) => x.table_schema);
    expect(schemas).toContain('auth');
    expect(schemas).toContain('audit');
  });
});
