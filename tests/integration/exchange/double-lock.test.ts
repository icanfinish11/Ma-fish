import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { uuidv7 } from '@vca/shared';
import { AssetLockedByContractError } from '@vca/api/modules/asset/index.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { ExchangeService } from '@vca/api/modules/exchange/exchange.service.js';
import { SwapContractService } from '@vca/api/modules/exchange/swap-contract.service.js';
import {
  ExpiredExchangeWindowError,
  IneligibleAssetError,
  InvalidExchangeTransitionError,
  UnknownExchangeObjectError,
} from '@vca/api/modules/exchange/core/errors.js';
import { rowLockOrder } from '@vca/api/common/db/lock-order.js';
import { createTestApp } from '../../helpers/app.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { waitForBlockedStatement, waitForBlockingCycle } from '../../helpers/db-lock.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';

/**
 * **双锁**与 `VALIDATING`（P3 / Task 7；§6.3:283-286 / D10 / C35 / C36）。
 *
 * ## 这一节判的是哪一层
 *
 * **服务层**（`SwapContractService`），经**真实 DI** 取到（`app.get(...)`）：
 * 「`AssetLockService` 真的被 provide 出来了、`SwapContractService` 真的被装配了」
 * 这件事由这一条路径见证（`asset-lock.test.ts` 直接 `new`，它不覆盖接线）。
 * 路由层的授权在 `tests/security/exchange/authz-matrix.test.ts` 里逐格判。
 *
 * ## 它**不**做什么（边界，写给下一个读它的人）
 *   * **不做所有权转移、不动钱** —— 那是 Task 8（§6.3:294 的命题本体，C31）；
 *   * **不写 `RELEASED`** —— 见下面第 1 条用例里的那一段「★ 据实记载」；
 *   * **不解锁** —— §6.3:290 的 `CANCELLED` 之后解锁是**增量 A-10**（Task 10）的活，
 *     而那也是 `unlockAssets` 的第一批生产调用方（A-10 逐字）；
 *   * **不发通知**（C15 的 outbox 是别的路径）。
 */
let app: INestApplication;
let redis: TestRedis;
let pg: TestPg;
let prisma: PrismaService;
let exchange: ExchangeService;
let swap: SwapContractService;

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
  swap = app.get(SwapContractService);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
  await redis?.stop();
});

const DIGEST = 'd'.repeat(64);
const DAY_MS = 24 * 3_600_000;

async function makeUser(): Promise<string> {
  return (await prisma.user.create({ data: {} })).id;
}

/**
 * 一件**合格**的作品（完整度 > 0 且 README 非空 —— §6.1 第 2 条的 D16 代理判据）。
 *
 * 版本与元数据**直接落库**：本文件不碰任何制品字节（`confirmLock` 也不碰），
 * 与 `offers.test.ts` 的文件头同一条据实说明。
 */
async function makeAsset(
  ownerId: string,
  overrides: { completeness?: number; readmeExcerpt?: string | null } = {},
): Promise<string> {
  const asset = await prisma.asset.create({ data: { ownerId } });
  const version = await prisma.assetVersion.create({
    data: {
      assetId: asset.id,
      sha256: `sha256-${asset.id}`,
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
      fileTree: [{ path: 'src/index.ts', bytes: 100 }],
      languages: [{ name: 'TypeScript', bytes: 100, ratio: 1 }],
      dependencies: [],
      completeness: overrides.completeness ?? 40,
      fileTreeTruncated: false,
      codeLines: 10,
    },
  });
  return asset.id;
}

/** 走**真实路径**造一份合约（propose + accept）：`partyA` = 被要约方，`partyB` = 发起方。 */
async function makeContractViaRealPath(): Promise<{
  contractId: string;
  partyA: string;
  partyB: string;
  assetA: string;
  assetB: string;
}> {
  const proposer = await makeUser();
  const counterparty = await makeUser();
  const offered = await makeAsset(proposer);
  const target = await makeAsset(counterparty);
  const offer = await exchange.proposeOffer({
    proposerId: proposer,
    offeredAssetId: offered,
    targetAssetId: target,
    offeredDossierDigest: DIGEST,
    claims: null,
  });
  const version = await prisma.assetVersion.findFirstOrThrow({ where: { assetId: offered } });
  const accepted = await exchange.acceptOffer({
    offerId: offer.offerId,
    actorId: counterparty,
    targetCommitment: { assetVersionId: version.id, dossierDigest: DIGEST },
  });
  return {
    contractId: accepted.contractId,
    partyA: counterparty,
    partyB: proposer,
    assetA: target,
    assetB: offered,
  };
}

