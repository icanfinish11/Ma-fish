import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 增量 A 的八个列在真库里的形状（P3 / Task 5.5）。
 *
 * ## 它钉的是哪八个（「六个承诺列」+ `code_lines` + `claims`）
 *
 * | 表 | 列 | 语义 |
 * |---|---|---|
 * | `asset.asset_metadata` | `code_lines int` **可空** | 解析期算出的代码行数（`min_code_lines` 的判据） |
 * | `exchange.swap_offers` | `offered_version_id` / `offered_sha256` / `offered_dossier_digest` | **提议方**在 `propose` 那一刻对自己拿出的那一份的承诺 |
 * | `exchange.swap_offers` | `claims jsonb` **可空** | 提议方的声明（闭集）；`null` = **没有声明** |
 * | `exchange.swap_contracts` | `target_version_id` / `target_sha256` / `target_dossier_digest` | **接受方**在 `accept` 那一刻对被要约作品的确认 |
 *
 * ## 它与 `tests/integration/asset/ownership.test.ts` 的列全集断言**分工不同**
 *
 * 那一条钉的是 `asset` schema 的**全集**（因此它必然因为 `code_lines` 变红一次——
 * 而**那是预期的，不是回归**，同一段注释里的 `locked_at` 就是上一格的先例）；
 * 这一条钉的是**新列自己的**类型、可空性与所在 schema——它不随别的表变化而变红，
 * 因此下一次读它的人能分清「谁该为这次变红负责」。
 *
 * ## 为什么是全集式 `toEqual` 而不是逐列「存在性」
 *
 * 三个方向都要红，而只有全集能做到：
 *   * **少一列**（model 写漏了）⇒ 数组短一行；
 *   * **多一列**（C16：为 P3.5 的押金 / 审判 / 回转预埋）⇒ 数组多一行；
 *   * **形状变了**（可空性、类型）⇒ 那一行的字符串变了。
 * 「存在性」断言对后两个方向**全瞎**：`claims` 从 `jsonb?` 改成 `jsonb NOT NULL DEFAULT '[]'`
 * 会让「没有声明」与「声明了空集」变成同一个值，而存在性照样绿。
 *
 * ## 可空性是**承重**的，不是风格（两处都据实写清）
 *
 * * `code_lines`：迁移会跑在**已有数据的库**上。给旧行填 `0` 会把「这一列之前不存在」与
 *   「这份制品真的 0 行代码」混成同一个值，而 `min_code_lines(n)` 的判据读到 `0` 会
 *   **判违约成立**——把一次数据缺失变成一次**错误的裁决**。
 * * `claims`：`null` = 「没有声明」，它与「声明了一个空集」不是同一件事
 *   （与 `readme_excerpt` 同一条纪律）。
 *
 * 两条都不是靠应用自觉：**它们是数据库里的可空性**，这一条用例就是它的机器见证。
 *
 * ## 授权面**不动**（据实记载，免得下一个读者去找一个不存在的改动）
 *
 * 加列不改授权：`infra/db/apply-grants.sql` 里的 `GRANT` 是**表级**的，表级授权覆盖
 * 该表此后新增的列。因此 `apply-grants.sql` 与 CI 的权限事实字符串在本任务里
 * **一个字都不改**（`exchange` 三张表的能力集合仍是 `INSERT,SELECT,UPDATE`，
 * 由 `tests/integration/db/exchange-enforcement.test.ts` 继续见证）。
 */
