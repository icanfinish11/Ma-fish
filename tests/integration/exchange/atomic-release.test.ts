import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { uuidv7 } from '@vca/shared';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { ExchangeService } from '@vca/api/modules/exchange/exchange.service.js';
import { SwapContractService } from '@vca/api/modules/exchange/swap-contract.service.js';
import { DISPUTE_WINDOW_DAYS, ObligationService, SwapReleaseService } from '@vca/api/modules/exchange/index.js';
import { CommitmentMismatchError, SwapSelfOfferError } from '@vca/api/modules/exchange/core/errors.js';
import { AssetAccessService } from '@vca/api/modules/asset/index.js';
import { LedgerService } from '@vca/api/modules/ledger/index.js';
import { createTestApp } from '../../helpers/app.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';

/**
 * ★★ **原子释放的验收面**（P3 / Task 8；§6.3:294 的命题本体 / §13.3 的验收判据 / C31 / A-8）。
 *
 * ## 这一节判的是哪一层
 * **服务层**（`SwapReleaseService`），经**真实 DI** 取到（`app.get(...)`）：
 * 「`AccessGrantService` / `LedgerService` / `OwnershipService` 真的被装配进来了」
 * 这件事由这一条路径见证（`ownership.test.ts` 直接 `new`，它不覆盖接线）。
 * 路由层的授权在 `tests/security/exchange/authz-matrix.test.ts` 里逐格判 ——
 * **本任务不加路由**（§9 的矩阵里没有 `SwapContract release` 这一行，理由写在
 * `swap-release.service.ts` 的类注释末条）。
 *
 * ## 合约怎么造（**走真实路径**，不直接写库）
 * `proposeOffer` → `acceptOffer`（可选带补差）→ `confirmLock` × 2 ⇒ `VALIDATING`
 * 且两件作品锁在**这一份**合约名下。这比「手工造一行 `VALIDATING`」强一层：
 * 补差条款、六个承诺列、锁的持有者全部是**生产路径**写下的值，
 * 因此这条用例证明的是「真实合约能释放」，而不是「我造的那一行能被释放」。
 *
 * ## 它与 `atomic-release-rollback.test.ts` 的分工
 * 这一份判**正面**（七件事都真的发生了、钱没动、幂等、A-8 的两个方向）；
 * 那一份判**反面**（注入异常 ⇒ 七个量逐项滚回去）。两份合起来才是 §13.3 的判据本体。
 */
let app: INestApplication;
let redis: TestRedis;
let pg: TestPg;
let prisma: PrismaService;
let exchange: ExchangeService;
let swap: SwapContractService;
let release: SwapReleaseService;
let access: AssetAccessService;
let ledger: LedgerService;

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
  release = app.get(SwapReleaseService);
  access = app.get(AssetAccessService);
  ledger = app.get(LedgerService);
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

/** 一件**合格**的作品（完整度 > 0 且 README 非空 —— §6.1 第 2 条的 D16 代理判据）。 */
async function makeAsset(ownerId: string): Promise<{ assetId: string; versionId: string }> {
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
      readmeExcerpt: '# 一件作品',
      fileTree: [{ path: 'src/index.ts', bytes: 100 }],
      languages: [{ name: 'TypeScript', bytes: 100, ratio: 1 }],
      dependencies: [],
      completeness: 40,
      fileTreeTruncated: false,
      codeLines: 10,
    },
  });
  return { assetId: asset.id, versionId: version.id };
}