/**
 * 直接落一行合约（边角用例用）。
 *
 * 为什么边角用例不走真实路径：它们要的是**某个特定状态**（窗口已过期、已经在 `VALIDATING`、
 * 已经 `RELEASED`），而真实路径今天到不了那些状态（`RELEASED` 是 Task 8 的）。
 * 走真实路径再改库会多一步、且把「造数据」与「判据」缠在一起。
 */
async function makeContractRow(input: {
  partyAId: string;
  partyBId: string;
  assetAId: string;
  assetBId: string;
  status?: string;
  lockedByAAt?: Date | null;
  lockedByBAt?: Date | null;
  lockDeadlineAt?: Date;
}): Promise<string> {
  const offer = await prisma.swapOffer.create({
    data: {
      proposerId: input.partyBId,
      counterpartyId: input.partyAId,
      offeredAssetId: input.assetBId,
      targetAssetId: input.assetAId,
      offeredDossierDigest: DIGEST,
      expiresAt: new Date(Date.now() + 3 * DAY_MS),
      // ★ **终态**：同一对 `(target, counterparty)` 上只允许一份**活跃**要约（Task 6 的
      //   部分唯一索引）。边角用例会在同一对作品上造第二份合约，而那个索引只覆盖
      //   `DRAFT` / `SENT` ⇒ 这里写成 `ACCEPTED`，既绕开它、也与真实语义一致
      //   （一份合约存在，正是因为它的要约被接受了）。
      status: 'ACCEPTED',
    },
    select: { id: true },
  });
  const contract = await prisma.swapContract.create({
    data: {
      offerId: offer.id,
      partyAId: input.partyAId,
      partyBId: input.partyBId,
      assetAId: input.assetAId,
      assetBId: input.assetBId,
      lockDeadlineAt: input.lockDeadlineAt ?? new Date(Date.now() + DAY_MS),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.lockedByAAt === undefined ? {} : { lockedByAAt: input.lockedByAAt }),
      ...(input.lockedByBAt === undefined ? {} : { lockedByBAt: input.lockedByBAt }),
    },
    select: { id: true },
  });
  return contract.id;
}

/** 一件作品的锁状态。 */
async function lockOf(assetId: string): Promise<{ lockedAt: Date | null; holderContractId: string | null }> {
  return (await prisma.asset.findUniqueOrThrow({
    where: { id: assetId },
    select: { lockedAt: true, holderContractId: true },
  })) as { lockedAt: Date | null; holderContractId: string | null };
}

/** 合约的一行（只取断言要读的那几列）。 */
async function contractRow(contractId: string): Promise<{
  status: string;
  lockedByAAt: Date | null;
  lockedByBAt: Date | null;
  cancelledAt: Date | null;
  releasedAt: Date | null;
}> {
  return prisma.swapContract.findUniqueOrThrow({
    where: { id: contractId },
    select: { status: true, lockedByAAt: true, lockedByBAt: true, cancelledAt: true, releasedAt: true },
  });
}

/** 某个合约上的审计行（动作名 → 条数）。 */
async function auditActions(contractId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { resource: 'SwapContract', resourceId: contractId },
    select: { action: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.action);
}

/** 把错误压成一行（断言失败时打出**实测形状**）。 */
function shapeOf(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  return `name=${String(e?.name)} code=${String(e?.code)} message=${String(e?.message).replace(/\s+/g, ' ').slice(0, 200)}`;
}