describe('增量 A 的八个列：真库里的类型与可空性（P3 / Task 5.5）', () => {
  let pg: TestPg;
  let owner: Client;

  beforeAll(async () => {
    pg = await startPostgres();
    owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await pg?.stop();
  });

  /**
   * 把「故意制造失败的语句」之后留在连接上的事务状态清干净（照 `exchange-enforcement`
   * 的同一条理由）：本文件的查询都是只读的，但留着这个兜底，免得将来有人在这里加一条
   * 会失败的写语句时，后面每一条以**别人的原因**变红。
   */
  afterEach(async () => {
    await owner.query('ROLLBACK').catch(() => undefined);
  });

  /**
   * 造一个版本行（连带它所属的作品行）。
   *
   * `asset` schema **内部**的两条外键是真的（`asset_versions → assets`、
   * `asset_metadata → asset_versions`），所以三张表都要有行；而跨 schema **没有**外键
   * （C5），`owner_id` 因此只是一个 UUID，不需要真有一个用户。
   */
  async function makeVersion(): Promise<string> {
    const assetId = (
      await owner.query<{ id: string }>(
        `INSERT INTO asset.assets (id, owner_id) VALUES (gen_random_uuid(), gen_random_uuid()) RETURNING id`,
      )
    ).rows[0]!.id;
    return (
      await owner.query<{ id: string }>(
        `INSERT INTO asset.asset_versions
           (id, asset_id, sha256, storage_key, plaintext_bytes, key_id, file_id)
         VALUES (gen_random_uuid(), $1, repeat('a', 64), 'k', 1, 'kid', 'fid')
         RETURNING id`,
        [assetId],
      )
    ).rows[0]!.id;
  }

  it('六个新列的类型与可空性逐字固定', async () => {
    const r = await owner.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE (table_schema = 'asset'    AND table_name = 'asset_metadata' AND column_name = 'code_lines')
           OR (table_schema = 'exchange' AND table_name = 'swap_offers'
               AND column_name IN ('offered_version_id','offered_sha256','offered_dossier_digest','claims'))
           OR (table_schema = 'exchange' AND table_name = 'swap_contracts'
               AND column_name IN ('target_version_id','target_sha256','target_dossier_digest'))
        ORDER BY table_schema, table_name, column_name`,
    );

    expect(
      r.rows.map(
        (row) =>
          `${row.table_name}.${row.column_name}:${row.data_type}${row.is_nullable === 'NO' ? '' : '?'}`,
      ),
      // 失败时把「查到了哪些」也摆出来：数组为空只会说「列不存在」，而
      // 「存在但类型/可空性不对」需要看见实际值才能归因。`toEqual` 自己会打差异，
      // 这一句是给「读日志的人」的（与 `exchange-enforcement` 的同款处置）。
      `实际查到的行：${JSON.stringify(r.rows)}`,
    ).toEqual([
      'asset_metadata.code_lines:integer?',
      'swap_contracts.target_dossier_digest:text?',
      'swap_contracts.target_sha256:text?',
      'swap_contracts.target_version_id:uuid?',
      'swap_offers.claims:jsonb?',
      'swap_offers.offered_dossier_digest:text?',
      'swap_offers.offered_sha256:text?',
      'swap_offers.offered_version_id:uuid?',
    ]);
  });

  /**
   * 承重面的**行为**见证（与上面那条是**不同**的判据）：可空性不是「迁移里写了 `?`」，
   * 而是**数据库真的允许 NULL**。
   *
   * 上面那条断言编码的是「迁移写的是什么」；这一条问的是「库里拦得住什么」——
   * 一个被写下来的期望值不会因为约束被改掉而变红的原因很简单：**它断言的就是那句话本身**
   * （P2 / Task 2 在同一类形状上付过一次代价，见 `ownership.test.ts` 里
   * `plaintext_bytes` 的 `NOT NULL` 行为见证，那里是「缺了长度的行必须被拒」）。
   *
   * **它拦得住两个方向**（两个方向的实测见报告的探针 P-5.5-a / P-5.5-e）：
   *   * `NOT NULL`（无默认值）⇒ `INSERT` 被 PostgreSQL 以 `23502` 拒绝；
   *   * `NOT NULL DEFAULT 0` ⇒ `INSERT` 成功，但读回来是 `0` 而不是 `null`
   *     ——而这**正是**那个会制造错误裁决的形状（见文件头）。
   */
  it('`code_lines` 接受 NULL：旧行是**合法**状态，不是被拒状态', async () => {
    const versionId = await makeVersion();

    // 显式 NULL 那一列 —— 旧行的形状（迁移之前落库的行没有 `code_lines`）。
    await owner.query(
      `INSERT INTO asset.asset_metadata
         (asset_version_id, readme_excerpt, file_tree, languages, dependencies,
          completeness, file_tree_truncated, code_lines)
       VALUES ($1, NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0, false, NULL)`,
      [versionId],
    );

    const r = await owner.query<{ code_lines: number | null }>(
      `SELECT code_lines FROM asset.asset_metadata WHERE asset_version_id = $1`,
      [versionId],
    );
    // NULL **原样**读回：不是 0，也不是「没有这一行」。这一条与
    // `AssetMetadataView.codeLines: number | null` 是同一个事实的两侧。
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.code_lines).toBeNull();
  });

  /**
   * 「`null` = **没有声明**」与「声明了一个**空集**」不是同一件事——这是 `claims` 那一列
   * 可空性的**全部**理由（与 `readme_excerpt` 同一条纪律）。
   *
   * 这条用例同时钉住两半，因此它不是「可空性」那一条的复制：
   *   * 不写 `claims` 的要约 ⇒ `null`（**没有**声明）；
   *   * 写 `'[]'::jsonb` 的要约 ⇒ 一个**空数组**（声明了，只是内容为空）。
   * ⇒ 把列改成 `NOT NULL DEFAULT '[]'` 会让**第一半**读回 `[]`，两个语义被合并，这条红。
   */
  it('`claims` 的 NULL 与空集是两个不同的值（可空性的全部理由）', async () => {
    const absent = await owner.query<{ claims: unknown }>(
      `INSERT INTO exchange.swap_offers
         (id, proposer_id, offered_asset_id, target_asset_id, counterparty_id, expires_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
               gen_random_uuid(), now() + interval '72 hours')
       RETURNING claims`,
    );
    const empty = await owner.query<{ claims: unknown }>(
      `INSERT INTO exchange.swap_offers
         (id, proposer_id, offered_asset_id, target_asset_id, counterparty_id, expires_at, claims)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
               gen_random_uuid(), now() + interval '72 hours', '[]'::jsonb)
       RETURNING claims`,
    );

    expect(absent.rows[0]!.claims).toBeNull();
    // 声明了一个空集：读回来是 `[]`，**不是** `null`。断言写成 `toEqual([])` 而不是
    // 「非 null」，因为后者在「列被写成 `NOT NULL DEFAULT '{}'`」时照样绿。
    expect(empty.rows[0]!.claims).toEqual([]);
  });
});
