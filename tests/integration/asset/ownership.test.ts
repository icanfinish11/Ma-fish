import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
import {
  AssetNotFoundError,
  OwnershipService,
  SelfTransferRejectedError,
} from '@vca/api/modules/asset/ownership.service.js';
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
 * 交互式事务的提交/回滚、行锁的排队语义、以及（`tests/integration/db/append-only.test.ts`
 * 那一半）角色 ACL。替身能证明的只有「我的假对象说了算」。
 */

/** `ok.zip` 的字节（八样本表里那个「合法」样本，见 fixtures/archives/generate.ts）。 */
function zipBytes(): Buffer {
  const sample = ARCHIVE_SAMPLES.find((item) => item.name === 'ok.zip');
  if (sample === undefined) throw new Error('样本表里没有 ok.zip');
  return sample.bytes();
}

/** 环境夹具里的密钥环（与 `AssetService` 构造期用的是同一份输入）。 */
function ringFromEnv(): KeyRing {
  return createKeyRing({ ARTIFACT_KEYS: testEnv.ARTIFACT_KEYS, ARTIFACT_ACTIVE_KEY_ID: testEnv.ARTIFACT_ACTIVE_KEY_ID });
}

const MAX_UPLOAD_BYTES = Number(testEnv.ARTIFACT_MAX_UPLOAD_BYTES);

/**
 * `LocalArtifactStore` 的分片布局：`<root>/<前2位>/<次2位>/<键>`（见 `local-artifact.store.ts`）。
 *
 * 用例里直接读盘上那份字节，是因为「转让没有碰过制品」这句话的判据只能是**字节**：
 * 存储端口刻意没有覆写 API，而「制品在静止状态被改写」正是要排除的形态。
 */
function objectPath(storeDir: string, key: string): string {
  return join(storeDir, key.slice(0, 2), key.slice(2, 4), key);
}

/** 递归列出制品库里的全部文件（相对路径，排好序）——复制制品会在这里多出一行。 */
async function listObjects(root: string): Promise<string[]> {
  const out: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else out.push(full.slice(root.length + 1));
    }
  }
  return out.sort();
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 真实接入（Task 5）→ 真实解析（Task 6）；返回**待落库**的那条记录（本函数刻意不落库——
 *  落库是每个用例自己要断言的那一步，提前做掉会让「一行版本」这类计数判据失去意义）。 */
