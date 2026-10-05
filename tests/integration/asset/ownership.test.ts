import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';

/**
 * 作品 / 版本 / 元数据 / 所有权历史（P1 / Task 7；设计决定 D11 + D12）。
 *
 * ## 这个文件问的三件事（分三节，各自独立）
 *
 * 1. **`asset` schema 的迁移真的落地了吗**——逐列断言形状（C5 的 schema 归属、C6 的
 *    `timestamptz(3)`、C4 的 UUIDv7 主键）。这一节**不**碰任何业务方法，它只问
 *    「迁移在真库上造成了什么」，因为那是本任务唯一一件「跑一次就永久生效」的事。
 * 2. **Task 5 的接入记录真的能落库吗**——`storageKey` 与 `plaintextBytes` 必须由
 *    `IngestedVersion` 逐字段写进 `asset_versions`（brief 的 Step 1b，Task 5 §12 的移交义务）。
 *    判据不是「列存在」，而是「**真实接入流程**产出的那个数出现在那一行里」。
 * 3. **所有权转让**——`Asset.ownerId` 变更 + 一行 `OwnershipHistory`，**同一事务**；
 *    制品**字节与键完全未变**（§5.2 第 2 条：制品只存一份，转让不解密、不复制）。
 *
 * ## 为什么必须真库
 *
 * 三节的判据全是 PostgreSQL 自身的语义：列类型与时区精度、Prisma 客户端的 UUIDv7 生成、
 * 交互式事务的提交/回滚、以及（`tests/integration/db/append-only.test.ts` 那一半）
 * 角色 ACL。替身能证明的只有「我的假对象说了算」。
 */
describe('asset schema：迁移落地的形状（C4 / C5 / C6）', () => {
  let pg: TestPg;
  let owner: Client;
  let prisma: PrismaService;

  beforeAll(async () => {
    pg = await startPostgres();
    owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await owner?.end();
    await pg?.stop();
  });

  /**
   * 列的**全集**断言（`table.column:data_type[:可空][:时间精度]`）。
   *
   * 为什么用全集而不是「存在性」：漏一列（比如 `storage_key`——Task 5 点名的那处计划缺口）
   * 与多一列（C16：不为后续阶段预埋）都必须是红的。判据里的类型也不是装饰：
   * `timestamptz` 与裸 `timestamp` 在 Prisma 里只差一个 `@db.Timestamptz(3)`，
   * 而后果是「存的是绝对时刻还是本地墙上时间」——C6 要的正是前者。
   */
  it('四张表的列、类型、可空性与时间精度逐字固定（C5 / C6）', async () => {
    const r = await owner.query(
      `SELECT table_name, column_name, data_type, is_nullable, datetime_precision
         FROM information_schema.columns
        WHERE table_schema = 'asset'
        ORDER BY table_name, ordinal_position`,
    );
    const shape = r.rows.map(
      (row) =>
        `${row.table_name}.${row.column_name}:${row.data_type}` +
        `${row.is_nullable === 'NO' ? '' : '?'}` +
        `${row.datetime_precision === null ? '' : `(${row.datetime_precision})`}`,
    );

    expect(shape).toEqual([
      // 元数据与版本 1:1，因此它的主键就是被描述的那个版本（与 P0 的 processed_jobs 同款，
      // 见 schema.prisma 里的说明）；六个内容字段逐字对应 Task 6 的 `ParsedMetadata`。
      'asset_metadata.asset_version_id:uuid',
      'asset_metadata.readme_excerpt:text?',
      'asset_metadata.file_tree:jsonb',
      'asset_metadata.languages:jsonb',
      'asset_metadata.dependencies:jsonb',
      'asset_metadata.completeness:integer',
      'asset_metadata.file_tree_truncated:boolean',
      // 版本记录：`storage_key` 与 `plaintext_bytes` 是 Task 5 移交给本任务的两列
      // （前者给下载路径取对象，后者是**写入侧计量器**数出的那个带外长度）。
      'asset_versions.id:uuid',
      'asset_versions.asset_id:uuid',
      'asset_versions.sha256:text',
      'asset_versions.storage_key:text',
      'asset_versions.plaintext_bytes:integer',
      'asset_versions.key_id:text',
      'asset_versions.file_id:text',
      'asset_versions.uploaded_by_id:uuid?',
      'asset_versions.created_at:timestamp with time zone(3)',
      'assets.id:uuid',
      'assets.owner_id:uuid',
      'assets.created_at:timestamp with time zone(3)',
      'ownership_history.id:uuid',
      'ownership_history.asset_id:uuid',
      'ownership_history.from_user_id:uuid',
      'ownership_history.to_user_id:uuid',
      'ownership_history.reason:text',
      'ownership_history.created_at:timestamp with time zone(3)',
    ]);
  });

  /**
   * C4：主键是 **UUIDv7**（含时间序、防枚举）。
   *
   * 判据落在**生成的取值**上，不是「列是 uuid」——`uuid PRIMARY KEY` 配一个 UUIDv4 的
   * 客户端默认值同样满足后者。Prisma 7 的 `@default(uuid(7))` 是**客户端**生成
   * （P0 的迁移里 `id` 列没有 DEFAULT，本迁移同理），所以这条断言同时钉住了
   * 「schema 里写的确实是 uuid(7) 且生成代码是新的」。
   */
  it('主键由 Prisma 客户端生成为 UUIDv7（C4）', async () => {
    const asset = await prisma.asset.create({ data: { ownerId: '00000000-0000-7000-8000-000000000001' } });

    // 版本位（第 3 组首位）必须是 7、变体位必须是 8/9/a/b —— UUIDv4 会在这里红。
    expect(asset.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(asset.createdAt).toBeInstanceOf(Date);
  });
});
