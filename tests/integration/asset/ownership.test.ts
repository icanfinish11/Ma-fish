import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { ARCHIVE_SAMPLES } from '../../fixtures/archives/generate.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { AuditService } from '@vca/api/modules/audit/index.js';
import { AssetService } from '@vca/api/modules/asset/asset.service.js';
import { AssetVersionService } from '@vca/api/modules/asset/asset-version.service.js';
import type { Env } from '@vca/api/config/env.schema.js';
import { createKeyRing, type KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import { parseMetadata } from '@vca/api/modules/asset/metadata/parse-metadata.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';

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

/**
 * 接入记录 → `asset_versions` / `asset_metadata`（brief Step 1b 的**强制义务**）。
 *
 * ## 这一节跑的是**真实**的接入流程，不是手搓的行
 *
 * `AssetService.putStream` + `finalize` 是 Task 5 交付的那条流水线（真加密、真落盘、
 * 真的数出明文字节数与 sha256），产出的 `IngestedVersion` 就是本任务必须落库的行形状。
 * 手写一份 `IngestedVersion` 字面量也能让下面的断言绿，但那样测的是**我写的字面量**，
 * 不是「Task 5 数出来的那个数」——而这条移交义务的要害正在于**来源**。
 *
 * 制品库用的是 `LocalArtifactStore`（真目录、真文件）：`stat` 回来的字节数是**密文**
 * 对象的长度，它就是「明文长度不能取错来源」的对照量。
 */
describe('版本落库：接入记录 → asset_versions / asset_metadata（Step 1b）', () => {
  let pg: TestPg;
  let owner: Client;
  let prisma: PrismaService;
  let assets: AssetService;
  let versions: AssetVersionService;
  let store: LocalArtifactStore;
  let storeDir: string;

  const MAX_UPLOAD_BYTES = Number(testEnv.ARTIFACT_MAX_UPLOAD_BYTES);
  const zipBytes = (): Buffer => {
    const sample = ARCHIVE_SAMPLES.find((item) => item.name === 'ok.zip');
    if (sample === undefined) throw new Error('样本表里没有 ok.zip');
    return sample.bytes();
  };
  const ringFromEnv = (): KeyRing =>
    createKeyRing({ ARTIFACT_KEYS: testEnv.ARTIFACT_KEYS, ARTIFACT_ACTIVE_KEY_ID: testEnv.ARTIFACT_ACTIVE_KEY_ID });

  beforeAll(async () => {
    pg = await startPostgres();
    owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    storeDir = await mkdtemp(join(tmpdir(), 'vca-t7-store-'));
    store = new LocalArtifactStore(storeDir);
    // `AssetService` 的三个依赖都注入**真的**那一个：存储（真目录）、配置（测试夹具）、
    // 审计（真库）。`ConfigService` 的类型参数是 `get()` 的重载形状，构造期不需要它。
    assets = new AssetService(
      store,
      new ConfigService(testEnv) as unknown as ConfigService<Env, true>,
      new AuditService(prisma),
    );
    versions = new AssetVersionService(prisma);
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await owner?.end();
    await pg?.stop();
    await rm(storeDir, { recursive: true, force: true });
  });

  /** 走一遍真实的接入流程，返回**待落库**的那条记录与它的元数据。 */
  async function ingest(): Promise<{
    assetId: string;
    ownerId: string;
    ingested: Awaited<ReturnType<AssetService['finalize']>>;
    metadata: Awaited<ReturnType<typeof parseMetadata>>;
    plaintext: Buffer;
  }> {
    const plaintext = zipBytes();
    const asset = await prisma.asset.create({ data: { ownerId: randomUUID() } });
    const write = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });
    const ingested = await assets.finalize(write, { uploadedById: randomUUID() });
    // 元数据这一半来自 Task 6：读取器按头里的 keyId 选键重新打开制品（与下载路径同一条路）。
    const reader = await EncryptedArtifactReader.open(store, ingested.storageKey, ringFromEnv());
    const metadata = await parseMetadata(reader, 'zip');
    return { assetId: asset.id, ownerId: asset.ownerId, ingested, metadata, plaintext };
  }

  it('storageKey 与 plaintextBytes 逐字段落库，且明文长度是**写入侧量出来**的那个数', async () => {
    const { assetId, ingested, metadata, plaintext } = await ingest();

    const persisted = await versions.persistIngested({ assetId, ingested, metadata });

    const row = await prisma.assetVersion.findUniqueOrThrow({ where: { id: persisted.assetVersionId } });
    // ① `storageKey`：下载路径取对象的唯一线索（P1 计划的字段清单漏了它，Task 5 发现）。
    expect(row.storageKey).toBe(ingested.storageKey);
    // ② `plaintextBytes`：制品**自称**长度之外的那个数，只能来自写入侧计量器。
    expect(row.plaintextBytes).toBe(ingested.plaintextBytes);
    // 与**地面真值**对齐：它就是上传的 ZIP 字节数……
    expect(row.plaintextBytes).toBe(plaintext.length);
    // ……而**不是**制品对象的长度（密文比明文大）。这一条正对着「取错来源」那个陷阱：
    // 若有人把这一列写成 `stat().bytes`，每一次合法下载都会以「长度不符」被拒。
    expect(row.plaintextBytes).not.toBe((await store.stat(ingested.storageKey)).bytes);
    expect(row.sha256).toBe(createHash('sha256').update(plaintext).digest('hex'));
    expect(row.sha256).toBe(ingested.sha256);
    expect(row.keyId).toBe(ingested.keyId);
    expect(row.fileId).toBe(ingested.fileId);
    expect(row.uploadedById).toBe(ingested.uploadedById);
    expect(row.assetId).toBe(assetId);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(persisted.storageKey).toBe(ingested.storageKey);
    expect(persisted.plaintextBytes).toBe(ingested.plaintextBytes);

    // 恰好一行版本、一行元数据：落库不是「顺手多写几条」。
    await expect(prisma.assetVersion.count({ where: { assetId } })).resolves.toBe(1);
    await expect(prisma.assetMetadata.count()).resolves.toBe(1);
  });

  it('Task 6 的六个元数据字段逐字段落库（JSONB 存的是整份结构）', async () => {
    const { assetId, ingested, metadata } = await ingest();

    const persisted = await versions.persistIngested({ assetId, ingested, metadata });
    const row = await prisma.assetMetadata.findUniqueOrThrow({ where: { assetVersionId: persisted.assetVersionId } });

    // 地面真值（`ok.zip` 的两个条目，见 fixtures/archives/generate.ts）：不是自我对照。
    expect(metadata.readmeExcerpt).toContain('# demo');
    expect(metadata.fileTree.map((f) => f.path)).toEqual(['README.md', 'src/index.ts']);
    expect(metadata.dependencies).toEqual([]);
    expect(metadata.completeness).toBeGreaterThanOrEqual(0);
    expect(metadata.completeness).toBeLessThanOrEqual(100);

    // 逐字段回读：`toEqual` 而不是「存在」，因此截断/丢字段都会红。
    expect(row.readmeExcerpt).toBe(metadata.readmeExcerpt);
    expect(row.fileTree).toEqual(metadata.fileTree);
    expect(row.languages).toEqual(metadata.languages);
    expect(row.dependencies).toEqual(metadata.dependencies);
    expect(row.completeness).toBe(metadata.completeness);
    expect(row.fileTreeTruncated).toBe(metadata.fileTreeTruncated);
    expect(row.fileTreeTruncated).toBe(false);
  });

  it('版本与元数据**同一事务**：元数据写不进去时版本也不留行', async () => {
    const { assetId, ingested, metadata } = await ingest();
    // 注入一个真实的失败：把运行时角色的 INSERT 权限收掉（属主身份操作，随后恢复）。
    await owner.query(`REVOKE INSERT ON asset.asset_metadata FROM app_user`);
    let thrown: unknown;
    try {
      await versions.persistIngested({ assetId, ingested, metadata });
    } catch (err: unknown) {
      thrown = err;
    } finally {
      await owner.query(`GRANT INSERT ON asset.asset_metadata TO app_user`);
    }

    expect(thrown, '元数据写不进去时没有抛错').toBeInstanceOf(Error);
    // 回滚的证据：版本那一行**不存在**（而不是留下一条没有元数据的版本）。
    await expect(prisma.assetVersion.count({ where: { assetId } })).resolves.toBe(0);

    // 反面对照：恢复权限之后同一条记录可以正常落库（否则上面那句断言在「怎么都抛」的实现上也绿）。
    const retry = await versions.persistIngested({ assetId, ingested, metadata });
    await expect(prisma.assetVersion.count({ where: { assetId } })).resolves.toBe(1);
    await expect(prisma.assetMetadata.count({ where: { assetVersionId: retry.assetVersionId } })).resolves.toBe(1);
  });
});
