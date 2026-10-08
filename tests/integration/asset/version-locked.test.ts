import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@vca/shared';
import { AssetLockService } from '@vca/api/modules/asset/asset-lock.service.js';
import { AssetVersionService } from '@vca/api/modules/asset/asset-version.service.js';
import { AssetLockedForVersionError } from '@vca/api/modules/asset/asset-version.service.js';
import { AssetNotFoundError } from '@vca/api/modules/asset/ownership.service.js';
import type { IngestedVersion } from '@vca/api/modules/asset/ingested-version.js';
import type { ParsedMetadata } from '@vca/api/modules/asset/metadata/parse-metadata.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 版本写入边界的**锁检查**（P3 / Task 7 / 增量 A-7；规格 §10 第 2 条）。
 *
 * ## 它解决什么
 * 设计 §6.3:284 说双方锁定后作品「**不可编辑**」，而这句话在今天之前**没有任何执行点**
 * —— `locked_at` 在整个 `apps/` 下零读取者。本任务在**唯一**能把版本加到一件**已存在**
 * 作品上的写入点（`AssetVersionService.persistIngested` 的 `{ assetId }` 分支）落下这道检查。
 *
 * ## 据实记载（比「有一条未受保护的路径」更准）
 * 那个分支**今天零生产调用方**（`asset-version.service.ts` 的类注释自己写着这件事，
 * `POST /assets/upload` 只创建新作品），只有 `tests/` 在调它。⇒ **「看 v1、交 v2」今天没有路**；
 * 本文件的验收面因此是**服务层集成用例**，不是 HTTP 用例。
 * 放它的理由是本项目自己的标准：**结构性不可能 > 约定** —— 等那条路径第一次有调用方时，
 * 锁已经在它里面了。
 *
 * ## 这个错误为什么住在 `asset`（而不是复用 `exchange` 的 `AssetLockedError`）
 * 预检 §0.2 实测：`asset → exchange` 一旦成环，`pnpm arch` 就是 **6 条 error / exit 6**。
 * D11 的接缝是「`asset` 拥有处分判定，`exchange` 把事实**推**给它」，因此这里**只**读
 * `asset.assets` 自己的两列，不 import 任何 exchange 符号。
 */
let pg: TestPg;
let prisma: PrismaService;
let versions: AssetVersionService;
let locks: AssetLockService;

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  locks = new AssetLockService();
  // ★ 注入是真的：`AssetVersionService` 的第二个依赖就是锁服务（A-7 的消费点）。
  versions = new AssetVersionService(prisma, locks);
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
});

/** 一条待落库的版本记录（**确定性假值**：本文件一个制品字节都不读）。 */
function ingestedFor(assetId: string): IngestedVersion {
  return {
    storageKey: `probe/${assetId}`,
    sha256: `sha256-${assetId}`,
    plaintextBytes: 1024,
    keyId: 'k1',
    fileId: `file-${assetId}`,
    kind: 'zip',
    uploadedById: null,
  };
}

/** 一份元数据（只要求形状合法：本文件不判资格，判的是锁）。 */
function metadata(): ParsedMetadata {
  return {
    readmeExcerpt: '# 一件作品',
    fileTree: [{ path: 'src/index.ts', bytes: 100 }],
    languages: [{ name: 'TypeScript', bytes: 100, ratio: 1 }],
    dependencies: [],
    completeness: 40,
    fileTreeTruncated: false,
    codeLines: 10,
  };
}

async function makeAsset(): Promise<string> {
  const owner = await prisma.user.create({ data: {} });
  return (await prisma.asset.create({ data: { ownerId: owner.id } })).id;
}

/** 那个作品的版本行数 + 元数据行数（判据是「两处都不动」）。 */
async function rowCounts(assetId: string): Promise<{ versions: number; metadata: number }> {
  const versionIds = (await prisma.assetVersion.findMany({ where: { assetId }, select: { id: true } })).map(
    (row) => row.id,
  );
  return {
    versions: versionIds.length,
    metadata: await prisma.assetMetadata.count({ where: { assetVersionId: { in: versionIds } } }),
  };
}

function shapeOf(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  return `name=${String(e?.name)} code=${String(e?.code)} message=${String(e?.message).replace(/\s+/g, ' ').slice(0, 200)}`;
}

