import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { uuidv7 } from '@vca/shared';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { AuditService, type AuditRecordInput } from '@vca/api/modules/audit/index.js';
import { ExchangeService } from '@vca/api/modules/exchange/exchange.service.js';
import { SwapContractService } from '@vca/api/modules/exchange/swap-contract.service.js';
import { SwapReleaseService } from '@vca/api/modules/exchange/index.js';
import { LedgerService } from '@vca/api/modules/ledger/index.js';
import type { Prisma } from '@vca/api/generated/prisma/client.js';
import { createTestApp } from '../../helpers/app.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';

/**
 * ★★ §6.3:294 的「**任何异常必须完全回滚，不留半成品所有权**」（设计 §13.3 的验收判据本体）。
 *
 * ## 为什么这条用例的判据是**八个量逐项相同**
 * 预检的反向对照测的正是这个形状（`[B7②]`：六个量逐项相同）。计划把它写成七个量，
 * 本文件在此基础上加了**第八个**：`access_grants` 的行数（Task 8 新增的那一档访问权）。
 * 只核对一个量（例如「所有权回滚了」）是不够的：一个「所有权回滚了、而托管分录留下了」的
 * 实现会让所有权那一条绿，而**账本里多了一笔从未发生的资金变动**
 * （P0 要的正是「审计日志可完整重建任一次资金变动的链路」，§13.2）。
 *
 * ## 怎么注入失败（**审计**，在任何写之后）
 * `audit.record` 在 `releaseInTx` 里是**最后一件事**（⑩），而这里要的正是
 * 「其他七件都已经做完、最后一件失败」的位置 —— 用审计做注入点还顺带给出
 * 预检 §B.2 第 2 条要的那条**独立断言**：「回滚后审计 0 行」。
 *
 * 替身只在 `action === 'exchange.contract_released'` 时抛，**其余调用照常**
 * （账本自己的 `ledger.posted` 也走同一个 `AuditService` —— 它必须照常，否则
 * 测的就不是「释放的最后一件事失败」而是「整个审计服务坏了」）。
 *
 * **不用**「往 SQL 里塞一句错的」那种注入：那会连**被测的**那七件一起改变
 * （计划 Step 2 逐字点名的理由）。
 *
 * ## 台架自证（这一条不能只有绿）
 * 同一个 app 上还有一条**反面对照**：不注入失败时八个量**都**变了 ——
 * 否则一个「怎么都不写」的实现也能骗过上面那条。两者共用同一个 `ArmedAudit` 替身，
 * 差别只有 `armed` 一位。
 */
let app: INestApplication;
let redis: TestRedis;
let pg: TestPg;
let prisma: PrismaService;
let exchange: ExchangeService;
let swap: SwapContractService;
let release: SwapReleaseService;
let ledger: LedgerService;
let armedAudit: ArmedAudit;

/**
 * 一个**可武装**的 `AuditService` 替身：`arm()` 之后，释放路径的那一行审计会抛。
 *
 * 它**委托**给真的 `AuditService`（同一个 `PrismaService`），因此除了被注入的那一次，
 * 每一条审计都真的落库 —— 判据里的 `audits` 计数才有意义。
 */
class ArmedAudit {
  private armed = false;
  private readonly real: AuditService;

  constructor(prisma: PrismaService) {
    this.real = new AuditService(prisma);
  }

  arm(): void {
    this.armed = true;
  }

  disarm(): void {
    this.armed = false;
  }

  async record(
    input: AuditRecordInput,
    tx?: Prisma.TransactionClient & { readonly $connect?: never },
  ): Promise<void> {
    if (this.armed && input.action === 'exchange.contract_released') {
      throw new Error('探针注入：释放路径的最后一件事（审计）失败');
    }
    await this.real.record(input, tx);
  }
}

