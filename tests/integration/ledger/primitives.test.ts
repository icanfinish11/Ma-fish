import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@vca/shared';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { LedgerService } from '@vca/api/modules/ledger/ledger.service.js';
import { ACCOUNT_KINDS } from '@vca/api/modules/ledger/core/account-kind.js';
import { TRANSACTION_KINDS } from '@vca/api/modules/ledger/core/types.js';
import { InsufficientFundsError } from '@vca/api/modules/ledger/core/errors.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 五个原语（P2 / Task 7）与**设计 §8.2 六行记账示例的逐行复现**。
 *
 * ## 六行 ↔ 五个原语：**不是**一一对应（据实说清，不凑数）
 * | §8.2 行 | 记账 | 谁走通 | `kind` |
 * |---|---|---|---|
 * | 1 充值 | `DR EXTERNAL_TOPUP CR USER_AVAILABLE` | `grantCredit` | `TOPUP` |
 * | 2 出价冻结保证金 | `DR USER_AVAILABLE CR USER_FROZEN` | `freeze` | `FREEZE` |
 * | 3 悔拍没收 | `DR USER_FROZEN CR PLATFORM_REVENUE + SELLER_AVAILABLE` | 通用 `post`（D12：金额规则属 P4） | `FORFEIT` |
 * | 4 成交 | `DR BUYER_AVAILABLE CR PLATFORM_ESCROW` | `lockToEscrow` | `ESCROW_LOCK` |
 * | 5 释放（验收后） | `DR PLATFORM_ESCROW CR SELLER_AVAILABLE + PLATFORM_REVENUE` | `releaseEscrow` | `ESCROW_RELEASE` |
 * | 6 交换补差 | `DR PAYER_AVAILABLE CR PLATFORM_ESCROW → 释放时转 RECEIVER_AVAILABLE` | `lockToEscrow` + `releaseEscrow`（**与行 4 共用 `ESCROW_LOCK`**） | `ESCROW_LOCK` + `ESCROW_RELEASE` |
 *
 * 于是准确的算式是「**5 个 `kind` 取值覆盖 6 行**（行 6 与行 4 共用一个取值）
 * **+ 1 个取值在 §8.2 之外** = 6」。第六个取值是 `UNFREEZE`——它是 §2.1「冻结与释放」
 * 的**字面对偶**，**不在 §8.2 的六行里**。本文件因此有 **7** 组记账用例：六行各一条，
 * 加上 `unfreeze` 的对偶那一条。
 *
 * ## §8.2 里的 `SELLER_AVAILABLE` / `BUYER_AVAILABLE` 不是账户类型（C30 / D6）
 * §8.1 只有五个 kind；买家与卖家是**属于不同用户的 `USER_AVAILABLE`**。
 * 库里没有、也不得有 `SELLER_AVAILABLE` 这种 kind（那会让不变式 #3 的条件化 CHECK 失去依据）。
 *
 * ## 每个用例都用新的 `uuidv7()` 当事人 ⇒ 互不干扰、无需清理。
 * 系统账户（托管 / 收入 / 充值对手方）是全局共享的，因此对它们的断言一律写成
 * **前后差**，不写成绝对值。
 */
let pg: TestPg;
let prisma: PrismaService;
let ledger: LedgerService;

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  ledger = new LedgerService(prisma, new AuditService(prisma));
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
});

// 这一版用例刻意**不**直接构造 `EXTERNAL_TOPUP` 的引用：充值一律走 `grantCredit`，
// 而 `post` 的通用路径由「悔拍没收」那条走通（两张门各有一条用例在看着）。
const available = (userId: string) => ({ kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: userId }) as const;
const frozen = (userId: string) => ({ kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: userId }) as const;

/** 某个账户的当前余额（`ownerUserId` 传 null 表示系统账户）。 */
async function balanceOf(kind: string, ownerUserId: string | null): Promise<bigint> {
  const rows = await prisma.ledgerAccount.findMany({ where: { kind, ownerUserId }, select: { balance: true } });
  return rows[0]?.balance ?? 0n;
}

