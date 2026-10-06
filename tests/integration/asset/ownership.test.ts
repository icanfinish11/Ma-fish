import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
 * ## 这个文件问的四件事（分四节，各自独立）
 *
 * 1. **`asset` schema 的迁移真的落地了吗**——逐列断言形状（C5 的 schema 归属、C6 的
 *    `timestamptz(3)`、C4 的 UUIDv7 主键）。这一节**不**碰任何业务方法，它只问
 *    「迁移在真库上造成了什么」，因为那是本任务唯一一件「跑一次就永久生效」的事。
 * 2. **Task 5 的接入记录真的能落库吗**——`storageKey` 与 `plaintextBytes` 必须由
 *    `IngestedVersion` 逐字段写进 `asset_versions`（brief 的 Step 1b，Task 5 §12 的移交义务）。
 *    判据不是「列存在」，而是「**真实接入流程**产出的那个数出现在那一行里」。
 * 3. **所有权转让**——`Asset.ownerId` 变更 + 一行 `OwnershipHistory`，**同一事务**；
 *    制品**字节与键完全未变**（§5.2 第 2 条：制品只存一份，转让不解密、不复制）。
 *    另外两条**拒绝**分支也在这里：「转给自己」在源头被拒（控制器裁定），以及作品不存在时
 *    落库给出的是领域错误而不是外键失败。
 * 4. **约束真的在拦东西吗**——`plaintext_bytes` 的 `NOT NULL` 有一条**行为**见证：
 *    一条缺了明文长度的版本行必须被 PostgreSQL 拒绝（修复轮 1 / Important 3）。
 *    第 1 节的形状断言编码的是「迁移写了什么」，这一条问的是「库里拦得住什么」。
 *
 * ## 为什么必须真库
 *
 * 四节的判据全是 PostgreSQL 自身的语义：列类型与时区精度、Prisma 客户端的 UUIDv7 生成、
 * 交互式事务的提交/回滚、行锁的排队语义、约束的拒绝，以及
 * （`tests/integration/db/append-only.test.ts` 那一半）角色 ACL。替身能证明的只有
 * 「我的假对象说了算」。
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
 * 第 1 节：迁移落地的形状。
 *
 * 文件级的导航（四节各自在问什么、为什么必须真库）写在**文件头**，这里不再重复一份。
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
    // `AssetService` 的四个依赖都注入**真的**那一个：存储（真目录）、密钥环（测试夹具）、
    // 审计（真库），以及落库服务（Task 9 起是第四个依赖，`ingest` 的第三步要用它）。
    //
    // **Task 8 改了这里的第二个入参**：密钥环原先由 `AssetService` 在自己的构造期从
    // `ConfigService` 现建，Task 8 把它提取成 `KEY_RING` 提供者（下载路径是第二个消费者，
    // 这正是 Task 5 的注释预告的时机）。因此这里给的是 `ringFromEnv()`——**同一份**环境夹具
    // 算出的同一个环，而不是另造一个。
    versions = new AssetVersionService(prisma);
    assets = new AssetService(
      store,
      ringFromEnv(),
      new AuditService(prisma),
      versions,
    );
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

    // 恰好一行版本、一行元数据：落库不是「顺手多写几条」。两条都**按这一次的版本**计数
    // （修复轮 1 / Minor）：`count()` 不带 `where` 是**库级**计数，与它上面那句版本计数
    // 口径不同——库级计数在本文件里还会被后面的用例改，读起来像在断言「全库只有一行」。
    await expect(prisma.assetVersion.count({ where: { assetId } })).resolves.toBe(1);
    await expect(
      prisma.assetMetadata.count({ where: { assetVersionId: persisted.assetVersionId } }),
    ).resolves.toBe(1);
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

  /**
   * **`plaintext_bytes` 的 `NOT NULL` 是承重的，不是一句注释**（修复轮 1 / Important 3）。
   *
   * ## 这条用例在问什么（以及形状断言问不到的那部分）
   *
   * `四张表的列、类型、可空性…`（第 1 节）把 `plaintext_bytes:integer`（**没有** `?`）
   * 写进了期望值里——那是「迁移写的是什么」的**编码**，不是「约束拦得住什么」的**见证**。
   * 一个被写下来的期望值不会因为约束被撤掉而变红的原因很简单：**它断言的就是那句话本身**。
   *
   * 这里问的是另一个问题：**「一份不知道明文长度」的版本行能不能被写进去？** 判据落在
   * 数据库的**行为**上——一条缺了长度的 `INSERT` 必须被拒（PostgreSQL `23502`
   * `not_null_violation`，且点的是 `plaintext_bytes` 那一列）。把迁移里那个 `NOT NULL`
   * 拿掉，这条用例立刻红（探针 **m10** 实测：插入**成功**、返回 1 行 ⇒ 断言红；
   * 同一探针下第 1 节的形状断言也一起红，两条判据互相独立）。
   *
   * ## 为什么用 raw SQL 而不是 Prisma 客户端
   *
   * 这一列在 Prisma 模型里是**必填**（`Int`，不是 `Int?`），因此客户端在类型与运行期都
   * 不会把 `null` 发出去——用它测这一条，测的是**生成代码**，不是**数据库**。约束活在库里
   * （`migration.sql` 的 `"plaintext_bytes" INTEGER NOT NULL`），因此见证也必须落在库里：
   * 这条语句绕过模型，直接问 PostgreSQL 答不答应。
   *
   * ## 为什么插入在事务里、且断言行数没变（**以及这两句的边界**，修复轮 2 按实测改写）
   *
   * 判据要包含「什么都没留下」。**此前这里写的是「事务结束时回滚」——那句话是错的**：
   * 一条语句**成功**并不会让交互式事务回滚（只有失败或显式回滚才会）。探针 m10 的日志
   * 就是反证：把迁移里那个 `NOT NULL` 拿掉之后，这条 raw 语句以「返回 1 行」结束，
   * 也就是一次**真正的提交**，库里确实多了一行没有长度的版本。
   *
   * 因此下面两句计数断言的判别力要说清楚：它们见证的是**绿路径**上的回滚
   * （`INSERT` 抛错 ⇒ 整个交互式事务回滚 ⇒ 一行不留）；而约束真被撤掉时它们**走不到**
   * ——上面那句 `toBeInstanceOf` 会先红、用例随即中止（m10 的日志正是这个形状）。
   * 「约束没了会留下脏数据」这件事，因此是由**探针**（返回 1 行）而不是这两句断言的。
   */
  it('未知明文长度的版本行写不进去：plaintext_bytes 的 NOT NULL 由数据库拒绝（23502）', async () => {
    const ownerId = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId } });
    const versionId = randomUUID();
    const before = await prisma.assetVersion.count();

    let thrown: unknown;
    let insertedRows: number | undefined;
    try {
      insertedRows = await prisma.$transaction(async (tx) =>
        tx.$executeRaw`
          INSERT INTO asset.asset_versions
            (id, asset_id, sha256, storage_key, plaintext_bytes, key_id, file_id, uploaded_by_id)
          VALUES (${versionId}::uuid, ${asset.id}::uuid, 'probe-sha256', 'probe-storage-key',
                  NULL, 'v2', 'probe-file-id', NULL)
        `,
      );
    } catch (err: unknown) {
      thrown = err;
    }

    // 「插进去了」与「被拒了」是互斥的两半，这里把两半都说清：成功的那一半带上返回值，
    // 于是失败信息里能看见「返回了 N 行」而不是只有一句 TypeError。
    expect(thrown, `缺长度的版本行被写进去了（返回 ${String(insertedRows)} 行）`).toBeInstanceOf(Error);

    /**
     * 错误的**形状**（实测定下来的，不是照文档猜的）：Prisma 7 把 raw 失败包成 `P2010`，
     * 而 PostgreSQL 的 SQLSTATE 在 `meta.driverAdapterError.cause` 里（有驱动适配器时），
     * 同时被序列化进 message（`Code: \`23502\``）。
     *
     * 因此判据取**两处**：① message 逐字带上 SQLSTATE 与列名——这是驱动适配器路径之外的
     * 表面（没有适配器时 PostgreSQL 自己的 `DatabaseError.code` 就是 `23502`，走的正是这一处）；
     * ② 有 `cause` 时它的 `originalCode` 也必须是 `23502`（这条路今天不走，但它在库里就是
     * 这个形状——少了它，一个有适配器的实现把 SQLSTATE 弄丢了也照样绿）。
     */
    const raw = thrown as { message?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } };
    expect(raw.message, 'raw 失败的消息里没有 PostgreSQL 的 SQLSTATE').toContain('23502');
    // 点名的必须是**那一列**：否则这条用例在「任意别的约束坏了」时也会绿。
    expect(raw.message).toContain('plaintext_bytes');
    expect(raw.message).toContain('not-null');
    const sqlState = raw.meta?.driverAdapterError?.cause?.originalCode;
    if (sqlState !== undefined) expect(sqlState).toBe('23502');

    // 负后果：一行都没有留下。**绿路径**上它是回滚的直接见证（那条 `INSERT` 抛错 ⇒
    // 整个交互式事务回滚）；约束真被撤掉时它走不到（上一句断言先红）——见本用例上面那段。
    await expect(prisma.assetVersion.count()).resolves.toBe(before);
    await expect(prisma.assetVersion.count({ where: { assetId: asset.id } })).resolves.toBe(0);
  });

  /**
   * **未知作品必须给出领域错误**（修复轮 1 / Important 2）。
   *
   * 落库路径的外键（`asset_versions.asset_id → asset.assets.id`）会在库里失败，于是
   * 接口上**碰巧**也是「有错误抛出」——但那是一条 `PrismaClientKnownRequestError`（`P2003`），
   * 调用方拿到的是一句「外键约束失败」，说不出**责任方**是谁。`transferOwnership` 在同样的
   * 情况下给的是 {@link AssetNotFoundError}（`ownership.service.ts`），两条路径因此不一致。
   *
   * 为什么现在就必须统一：**Task 8 会把这两个方法直接接在 HTTP 边界下面**。翻译要么做一次、
   * 要么做两次——做两次的话同一种「调用方指错了作品」在两条路由上会得到不同的状态码，
   * 而那正是本仓库一直在避免的形态（状态码要说清责任方）。
   *
   * 判据有两半：错误**类型**是领域的（不是 Prisma 的），以及**没有留下任何行**。
   * 反面对照在同一个用例里：一个真的存在的作品照旧落库成功——否则上面那句在「怎么都抛」
   * 的实现上也绿。
   *
   * 「没有留下任何行」用的是**前后差值**（`count()` 无 `where` 是库级计数，本文件前面的用例
   * 已经写过版本行，直接断言库级计数只能是自我同义反复）：拒绝前后的行数必须**一个不差**。
   */
  it('未知作品 ⇒ persistIngested 抛 AssetNotFoundError（不是 Prisma 的 P2003），且不留任何行', async () => {
    const { ingested, metadata } = await ingestVersion(prisma, assets, store);
    const ghost = randomUUID();
    const rowsBefore = await prisma.assetVersion.count();

    let thrown: unknown;
    try {
      await versions.persistIngested({ assetId: ghost, ingested, metadata });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AssetNotFoundError);
    expect((thrown as AssetNotFoundError).assetId).toBe(ghost);
    // 领域错误说出的是「作品不存在」；P2003 会带着一句外键约束失败（把责任推给数据库）。
    expect((thrown as Error).message).toContain('作品不存在');

    // 负后果：**没有任何行**被写下。半份状态（版本行在、元数据行不在）与「多写一行」都在
    // 这两句里：前者让 `assetId` 那句红，后者让差值那句红。
    await expect(prisma.assetVersion.count({ where: { assetId: ghost } })).resolves.toBe(0);
    await expect(prisma.assetVersion.count()).resolves.toBe(rowsBefore);

    // 反面对照：真的存在的作品照旧落库（否则上面几句在「怎么都抛」的实现上也绿）。
    const real = await prisma.asset.create({ data: { ownerId: randomUUID() } });
    const persisted = await versions.persistIngested({ assetId: real.id, ingested, metadata });
    await expect(prisma.assetVersion.count({ where: { assetId: real.id } })).resolves.toBe(1);
    await expect(prisma.assetMetadata.count({ where: { assetVersionId: persisted.assetVersionId } })).resolves.toBe(1);
    await expect(prisma.assetVersion.count()).resolves.toBe(rowsBefore + 1);
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
    // 清空这个卷（修复轮 1 / Minor）。**它为什么安全**：`setupFiles` 把 `ARTIFACT_STORE_DIR`
    // 按 **worker** 切成独立目录（`tests/setup/artifact-store.ts`、`tests/helpers/env.ts`），
    // 而 vitest 在**同一个 worker 内顺序跑文件** —— 因此这个 `rm -rf` 只会清掉
    // **本文件之前**在这个 worker 里跑过的制品套件留下的对象（每一套件在引导期都这么做，
    // 残留目录也会被顺带收掉）。它不是「因为碰巧没人在用」才安全的：目录所有权是按 worker
    // 隔离出来的，若哪天 vitest 改成同 worker 内并发跑文件，这里会**响亮地**坏掉
    // （另一个文件正在用的对象被删），而不是静默跑错。
    await rm(storeDir, { recursive: true, force: true });
    store = new LocalArtifactStore(storeDir);
    // 第二个入参是密钥环（Task 8 起从 `ConfigService` 换成 `KEY_RING`，理由见第 2 节的同一条）；
    // 第四个是落库服务（Task 9 起 `AssetService.ingest` 的第三步用它）。
    versions = new AssetVersionService(prisma);
    assets = new AssetService(
      store,
      ringFromEnv(),
      new AuditService(prisma),
      versions,
    );
    ownership = new OwnershipService(prisma);
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await owner?.end();
    await pg?.stop();
    // 收尾同样只作用于**本 worker** 的目录（理由见 `beforeAll` 里那段）。留下也不会影响别的
    // 文件，但不下一个人来清：套件自己用完自己收，是 `tests/helpers/env.ts` 那句
    // 「目录的清理归各套件自己（谁用谁清）」的落点。
    await rm(storeDir, { recursive: true, force: true });
  });

  it('转让 = ownerId 变更 + **追加**一行历史；连续两次转让链条一致', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const carol = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    // Task 1 起转让**收调用方的事务**（`tx` 必填）：调用点自己写 `$transaction`，
    // 转让因此不再有自己的 `COMMIT`。下面两笔各是一个独立事务（与转让前的语义相同）。
    const first = await prisma.$transaction((tx) =>
      ownership.transferOwnership(tx, { assetId: asset.id, toUserId: bob, reason: '拍卖成交' }),
    );
    expect(first.assetId).toBe(asset.id);
    expect(first.fromUserId).toBe(alice);
    expect(first.toUserId).toBe(bob);
    expect(first.transferredAt).toBeInstanceOf(Date);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: bob,
    });

    const second = await prisma.$transaction((tx) =>
      ownership.transferOwnership(tx, { assetId: asset.id, toUserId: carol, reason: '交换成交' }),
    );
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
    await prisma.$transaction((tx) =>
      ownership.transferOwnership(tx, { assetId: seeded.assetId, toUserId: to, reason: '转让' }),
    );

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
      await prisma.$transaction((tx) =>
        ownership.transferOwnership(tx, { assetId: ghost, toUserId: randomUUID(), reason: '不存在的作品' }),
      );
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
   * ## 判据有两半，但两半的判别力**不相同**（修复轮 2 按实测改写）
   *
   * 1. **抛出领域错误**（不是数据库错误、不是静默成功）：`SelfTransferRejectedError`。
   *    这一半是**被计分**的——探针 m9（把守卫整块拿掉）实测 `1 failed | 12 passed`，
   *    失败信息是 `expected undefined to be an instance of SelfTransferRejectedError`，
   *    落点就在下面第一句断言上。
   * 2. **负后果**（没有历史行、`ownerId` 未变）：这一半钉的是守卫的**位置**——
   *    它在**任何写之前**。据实记载它的可证伪性：事务内的「先写再抛」会整体回滚，
   *    读起来与「没写」逐字相同，因此**今天没有任何探针**能把它单独打红；
   *    它防的是另一类改动（某天有人把这次写挪出事务、改成嵌套事务或提前提交），
   *    那时「没有历史行」会红，而 `ownerId` 那一句仍然不会——见下面 `ownerId` 那条注释。
   *
   * 上一条（大写拼写）与这一条问的**不是**同一件事：这里给的是逐字相同的字符串，
   * 它在「直接比较字符串」的实现下也绿；那里给的是同一个取值的另一种拼写。
   */
  it('转给自己 ⇒ SelfTransferRejectedError，且没有写下任何历史行、所有人未变', async () => {
    const alice = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    let thrown: unknown;
    try {
      await prisma.$transaction((tx) =>
        ownership.transferOwnership(tx, { assetId: asset.id, toUserId: alice, reason: '转给自己' }),
      );
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SelfTransferRejectedError);
    expect((thrown as SelfTransferRejectedError).assetId).toBe(asset.id);
    expect((thrown as SelfTransferRejectedError).userId).toBe(alice);
    expect((thrown as Error).message).toContain('转给自己');

    /**
     * 负后果的两半。**它们钉的是「守卫在任何写之前」这个位置**，但两句的可证伪性并不相同
     * （修复轮 2 的据实记载，替换掉此前那句错误的「先改指针再抛错，这里会红」——
     * 自转写的是**同一个** `ownerId`，写与不写读回来逐字相同，在事务内还是事务外都一样）：
     *
     * - **没有历史行**：只有当某次改动让这次写**逃出事务**（换成 `this.prisma`、嵌套事务、
     *   提前提交）时才可能变红；今天没有探针能把它单独打红。
     * - **指针未变**：这条对自转路径在**构造上就不可证伪**——同一个取值写回去，读回来
     *   与没写过完全一致。它是**意图文档**，不是一条被计分的判据；真正承重的是上面那句
     *   `instanceof`（探针 m9 见证）。
     */
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(0);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: alice,
    });

    // 反面对照：同一个作品转让给**别人**照旧成功（否则上面两句在「怎么都抛」的实现上也红）。
    const to = randomUUID();
    const ok = await prisma.$transaction((tx) =>
      ownership.transferOwnership(tx, { assetId: asset.id, toUserId: to, reason: '正常转让' }),
    );
    expect(ok.fromUserId).toBe(alice);
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(1);
  });

  /**
   * **同一个取值的另一种拼写**：大写 UUID 也必须被自转守卫拦下（修复轮 2 / Critical）。
   *
   * ## 为什么这是一条独立的判据（而不是上一条的重复）
   *
   * 上一条给的是**逐字相同**的字符串，于是它在两种实现下都绿：一种比较「规范化之后的取值」，
   * 另一种直接比较两个字符串。而 PostgreSQL 的 `uuid` 列会把取值规范成**小写**存进去，
   * 从库里读回来的 `owner_id` 因此必然是小写——一个**大写拼写的当前所有人**是
   * 「同一个取值、不同的字符串」。直接比较字符串的实现会认为这是一次「转给别人」：
   * 守卫被跳过，`ownerId` 被写回同一个值，历史里落下一行 `X→X`。
   *
   * 而那一行是**永久**的（`UPDATE`/`DELETE` 在运行时角色下被 `REVOKE`，判据 10），
   * 正是这条守卫存在的全部理由——一次合法的输入拼写就足以把它绕过去。
   *
   * 判据与上一条同形：领域错误 + 一行历史都没写下。**判别力**由探针 m1 给出
   * （把 `toLowerCase()` 去掉 ⇒ 本用例红，上一条照旧绿）。
   */
  it('转给自己（大写拼写的 UUID）⇒ 同样被拒，且没有写下 X→X 历史行', async () => {
    const alice = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    const upper = alice.toUpperCase();
    // 自检：这必须真的是「另一种拼写」。全是数字的 UUID（概率约 1e-7）会让本用例变成
    // 上一条的复制品——那时这条断言会**响亮地**失败，而不是静默地失去判别力。
    expect(upper, '大写之后没有变化：本用例没有测到「另一种拼写」').not.toBe(alice);
    expect(upper.toLowerCase()).toBe(alice);

    let thrown: unknown;
    try {
      await prisma.$transaction((tx) =>
        ownership.transferOwnership(tx, { assetId: asset.id, toUserId: upper, reason: '转给自己（大写拼写）' }),
      );
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SelfTransferRejectedError);
    // 错误里带的是**规范化之后**的取值（= 从库里读出来的那个），不是调用方给的那串拼写。
    expect((thrown as SelfTransferRejectedError).userId).toBe(alice);

    // 负后果：那一行 `X→X` **没有**被写下，指针也没有被写过。
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(0);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: alice,
    });
  });

  /**
   * 历史写不进去 ⇒ 指针也没有变（不是半个转让）。
   *
   * ## Task 1 之后这条用例表达的性质**由谁提供**（据实改写，不夸大）
   *
   * 改签名**之前**，这条用例的原子性是「方法**自开事务**」给的：`transferOwnership`
   * 自己 `BEGIN`，历史写不进去时它自己的事务回滚。改签名之后同类性质由**调用方的
   * `$transaction`** 提供——因此这里的调用点在明处写了一个 `prisma.$transaction`。
   *
   * ## ★ 它的判别力边界（据实记载，防「红在别的机制上」那一类缺陷）
   *
   * **这条用例在新旧两种实现下的可观测结果逐项相同**（指针仍是 alice、历史 0 行、
   * 抛出的是一个 `Error`）：两种实现都让这次写整体回滚，只是回滚由谁发起不同。
   * 因此它**不是**「自开事务被拿掉」的见证——那是 Step 6 那两条方向用例的活
   * （探针 P-2 实测：把 `this.prisma.$transaction` 写回方法体，红的正是那一条，
   * 而本条照旧绿）。留在这里的理由是它仍然钉着一件真事：**一次失败的转让不会留下
   * 半份状态**，而那件事对任何实现都必须成立。
   */
  it('历史写不进去 ⇒ 指针也没有变（原子性由调用方的 $transaction 提供，不再是方法自开事务）', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    // 注入一个真实的失败：运行时角色的 INSERT 被收掉（属主身份操作，随后恢复）。
    await owner.query(`REVOKE INSERT ON asset.ownership_history FROM app_user`);
    let thrown: unknown;
    try {
      await prisma.$transaction((tx) =>
        ownership.transferOwnership(tx, { assetId: asset.id, toUserId: bob, reason: '这笔必须整体失败' }),
      );
    } catch (err: unknown) {
      thrown = err;
    } finally {
      await owner.query(`GRANT INSERT ON asset.ownership_history TO app_user`);
    }

    expect(thrown, '历史写不进去时没有抛错').toBeInstanceOf(Error);
    // 回滚的证据：指针仍是 alice（若指针那次写逃出了这个事务，这里会变成 bob 而没有历史行）。
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: alice,
    });
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(0);

    // 反面对照：权限恢复之后同一笔转让可以成功（否则上面那句断言在「怎么都抛」的实现上也绿）。
    const retry = await prisma.$transaction((tx) =>
      ownership.transferOwnership(tx, { assetId: asset.id, toUserId: bob, reason: '重试' }),
    );
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

    // ★ 这里**不能**写成 `await prisma.$transaction(...)`：`pending` 必须保持是一个
    //   **尚未 settle 的 Promise**，这条用例靠「先不等它」来制造并发。`$transaction(fn)`
    //   本身就返回 Promise，因此并发构造原样保留（Task 1 Step 5 明写的两处特殊处理之一）。
    const pending = prisma.$transaction((tx) =>
      ownership.transferOwnership(tx, { assetId: asset.id, toUserId: carol, reason: '并发场景' }),
    );
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

  /**
   * ★ **预检 §0.1 的反向对照，逐字搬进用例**（Task 1 的核心判据）。
   *
   * 这条用例问的是：把转让 + 一次业务写入放进**同一个** `$transaction`，其中业务写入抛错，
   * 那么**所有权指针**与**历史行**是不是都回到原样。
   *
   * ## 它的红是什么样（**探针 P-2 的实测就是预检的 `[B6]` 构造**）
   *
   * 把 `transferOwnership` 改回**自开事务**（`this.prisma.$transaction(...)`）之后，
   * 这条用例红，且红在下面 `ownerId` 那一句上：外层事务回滚了，所有权指针**真的**
   * 变成了 bob、`ownership_history` **真的**多了一行——预检的
   * 「账本回滚、所有权不滚」在当前 HEAD 上原样复现。改回之后绿，而绿的机制是
   * **结构性的**：本方法里 `this.prisma.$transaction` **零匹配**，它不再有自己的 `COMMIT`。
   *
   * 两个量**逐项**核对（不是只看指针）：历史里那一行同样是不可撤销的写入
   * （`ownership_history` 的 UPDATE/DELETE 在运行期角色下被 REVOKE，判据 10）。
   */
  it('外层事务回滚 ⇒ 所有权指针与历史行**都**回滚（预检 §0.1 的 [B6] 构造）', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    await expect(
      prisma.$transaction(async (tx) => {
        await ownership.transferOwnership(tx, { assetId: asset.id, toUserId: bob, reason: '注定回滚的转让' });
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');

    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: alice,
    });
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(0);
  });

  /**
   * 反面对照（**每条拒绝都要有验收对照**）：同一个 `$transaction` 正常提交时，
   * 指针与历史行**一起**落地。「怎么都不写」的实现会骗过上面那条，这一条挡住它。
   *
   * 判别力：它同时钉住「指针变了」与「历史有且仅有一行」——`fromUserId` 那一句还钉住了
   * 持锁读出来的前手是 alice（不是别的什么）。
   */
  it('同一事务正常提交 ⇒ 指针与历史行**一起**可见（反面对照）', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const asset = await prisma.asset.create({ data: { ownerId: alice } });

    const result = await prisma.$transaction((tx) =>
      ownership.transferOwnership(tx, { assetId: asset.id, toUserId: bob, reason: '正常提交' }),
    );

    expect(result.fromUserId).toBe(alice);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).resolves.toMatchObject({
      ownerId: bob,
    });
    await expect(prisma.ownershipHistory.count({ where: { assetId: asset.id } })).resolves.toBe(1);
  });
});