beforeAll(async () => {
  redis = await startTestRedis();
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  armedAudit = new ArmedAudit(prisma);
  app = await createTestApp({
    overrides: [
      (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
      (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
      // ★ 替身必须**替换掉** `AuditService` 这一 token：`SwapReleaseService` /
      //   `ExchangeService` / `SwapContractService` / `LedgerService` 都注入它，
      //   因此这一个 token 的替换让「释放路径的最后一件事」可注入地失败。
      (builder) => builder.overrideProvider(AuditService).useValue(armedAudit),
    ],
  });
  exchange = app.get(ExchangeService);
  swap = app.get(SwapContractService);
  release = app.get(SwapReleaseService);
  ledger = app.get(LedgerService);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
  await redis?.stop();
});

const DIGEST = 'd'.repeat(64);

async function makeUser(): Promise<string> {
  return (await prisma.user.create({ data: {} })).id;
}

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

/** 走真实路径造一份 `VALIDATING` 的合约（带补差 ⇒ 七件事全都会被走到）。 */
async function makeValidatingContract(): Promise<{
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
    offeredAssetId: offered.assetId,
    targetAssetId: target.assetId,
    offeredDossierDigest: DIGEST,
    claims: null,
  });
  const accepted = await exchange.acceptOffer({
    offerId: offer.offerId,
    actorId: counterparty,
    targetCommitment: { assetVersionId: offered.versionId, dossierDigest: DIGEST },
    topUp: { amount: 1000n, payer: 'ACCEPTOR' },
  });
  await prisma.$transaction((tx) =>
    ledger.grantCredit(tx, { userId: counterparty, amount: 5000n, idempotencyKey: `t8-fund:${uuidv7()}` }),
  );
  await swap.confirmLock(accepted.contractId, counterparty);
  const settled = await swap.confirmLock(accepted.contractId, proposer);
  expect(settled.status, '构造：双方确认之后合约必须在 VALIDATING').toBe('VALIDATING');
  return {
    contractId: accepted.contractId,
    partyA: counterparty,
    partyB: proposer,
    assetA: target.assetId,
    assetB: offered.assetId,
  };
}