describe('双锁与 VALIDATING（§6.3:283-286 / Task 7）', () => {
  // ══════════════════════════════════════════════════════════════════════════
  // ① 双方确认 ⇒ 锁 + VALIDATING
  // ══════════════════════════════════════════════════════════════════════════

  it('★ 双方各自确认之后：两件作品的 `locked_at` + `holder_contract_id` 都非空，且合约进 `VALIDATING`（**不是** `RELEASED`）', async () => {
    const { contractId, partyA, partyB, assetA, assetB } = await makeContractViaRealPath();

    // ── 一方确认：**作品一件都没被锁**（拒绝面的对照，也是「一个人说了不算」的见证）。
    const first = await swap.confirmLock(contractId, partyA);
    expect(first, '一个人确认不该推进到 VALIDATING').toMatchObject({
      contractId,
      status: 'PENDING_BOTH_LOCK',
      bothLocked: false,
    });
    expect(await lockOf(assetA), '只有一方确认时作品不该被锁').toEqual({ lockedAt: null, holderContractId: null });
    expect(await lockOf(assetB)).toEqual({ lockedAt: null, holderContractId: null });
    // A 的那一侧时间戳**写下了**（它是「谁在什么时候按了确认」的记录）。
    expect((await contractRow(contractId)).lockedByAAt).toBeInstanceOf(Date);

    // ── 另一方确认：双方均锁定 ⇒ §6.3:284 的三个谓词 + 推进到 VALIDATING。
    const second = await swap.confirmLock(contractId, partyB);
    expect(second.bothLocked).toBe(true);
    expect(second.status).toBe('VALIDATING');
    for (const assetId of [assetA, assetB]) {
      const held = await lockOf(assetId);
      expect(held.lockedAt, `资产 ${assetId} 的 locked_at`).toBeInstanceOf(Date);
      expect(held.holderContractId, '锁定必须记下**谁锁的**（解锁与幂等重放的判据）').toBe(contractId);
    }
    const row = await contractRow(contractId);
    expect(row.status).toBe('VALIDATING');
    expect(row.releasedAt, '★ Task 7 **不写** `RELEASED`（见本用例末尾的据实记载）').toBeNull();
    // 审计：这一次推进落**恰好一行**（`accept` 那一刻也写过一行，因此按动作名筛）。
    expect(
      (await auditActions(contractId)).filter((action) => action === 'exchange.contract_both_locked'),
    ).toHaveLength(1);

    /**
     * ★ **据实记载：为什么不写 `RELEASED`（计划 Step 3 的接口注释写的是「通过 ⇒ RELEASED」）**
     *
     * Task 8 的 `release()` 逐字（`task-8-brief.md`）：
     * ```
     * if (contract.status === 'RELEASED' || 'SETTLED' || 'DISPUTED') {
     *   // 幂等重放：已经是（或已越过）RELEASED ⇒ 不再动任何一行。
     *   return { contractId, status: contract.status, transactionIds: [], releasedNow: false };
     * }
     * ```
     * ⇒ 若 Task 7 把状态写成 `RELEASED`，Task 8 的释放会走**幂等重放那一支**、
     * `releasedNow: false`、**所有权一次都不换** —— 一份「已释放」而所有权没动的合约，
     * 且没有任何断言会红。**两处只能有一处写下 `RELEASED`**，而写下它的那一处必须
     * 是**同一个事务里做完所有权 + 访问权 + 补差托管**的那一处（§6.3:294，Task 8）。
     * ⇒ Task 7 的落点是 `VALIDATING`，而「通过」这件事由 `validate()` 的判决**报出来**
     * （见下面第 7 条用例），不由状态表达。
     */
  }, 120_000);

  it('幂等重放：已经是 `VALIDATING` 之后再确认 ⇒ **不报错**、返回当前状态，且作品的锁与审计行数都不变', async () => {
    const { contractId, partyA, partyB, assetA } = await makeContractViaRealPath();
    await swap.confirmLock(contractId, partyA);
    await swap.confirmLock(contractId, partyB);
    const before = await lockOf(assetA);
    const auditsBefore = (await auditActions(contractId)).length;

    // 同一个人的第二/第三次确认（网络重试的形状）。
    for (const actor of [partyB, partyA, partyB]) {
      const replay = await swap.confirmLock(contractId, actor);
      expect(replay.status, `重放必须回**当前**状态而不是抛错。实测：${JSON.stringify(replay)}`).toBe('VALIDATING');
      expect(replay.bothLocked).toBe(true);
    }
    expect(await lockOf(assetA), '重放不该改写锁定时刻').toEqual(before);
    expect(await auditActions(contractId), '重放不该多写审计行').toHaveLength(auditsBefore);
  }, 120_000);

  it('24 小时窗口：**窗口内**确认成功（验收面）；`lockDeadlineAt` 已过 ⇒ ExpiredExchangeWindowError（拒绝面，**不是**「非法迁移」）', async () => {
    const [partyA, partyB] = [await makeUser(), await makeUser()];
    const assetA = await makeAsset(partyA);
    const assetB = await makeAsset(partyB);

    // ── 拒绝面：期限已过（闭边界：`now >= lockDeadlineAt`，见 `timers.ts`）。
    const expired = await makeContractRow({
      partyAId: partyA,
      partyBId: partyB,
      assetAId: assetA,
      assetBId: assetB,
      lockDeadlineAt: new Date(Date.now() - 1_000),
    });
    const error = await swap.confirmLock(expired, partyA).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, `超时是**另一个**因由。实测：${shapeOf(error)}`).toBeInstanceOf(ExpiredExchangeWindowError);
    expect(error, '超时**不是**一次「非法状态迁移」（两者在 HTTP 上是同一档 409，但责任方与处置不同）').not.toBeInstanceOf(
      InvalidExchangeTransitionError,
    );
    // 被拒之后那一行**什么都没变**（时间戳没有被写下）。
    expect(await contractRow(expired)).toMatchObject({ lockedByAAt: null, lockedByBAt: null });

    // ── 验收对照：**同一形状**、期限在将来 ⇒ 成功（否则上面那条可能只是「这句永远抛」）。
    const fresh = await makeContractRow({ partyAId: partyA, partyBId: partyB, assetAId: assetA, assetBId: assetB });
    await expect(swap.confirmLock(fresh, partyA)).resolves.toMatchObject({ status: 'PENDING_BOTH_LOCK' });
    expect((await contractRow(fresh)).lockedByAAt).toBeInstanceOf(Date);
  }, 120_000);

  it('非当事人 ⇒ UnknownExchangeObjectError（服务层**自足**判定）；不存在的 id ⇒ **同一个**错误（不泄露存在性）', async () => {
    const { contractId, partyA } = await makeContractViaRealPath();
    const stranger = await makeUser();
    const strangerError = await swap.confirmLock(contractId, stranger).then(
      () => null,
      (e: unknown) => e,
    );
    expect(strangerError, `实测：${shapeOf(strangerError)}`).toBeInstanceOf(UnknownExchangeObjectError);
    expect((strangerError as UnknownExchangeObjectError).kind).toBe('contract');

    const missingError = await swap.confirmLock(uuidv7(), partyA).then(
      () => null,
      (e: unknown) => e,
    );
    expect(missingError, `实测：${shapeOf(missingError)}`).toBeInstanceOf(UnknownExchangeObjectError);
    // 同一个错误类 ⇒ HTTP 上是同一个 404（两条因由在 D11 的读法里不可区分）。
    expect((missingError as UnknownExchangeObjectError).kind).toBe('contract');

    // 验收对照：**当事人**在同一个合约上不抛（否则上面两条可能只是「这个 id 谁都用不了」）。
    await expect(swap.confirmLock(contractId, partyA)).resolves.toMatchObject({ status: 'PENDING_BOTH_LOCK' });
  }, 120_000);

  it('资产锁冲突：作品已被**别的**合约锁着 ⇒ AssetLockedByContractError，且这**一次确认一条字段都没留下**（事务回滚）', async () => {
    const [ownerA, ownerB, otherA, otherB] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const assetA = await makeAsset(ownerA);
    const assetB = await makeAsset(ownerB);
    // 用**同一个** owner 造第二份合约的资产：`assetA` 被两份合约共用 ⇒ 争抢同一件作品。
    const otherContract = await makeContractRow({
      partyAId: otherA,
      partyBId: otherB,
      assetAId: assetA,
      assetBId: await makeAsset(otherB),
    });
    // 让 otherContract **先**把 `assetA` 锁上（双方确认）。
    await swap.confirmLock(otherContract, otherA);
    await swap.confirmLock(otherContract, otherB);
    expect((await lockOf(assetA)).holderContractId).toBe(otherContract);

    // 第二份合约：双方确认时才发现作品被抢 ⇒ 409 那一档。
    const contractId = await makeContractRow({ partyAId: ownerA, partyBId: ownerB, assetAId: assetA, assetBId: assetB });
    await swap.confirmLock(contractId, ownerA);
    const error = await swap.confirmLock(contractId, ownerB).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, `实测：${shapeOf(error)}`).toBeInstanceOf(AssetLockedByContractError);

    // **回滚的见证**：这一次确认（ownerB 的那一侧时间戳）**没有留下**，状态也没动 ——
    // 半份状态（时间戳写了、作品没锁上、合约却在 VALIDATING）是本设计要排除的形状。
    expect(await contractRow(contractId)).toMatchObject({
      status: 'PENDING_BOTH_LOCK',
      lockedByAAt: expect.any(Date),
      lockedByBAt: null,
    });
    expect(await auditActions(contractId), '失败的那一次不写审计').toEqual([]);
    // 作品仍然只属于**抢先**的那一份合约。
    expect((await lockOf(assetA)).holderContractId).toBe(otherContract);
  }, 120_000);

  // ══════════════════════════════════════════════════════════════════════════
  // ② 资格：不通过 ⇒ **停在** VALIDATING（D8 的边界）
  // ══════════════════════════════════════════════════════════════════════════

  it('★ 资格不通过 ⇒ 合约**停在** `VALIDATING`（不是回滚、**不是**自动 `CANCELLED`）并抛出 IneligibleAssetError', async () => {
    const { contractId, partyA, partyB, assetA, assetB } = await makeContractViaRealPath();
    await swap.confirmLock(contractId, partyA);

    // 让**被拿出**的那件作品失去资格（完整度 → 0）。这正是「作者在对方确认之后
    // 换了内容」那一类事实在库里的样子 —— 平台不判质量，它只读事实（D7/D16）。
    const version = await prisma.assetVersion.findFirstOrThrow({ where: { assetId: assetB } });
    await prisma.assetMetadata.update({ where: { assetVersionId: version.id }, data: { completeness: 0 } });

    const error = await swap.confirmLock(contractId, partyB).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, `实测：${shapeOf(error)}`).toBeInstanceOf(IneligibleAssetError);
    expect((error as IneligibleAssetError).assetId).toBe(assetB);

    // ★ 三件事**同时**成立：状态是 VALIDATING（提交了）、两件作品**锁着**、合约**没有**被取消。
    const row = await contractRow(contractId);
    expect(row.status, '资格不通过时合约停在 VALIDATING 等人修（D8：不自动取消）').toBe('VALIDATING');
    expect(row.cancelledAt).toBeNull();
    expect(await lockOf(assetA)).toMatchObject({ holderContractId: contractId });
    expect(await lockOf(assetB)).toMatchObject({ holderContractId: contractId });

    // 验收对照：把事实修回来（完整度 → 40）⇒ `validate` 的判决**当场**翻转，
    // 而状态**一个字节都没变**（判决是读出来的，不是写出来的）。
    await prisma.assetMetadata.update({ where: { assetVersionId: version.id }, data: { completeness: 40 } });
    await expect(swap.validate(contractId)).resolves.toEqual({ status: 'VALIDATING', eligible: true });
  }, 120_000);

  it('`validate()`：合格 ⇒ `{VALIDATING, true}`；不合格 ⇒ `{VALIDATING, false}` 且**不**改状态（两条方向）', async () => {
    const { contractId, partyA, partyB, assetB } = await makeContractViaRealPath();
    await swap.confirmLock(contractId, partyA);
    await swap.confirmLock(contractId, partyB);

    await expect(swap.validate(contractId)).resolves.toEqual({ status: 'VALIDATING', eligible: true });

    const version = await prisma.assetVersion.findFirstOrThrow({ where: { assetId: assetB } });
    await prisma.assetMetadata.update({ where: { assetVersionId: version.id }, data: { readmeExcerpt: '   ' } });
    await expect(swap.validate(contractId), '空白 README 与没有 README 是同一件事').resolves.toEqual({
      status: 'VALIDATING',
      eligible: false,
    });
    expect((await contractRow(contractId)).status, '`validate` 是**读**：判决再坏也不写状态').toBe('VALIDATING');
    expect((await contractRow(contractId)).cancelledAt).toBeNull();
    // 不存在的合约 ⇒ 404 那一档（同一个自足判定）。
    await expect(swap.validate(uuidv7())).rejects.toBeInstanceOf(UnknownExchangeObjectError);
  }, 120_000);

  // ══════════════════════════════════════════════════════════════════════════
  // ③ 撤销（§6.3:290 / D8）
  // ══════════════════════════════════════════════════════════════════════════

  it('★ 撤销：`PENDING_BOTH_LOCK` 与 `VALIDATING` 两个阶段各一条路 ⇒ `CANCELLED` + `cancelledAt`；第二次撤销 ⇒ 409；`RELEASED` 之后 ⇒ 409（D8）', async () => {
    // ── 阶段一：`PENDING_BOTH_LOCK`（还没人确认）时退出。
    const [partyA1, partyB1] = [await makeUser(), await makeUser()];
    const early = await makeContractRow({
      partyAId: partyA1,
      partyBId: partyB1,
      assetAId: await makeAsset(partyA1),
      assetBId: await makeAsset(partyB1),
    });
    await swap.cancel(early, partyB1, 'NOT_INTERESTED');
    const earlyRow = await contractRow(early);
    expect(earlyRow.status).toBe('CANCELLED');
    expect(earlyRow.cancelledAt).toBeInstanceOf(Date);
    expect(await auditActions(early)).toEqual(['exchange.contract_cancelled']);
    // 第二次撤销：终态没有出边 ⇒ 409 那一档（不是静默成功）。
    const again = await swap.cancel(early, partyA1, 'OTHER').then(
      () => null,
      (e: unknown) => e,
    );
    expect(again, `实测：${shapeOf(again)}`).toBeInstanceOf(InvalidExchangeTransitionError);

    // ── 阶段二：`VALIDATING`（双方都确认了、作品也锁上了）时退出。
    const { contractId, partyA, partyB, assetA, assetB } = await makeContractViaRealPath();
    await swap.confirmLock(contractId, partyA);
    await swap.confirmLock(contractId, partyB);
    expect((await contractRow(contractId)).status).toBe('VALIDATING');
    await swap.cancel(contractId, partyA, 'TERMS_UNACCEPTABLE');
    expect(await contractRow(contractId)).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(Date) });
    // ★ **据实记载 A-10 的边界**：撤销**不解锁**作品 —— 「两个终态解锁」是增量 A-10
    //   （Task 10）的交付物，A-10 逐字写着 `unlockAssets` 的「第一批生产调用方」在它那里。
    //   这一条断言把那条边界钉住：谁在 Task 7 里顺手加上解锁，它会红。
    expect(await lockOf(assetA), 'A-10 之前，撤销**不**解锁').toMatchObject({ holderContractId: contractId });
    expect(await lockOf(assetB)).toMatchObject({ holderContractId: contractId });

    // ── `RELEASED` 之后没有退出路径（§6.3 的箭头只画在 RELEASED 之前 / D8）。
    const released = await makeContractRow({
      partyAId: await makeUser(),
      partyBId: await makeUser(),
      assetAId: await makeAsset(await makeUser()),
      assetBId: await makeAsset(await makeUser()),
      status: 'RELEASED',
    });
    const tooLate = await swap.cancel(released, (await prisma.swapContract.findUniqueOrThrow({ where: { id: released } })).partyAId, 'OTHER').then(
      () => null,
      (e: unknown) => e,
    );
    expect(tooLate, `实测：${shapeOf(tooLate)}`).toBeInstanceOf(InvalidExchangeTransitionError);

    // ── 非当事人 ⇒ 404 那一档（与 `confirmLock` 同一条自足判定）。
    const stranger = await makeUser();
    await expect(swap.cancel(contractId, stranger, 'OTHER')).rejects.toBeInstanceOf(UnknownExchangeObjectError);
    // 验收对照：被撤销的那一份合约**仍然**是 CANCELLED（上面那次非当事人调用没有改动任何东西）。
    expect((await contractRow(contractId)).status).toBe('CANCELLED');
  }, 120_000);

  // ══════════════════════════════════════════════════════════════════════════
  // ④ 死锁：Task 7 是 `retryable-conflict.ts` 的第一个正当消费者
  // ══════════════════════════════════════════════════════════════════════════

  it('★ 真死锁（`$queryRaw` ⇒ **P2010**/40P01）在服务层被消化：同一构造下 `confirmLock` 必须**成功**，而不是把死锁抛给调用方', async () => {
    // ## 构造（确定性：靠**观察**服务端而不是靠 sleep 猜，与 Task 4 的 `deadlockThenRetry` 同形）
    // ```
    // 竞争者（一条裸 pg 连接）: BEGIN; SELECT y FOR UPDATE;          ← 先持有**大的**那个 id
    // 受害者（confirmLock，partyA 已确认）: 写合约行 → 锁 x（成功）→ 锁 y（卡住）
    // 观察者: `pg_blocking_pids` 里**两条连接互相阻塞**              ← 环真的形成了
    // 竞争者: UPDATE exchange.swap_contracts SET status='PENDING_BOTH_LOCK' WHERE id = c
    //        ← 合约行被受害者持有 ⇒ 环闭合
    // ```
    // 受害者（先开始等的那一个）先到 `deadlock_timeout` ⇒ 被 PostgreSQL 中止（`40P01`）⇒
    // 竞争者拿到合约行、回滚、释放 ⇒ **服务层的重试**那一次一路上到提交。
    //
    // ## ★★ 据实记载：重试在**服务内部**，因此本用例的判据是**行为**的（本轮实测修正）
    //
    // 第一版把 `confirmLock` 包在测试自己的 `withBoundedConflictRetry` 里，期望从外面
    // 观测到「第一次 P2010、第二次成功」。**实测（`evidence/t7-deadlock-diag-prisma.txt`）**：
    // 环确实形成了（`pg_blocking_pids` 双向）、竞争者确实被堵了 ~918 ms、受害者确实被中止了，
    // 而**测试那一层什么都看不到** —— 因为 `withBoundedConflictRetry` 在 `confirmLock`
    // **里面**（包住整个事务，见该方法的注释），它已经把那一档消化掉了：
    // 测试的 `attempts` 停在 1、`retries` 是 0、promise **成功**。
    // ⇒ 这个位置是**对的**（重试必须包住事务本身，而不是包在调用点：死锁中止的是事务），
    //   而判据也必须跟着搬：本用例断言的是**调用方看得见的性质** ——
    //   「一次真死锁不会以 P2010 冒到调用方头上，且最终状态是对的」。
    //   重试**存在**这件事由变异探针证明：`P-T7-no-retry`（删掉那个包装）与
    //   `P-T7-disc-p2034`（把判别式窄成只认 P2034）都会让**这一条**红。
    //
    // ## 两档里为什么这里是 P2010
    // 受害者卡住的那一句是 `$queryRaw` 的 `SELECT … FOR UPDATE`（预检 §0.4 实测：
    // 经 `$queryRaw` ⇒ P2010；经 Prisma 委托 ⇒ P2034）。**据实记载**：Task 7 的路径
    // **只**产出这一档 —— 取锁顺序是「合约行（委托）→ 作品行（raw）」，而受害者
    // 阻塞在 `updateMany` **之后**，因此卡住的永远是 raw 那一句。
    // 第二档（P2034）的见证在 `tests/integration/ledger/account-lock-order.test.ts`，
    // 而探针 `P-T7-disc-p2010`（把判别式窄成只认 P2010）会打红**那一条** ——
    // 也就是「两档都要认」不是一句空话。
    const [partyA, partyB] = [await makeUser(), await makeUser()];
    const assetA = await makeAsset(partyA);
    const assetB = await makeAsset(partyB);
    const contractId = await makeContractRow({
      partyAId: partyA,
      partyBId: partyB,
      assetAId: assetA,
      assetBId: assetB,
      lockedByAAt: new Date(), // 只剩 partyB 那一次确认把它推下去
    });
    const x = rowLockOrder([assetA, assetB])[0]!;
    const y = rowLockOrder([assetA, assetB])[1]!;
    expect(x, '两件作品是两个不同的 id（否则这一条什么都没测）').not.toBe(y);

    const rival = new Client({ connectionString: pg.appUri });
    await rival.connect();
    let released = false;
    const releaseRival = async (): Promise<void> => {
      if (released) return;
      released = true;
      await rival.end().catch(() => undefined);
    };
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT id FROM asset.assets WHERE id = $1::uuid FOR UPDATE', [y]);

      // 受害者：**真实的 `confirmLock`**（它自己带重试；本用例不包第二层）。
      const victim = swap.confirmLock(contractId, partyB).then(
        (v) => ({ ok: true as const, value: v }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const observer = new Client({ connectionString: pg.appUri });
      await observer.connect();
      let blocked: string;
      try {
        blocked = await waitForBlockedStatement(observer, /FROM\s+"?asset"?\."?assets"?[\s\S]*FOR UPDATE/);
      } finally {
        await observer.end();
      }
      expect(blocked, `受害者必须卡在**取作品行锁**那一句上（那是 P2010 那一档）。实测：${blocked}`).toMatch(
        /FOR UPDATE/,
      );

      // ★ 构造见证：竞争者去要合约行之前，先让**环**在服务端看得见（`pg_blocking_pids` 双向）。
      const rivalUpdate = rival.query(
        `UPDATE exchange.swap_contracts SET status = 'PENDING_BOTH_LOCK' WHERE id = $1`,
        [contractId],
      );
      const cycleObserver = new Client({ connectionString: pg.appUri });
      await cycleObserver.connect();
      let cycle: { pids: readonly [number, number]; queries: readonly [string, string] };
      try {
        cycle = await waitForBlockingCycle(
          cycleObserver,
          /FROM\s+"?asset"?\."?assets"?[\s\S]*FOR UPDATE/,
          /UPDATE exchange\.swap_contracts/,
        );
      } finally {
        await cycleObserver.end();
      }
      expect(
        cycle.queries[0],
        `环里的一条必须是**取作品行锁**那一句（它决定错误是哪一档）。实测：${JSON.stringify(cycle)}`,
      ).toMatch(/FROM\s+"?asset"?\."?assets"?[\s\S]*FOR UPDATE/);
      expect(cycle.queries[1], `环里的另一条必须是竞争者的合约行 UPDATE。实测：${JSON.stringify(cycle)}`).toMatch(
        /UPDATE exchange\.swap_contracts/,
      );

      // 竞争者最终拿得到合约行（**前提**：被中止的是受害者那一侧，否则这一句会抛，
      // 而那说明时序前提不成立 —— 响亮地抛，绝不据此判任何事）。
      await rivalUpdate.catch((error: unknown) => {
        throw new Error(
          `构造失败：竞争者自己成了死锁牺牲者（${shapeOf(error)}）—— 时序前提不成立，这一轮不能据此判任何事`,
        );
      });
      await rival.query('ROLLBACK');
      await releaseRival();

      const settled = await victim;
      expect(
        settled.ok,
        '★ 一次真死锁**不该冒到调用方头上**：服务层的重试要把它消化掉（探针 P-T7-no-retry / P-T7-disc-p2034 让这一条红）。' +
          `实测：${shapeOf(settled.ok ? null : settled.error)}`,
      ).toBe(true);
      if (settled.ok) {
        expect(settled.value).toMatchObject({ contractId, status: 'VALIDATING', bothLocked: true });
      }

      // 收敛之后**真的**走完了整条路径（不是「重试一次什么也没做」）。
      expect(await contractRow(contractId)).toMatchObject({ status: 'VALIDATING', lockedByBAt: expect.any(Date) });
      expect(await lockOf(x)).toMatchObject({ holderContractId: contractId });
      expect(await lockOf(y)).toMatchObject({ holderContractId: contractId });
      // 审计**恰好一行**：被中止的那一次什么都没留下（重试不是「又做了一遍」）。
      expect(
        (await auditActions(contractId)).filter((action) => action === 'exchange.contract_both_locked'),
      ).toHaveLength(1);
    } finally {
      await releaseRival();
    }
  }, 120_000);
});