async function ingestVersion(
  prisma: PrismaService,
  assets: AssetService,
  store: LocalArtifactStore,
  ownerId: string = randomUUID(),
): Promise<{
  assetId: string;
  ownerId: string;
  ingested: Awaited<ReturnType<AssetService['finalize']>>;
  metadata: Awaited<ReturnType<typeof parseMetadata>>;
  plaintext: Buffer;
}> {
  const plaintext = zipBytes();
  const asset = await prisma.asset.create({ data: { ownerId } });
  const write = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });
  const ingested = await assets.finalize(write, { uploadedById: randomUUID() });
  // 元数据这一半来自 Task 6：读取器按头里的 keyId 选键重新打开制品（与下载路径同一条路）。
  const reader = await EncryptedArtifactReader.open(store, ingested.storageKey, ringFromEnv());
  const metadata = await parseMetadata(reader, 'zip');
  return { assetId: asset.id, ownerId: asset.ownerId, ingested, metadata, plaintext };
}

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
      new ConfigService(testEnv),
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

  it('storageKey 与 plaintextBytes 逐字段落库，且明文长度是**写入侧量出来**的那个数', async () => {
    const { assetId, ingested, metadata, plaintext } = await ingestVersion(prisma, assets, store);

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
    const { assetId, ingested, metadata } = await ingestVersion(prisma, assets, store);

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
    const { assetId, ingested, metadata } = await ingestVersion(prisma, assets, store);
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

/**
 * 所有权转让（D11 / 设计 §5.2 第 2 条）。
 *
 * 判据有两半，**缺一不可**：
 *
 * 1. **变了什么**：`Asset.ownerId` 指向新所有人，并且 `OwnershipHistory` **追加**一行
 *    （不是改写既有行）。两件事必须在**同一个事务**里——一半成功等于历史说谎。
 * 2. **没变什么**：制品一个字节都没动。「制品只存一份」正是「原子式所有权互换是一个
 *    本地数据库事务」的全部前提；如果转让要解密/复制制品，它就不再是本地事务了。
 *    这一半的判据只能落在**字节**上（`sha256` 与对象键），不能落在「没抛错」上。
 */
describe('所有权转让：指针 + 一行历史（同一事务），制品一个字节都不动', () => {
  let pg: TestPg;
  let owner: Client;
  let prisma: PrismaService;
  let assets: AssetService;
  let versions: AssetVersionService;
  let ownership: OwnershipService;
  let store: LocalArtifactStore;
  let storeDir: string;

  beforeAll(async () => {
    pg = await startPostgres();
    owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    // 制品卷用**环境里那个**（`tests/setup/artifact-store.ts` 按 worker 定的目录），
    // 不用本用例私有的临时目录：这样「转让有没有碰制品」的判据落在**应用真正会用的那个卷**上，
    // 而变异探针（注入一段真的去读写制品的代码）也只有在这里才找得到那份制品。
    storeDir = process.env.ARTIFACT_STORE_DIR as string;
    await rm(storeDir, { recursive: true, force: true });
    store = new LocalArtifactStore(storeDir);
    assets = new AssetService(
      store,
      new ConfigService(testEnv),
      new AuditService(prisma),
    );
    versions = new AssetVersionService(prisma);
    ownership = new OwnershipService(prisma);
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await owner?.end();
    await pg?.stop();
    await rm(storeDir, { recursive: true, force: true });
  });

  it('转让 = ownerId 变更 + **追加**一行历史；连续两次转让链条一致', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const carol = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    const first = await ownership.transferOwnership({ assetId: asset.id, toUserId: bob, reason: '拍卖成交' });
    expect(first.assetId).toBe(asset.id);
    expect(first.fromUserId).toBe(alice);
    expect(first.toUserId).toBe(bob);
    expect(first.transferredAt).toBeInstanceOf(Date);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: bob,
    });

    const second = await ownership.transferOwnership({ assetId: asset.id, toUserId: carol, reason: '交换成交' });
    // 第二笔的**前手是当前所有人**（bob），不是「上一次转让之前那个人」——这正是行锁要保证的。
    expect(second.fromUserId).toBe(bob);
    expect(second.toUserId).toBe(carol);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: carol,
    });

    const history = await prisma.ownershipHistory.findMany({ where: { assetId: asset.id } });
    // 顺序无关的判据（`createdAt` 只到毫秒，两行可能同毫秒——按时间排序不稳定）。
    const pairs = history.map((row) => `${row.fromUserId}->${row.toUserId}`);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(expect.arrayContaining([`${alice}->${bob}`, `${bob}->${carol}`]));
    expect(pairs, '第二行写下了过期的前手（alice→carol）').not.toContain(`${alice}->${carol}`);
    expect(new Set(history.map((row) => row.id))).toEqual(
      new Set([first.ownershipHistoryId, second.ownershipHistoryId]),
    );
    // 事由逐字落库；时间是 Date（C6 的 timestamptz(3) 回读）
    expect(history.map((row) => row.reason).sort()).toEqual(['交换成交', '拍卖成交']);
    for (const row of history) expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('转让不触碰制品：字节、对象键与版本行都**逐字段未变**（§5.2 第 2 条）', async () => {
    const seeded = await ingestVersion(prisma, assets, store);
    const persisted = await versions.persistIngested({
      assetId: seeded.assetId,
      ingested: seeded.ingested,
      metadata: seeded.metadata,
    });
    const path = objectPath(storeDir, seeded.ingested.storageKey);
    const beforeBytes = await readFile(path);
    const beforeObjects = await listObjects(storeDir);
    const beforeRow = await prisma.assetVersion.findUniqueOrThrow({ where: { id: persisted.assetVersionId } });

    const to = randomUUID();
    await ownership.transferOwnership({ assetId: seeded.assetId, toUserId: to, reason: '转让' });

    // ① 盘上那份制品：字节逐字节相同（大小、内容、摘要都不变）。
    const afterBytes = await readFile(path);
    expect(afterBytes.equals(beforeBytes), '转让改写了制品的字节').toBe(true);
    expect(sha256(afterBytes)).toBe(sha256(beforeBytes));
    // ② 制品库里**没有**多出对象（复制制品会在这里多一行）。
    await expect(listObjects(storeDir)).resolves.toEqual(beforeObjects);
    // ③ 版本行逐字段未变：`storageKey`（下载路径取对象的线索）、`plaintextBytes`（带外长度）、
    //    `sha256`、`keyId`、`fileId`、`uploadedById`、`createdAt` 全部照旧。
    const afterRow = await prisma.assetVersion.findUniqueOrThrow({ where: { id: persisted.assetVersionId } });
    expect(afterRow).toEqual(beforeRow);
    await expect(prisma.assetVersion.count({ where: { assetId: seeded.assetId } })).resolves.toBe(1);

    // 反面对照：指针**确实**变了，否则上面几条在一个「什么都没做」的实现上也绿。
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: seeded.assetId } })).resolves.toMatchObject({
      ownerId: to,
    });
    await expect(prisma.ownershipHistory.count({ where: { assetId: seeded.assetId } })).resolves.toBe(1);
  });

  it('未知作品 ⇒ AssetNotFoundError，且不留下任何历史行', async () => {
    const ghost = randomUUID();
    let thrown: unknown;
    try {
      await ownership.transferOwnership({ assetId: ghost, toUserId: randomUUID(), reason: '不存在的作品' });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AssetNotFoundError);
    expect((thrown as AssetNotFoundError).assetId).toBe(ghost);
    await expect(prisma.ownershipHistory.count({ where: { assetId: ghost } })).resolves.toBe(0);
  });

  /**
   * **转给自己必须被拒**（控制器裁定；修复轮 1 / Critical 1）。
   *
   * ## 为什么必须在**源头**拒，而不是「照字面执行」
   *
   * 一次「转给自己」照旧实现会写下一行 `X→X`：`ownerId` 写回同一个值，历史里多一条
   * 什么都不表示的行。而这张**删不掉**——`UPDATE`/`DELETE` 在运行时角色下被 `REVOKE`
   * （判据 10），库里也没有任何清理入口。也就是说，一行 `X→X` 是**永久**的，
   * 而它承载的信息是零。append-only 的代价只有在「写进去的每一行都有意义」时才付得起。
   *
   * ## 判据有两半，缺一不可
   *
   * 1. 抛出**领域错误**（不是数据库错误、不是静默成功）：`SelfTransferRejectedError`。
   * 2. **负后果真的没发生**：没有历史行被写下、`ownerId` 一个字都没变。
   *    只断言「抛错了」是不够的——一个「先写历史再抛错」的实现在那半边照样绿。
   *
   * 这条用例在**拒绝分支被拿掉**时必然红（探针 m9 实测）：没有守卫时它会以
   * 「历史行被写下来了」失败。
   */
  it('转给自己 ⇒ SelfTransferRejectedError，且没有写下任何历史行、所有人未变', async () => {
    const alice = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    let thrown: unknown;
    try {
      await ownership.transferOwnership({ assetId: asset.id, toUserId: alice, reason: '转给自己' });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SelfTransferRejectedError);
    expect((thrown as SelfTransferRejectedError).assetId).toBe(asset.id);
    expect((thrown as SelfTransferRejectedError).userId).toBe(alice);
    expect((thrown as Error).message).toContain('转给自己');

    // 负后果的两半：没有历史行（那一行删不掉，因此这一条是**永久性**的判据），
    // 且指针未变（若实现先改指针再抛错，这里会红）。
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(0);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: alice,
    });

    // 反面对照：同一个作品转让给**别人**照旧成功（否则上面两句在「怎么都抛」的实现上也绿）。
    const to = randomUUID();
    const ok = await ownership.transferOwnership({ assetId: asset.id, toUserId: to, reason: '正常转让' });
    expect(ok.fromUserId).toBe(alice);
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(1);
  });

  it('同一事务：历史写不进去时指针**也没有变**（不是半个转让）', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    // 注入一个真实的失败：运行时角色的 INSERT 被收掉（属主身份操作，随后恢复）。
    await owner.query(`REVOKE INSERT ON asset.ownership_history FROM app_user`);
    let thrown: unknown;
    try {
      await ownership.transferOwnership({ assetId: asset.id, toUserId: bob, reason: '这笔必须整体失败' });
    } catch (err: unknown) {
      thrown = err;
    } finally {
      await owner.query(`GRANT INSERT ON asset.ownership_history TO app_user`);
    }

    expect(thrown, '历史写不进去时没有抛错').toBeInstanceOf(Error);
    // 回滚的证据：指针仍是 alice（若两条语句各写各的事务，这里会变成 bob 而没有历史行）。
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: alice,
    });
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(0);

    // 反面对照：权限恢复之后同一笔转让可以成功（否则上面那句断言在「怎么都抛」的实现上也绿）。
    const retry = await ownership.transferOwnership({ assetId: asset.id, toUserId: bob, reason: '重试' });
    expect(retry.fromUserId).toBe(alice);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: bob,
    });
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(1);
  });

  /**
   * **行锁**：前手必须取「拿到锁那一刻」的所有人。
   *
   * ## 这条用例在问什么
   *
   * 转让要读一次当前所有人（`fromUserId`），再改指针。若那一次读**不持锁**，两笔并发转让
   * 会各自读到同一个前手，于是第二行记下一个**过期的** `fromUserId`——一份自相矛盾的
   * 所有权史（P1 的存在意义之一就是它能在争议里当证据）。
   *
   * ## 为什么这样构造是**确定性**的
   *
   * 用例自己（属主连接）先 `BEGIN; SELECT ... FOR UPDATE` 扣住那一行，再发起转让：
   *   * 持锁读的实现会在**读**那一步阻塞，直到用例把所有人改成 dave 并提交，于是它读到
   *     `dave` ⇒ 历史行是 `dave→carol`；
   *   * 不持锁的实现在读那一步就拿到了 `alice`（MVCC 读不会被行锁挡住），随后 `UPDATE`
   *     才阻塞，解锁后照着新版本写 `carol` ⇒ 历史行是 `alice→carol`，断言红。
   *
   * 时序前提写在明处：中间那 500ms 是「让转让走到它那条读语句」的余量，本地容器上一次
   * 往返是亚毫秒级。若机器把它拖慢到 500ms 以上，这条用例会**漏判**（绿），不会误判（红）。
   */
  it('行锁：前手取的是拿到锁那一刻的所有人，不是读之前那个（并发转让不会记下过期前手）', async () => {
    const alice = randomUUID();
    const dave = randomUUID();
    const carol = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    await owner.query('BEGIN');
    await owner.query('SELECT owner_id FROM asset.assets WHERE id = $1 FOR UPDATE', [asset.id]);

    const pending = ownership.transferOwnership({ assetId: asset.id, toUserId: carol, reason: '并发场景' });
    // 让转让走到它的读语句（持锁实现会**停在那里**）
    await new Promise((resolve) => setTimeout(resolve, 500));
    // 锁的持有者在这一行上做一次真实的变更（模拟另一笔事务先提交）
    await owner.query('UPDATE asset.assets SET owner_id = $1 WHERE id = $2', [dave, asset.id]);
    await owner.query('COMMIT');

    const result = await pending;
    expect(result.fromUserId, '前手是读锁之前那个值 —— 记下了一行过期的所有权史').toBe(dave);
    const history = await prisma.ownershipHistory.findMany({ where: { assetId: asset.id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.fromUserId).toBe(dave);
    expect(history[0]?.toUserId).toBe(carol);
  });
});