/** **八个量**（计划的七个 + Task 8 新增的访问权行数）。 */
async function snapshot(
  assetA: string,
  assetB: string,
): Promise<{
  ownerA: string;
  ownerB: string;
  escrow: string;
  audits: number;
  entries: number;
  transactions: number;
  history: number;
  grants: number;
}> {
  const [a, b, escrowAccount] = await Promise.all([
    prisma.asset.findUniqueOrThrow({ where: { id: assetA }, select: { ownerId: true } }),
    prisma.asset.findUniqueOrThrow({ where: { id: assetB }, select: { ownerId: true } }),
    prisma.ledgerAccount.findFirstOrThrow({ where: { kind: 'PLATFORM_ESCROW' }, select: { balance: true } }),
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
    audits,
    entries,
    transactions,
    history,
    grants,
  };
}

describe('原子释放的回滚（§6.3:294 / §13.3 的判据本体）', () => {
  it('★ 最后一件事（审计）失败 ⇒ **八个量逐项**与释放之前相同', async () => {
    const { contractId, partyA, partyB, assetA, assetB } = await makeValidatingContract();
    const before = await snapshot(assetA, assetB);

    armedAudit.arm();
    const error = await release.releaseContract(contractId, partyB).then(
      () => null,
      (e: unknown) => e,
    );
    armedAudit.disarm();

    expect(error, '注入的失败必须原样冒到调用方（不重试、不吞）').toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain('探针注入');
    const after = await snapshot(assetA, assetB);
    // ★ **逐项相同**（而不是「某些量没变」）：`toEqual` 对八个键逐个比较。
    expect(after).toEqual(before);

    // 逐项再写一遍：失败信息里因此能看出**是哪一个量**没滚回去。
    expect(after.ownerA, '所有权指针 A').toBe(before.ownerA);
    expect(after.ownerB, '所有权指针 B').toBe(before.ownerB);
    expect(after.escrow, '托管余额').toBe(before.escrow);
    expect(after.audits, '审计行数').toBe(before.audits);
    expect(after.entries, '账本分录').toBe(before.entries);
    expect(after.transactions, '账本交易').toBe(before.transactions);
    expect(after.history, '所有权史').toBe(before.history);
    expect(after.grants, '访问权行数').toBe(before.grants);

    // ★ **独立断言**（预检 §B.2 第 2 条逐字：三条资金路径各自要有一条「回滚后审计 0 行」
    //   的断言，**不能折进总数核对**）。本任务给的是**释放**这一条。
    expect(
      await prisma.auditLog.count({ where: { action: 'exchange.contract_released', resourceId: contractId } }),
      '★ 回滚之后**审计 0 行**',
    ).toBe(0);
    // 义务行也一行都没有（它建在托管过账之后、审计之前 —— 一个「义务留下了而钱没进」
    // 的实现会让不变式 #4 的右式凭空变大）。
    expect(await prisma.swapObligation.count({ where: { contractId } })).toBe(0);
    // 合约仍在 `VALIDATING`（§6.3 的图没有「失败 ⇒ 别的状态」这条边）。
    expect((await prisma.swapContract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe(
      'VALIDATING',
    );
    // 作品仍然锁在**这一份**合约名下（回滚没有把 Task 7 的锁也带走）。
    const holder = await prisma.asset.findMany({
      where: { id: { in: [assetA, assetB] } },
      select: { holderContractId: true },
    });
    expect(holder.map((row) => row.holderContractId)).toEqual([contractId, contractId]);
    // `partyA` 的钱仍然在可用余额里（那一笔托管锁回滚了）。
    expect((await ledger.readBalances(prisma, partyA)).available).toBe(5000n);
  }, 180_000);

  it('★ 反面对照：不注入失败时**八个量都变了**（否则一个「怎么都不写」的实现也能骗过上面那条）', async () => {
    const { contractId, partyA, partyB, assetA, assetB } = await makeValidatingContract();
    const before = await snapshot(assetA, assetB);

    const result = await release.releaseContract(contractId, partyB);

    expect(result.releasedNow).toBe(true);
    const after = await snapshot(assetA, assetB);
    expect(after.ownerA).toBe(partyB); // 所有权真的换了
    expect(after.ownerB).toBe(partyA);
    expect(after.history).toBe(before.history + 2);
    expect(after.transactions).toBe(before.transactions + 1); // 补差那一笔
    expect(after.entries).toBe(before.entries + 2);
    expect(after.escrow).toBe((BigInt(before.escrow) + 1000n).toString());
    // 审计：**这一条路径** +1（同一个事务里还可能有账本那一行 `ledger.posted`，
    // 因此总数 +2 —— 逐项断言写在这里，而不是「至少变了」）。
    expect(after.audits).toBe(before.audits + 2);
    expect(
      await prisma.auditLog.count({ where: { action: 'exchange.contract_released', resourceId: contractId } }),
    ).toBe(1);
    expect(after.grants).toBe(before.grants + 2);

    // 台架自证的另一半：**同一批量**在注入与不注入两侧给出**相反**的结论
    // （上面那条是 `toEqual(before)`，这条是八个键里七个都变了）。
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter((key) => after[key] !== before[key]);
    expect(changed.sort()).toEqual(
      ['audits', 'entries', 'escrow', 'grants', 'history', 'ownerA', 'ownerB', 'transactions'].sort(),
    );
  }, 180_000);

  it('★ 注入失败之后**再释放一次**能成功（回滚不是「把合约废掉」）', async () => {
    // 这一条判的是「完全回滚」的后半句：**不留半成品**。若上一轮留下了任何一件
    // （例如一行访问权、一条义务、一笔托管），第二次释放会以完全不同的形状失败
    // （唯一索引冲突 / 余额不足 / 持有者不符），而那时**谁都说不清**是哪一件没滚。
    const { contractId, partyB, assetA, assetB } = await makeValidatingContract();
    const before = await snapshot(assetA, assetB);
    armedAudit.arm();
    await expect(release.releaseContract(contractId, partyB)).rejects.toThrow('探针注入');
    armedAudit.disarm();

    const result = await release.releaseContract(contractId, partyB);

    expect(result.releasedNow).toBe(true);
    const after = await snapshot(assetA, assetB);
    expect(after.ownerA).toBe(partyB);
    // **恰好一次**的所有权互换（两行历史，不是四行）。
    expect(after.history).toBe(before.history + 2);
    // 恰恰一份义务、恰恰一笔托管（不是「重试又做了一遍」）。
    expect(await prisma.swapObligation.count({ where: { contractId } })).toBe(1);
    expect(
      await prisma.ledgerTransaction.count({ where: { idempotencyKey: `exchange:lock:${contractId}` } }),
    ).toBe(1);
  }, 180_000);

  it('★ 审计替身**只在释放路径上**抛（台架自证：别的路径的审计照常落库）', async () => {
    // 没有这一条，上面那些红就可能来自「整个审计服务坏了」而不是「释放的最后一件事失败」
    // —— 「探针红对了，但红在另一个机制上」正是本阶段反复点名的那一类假证据。
    const actor = await makeUser();
    armedAudit.arm();
    const other = await prisma.auditLog.count();
    await prisma.$transaction((tx) =>
      ledger.grantCredit(tx, { userId: actor, amount: 10n, idempotencyKey: `t8-selfproof:${uuidv7()}` }),
    );
    armedAudit.disarm();
    expect(await prisma.auditLog.count()).toBe(other + 1);
  }, 120_000);
});
