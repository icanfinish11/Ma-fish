import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { AssetNotFoundError } from '@vca/api/modules/asset/ownership.service.js';
import { AssetAccessService } from '@vca/api/modules/asset/asset-access.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { ExchangeService } from '@vca/api/modules/exchange/exchange.service.js';
import {
  AssetLockedError,
  IneligibleAssetError,
  InvalidClaimsError,
  InvalidExchangeTransitionError,
  StaleCommitmentError,
  SwapSelfOfferError,
  UnknownExchangeObjectError,
} from '@vca/api/modules/exchange/core/errors.js';
import { createTestApp } from '../../helpers/app.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';

/**
 * 等到**服务端**说「有一条语句正卡在 `exchange.swap_offers` 的行锁上」。
 *
 * ## 为什么不用 `sleep`（Task 4 修复轮实测过的理由，逐字同源）
 * 一条靠 `sleep` 的时序断言测的是**机器有多忙**，不是被观察的那条性质：
 * 本仓库已经因此红过一次（全量 `pnpm test` 下竞争者成了死锁牺牲者）。
 * 这里观察的是 `pg_stat_activity` 里的 `wait_event_type = 'Lock'` ——
 * **服务端的事实**，它出现的那一刻就是交错真的被造出来的那一刻。
 *
 * 超时**抛错**而不是继续跑：等不到锁说明交错没造出来，
 * 而那种情形下继续跑只会得到一条指向错误原因的红灯。
 */
async function waitForRowLockWait(prisma: PrismaService): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_stat_activity
       WHERE state = 'active'
         AND wait_event_type = 'Lock'
         AND query ILIKE '%exchange%swap_offers%'`;
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待「accept 的 UPDATE 卡在行锁上」超时：并发交错没有被造出来');
}

/**
 * 要约的生命周期（P3 / Task 6 + 增量 A-6）。
 *
 * ## 这个文件判的是哪一层
 *
 * **服务层**（`ExchangeService`），不是路由层：授权在 `tests/security/exchange/authz-matrix.test.ts`
 * 里逐格判，而这里判的是「一个请求走到服务里之后，状态与行是怎么变的」。
 *
 * ## 制品字节**不参与**本文件（据实记载，免得下一个人以为这里验过制品）
 *
 * `proposeOffer` / `acceptOffer` 读的只有 `asset_versions` 的四列（id / sha256 / assetId）
 * 与 `asset_metadata` 的六列，**一个制品字节都不读**（解压、解密、校验都是别处的路径）。
 * 因此版本行是**直接落库**的，`storageKey` / `keyId` / `fileId` 取确定性假值——
 * 没有一条断言依赖一份真实的加密制品。代价据实写在这里：**本文件证明不了
 * 「真实的接入流程产出的行能被要约接受」**，那由 §6.1 的资格判据（完整度 + README 摘录）
 * 与 `tests/integration/asset/*` 分别承担。
 */