describe('版本写入边界的锁检查（§6.3:284 的第一个执行点；增量 A-7）', () => {
  it('★ 锁定之后 `persistIngested({ assetId })` 拒绝写入新版本（且**一行都不留**）', async () => {
    const assetId = await makeAsset();
    // 先用一次**成功**的写入把「未锁定时这条路是通的」变成事实（否则下面的拒绝
    // 可能只是「这个方法永远抛」）。它同时是第一条验收对照。
    const first = await versions.persistIngested({ assetId, ingested: ingestedFor(assetId), metadata: metadata() });
    const before = await rowCounts(assetId);
    expect(before).toEqual({ versions: 1, metadata: 1 });

    // 前置：直接把作品锁给一份合约（Task 7 的接口）。
    const contractId = uuidv7();
    await prisma.$transaction((tx) => locks.lockAssets(tx, [assetId], contractId));

    const error = await versions
      .persistIngested({ assetId, ingested: ingestedFor(assetId), metadata: metadata() })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error, `锁定之后必须拒绝写新版本。实测：${shapeOf(error)}`).toBeInstanceOf(AssetLockedForVersionError);
    expect((error as AssetLockedForVersionError).assetId).toBe(assetId);
    expect((error as AssetLockedForVersionError).holderContractId, '错误必须点名**谁**锁的').toBe(contractId);

    // ★ 「不留任何行」：版本与元数据**两个计数**都不变（事务整体回滚，
    //   而不是「拒绝之前先写了一半」）。
    expect(await rowCounts(assetId)).toEqual(before);
    // 那一次**成功**的写入还在（拒绝没有把它顺手删掉）。
    expect((await prisma.assetVersion.findUniqueOrThrow({ where: { id: first.assetVersionId } })).assetId).toBe(assetId);
  }, 120_000);

  it('验收对照：**未锁定**的作品照样能加版本（否则上面那条拒绝什么都没证明）', async () => {
    const assetId = await makeAsset();
    const a = await versions.persistIngested({ assetId, ingested: ingestedFor(assetId), metadata: metadata() });
    const b = await versions.persistIngested({ assetId, ingested: ingestedFor(assetId), metadata: metadata() });
    expect(a.assetVersionId).not.toBe(b.assetVersionId);
    expect(await rowCounts(assetId)).toEqual({ versions: 2, metadata: 2 });
  }, 120_000);

  it('★ 解锁之后（`unlockAssets`）又能加版本 —— 锁不是单向阀', async () => {
    const assetId = await makeAsset();
    const contractId = uuidv7();
    await prisma.$transaction((tx) => locks.lockAssets(tx, [assetId], contractId));
    await expect(
      versions.persistIngested({ assetId, ingested: ingestedFor(assetId), metadata: metadata() }),
    ).rejects.toBeInstanceOf(AssetLockedForVersionError);

    // 持有者解锁 ⇒ 同一个调用成功。**没有这一条**，一个「有锁就永远拒」的实现
    // （例如把判据写成常量 true）也能骗过上面那条。
    await prisma.$transaction((tx) => locks.unlockAssets(tx, [assetId], contractId));
    const persisted = await versions.persistIngested({
      assetId,
      ingested: ingestedFor(assetId),
      metadata: metadata(),
    });
    expect(await rowCounts(assetId)).toEqual({ versions: 1, metadata: 1 });
    expect(persisted.assetId).toBe(assetId);

    // 再锁上 ⇒ 又拒（两个方向都真的在被检查，不是「第一次之后就不再判」）。
    await prisma.$transaction((tx) => locks.lockAssets(tx, [assetId], uuidv7()));
    await expect(
      versions.persistIngested({ assetId, ingested: ingestedFor(assetId), metadata: metadata() }),
    ).rejects.toBeInstanceOf(AssetLockedForVersionError);
  }, 120_000);

  it('未知作品仍然抛 AssetNotFoundError（不是「没锁」、也不是 Prisma 的 P2003），且不留任何行', async () => {
    // ★ 这一条是 A-7 **改动**那段代码时的回归护栏：判据从「作品在不在」换成了
    // 「`isLocked` 给出的判决」，而「作品不存在 ⇒ 404」这条既有行为一个字都不能变
    // （`ownership.test.ts` 有一条同名用例；这里的价值是它与新的锁判据**同处一条路径**）。
    const ghost = uuidv7();
    const error = await versions
      .persistIngested({ assetId: ghost, ingested: ingestedFor(ghost), metadata: metadata() })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error, `实测：${shapeOf(error)}`).toBeInstanceOf(AssetNotFoundError);
    expect(error, '不能是「已锁定」那一档（那会把一次调用方错误说成一次处分冻结）').not.toBeInstanceOf(
      AssetLockedForVersionError,
    );
    expect(await prisma.assetVersion.count({ where: { assetId: ghost } })).toBe(0);
    expect(await prisma.asset.count({ where: { id: ghost } })).toBe(0);
  }, 120_000);
});