/** 一笔交易的分录（kind, amount），按 kind 排序——用来断言**符号约定**本身。 */
async function entriesOf(idempotencyKey: string): Promise<[string, bigint][]> {
  const tx = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey },
    select: { entries: { select: { amount: true, account: { select: { kind: true } } } } },
  });
  return (tx?.entries ?? [])
    .map((e) => [e.account.kind, e.amount] as [string, bigint])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * 一笔交易的 `kind`（不存在时返回 `null`）。
 *
 * 为什么单独断言它：上面那张「六行 ↔ 五个原语」的表是**散文**，而这里把它变成可判定的
 * 事实——行 6 与行 4 **共用** `ESCROW_LOCK` 这件事只有逐笔读 `kind` 才看得见。
 */
async function kindOf(idempotencyKey: string): Promise<string | null> {
  const tx = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey },
    select: { kind: true },
  });
  return tx?.kind ?? null;
}

/** 一笔过账留下的审计行数（按审计 metadata 里的幂等键找）。 */
async function auditRowsFor(key: string): Promise<number> {
  return prisma.auditLog.count({ where: { metadata: { path: ['idempotencyKey'], equals: key } } });
}

describe('五个原语（§8.2 / §8.4）', () => {
  it('§8.2 行 1 / 充值：DR EXTERNAL_TOPUP CR USER_AVAILABLE，kind = TOPUP', async () => {
    const userId = uuidv7();
    const key = `topup:${userId}`;
    await prisma.$transaction((tx) =>
      ledger.grantCredit(tx, { userId, amount: 10_000n, idempotencyKey: key, actorId: userId }),
    );
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 10_000n, frozen: 0n });
    // 分录的符号约定：系统 −10000（借）、用户 +10000（贷）。这一条把「负=借」钉住。
    expect(await entriesOf(key)).toEqual([
      [ACCOUNT_KINDS.EXTERNAL_TOPUP, -10_000n],
      [ACCOUNT_KINDS.USER_AVAILABLE, 10_000n],
    ]);
    expect(await kindOf(key)).toBe(TRANSACTION_KINDS.TOPUP);
    // `actorId` 的转发（五个原语里只在这一处见证；见报告的「据实记载」一节）：
    expect(
      await prisma.auditLog.findFirst({
        where: { metadata: { path: ['idempotencyKey'], equals: key } },
        select: { actorId: true, resource: true },
      }),
    ).toEqual({ actorId: userId, resource: 'LedgerTransaction' });
  });

  it('§8.2 行 2 / 出价冻结保证金：DR USER_AVAILABLE CR USER_FROZEN，kind = FREEZE', async () => {
    const userId = uuidv7();
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId, amount: 10_000n, idempotencyKey: `topup:${userId}` });
      await ledger.freeze(tx, { userId, amount: 6_000n, idempotencyKey: `freeze:${userId}` });
    });
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 4_000n, frozen: 6_000n });
    expect(await entriesOf(`freeze:${userId}`)).toEqual([
      [ACCOUNT_KINDS.USER_AVAILABLE, -6_000n],
      [ACCOUNT_KINDS.USER_FROZEN, 6_000n],
    ]);
    expect(await kindOf(`freeze:${userId}`)).toBe(TRANSACTION_KINDS.FREEZE);
  });

  it('解冻（「冻结与释放」的字面另一半，**不在 §8.2 六行里**）：冻结 → 可用，两步后回到原值', async () => {
    const userId = uuidv7();
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId, amount: 1_000n, idempotencyKey: `topup:${userId}` });
      await ledger.freeze(tx, { userId, amount: 1_000n, idempotencyKey: `freeze:${userId}` });
      await ledger.unfreeze(tx, { userId, amount: 1_000n, idempotencyKey: `unfreeze:${userId}` });
    });
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 1_000n, frozen: 0n });
    // 方向必须与第 2 行**相反**（这正是这一条的判别力所在）：
    expect(await entriesOf(`unfreeze:${userId}`)).toEqual([
      [ACCOUNT_KINDS.USER_AVAILABLE, 1_000n],
      [ACCOUNT_KINDS.USER_FROZEN, -1_000n],
    ]);
    expect(await kindOf(`unfreeze:${userId}`)).toBe(TRANSACTION_KINDS.UNFREEZE);
  });

  it('§8.2 行 4 / 成交：DR BUYER_AVAILABLE CR PLATFORM_ESCROW，kind = ESCROW_LOCK', async () => {
    const buyerId = uuidv7();
    const escrowBefore = await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null);
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: buyerId, amount: 10_000n, idempotencyKey: `topup:${buyerId}` });
      await ledger.lockToEscrow(tx, { buyerId, amount: 10_000n, idempotencyKey: `lock:${buyerId}` });
    });
    expect(await ledger.readBalances(prisma, buyerId)).toEqual({ available: 0n, frozen: 0n });
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null)).toBe(escrowBefore + 10_000n);
    expect(await entriesOf(`lock:${buyerId}`)).toEqual([
      [ACCOUNT_KINDS.PLATFORM_ESCROW, 10_000n],
      [ACCOUNT_KINDS.USER_AVAILABLE, -10_000n],
    ]);
    expect(await kindOf(`lock:${buyerId}`)).toBe(TRANSACTION_KINDS.ESCROW_LOCK);
  });

  it('§8.2 行 5 / 释放：托管 −10000、卖家 +9500、平台 +500（§8.4 的 5%），kind = ESCROW_RELEASE', async () => {
    const buyerId = uuidv7();
    const sellerId = uuidv7();
    const escrowBefore = await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null);
    const revenueBefore = await balanceOf(ACCOUNT_KINDS.PLATFORM_REVENUE, null);
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: buyerId, amount: 10_000n, idempotencyKey: `topup:${buyerId}` });
      await ledger.lockToEscrow(tx, { buyerId, amount: 10_000n, idempotencyKey: `lock:${buyerId}` });
      await ledger.releaseEscrow(tx, { sellerId, gross: 10_000n, idempotencyKey: `release:${buyerId}` });
    });
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null)).toBe(escrowBefore); // 净额与手续费都出去了
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_REVENUE, null)).toBe(revenueBefore + 500n);
    expect(await ledger.readBalances(prisma, sellerId)).toEqual({ available: 9_500n, frozen: 0n });
    expect(await entriesOf(`release:${buyerId}`)).toEqual([
      [ACCOUNT_KINDS.PLATFORM_ESCROW, -10_000n],
      [ACCOUNT_KINDS.PLATFORM_REVENUE, 500n],
      [ACCOUNT_KINDS.USER_AVAILABLE, 9_500n],
    ]);
    expect(await kindOf(`release:${buyerId}`)).toBe(TRANSACTION_KINDS.ESCROW_RELEASE);
  });

  it('释放的**最小反例**：gross=1 分 ⇒ 平台 1、卖家 0，`fee+net=gross` 在真库路径上同样成立', async () => {
    const buyerId = uuidv7(); // 1 分钱的托管也能建起来（发 1 分、锁 1 分）
    const sellerId = uuidv7();
    const revenueBefore = await balanceOf(ACCOUNT_KINDS.PLATFORM_REVENUE, null);
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: buyerId, amount: 1n, idempotencyKey: `topup:${buyerId}` });
      await ledger.lockToEscrow(tx, { buyerId, amount: 1n, idempotencyKey: `lock:${buyerId}` });
      await ledger.releaseEscrow(tx, { sellerId, gross: 1n, idempotencyKey: `release:${buyerId}` });
    });
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_REVENUE, null)).toBe(revenueBefore + 1n);
    expect(await ledger.readBalances(prisma, sellerId)).toEqual({ available: 0n, frozen: 0n });
    // 卖家那条**转移**不存在 ⇒ 只有托管与收入两条腿（卖家一条都没有；
    // 写一条 0 金额的腿会撞迁移里的 `entries_amount_nonzero`）：
    expect(await entriesOf(`release:${buyerId}`)).toEqual([
      [ACCOUNT_KINDS.PLATFORM_ESCROW, -1n],
      [ACCOUNT_KINDS.PLATFORM_REVENUE, 1n],
    ]);
  });

  it('释放的零腿被**丢弃**而不是写成 0：`feeBps=0` 时只有两条腿（`net` 那条）', async () => {
    const buyerId = uuidv7();
    const sellerId = uuidv7();
    const result = await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: buyerId, amount: 100n, idempotencyKey: `topup:${buyerId}` });
      await ledger.lockToEscrow(tx, { buyerId, amount: 100n, idempotencyKey: `lock:${buyerId}` });
      return ledger.releaseEscrow(tx, { sellerId, gross: 100n, feeBps: 0, idempotencyKey: `release:${buyerId}` });
    });
    expect(await prisma.ledgerEntry.count({ where: { transactionId: result.transactionId } })).toBe(2);
    expect(await ledger.readBalances(prisma, sellerId)).toEqual({ available: 100n, frozen: 0n });
    // `feeBps` 必须**真的**被收到：费率若被忽略（恒用 `PLATFORM_FEE_BPS`），这一条与下一条都会红。
    expect(await entriesOf(`release:${buyerId}`)).toEqual([
      [ACCOUNT_KINDS.PLATFORM_ESCROW, -100n],
      [ACCOUNT_KINDS.USER_AVAILABLE, 100n],
    ]);
  });

  it('§8.2 行 3 / 悔拍没收由**通用 post** 走通（D12：金额规则属 P4，本用例只把它当参数），kind = FORFEIT', async () => {
    const loserId = uuidv7();
    const sellerId = uuidv7();
    const revenueBefore = await balanceOf(ACCOUNT_KINDS.PLATFORM_REVENUE, null);
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: loserId, amount: 1_000n, idempotencyKey: `topup:${loserId}` });
      await ledger.freeze(tx, { userId: loserId, amount: 1_000n, idempotencyKey: `freeze:${loserId}` });
      // 罚没 600 / 赔偿 400 —— 这两个数字是 P4 的业务规则，本用例只是把它们当**参数**。
      await ledger.post(tx, {
        kind: TRANSACTION_KINDS.FORFEIT,
        idempotencyKey: `forfeit:${loserId}`,
        moves: [
          { from: frozen(loserId), to: { kind: ACCOUNT_KINDS.PLATFORM_REVENUE, ownerUserId: null }, amount: 600n },
          { from: frozen(loserId), to: available(sellerId), amount: 400n },
        ],
      });
    });
    expect(await ledger.readBalances(prisma, loserId)).toEqual({ available: 0n, frozen: 0n });
    expect(await ledger.readBalances(prisma, sellerId)).toEqual({ available: 400n, frozen: 0n });
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_REVENUE, null)).toBe(revenueBefore + 600n);
    expect(await entriesOf(`forfeit:${loserId}`)).toEqual([
      [ACCOUNT_KINDS.PLATFORM_REVENUE, 600n],
      [ACCOUNT_KINDS.USER_AVAILABLE, 400n],
      [ACCOUNT_KINDS.USER_FROZEN, -1_000n],
    ]);
    expect(await kindOf(`forfeit:${loserId}`)).toBe(TRANSACTION_KINDS.FORFEIT);
  });

  it('§8.2 行 6 / 交换补差：付款方可用 → 托管 → 释放时转收款方（两次原语调用，无命名包装）', async () => {
    // 这一行原先**没有任何用例**，而计划却声称「六行逐行对应」。它的记账形状与行 4+行 5
    // 是同一个机械形状（原文：`DR PAYER_AVAILABLE CR PLATFORM_ESCROW → 释放时转
    // RECEIVER_AVAILABLE`），因此不需要第七个 `TRANSACTION_KINDS` 取值，也不需要一个新的
    // 包装函数（D12 / C16）——但它**必须有一条用例**，否则「够用」只是声称。
    // ★ 对应关系在这里是**可判定**的：左半句的 `kind` 与行 4 **同一个**（`ESCROW_LOCK`）。
    const payerId = uuidv7();
    const receiverId = uuidv7();
    const escrowBefore = await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null);
    const revenueBefore = await balanceOf(ACCOUNT_KINDS.PLATFORM_REVENUE, null);
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: payerId, amount: 3_000n, idempotencyKey: `topup:${payerId}` });
      // 第一步 = 行 6 的左半句（付款方 → 托管），与「成交」同一个原语
      await ledger.lockToEscrow(tx, { buyerId: payerId, amount: 3_000n, idempotencyKey: `boot-lock:${payerId}` });
      // 第二步 = 行 6 的右半句（释放时转收款方）。`feeBps: 0`：补差不是成交，**没有平台手续费**
      // （§8.4 的手续费挂在「成交 → 验收 → 释放」那条线上；把费率写死在这里会是 P3/P4 的业务决定）
      await ledger.releaseEscrow(tx, { sellerId: receiverId, gross: 3_000n, feeBps: 0, idempotencyKey: `boot-release:${payerId}` });
    });
    expect(await ledger.readBalances(prisma, payerId)).toEqual({ available: 0n, frozen: 0n });
    expect(await ledger.readBalances(prisma, receiverId)).toEqual({ available: 3_000n, frozen: 0n });
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null)).toBe(escrowBefore); // 托管净变动为 0
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_REVENUE, null)).toBe(revenueBefore); // 平台一分未收
    // ★ 行 6 与行 4 共用同一个 `kind`（这就是「5 个取值覆盖 6 行」那句话的机器判据）：
    expect(await kindOf(`boot-lock:${payerId}`)).toBe(TRANSACTION_KINDS.ESCROW_LOCK);
    expect(await kindOf(`boot-release:${payerId}`)).toBe(TRANSACTION_KINDS.ESCROW_RELEASE);
  });

  it('余额不足的冻结被拒，且库里**一行都没留下**（交易 / 审计都为 0；它们的接受对侧在同一条里）', async () => {
    const userId = uuidv7();
    const okKey = `freeze-ok:${userId}`;
    await prisma.$transaction((tx) =>
      ledger.grantCredit(tx, { userId, amount: 100n, idempotencyKey: `topup:${userId}` }),
    );

    // ① **接受方向先跑**：同一形状的一次**成功**冻结 ⇒ 同样的两个查询必须返回 1 / 1。
    //    没有它，下面那两个 0 只能证明「查询写错了」。
    await prisma.$transaction((tx) =>
      ledger.freeze(tx, { userId, amount: 100n, idempotencyKey: okKey }),
    );
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: okKey } })).toBe(1);
    expect(await auditRowsFor(okKey)).toBe(1);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 0n, frozen: 100n });

    // ② 拒绝方向：可用余额已经是 0，再冻 1 分 ⇒ 领域错误，且不留任何行。
    const key = `freeze:${userId}`;
    await expect(
      prisma.$transaction((tx) => ledger.freeze(tx, { userId, amount: 1n, idempotencyKey: key })),
    ).rejects.toThrow(InsufficientFundsError);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(await auditRowsFor(key)).toBe(0);
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 0n, frozen: 100n });
    // 那笔已提交的冻结**一字未动**：
    expect(await prisma.ledgerEntry.count({ where: { transactionId: (await prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: okKey }, select: { id: true } })).id } })).toBe(2);
  });
});