describe('交换要约的生命周期（P3 / Task 6）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let exchange: ExchangeService;
  let assets: AssetAccessService;

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
      ],
    });
    exchange = app.get(ExchangeService);
    assets = app.get(AssetAccessService);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
  });

  /** 一个用户。 */
  async function makeUser(): Promise<string> {
    return (await prisma.user.create({ data: {} })).id;
  }

  /** 一件作品 + 一份版本 + 一份元数据（**直接落库**，见文件头）。 */
  async function makeAsset(
    ownerId: string,
    overrides: {
      completeness?: number;
      readmeExcerpt?: string | null;
      codeLines?: number | null;
      fileTree?: { path: string; bytes: number }[];
      languages?: { name: string; bytes: number; ratio: number }[];
      dependencies?: { ecosystem: string; name: string; version: string }[];
    } = {},
  ): Promise<{ assetId: string; assetVersionId: string; sha256: string }> {
    const asset = await prisma.asset.create({ data: { ownerId } });
    const sha256 = `sha256-${asset.id}`;
    const version = await prisma.assetVersion.create({
      data: {
        assetId: asset.id,
        sha256,
        storageKey: `probe/${asset.id}`,
        plaintextBytes: 1024,
        keyId: 'k1',
        fileId: `file-${asset.id}`,
        uploadedById: ownerId,
      },
    });
    await prisma.assetMetadata.create({
      data: {
        assetVersionId: version.id,
        readmeExcerpt: overrides.readmeExcerpt === undefined ? '# 一件作品' : overrides.readmeExcerpt,
        fileTree: overrides.fileTree ?? [{ path: 'src/index.ts', bytes: 100 }],
        languages: overrides.languages ?? [{ name: 'TypeScript', bytes: 100, ratio: 1 }],
        dependencies: overrides.dependencies ?? [{ ecosystem: 'npm', name: 'zod', version: '4.6.5' }],
        completeness: overrides.completeness ?? 40,
        fileTreeTruncated: false,
        // `undefined` ⇒ **不写这一列**（走默认的 NULL），用来造 Task 5.5 的「旧行」。
        ...(overrides.codeLines === undefined ? {} : { codeLines: overrides.codeLines }),
      },
    });
    return { assetId: asset.id, assetVersionId: version.id, sha256 };
  }

  const DIGEST = 'd'.repeat(64);

  // ══════════════════════════════════════════════════════════════════════════
  // ① 发要约：五个拒绝面 + 每一个的验收对照
  // ══════════════════════════════════════════════════════════════════════════

  describe('发要约（§6.3 的 `DRAFT → SENT`；五个拒绝面各有验收对照）', () => {
    it('作品不存在 / 不是自己的 ⇒ AssetNotFoundError（两次 checkAccess 是 D11 的唯一入口）', async () => {
      const proposer = await makeUser();
      const other = await makeUser();
      const mine = await makeAsset(proposer);
      const theirs = await makeAsset(other);

      // ① 被拿出的作品不是自己的。
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: theirs.assetId,
          targetAssetId: theirs.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(AssetNotFoundError);

      // ② 两份作品**同属自己**：这不是「不存在」，而是自要约（409）。判据是
      //    「目标作品也归我」——因此它只能由 `checkAccess(targetAssetId, proposer)` 的
      //    **true** 给出，而不是由任何一条「按 id 取 owner」的新查询给出。
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: mine.assetId,
          targetAssetId: mine.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(SwapSelfOfferError);

      // ③ 作品根本不存在。
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: '01920000-0000-7000-8000-0000000000ff',
          targetAssetId: theirs.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(AssetNotFoundError);
      // ④ 目标作品根本不存在。
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: mine.assetId,
          targetAssetId: '01920000-0000-7000-8000-0000000000fe',
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(AssetNotFoundError);

      // **验收对照**：同一个人拿自己的作品去要约别人的作品 ⇒ 通过。
      // 没有它，一个「怎么都拒」的实现也能让上面三条变绿。
      const ok = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: mine.assetId,
        targetAssetId: theirs.assetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      });
      expect(ok.created).toBe(true);
      expect(ok.counterpartyId).toBe(other);
    });

    it('★ 归属判定**恰好两次** `checkAccess`（D11 的唯一入口），一次一件作品', async () => {
      // 计划 Task 6 的「先验再做」把这条要求写成了可验证的形式：
      // 「`asset` 的 `checkAccess` 需要一次真实调用来判『这件作品是不是他的』……
      //   要约的创建需要**两件**作品的归属判定，因此 `proposeOffer` 里是两次 `checkAccess`。
      //   **这不是一个新接口**」。
      //
      // ## 这条断言**证明**什么、**不**证明什么（据实划清）
      // * 证明：授权判定在 `proposeOffer` 里恰好被问**两次**，每次都是 `(assetId, proposerId)`
      //   这一对形状 —— 也就是「没有第三个授权问题」（例如「这件作品锁着吗」被误当成授权、
      //   或者对同一件作品问两遍）。
      // * **不**证明：服务里不存在任何其它读 `asset` 的代码 —— `readAssetFacts` 的
      //   `prisma.asset.findUnique` 是**事实读取**（ownerId / lockedAt），不是判定。
      //   把它也算进来的话，断言会变成对**实现细节**的计数，而那是「一条红在别的机制上」
      //   的断言（本轮刻意不写它）。
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const mine = await makeAsset(proposer);
      const theirs = await makeAsset(counterparty);

      const access = vi.spyOn(assets, 'checkAccess');
      try {
        await exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: mine.assetId,
          targetAssetId: theirs.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        });
        expect(access.mock.calls).toHaveLength(2);
        expect(access.mock.calls.map((call) => `${call[0]}:${String(call[1])}`).sort()).toEqual(
          [`${mine.assetId}:${proposer}`, `${theirs.assetId}:${proposer}`].sort(),
        );
      } finally {
        access.mockRestore();
      }
    });

    it('向自己发要约（两份作品同属一人）⇒ SwapSelfOfferError（与归属判定分开的两件事）', async () => {
      const proposer = await makeUser();
      const a = await makeAsset(proposer);
      const b = await makeAsset(proposer);
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: a.assetId,
          targetAssetId: b.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(SwapSelfOfferError);
      // **验收对照**：把目标换成**别人**的作品 ⇒ 通过（同一个提出方、同一件被拿出作品）。
      const other = await makeUser();
      const c = await makeAsset(other);
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: a.assetId,
          targetAssetId: c.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).resolves.toMatchObject({ counterpartyId: other, created: true });
    });

    it('任一作品已被锁定（§6.3:284）⇒ AssetLockedError（两个方向各一条 + 验收对照）', async () => {
      const proposer = await makeUser();
      const counterparty = await makeUser();

      // 方向 ①：被拿出的作品锁着。
      const lockedOffered = await makeAsset(proposer);
      const target1 = await makeAsset(counterparty);
      await prisma.asset.update({ where: { id: lockedOffered.assetId }, data: { lockedAt: new Date() } });
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: lockedOffered.assetId,
          targetAssetId: target1.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(AssetLockedError);

      // 方向 ②：被要约的作品锁着。
      const offered2 = await makeAsset(proposer);
      const lockedTarget = await makeAsset(counterparty);
      await prisma.asset.update({ where: { id: lockedTarget.assetId }, data: { lockedAt: new Date() } });
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: offered2.assetId,
          targetAssetId: lockedTarget.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(AssetLockedError);

      // **验收对照**：解锁之后同一句话 ⇒ 通过。没有它，「怎么都拒」也能骗过上面两条。
      await prisma.asset.update({ where: { id: lockedTarget.assetId }, data: { lockedAt: null } });
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: offered2.assetId,
          targetAssetId: lockedTarget.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it('任一作品不满足 §6.1 第 2 条 ⇒ IneligibleAssetError（完整度 / README 两个方向 + 验收对照）', async () => {
      const proposer = await makeUser();
      const counterparty = await makeUser();

      // 方向 ①：被拿出的作品完整度为 0。
      const flatOffered = await makeAsset(proposer, { completeness: 0 });
      const target1 = await makeAsset(counterparty);
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: flatOffered.assetId,
          targetAssetId: target1.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(IneligibleAssetError);

      // 方向 ②：被要约的作品没有 README（「没有」与「空文件」不是同一件事）。
      const offered2 = await makeAsset(proposer);
      const noReadme = await makeAsset(counterparty, { readmeExcerpt: null });
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: offered2.assetId,
          targetAssetId: noReadme.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).rejects.toBeInstanceOf(IneligibleAssetError);

      // **验收对照**：两件都合格 ⇒ 通过。
      const good = await makeAsset(counterparty);
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: offered2.assetId,
          targetAssetId: good.assetId,
          offeredDossierDigest: DIGEST,
          claims: null,
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it('同一对 (target, counterparty) 上已有**活跃**要约 ⇒ 复用那一行（`created: false`）', async () => {
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const offered = await makeAsset(proposer);
      const target = await makeAsset(counterparty);

      const first = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: offered.assetId,
        targetAssetId: target.assetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      });
      expect(first.created).toBe(true);

      const second = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: offered.assetId,
        targetAssetId: target.assetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      });
      // 与账本的幂等三态同一条纪律：重复是调用方需要知道的**事实**，不是被吞掉的错误。
      expect(second.created).toBe(false);
      expect(second.offerId).toBe(first.offerId);
      expect(second.expiresAt).toEqual(first.expiresAt);

      // 库里恰好一行（复用不是「又插了一行然后返回旧的」）。
      expect(await prisma.swapOffer.count({ where: { targetAssetId: target.assetId } })).toBe(1);
    });

    it('★★ 控制器裁定 ①：`REJECTED`（终态）之后**可以**重新要约', async () => {
      // 裁定逐字：「『`REJECTED` 是终态』约束的是**那一份要约**，而不是**那一对人**。」
      // 全线唯一索引之下这条会以 P2002 失败 —— 一次拒绝永久封死一条配对路径。
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const offered = await makeAsset(proposer);
      const target = await makeAsset(counterparty);

      const first = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: offered.assetId,
        targetAssetId: target.assetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      });
      await exchange.rejectOffer({ offerId: first.offerId, actorId: counterparty, reason: 'NOT_INTERESTED' });

      const again = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: offered.assetId,
        targetAssetId: target.assetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      });
      expect(again.created).toBe(true);
      expect(again.offerId).not.toBe(first.offerId);
      // 两份行**都在**：历史没有被改写（`REJECTED` 是终态这件事对**那一份**仍然成立）。
      const rows = await prisma.swapOffer.findMany({
        where: { targetAssetId: target.assetId },
        select: { id: true, status: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.status).sort()).toEqual(['REJECTED', 'SENT']);
    });

    it('★ 重复调用是幂等的：并发/连续两次只留一行，且第二次一定拿到 `created: false`', async () => {
      // **据实说明，不夸大**：本用例断言的是**结果契约**（同一对只剩一行、两次调用给出
      // 同一份要约），**不是**并发本身——`Promise.all` 之下的两条语句可能被连接池串行化。
      // 真正的并发见证在**真库**那一层（`tests/integration/db/exchange-enforcement.test.ts`
      // 用三条独立连接去撞部分唯一索引），理由与 Task 2 的 `(producer, key)` 那一条相同。
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const offered = await makeAsset(proposer);
      const target = await makeAsset(counterparty);

      const results = await Promise.allSettled(
        [1, 2].map(() =>
          exchange.proposeOffer({
            proposerId: proposer,
            offeredAssetId: offered.assetId,
            targetAssetId: target.assetId,
            offeredDossierDigest: DIGEST,
            claims: null,
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      expect(ok, `两次调用都必须成功（P2002 在服务里被消化成复用）：${JSON.stringify(results)}`).toHaveLength(2);
      expect(new Set(ok.map((r) => r.offerId)).size).toBe(1);
      expect(ok.filter((r) => r.created)).toHaveLength(1);
      expect(await prisma.swapOffer.count({ where: { targetAssetId: target.assetId } })).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ② 增量 A-6：承诺闭集与「钉住」的写入侧
  // ══════════════════════════════════════════════════════════════════════════

  describe('增量 A-6：承诺闭集与钉住', () => {
    it('★ `proposeOffer` 把提议方的三个承诺列与 `claims` 一起落库', async () => {
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const offered = await makeAsset(proposer, {
        codeLines: 4321,
        fileTree: [{ path: 'src/index.ts', bytes: 10 }, { path: 'README.md', bytes: 20 }],
        languages: [{ name: 'TypeScript', bytes: 10, ratio: 1 }],
        dependencies: [{ ecosystem: 'npm', name: 'zod', version: '4.6.5' }],
      });
      const target = await makeAsset(counterparty);

      const claims = [
        { kind: 'paths_exist', paths: ['src/index.ts'] },
        { kind: 'min_code_lines', min: 1000 },
        { kind: 'declared_stack', languages: ['TypeScript'] },
        { kind: 'dependency_manifest_parses', ecosystem: 'npm' },
        { kind: 'entry_file_exists', path: 'src/index.ts' },
      ];
      const result = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: offered.assetId,
        targetAssetId: target.assetId,
        offeredDossierDigest: DIGEST,
        claims,
      });

      const row = await prisma.swapOffer.findUniqueOrThrow({ where: { id: result.offerId } });
      // 三个承诺列**逐项**：版本是**服务端**读出来的当前那一份（不是请求里给的），
      // sha256 同（`asset_versions.sha256`），摘要**原样**存带回的那个串。
      expect(row.offeredVersionId).toBe(offered.assetVersionId);
      expect(row.offeredSha256).toBe(offered.sha256);
      expect(row.offeredDossierDigest).toBe(DIGEST);
      // `claims` 逐条：解析后的规范化形状（闭集外的键已被剥掉——这里没有，因此逐字相同）。
      expect(row.claims).toEqual(claims);
      // 72 小时的有效期**由服务算出并落库**（不是 `created_at + interval`）。
      const hours = (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
      expect(hours).toBeGreaterThan(71.9);
      expect(hours).toBeLessThan(72.1);
    });

    it('拒绝面：`claims` 里出现闭集外的 kind ⇒ InvalidClaimsError，且**没有一行落库**', async () => {
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const offered = await makeAsset(proposer);
      const target = await makeAsset(counterparty);
      const before = await prisma.swapOffer.count();

      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: offered.assetId,
          targetAssetId: target.assetId,
          offeredDossierDigest: DIGEST,
          claims: [{ kind: 'quality_is_good' }],
        }),
      ).rejects.toBeInstanceOf(InvalidClaimsError);

      expect(await prisma.swapOffer.count()).toBe(before);
      // **验收对照**：同一个调用换一条闭集内的声明 ⇒ 通过（否则上面那条可能只是「写不进去」）。
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: offered.assetId,
          targetAssetId: target.assetId,
          offeredDossierDigest: DIGEST,
          claims: [{ kind: 'entry_file_exists', path: 'src/index.ts' }],
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it('★ 声明侧 fail-closed：`min_code_lines` 而 `code_lines` 是 NULL ⇒ 422 那一条，且没有一行落库', async () => {
      const proposer = await makeUser();
      const counterparty = await makeUser();
      // Task 5.5 的「旧行」：`code_lines` 是 NULL（**不是** 0）。
      const legacy = await makeAsset(proposer, { codeLines: null });
      const target = await makeAsset(counterparty);
      const before = await prisma.swapOffer.count();

      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: legacy.assetId,
          targetAssetId: target.assetId,
          offeredDossierDigest: DIGEST,
          claims: [{ kind: 'min_code_lines', min: 10 }],
        }),
      ).rejects.toBeInstanceOf(InvalidClaimsError);
      expect(await prisma.swapOffer.count()).toBe(before);

      // **反向对照**：同一件作品、同一个调用，声明换一条**核得动**的 ⇒ 通过。
      // 没有它，一个「所有声明都拒」的实现同样能让上面那条变绿。
      await expect(
        exchange.proposeOffer({
          proposerId: proposer,
          offeredAssetId: legacy.assetId,
          targetAssetId: target.assetId,
          offeredDossierDigest: DIGEST,
          claims: [{ kind: 'paths_exist', paths: ['src/index.ts'] }],
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it('`claims` 缺省 ⇒ 列是 NULL（**没有声明**），而 `[]` ⇒ 空集（两个不同的值）', async () => {
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const a = await makeAsset(proposer);
      const b = await makeAsset(proposer);
      const t1 = await makeAsset(counterparty);
      const t2 = await makeAsset(counterparty);

      const noClaims = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: a.assetId,
        targetAssetId: t1.assetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      });
      const emptyClaims = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: b.assetId,
        targetAssetId: t2.assetId,
        offeredDossierDigest: DIGEST,
        claims: [],
      });
      const rows = await prisma.swapOffer.findMany({
        where: { id: { in: [noClaims.offerId, emptyClaims.offerId] } },
        select: { id: true, claims: true },
      });
      const byId = new Map(rows.map((row) => [row.id, row.claims]));
      expect(byId.get(noClaims.offerId)).toBeNull();
      expect(byId.get(emptyClaims.offerId)).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ③ 接受：契约的钉住 + TOCTOU
  // ══════════════════════════════════════════════════════════════════════════

  describe('接受（§6.3 的 `SENT → ACCEPTED → 生成 SwapContract`）', () => {
    /** 造一份 `SENT` 要约，并返回它落库之后的那一行（含三个承诺列）。 */
    async function seedOffer(): Promise<{
      proposer: string;
      counterparty: string;
      offered: { assetId: string; assetVersionId: string; sha256: string };
      target: { assetId: string; assetVersionId: string; sha256: string };
      offerId: string;
    }> {
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const offered = await makeAsset(proposer);
      const target = await makeAsset(counterparty);
      const result = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: offered.assetId,
        targetAssetId: target.assetId,
        offeredDossierDigest: DIGEST,
        claims: [{ kind: 'entry_file_exists', path: 'src/index.ts' }],
      });
      return { proposer, counterparty, offered, target, offerId: result.offerId };
    }

    it('★ `accept` 写入 target 三列，且合约的 `target_version_id` 等于请求里带回的那个', async () => {
      const seeded = await seedOffer();
      const decision = await exchange.acceptOffer({
        offerId: seeded.offerId,
        actorId: seeded.counterparty,
        // 接受方带回**他看过的**那一份（规格 §5.1：预览响应给的 `(assetVersionId, dossierDigest)`）。
        targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST },
      });

      const contract = await prisma.swapContract.findUniqueOrThrow({ where: { id: decision.contractId } });
      expect(contract.targetVersionId).toBe(seeded.offered.assetVersionId);
      expect(contract.targetSha256).toBe(seeded.offered.sha256);
      expect(contract.targetDossierDigest).toBe(DIGEST);
      // 两方与两件作品的固定朝向（`partyA` = 被要约方，`assetA` = 被要约的作品）。
      expect(contract.partyAId).toBe(seeded.counterparty);
      expect(contract.partyBId).toBe(seeded.proposer);
      expect(contract.assetAId).toBe(seeded.target.assetId);
      expect(contract.assetBId).toBe(seeded.offered.assetId);
      // Task 6 **只建等价互换**的合约（补差的两个默认值；条件化 CHECK 对此放行）。
      expect(contract.topUpAmount).toBe(0n);
      expect(contract.topUpPayerId).toBeNull();
      expect(contract.status).toBe('PENDING_BOTH_LOCK');
      const lockHours = (contract.lockDeadlineAt.getTime() - contract.createdAt.getTime()) / 3_600_000;
      expect(lockHours).toBeGreaterThan(23.9);
      expect(lockHours).toBeLessThan(24.1);

      // 要约翻成终态 `ACCEPTED`，且**同一次事务**里生成合约。
      const offer = await prisma.swapOffer.findUniqueOrThrow({ where: { id: seeded.offerId } });
      expect(offer.status).toBe('ACCEPTED');
    });

    it('★ TOCTOU：带回的 `dossierDigest` 与当前值不一致 ⇒ 409 且**一行都不写**', async () => {
      const seeded = await seedOffer();
      const contractsBefore = await prisma.swapContract.count();
      const auditsBefore = await prisma.auditLog.count();
      const offerBefore = await prisma.swapOffer.findUniqueOrThrow({ where: { id: seeded.offerId } });

      await expect(
        exchange.acceptOffer({
          offerId: seeded.offerId,
          actorId: seeded.counterparty,
          // 一份**别的** dossier 的摘要（作者在上一次查看之后上传了新版本的那种情形）。
          targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: 'e'.repeat(64) },
        }),
      ).rejects.toBeInstanceOf(StaleCommitmentError);

      expect(await prisma.swapContract.count()).toBe(contractsBefore);
      expect(await prisma.auditLog.count()).toBe(auditsBefore);
      const offerAfter = await prisma.swapOffer.findUniqueOrThrow({ where: { id: seeded.offerId } });
      expect(offerAfter.status).toBe('SENT');
      expect(offerAfter.status).toBe(offerBefore.status);

      // **验收对照**：带上**对的那一份** ⇒ 接受成功。
      // 没有它，一个「怎么都拒」的实现同样能让上面那三条变绿。
      const ok = await exchange.acceptOffer({
        offerId: seeded.offerId,
        actorId: seeded.counterparty,
        targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST },
      });
      expect(ok.contractId).toBeTruthy();
      expect(await prisma.swapContract.count()).toBe(contractsBefore + 1);
    });

    it('★ TOCTOU 的另一半：带回的 `assetVersionId` 不是当前那一份 ⇒ 409', async () => {
      // 两个字段是**同一个事实**的两个投影（「哪一份」），因此各自都必须是承重的：
      // 只判摘要时，一个把版本 id 原样漏过的实现（例如从不看它）不会被任何用例发现。
      const seeded = await seedOffer();
      await expect(
        exchange.acceptOffer({
          offerId: seeded.offerId,
          actorId: seeded.counterparty,
          // 摘要是对的、版本是**别的**（这里取目标作品的那一份，形状合法但语义错）。
          targetCommitment: { assetVersionId: seeded.target.assetVersionId, dossierDigest: DIGEST },
        }),
      ).rejects.toBeInstanceOf(StaleCommitmentError);
      expect(await prisma.swapContract.count({ where: { offerId: seeded.offerId } })).toBe(0);

      // **验收对照**：换成对的那一份 ⇒ 通过。
      await expect(
        exchange.acceptOffer({
          offerId: seeded.offerId,
          actorId: seeded.counterparty,
          targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST },
        }),
      ).resolves.toMatchObject({ offerId: seeded.offerId });
    });

    it('只有**被要约方**能接受与拒绝；第三方的请求被服务层拒（不是只靠守卫）', async () => {
      const seeded = await seedOffer();
      const stranger = await makeUser();
      await expect(
        exchange.acceptOffer({
          offerId: seeded.offerId,
          actorId: stranger,
          targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST },
        }),
      ).rejects.toBeInstanceOf(UnknownExchangeObjectError);
      await expect(
        exchange.rejectOffer({ offerId: seeded.offerId, actorId: stranger, reason: 'NOT_INTERESTED' }),
      ).rejects.toBeInstanceOf(UnknownExchangeObjectError);
      // **验收对照**：真正的对手方两条都成功（后者用 `rejectOffer`，见下一条 describe）。
      const ok = await exchange.rejectOffer({
        offerId: seeded.offerId,
        actorId: seeded.counterparty,
        reason: 'NOT_INTERESTED',
      });
      expect(ok).toBeUndefined();
    });

    it('★ 真交错：并发的第二个 `accept` 撞上条件更新 ⇒ 409，**不是**靠唯一索引给出的 500', async () => {
      // ## 这条用例判的是什么（一条**真实**的并发交错，不是 `Promise.all` 的巧合）
      // 状态守卫读的是**事务之外**的那一次 `findUnique`，因此两个并发的 `accept`
      // 可以都读到 `SENT`。这一条把那个交错**确定性地**造出来：
      //   ① 用一条独立连接把要约行 `FOR UPDATE` 锁住；
      //   ② 让 `acceptOffer` 跑起来 —— 它会读完状态、通过 TOCTOU，然后**卡在**那条
      //      条件 UPDATE 上（因为行锁在 ① 手里）；
      //   ③ **观察到**它真的卡住了（`pg_stat_activity` 里的 `Lock` 等待，不是 `sleep`）；
      //   ④ 在持有锁的那条连接上把状态改成 `ACCEPTED` 并提交；
      //   ⑤ 被放行的 UPDATE 在 READ COMMITTED 下**重新求值** `WHERE status = 'SENT'`
      //      ⇒ 受影响行数 **0** ⇒ `InvalidExchangeTransitionError`（409）。
      //
      // ## 判别力（把它换回不带状态条件的 `update` 会怎样）
      // 无条件的 `UPDATE … WHERE id = $1` 照样写成功（把已经是 `ACCEPTED` 的行再写一次），
      // 于是这一步**不会**抛错，`acceptOffer` 会继续去建合约并返回一个 `contractId`
      // ⇒ 本用例红在 `expected … to be an instance of InvalidExchangeTransitionError` 上。
      // ⇒ 它是「条件更新」这个修法的**承重**见证（探针 P-T6-e）。
      const seeded = await seedOffer();
      const locker = new Client({ connectionString: pg.ownerUri });
      await locker.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM exchange.swap_offers WHERE id = $1 FOR UPDATE', [seeded.offerId]);

        const pending = exchange.acceptOffer({
          offerId: seeded.offerId,
          actorId: seeded.counterparty,
          targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST },
        });
        // 它稍后被 `await expect(...).rejects` 消费；这一句只是防止「在断言之前就已经拒绝」
        // 被 Node 当成一次未处理的拒绝（那会在输出里多一行噪音，而本仓库要求测试输出 pristine）。
        void pending.catch(() => undefined);

        // ②→③：等到**服务端**说它卡住了。`sleep` 不在这里出现（Task 4 修复轮的同一条纪律：
        // 一条靠 sleep 的时序断言测的是机器有多忙，不是被观察的性质）。
        await waitForRowLockWait(prisma);

        await locker.query(`UPDATE exchange.swap_offers SET status = 'ACCEPTED' WHERE id = $1`, [seeded.offerId]);
        await locker.query('COMMIT');

        await expect(pending).rejects.toBeInstanceOf(InvalidExchangeTransitionError);
        // 没有任何合约被留在这份要约上（那一笔事务整体回滚了）。
        expect(await prisma.swapContract.count({ where: { offerId: seeded.offerId } })).toBe(0);
      } finally {
        await locker.query('ROLLBACK').catch(() => undefined);
        await locker.end();
      }
    });

    it('终态之后不能再决策：`ACCEPTED` 的要约再被接受 ⇒ InvalidExchangeTransitionError', async () => {
      const seeded = await seedOffer();
      await exchange.acceptOffer({
        offerId: seeded.offerId,
        actorId: seeded.counterparty,
        targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST },
      });
      // 状态机的守卫在**任何写之前**（第二次接受若走到插入，会先撞 `swap_contracts.offer_id`
      // 的唯一索引 —— 那样这条用例就红在**别的机制**上了，而它声称的是状态守卫）。
      await expect(
        exchange.acceptOffer({
          offerId: seeded.offerId,
          actorId: seeded.counterparty,
          targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST },
        }),
      ).rejects.toBeInstanceOf(InvalidExchangeTransitionError);
      expect(await prisma.swapContract.count({ where: { offerId: seeded.offerId } })).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ④ 拒绝 / 撤回 / 读取（四个终态各有到达路径）
  // ══════════════════════════════════════════════════════════════════════════

  describe('拒绝 / 撤回 / 读取', () => {
    async function seedSent(): Promise<{
      proposer: string;
      counterparty: string;
      offered: { assetId: string; assetVersionId: string; sha256: string };
      offerId: string;
    }> {
      const proposer = await makeUser();
      const counterparty = await makeUser();
      const offered = await makeAsset(proposer);
      const target = await makeAsset(counterparty);
      const result = await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId: offered.assetId,
        targetAssetId: target.assetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      });
      return { proposer, counterparty, offered, offerId: result.offerId };
    }

    it('拒绝把理由**原文**落库，并把状态翻成 `REJECTED`（终态）', async () => {
      const seeded = await seedSent();
      await exchange.rejectOffer({
        offerId: seeded.offerId,
        actorId: seeded.counterparty,
        reason: 'TERMS_UNACCEPTABLE',
      });
      const row = await prisma.swapOffer.findUniqueOrThrow({ where: { id: seeded.offerId } });
      expect(row.status).toBe('REJECTED');
      expect(row.reason).toBe('TERMS_UNACCEPTABLE');
      // **验收对照**：另一份要约走撤回 ⇒ `WITHDRAWN`（否则「怎么都写 REJECTED」也能骗过上面）。
      const other = await seedSent();
      await exchange.withdrawOffer({ offerId: other.offerId, actorId: other.proposer, reason: 'OTHER' });
      expect((await prisma.swapOffer.findUniqueOrThrow({ where: { id: other.offerId } })).status).toBe('WITHDRAWN');
    });

    it('撤回**只有发起方**能做：对手方撤回被拒，且状态未变', async () => {
      const seeded = await seedSent();
      await expect(
        exchange.withdrawOffer({ offerId: seeded.offerId, actorId: seeded.counterparty, reason: 'OTHER' }),
      ).rejects.toBeInstanceOf(UnknownExchangeObjectError);
      expect((await prisma.swapOffer.findUniqueOrThrow({ where: { id: seeded.offerId } })).status).toBe('SENT');
      // **验收对照**：发起方自己撤回 ⇒ 成功。
      await expect(
        exchange.withdrawOffer({ offerId: seeded.offerId, actorId: seeded.proposer, reason: 'OTHER' }),
      ).resolves.toBeUndefined();
      expect((await prisma.swapOffer.findUniqueOrThrow({ where: { id: seeded.offerId } })).status).toBe('WITHDRAWN');
    });

    it('读取：双方都看得到，第三方看不到（服务层的自足判定）', async () => {
      const seeded = await seedSent();
      const view = await exchange.getOffer(seeded.offerId, seeded.counterparty);
      expect(view.offerId).toBe(seeded.offerId);
      expect(view.status).toBe('SENT');
      expect(view.claims).toBeNull();
      expect(view.offeredCommitment).toEqual({ assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST });
      // 摘要**不**在视图里（内容指纹不进对外契约）。
      expect(Object.keys(view)).not.toContain('offeredSha256');
      // 发起方也看得到（`getOffer` 的契约是「对手方 / 发起方可见」）。
      await expect(exchange.getOffer(seeded.offerId, seeded.proposer)).resolves.toMatchObject({
        offerId: seeded.offerId,
      });
      // 第三方看不到；不存在的 id 也看不到（**同一个**错误：不向非当事人泄露存在性）。
      const stranger = await makeUser();
      await expect(exchange.getOffer(seeded.offerId, stranger)).rejects.toBeInstanceOf(UnknownExchangeObjectError);
      await expect(
        exchange.getOffer('01920000-0000-7000-8000-0000000000ff', stranger),
      ).rejects.toBeInstanceOf(UnknownExchangeObjectError);
    });

    it('读取合约：两位当事人都看得到，第三方看不到', async () => {
      const seeded = await seedSent();
      const decision = await exchange.acceptOffer({
        offerId: seeded.offerId,
        actorId: seeded.counterparty,
        targetCommitment: { assetVersionId: seeded.offered.assetVersionId, dossierDigest: DIGEST },
      });
      const view = await exchange.getContract(decision.contractId, seeded.proposer);
      expect(view.contractId).toBe(decision.contractId);
      expect(view.status).toBe('PENDING_BOTH_LOCK');
      expect(view.targetCommitment).toEqual({
        assetVersionId: seeded.offered.assetVersionId,
        dossierDigest: DIGEST,
      });
      await expect(exchange.getContract(decision.contractId, seeded.counterparty)).resolves.toMatchObject({
        contractId: decision.contractId,
      });
      const stranger = await makeUser();
      await expect(exchange.getContract(decision.contractId, stranger)).rejects.toBeInstanceOf(
        UnknownExchangeObjectError,
      );
    });
  });
});