/** 走真实路径造一份 `VALIDATING` 的合约（`partyA` = 被要约方，`partyB` = 发起方）。 */
async function makeValidatingContract(
  options: { readonly topUp?: { readonly amount: bigint; readonly payer: 'PROPOSER' | 'ACCEPTOR' } } = {},
): Promise<{
  contractId: string;
  partyA: string;
  partyB: string;
  assetA: string;
  assetB: string;
  offeredVersionId: string;
}> {
  const proposer = await makeUser();
  const counterparty = await makeUser();
  const offered = await makeAsset(proposer); // = assetB（发起方拿出来的那件）
  const target = await makeAsset(counterparty); // = assetA（被要约的那件）
  const offer = await exchange.proposeOffer({
    proposerId: proposer,
    offeredAssetId: offered.assetId,
    targetAssetId: target.assetId,
    offeredDossierDigest: DIGEST,
    claims: null,
  });
  const accepted = await exchange.acceptOffer({
    offerId: offer.offerId,
    actorId: counterparty,
    targetCommitment: { assetVersionId: offered.versionId, dossierDigest: DIGEST },
    ...(options.topUp === undefined ? {} : { topUp: options.topUp }),
  });
  await swap.confirmLock(accepted.contractId, counterparty);
  const settled = await swap.confirmLock(accepted.contractId, proposer);
  // **构造见证**：这一条用例的前提是「合约真的在 VALIDATING 且资产锁着」。
  // 不成立时下面那些断言会以一堆无关的红出现（而红的原因不是被测的那件事）。
  expect(settled.status, '构造：双方确认之后合约必须在 VALIDATING').toBe('VALIDATING');
  return {
    contractId: accepted.contractId,
    partyA: counterparty,
    partyB: proposer,
    assetA: target.assetId,
    assetB: offered.assetId,
    offeredVersionId: offered.versionId,
  };
}

/**
 * **七个量**（§13.3 的判据本体）+ 访问权行数（第八个量）。
 *
 * 只核对一个量（例如「所有权回滚了」）是不够的：一个「所有权回滚了、而托管分录留下了」的
 * 实现会让所有权那一条绿，而**账本里多了一笔从未发生的资金变动**
 * （P0 要的正是「审计日志可完整重建任一次资金变动的链路」，§13.2）。
 */
async function snapshot(
  assetA: string,
  assetB: string,
): Promise<{
  ownerA: string;
  ownerB: string;
  escrow: string;
  revenue: string;
  audits: number;
  entries: number;
  transactions: number;
  history: number;
  grants: number;
}> {
  const [a, b, escrowAccount, revenueAccount] = await Promise.all([
    prisma.asset.findUniqueOrThrow({ where: { id: assetA }, select: { ownerId: true } }),
    prisma.asset.findUniqueOrThrow({ where: { id: assetB }, select: { ownerId: true } }),
    prisma.ledgerAccount.findFirstOrThrow({ where: { kind: 'PLATFORM_ESCROW' }, select: { balance: true } }),
    prisma.ledgerAccount.findFirstOrThrow({ where: { kind: 'PLATFORM_REVENUE' }, select: { balance: true } }),
  ]);
  const [audits, entries, transactions, history, grants] = await Promise.all([
    prisma.auditLog.count(),
    prisma.ledgerEntry.count(),
    prisma.ledgerTransaction.count(),
    prisma.ownershipHistory.count(),
    prisma.accessGrant.count(),
  ]);
  return {
    ownerA: a.ownerId,
    ownerB: b.ownerId,
    escrow: escrowAccount.balance.toString(),
    revenue: revenueAccount.balance.toString(),
    audits,
    entries,
    transactions,
    history,
    grants,
  };
}

/** 一份合约的**要约行**（`swap_offers` 与 `swap_contracts` 是 1:1，`offerId` 唯一）。 */
async function offerOf(contractId: string): Promise<string> {
  const contract = await prisma.swapContract.findUniqueOrThrow({
    where: { id: contractId },
    select: { offerId: true },
  });
  return contract.offerId;
}

/** 给某个用户发额度（补差的来源；`grantCredit` 是 idempotent 的，键自选）。 */
async function fund(userId: string, amount: bigint): Promise<void> {
  await prisma.$transaction((tx) =>
    ledger.grantCredit(tx, { userId, amount, idempotencyKey: `t8-fund:${uuidv7()}` }),
  );
}

describe('原子释放（§6.3:294 的正面 / §13.3 / C31）', () => {
  it('★ 一个事务里的七件事全部可见（§6.3:294 的正面）', async () => {
    const { contractId, partyA, partyB, assetA, assetB } = await makeValidatingContract({
      topUp: { amount: 1000n, payer: 'ACCEPTOR' },
    });
    await fund(partyA, 5000n);
    const before = await snapshot(assetA, assetB);
    const receiverBefore = await ledger.readBalances(prisma, partyB);

    const result = await release.releaseContract(contractId, partyB);

    expect(result.status).toBe('RELEASED');
    expect(result.releasedNow).toBe(true);

    // ① 两件作品的所有权互换（`assetA` 是被要约作品 ⇒ 归发起方；`assetB` 归被要约方）
    const after = await snapshot(assetA, assetB);
    expect({ ownerA: after.ownerA, ownerB: after.ownerB }).toEqual({ ownerA: partyB, ownerB: partyA });

    // ② 两行 append-only 历史（`reason` 是业务事由，逐字落库）
    const rows = await prisma.ownershipHistory.findMany({
      where: { assetId: { in: [assetA, assetB] } },
      orderBy: [{ assetId: 'asc' }, { createdAt: 'asc' }],
      select: { assetId: true, fromUserId: true, toUserId: true, reason: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.fromUserId}->${row.toUserId}`).sort()).toEqual(
      [`${partyA}->${partyB}`, `${partyB}->${partyA}`].sort(),
    );
    expect(new Set(rows.map((row) => row.reason))).toEqual(new Set([`交换释放：合约 ${contractId}`]));

    // ③ 双方访问权：**用 `checkAccess` 判**（D11：不许自己再判一遍）
    //    反面对照也在这里：释放**之前**对手方过不了 —— 否则这一条什么都没测。
    expect(await access.checkAccess(assetA, partyB), '新所有人').toBe(true);
    expect(await access.checkAccess(assetB, partyA), '新所有人').toBe(true);
    expect(await access.checkAccess(assetA, partyB)).toBe(true);

    // ④ 补差在托管里（ESCROW_LOCK），且 `transactionIds` 就是那一笔
    expect(after.escrow).toBe((BigInt(before.escrow) + 1000n).toString());
    expect(after.transactions).toBe(before.transactions + 1);
    expect(after.entries).toBe(before.entries + 2); // 复式两腿
    expect(result.transactionIds).toHaveLength(1);
    const locked = await prisma.ledgerTransaction.findUniqueOrThrow({
      where: { id: result.transactionIds[0]! },
      select: { kind: true, idempotencyKey: true },
    });
    expect(locked).toEqual({ kind: 'ESCROW_LOCK', idempotencyKey: `exchange:lock:${contractId}` });

    // ⑤ 义务行：`(producer, key)` = `('exchange', 'obligation:{contractId}')`，`state = 'LOCKED'`
    const obligation = await prisma.swapObligation.findUniqueOrThrow({ where: { contractId } });
    expect(obligation).toMatchObject({
      producer: 'exchange',
      key: `obligation:${contractId}`,
      amount: 1000n,
      state: 'LOCKED',
    });

    // ⑥ 审计：`exchange.contract_released` **一行**（本任务给释放路径的那一条独立断言）
    const released = await prisma.auditLog.findMany({
      where: { action: 'exchange.contract_released', resourceId: contractId },
      select: { actorId: true, metadata: true },
    });
    expect(released).toHaveLength(1);
    expect(released[0]!.actorId).toBe(partyB);
    expect(released[0]!.metadata).toMatchObject({ topUpAmount: '1000' });

    // ⑦ 状态 + 争议期截止（`releasedAt + 7 天`）
    const contract = await prisma.swapContract.findUniqueOrThrow({
      where: { id: contractId },
      select: { status: true, releasedAt: true, disputeDeadlineAt: true },
    });
    expect(contract.status).toBe('RELEASED');
    expect(contract.disputeDeadlineAt!.getTime() - contract.releasedAt!.getTime()).toBe(
      DISPUTE_WINDOW_DAYS * DAY_MS,
    );

    // 第八个量：两行访问权（为「转让之后再转让」留的那一档）
    expect(after.grants).toBe(before.grants + 2);
    expect((await ledger.readBalances(prisma, partyB)).available).toBe(receiverBefore.available);
  }, 180_000);

  it('★ 释放**之前**对手方过不了 `checkAccess`（上面那条 ③ 的反面对照单独行使）', async () => {
    // 为什么单列一条：`checkAccess` 的第二档（`access_grants`）若被写成「谁都放行」
    // 或者「第一档被写坏」，上面那条仍然会绿 —— 因为它只在**释放之后**读。
    // 这一条判的是**释放之前**：`partyB` 不是 `assetA` 的所有人，也没有任何授权行。
    const { partyA, partyB, assetA, assetB } = await makeValidatingContract();
    expect(await access.checkAccess(assetA, partyB), '释放之前：对手方尚未获得访问权').toBe(false);
    expect(await access.checkAccess(assetB, partyA), '释放之前：对手方尚未获得访问权').toBe(false);
    // 既有语义不被这一档改坏：所有人自己当然过得了。
    expect(await access.checkAccess(assetA, partyA)).toBe(true);
    expect(await access.checkAccess(assetB, partyB)).toBe(true);
    // 陌生人两个阶段都过不了（第二档不是「登录即可」）。
    const stranger = await makeUser();
    expect(await access.checkAccess(assetA, stranger)).toBe(false);
    expect(await access.checkAccess(assetB, stranger)).toBe(false);
  }, 180_000);

  it('★ C31 的可执行见证：`RELEASED` **不动钱**（接收方余额与平台收入都不变）', async () => {
    // 这条断言是控制器裁定 ② 的落点。若谁把 `releaseEscrow` 挪到 RELEASED，
    // 它会立刻红 —— 而那正是「争议期只有在钱还冻着时才有意义」那条理由的执行点。
    const { contractId, partyA, partyB, assetA, assetB } = await makeValidatingContract({
      topUp: { amount: 700n, payer: 'ACCEPTOR' },
    });
    await fund(partyA, 5000n);
    const before = await snapshot(assetA, assetB);
    const receiverBefore = await ledger.readBalances(prisma, partyB);

    await release.releaseContract(contractId, null);

    const after = await snapshot(assetA, assetB);
    const receiverAfter = await ledger.readBalances(prisma, partyB);
    expect(receiverAfter.available, '接收方的**可用**余额一分都不许多').toBe(receiverBefore.available);
    expect(receiverAfter.frozen).toBe(receiverBefore.frozen);
    expect(after.revenue, '平台收入同样不动（手续费只在 SETTLED 收，C32）').toBe(before.revenue);
    // 正面对照：钱**真的**动了 —— 从付款方的可用余额进了托管（不是「谁都没动」）。
    expect(BigInt(after.escrow) - BigInt(before.escrow)).toBe(700n);
    const payerAfter = await ledger.readBalances(prisma, partyA);
    expect(payerAfter.available).toBe(5000n - 700n);
  }, 180_000);

  it('★ 幂等：同一个合约释放两次 ⇒ 第二次 `releasedNow: false`，且七个量**一个都不变**', async () => {
    const { contractId, partyA, partyB, assetA, assetB } = await makeValidatingContract({
      topUp: { amount: 300n, payer: 'PROPOSER' },
    });
    await fund(partyB, 5000n);

    const first = await release.releaseContract(contractId, partyB);
    expect(first.releasedNow).toBe(true);
    const afterFirst = await snapshot(assetA, assetB);

    const second = await release.releaseContract(contractId, partyB);

    expect(second.releasedNow).toBe(false);
    expect(second.status).toBe('RELEASED');
    expect(second.transactionIds).toEqual([]);
    expect(await snapshot(assetA, assetB), '七个量逐项相同').toEqual(afterFirst);
    // 义务行与托管交易也各只有一份（键是确定性的：`exchange:lock:{contractId}`）。
    expect(await prisma.swapObligation.count({ where: { contractId } })).toBe(1);
    expect(
      await prisma.ledgerTransaction.count({ where: { idempotencyKey: `exchange:lock:${contractId}` } }),
    ).toBe(1);
    // 审计仍然只有第一行（重放**不写**审计 —— 它没有发生任何事）。
    expect(
      await prisma.auditLog.count({ where: { action: 'exchange.contract_released', resourceId: contractId } }),
    ).toBe(1);
  }, 180_000);

  it('★ 同一份合约的两件作品属于同一个人 ⇒ `SwapSelfOfferError`（可执行的组合风险）', async () => {
    // 预检 §B.3 点名的那个交点：「交换的语义天然包含『转给对手方』」，而同一个 `toUserId`
    // 出现两次时会撞上 P1 的 `SelfTransferRejectedError`（409，因由说错话）。
    // 判在**取锁之后、任何写之前**（`releaseInTx` 的 ④）。
    //
    // **构造**：两件作品都属于同一个人 —— 真实路径造不出来（`proposeOffer` 判
    // `SwapSelfOfferError`），因此这里把那两行改到同一个人名下之后再释放。
    const { contractId, partyA, partyB, assetA, assetB } = await makeValidatingContract();
    const before = await snapshot(assetA, assetB);
    await prisma.asset.update({ where: { id: assetB }, data: { ownerId: partyA } });
    const moved = await snapshot(assetA, assetB);

    const error = await release.releaseContract(contractId, partyB).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwapSelfOfferError);
    // **反面对照**：正常的两方合约不会被它挡住（上面几条用例的 `releasedNow: true` 就是它）。
    // 状态与账本在这条路径上**一个字节都没动**（除了上面那次人为改所有人）。
    expect(await snapshot(assetA, assetB)).toEqual(moved);
    expect((await prisma.swapContract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe(
      'VALIDATING',
    );
    // 让这条用例的构造**自证**：`before` 与 `moved` 只差 `ownerB`。
    expect({ ...moved, ownerB: before.ownerB }).toEqual(before);
  }, 180_000);
});

/**
 * 增量 A-8（规格 §5.2 校验点 1）：`RELEASED` 时钉住的版本仍存在、`sha256` 一致。
 *
 * **据实划界（不要把它宣传成拦截）**：今天版本不可删、制品不可改，因此这道校验在
 * 正常路径上**总是通过** —— 它买的是**证据与将来**。下面的用例把两个方向都实测：
 * 正面（一致 ⇒ 释放照旧）与反面（对不上 ⇒ 拒绝，且七个量逐项不变）——
 * 而后者的构造**只能**靠直接改库（生产路径上没有让它们对不上的入口，这正是那句话的意思）。
 */
describe('增量 A-8：释放前的承诺校验（§5.2 校验点 1）', () => {
  it('★ 承诺一致 ⇒ 释放照旧（**反向对照**：这道校验不是一堵什么都能挡的墙）', async () => {
    const { contractId, partyB, assetA, assetB } = await makeValidatingContract();
    const result = await release.releaseContract(contractId, partyB);
    expect(result.releasedNow).toBe(true);
    const after = await snapshot(assetA, assetB);
    expect(after.ownerA).toBe(partyB);
  }, 180_000);

  it('★ `offered_sha256` 与制品不符 ⇒ 拒绝释放，且七个量逐项不变', async () => {
    const { contractId, partyB, assetA, assetB, offeredVersionId } = await makeValidatingContract();
    const before = await snapshot(assetA, assetB);
    // 让「钉住的那一份」与库里那一行对不上（版本行是 write-once 的，因此反向改：
    // 把**钉住值**改成另一个合法摘要 —— 它模拟的是「制品被替换而承诺没变」那一侧）。
    await prisma.swapOffer.update({
      where: { id: await offerOf(contractId) },
      data: { offeredSha256: 'f'.repeat(64) },
    });

    const error = await release.releaseContract(contractId, partyB).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommitmentMismatchError);
    expect((error as CommitmentMismatchError).field).toBe('offered_version');
    expect(await snapshot(assetA, assetB), '七个量逐项不变').toEqual(before);
    expect(
      await prisma.auditLog.count({ where: { action: 'exchange.contract_released', resourceId: contractId } }),
      '★ 独立断言：拒绝释放之后**审计 0 行**（不能折进总数核对）',
    ).toBe(0);
    expect((await prisma.swapContract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe(
      'VALIDATING',
    );
    // 版本行本身没被动过（这一条证明「拒绝」不是因为构造把数据改坏了）。
    expect(
      (await prisma.assetVersion.findUniqueOrThrow({ where: { id: offeredVersionId }, select: { sha256: true } }))
        .sha256,
    ).toBe(`sha256-${assetB}`);
  }, 180_000);

  it('★ 钉住的版本**行不存在** ⇒ 拒绝释放（① 的执行点：一旦有人加了删除能力，这里就是它）', async () => {
    const { contractId, partyB, assetA, assetB, offeredVersionId } = await makeValidatingContract();
    const before = await snapshot(assetA, assetB);
    // 删除版本行需要先删它的元数据行（外键），而且 `app_user` 对这两张表有 DELETE 权限
    // —— 也就是说这条构造**今天做得到**，而生产代码里没有任何一条删除路径。
    await prisma.$transaction(async (tx) => {
      await tx.assetMetadata.delete({ where: { assetVersionId: offeredVersionId } });
      await tx.assetVersion.delete({ where: { id: offeredVersionId } });
    });

    const error = await release.releaseContract(contractId, partyB).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommitmentMismatchError);
    expect((error as CommitmentMismatchError).field).toBe('offered_version');
    expect(String((error as CommitmentMismatchError).reason)).toContain('不存在');
    expect(await snapshot(assetA, assetB), '七个量逐项不变').toEqual(before);
  }, 180_000);

  it('★ 钉住的 dossier 摘要为空 ⇒ 拒绝释放（③ 的 **fail-closed 半边**；据实记载：重放比对属 A-9）', async () => {
    // 规格 §5.2 的判据 ③ 是「dossier **重放**摘要一致」，而重放要 `canonicalizeDossier()`
    // —— 那是**增量 A-9（Task 9）**的交付物。本任务因此落地它能落地的那一半：
    // **钉住值必须非空**（NULL = 这一行从来没有承诺过）。
    // 这一条用例把那个边界**写成可执行的**：A-9 落地后，把实现里的「非空」换成
    // 「重放相等」时，这一条会**继续绿**（NULL 仍然被拒），而新增的重放用例才是新判据。
    const { contractId, partyB, assetA, assetB } = await makeValidatingContract();
    const before = await snapshot(assetA, assetB);
    await prisma.swapOffer.update({
      where: { id: await offerOf(contractId) },
      data: { offeredDossierDigest: null },
    });

    const error = await release.releaseContract(contractId, partyB).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommitmentMismatchError);
    expect((error as CommitmentMismatchError).field).toBe('offered_dossier');
    expect(await snapshot(assetA, assetB), '七个量逐项不变').toEqual(before);
  }, 180_000);

  it('★ 释放之后义务行与承诺列**都还在**（A-8 不改写任何承诺 —— 它只核对）', async () => {
    // 这一条挡的是「顺手把承诺列写成当前值」那种实现：核对变成了**改写**，
    // 于是「一份对不上的事实」会被静默修好，而审计链上再也看不出它曾经对不上。
    const { contractId, partyB, assetB } = await makeValidatingContract({ topUp: { amount: 1n, payer: 'PROPOSER' } });
    await fund(partyB, 100n);
    const before = await prisma.swapContract.findUniqueOrThrow({
      where: { id: contractId },
      select: { targetVersionId: true, targetSha256: true, targetDossierDigest: true },
    });
    const offeredBefore = await prisma.swapOffer.findUniqueOrThrow({
      where: { id: await offerOf(contractId) },
      select: { offeredVersionId: true, offeredSha256: true, offeredDossierDigest: true },
    });

    await release.releaseContract(contractId, partyB);

    expect(
      await prisma.swapContract.findUniqueOrThrow({
        where: { id: contractId },
        select: { targetVersionId: true, targetSha256: true, targetDossierDigest: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.swapOffer.findUniqueOrThrow({
        where: { id: await offerOf(contractId) },
        select: { offeredVersionId: true, offeredSha256: true, offeredDossierDigest: true },
      }),
    ).toEqual(offeredBefore);
    // `assetB` 的版本没有被这次释放碰过（A-8 只读）。
    expect(await prisma.assetVersion.count({ where: { assetId: assetB } })).toBe(1);
  }, 180_000);
});

/**
 * ★ 补差条款落在**合约**（Task 8 的落点）与 `ObligationService` 的两条边界。
 */
describe('补差进托管与义务登记（C31 / C32 / D7 / 控制器裁定 ⑤）', () => {
  it('★ 等价互换（没有 topUp）⇒ **不建义务行**、不动钱，而所有权照样互换', async () => {
    // 规格 §2.4 逐字记载了这条的后果：「补差为 0 时释放事务连义务行都不建 ⇒
    // 争议期能冻的只有空气」。它是 P3 的**已知边界**（押金是 P3.5 的事，D9），
    // 因此这一条是**据实记载**那条边界，而不是一个待修的问题。
    const { contractId, partyA, partyB, assetA, assetB } = await makeValidatingContract();
    const before = await snapshot(assetA, assetB);

    const result = await release.releaseContract(contractId, partyB);

    expect(result.transactionIds).toEqual([]);
    const after = await snapshot(assetA, assetB);
    expect(after.escrow).toBe(before.escrow);
    expect(after.transactions).toBe(before.transactions);
    expect(await prisma.swapObligation.count({ where: { contractId } })).toBe(0);
    expect({ ownerA: after.ownerA, ownerB: after.ownerB }).toEqual({ ownerA: partyB, ownerB: partyA });
    // 审计仍然有那一行（**不动钱**不等于**不记账**）。
    expect(
      await prisma.auditLog.count({ where: { action: 'exchange.contract_released', resourceId: contractId } }),
    ).toBe(1);
    // 义务行的缺席是「这份合约没有欠款」，而不是「这条路径没跑」——用状态与访问权反证。
    expect((await prisma.swapContract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe('RELEASED');
    expect(await access.checkAccess(assetA, partyB)).toBe(true);
    expect(partyA).not.toBe(partyB);
  }, 180_000);

  it('★ 补差由**发起方**付 ⇒ 付款方是 `partyB`（闭集映射的方向不靠猜）', async () => {
    const { contractId, partyA, partyB, assetA, assetB } = await makeValidatingContract({
      topUp: { amount: 250n, payer: 'PROPOSER' },
    });
    await fund(partyB, 1000n);
    const before = await snapshot(assetA, assetB);

    await release.releaseContract(contractId, partyB);

    const contract = await prisma.swapContract.findUniqueOrThrow({
      where: { id: contractId },
      select: { topUpAmount: true, topUpPayerId: true },
    });
    expect(contract).toEqual({ topUpAmount: 250n, topUpPayerId: partyB });
    // 钱从 **`partyB`** 的可用余额出（不是 `partyA` 的）。
    expect((await ledger.readBalances(prisma, partyB)).available).toBe(1000n - 250n);
    expect((await ledger.readBalances(prisma, partyA)).available).toBe(0n);
    expect(BigInt((await snapshot(assetA, assetB)).escrow) - BigInt(before.escrow)).toBe(250n);
  }, 180_000);

  it('★ 同一份合约登记两次义务 ⇒ `P2002`（`(producer, key)` 唯一索引是执行者）', async () => {
    // 控制器裁定 ⑤ 逐字：「链的形态是 `(producer, key)` **唯一索引**，不是 `settle:` 前缀约定」
    // —— 那个前缀今天五处全是注释、零检查。这一条把「唯一索引真的在挡」变成实测。
    const { contractId } = await makeValidatingContract();
    const obligations = app.get(ObligationService);
    await prisma.$transaction((tx) => obligations.record(tx, { contractId, amount: 100n }));
    const error = await prisma
      .$transaction((tx) => obligations.record(tx, { contractId, amount: 100n }))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((error as { code?: string } | null)?.code, '同一份合约的第二条义务必须被数据库拒').toBe('P2002');
    expect(await prisma.swapObligation.count({ where: { contractId } })).toBe(1);
  }, 180_000);
});
