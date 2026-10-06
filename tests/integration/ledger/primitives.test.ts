import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { uuidv7 } from '@vca/shared';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { AdminDirectory } from '@vca/api/modules/auth/admin-directory.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { LedgerService } from '@vca/api/modules/ledger/ledger.service.js';
import { ACCOUNT_KINDS } from '@vca/api/modules/ledger/core/account-kind.js';
import { TRANSACTION_KINDS } from '@vca/api/modules/ledger/core/types.js';
import { InsufficientFundsError, UnknownUserError } from '@vca/api/modules/ledger/core/errors.js';
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
 * 库里没有、也不得有 `SELLER_AVAILABLE` 这种 kind（那会让「哪些账户允许为负」这条
 * 条件化 CHECK 失去依据——它今天枚举的是 `EXTERNAL_TOPUP` 这**一个**取值）。
 *
 * ## 每个用例都用新的当事人（**真实的**用户，C1）⇒ 互不干扰、无需清理。
 * 系统账户（托管 / 收入 / 充值对手方）是全局共享的，因此对它们的断言一律写成
 * **前后差**，不写成绝对值。
 *
 * ## 为什么当事人是「真用户」而不是任意的 `uuidv7()`
 * P2 最终审查的 **C1**：`grantCredit` 此前只校验 `userId` 的**格式**，而 `resolveAccounts`
 * 会把 `(USER_AVAILABLE, <任意 uuid>)` 按需插进 `ledger.accounts`。于是给一个 `auth.users`
 * 里不存在的 uuid 发额度会**成功**——账平、五条不变式全绿、对账全绿、审计如实，
 * 而**没有任何路由或任务能花掉那笔钱**。修好之后收款人必须存在，因此这里真的建用户。
 */
let pg: TestPg;
let prisma: PrismaService;
let ledger: LedgerService;

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  ledger = new LedgerService(prisma, new AuditService(prisma), new AdminDirectory(prisma));
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

/**
 * 一个**真的**存在于 `auth.users` 的用户（C1：额度发放的收款人必须是真用户）。
 *
 * 为什么这些用例不再用 `uuidv7()` 当当事人：那是 P2 最终审查的 C1 —— `grantCredit` 此前
 * 可以给一个 `auth.users` 里不存在的 uuid 发额度（账平、五条不变式全绿、**钱永远花不掉**，
 * 而它还是唯一一个凭空造钱的端点）。修好之后，发放的收款人必须是真用户；
 * 而这些用例要的只是「一个正常用户」，因此在这里真的建一个。
 */
async function realUser(): Promise<string> {
  const user = await prisma.user.create({ data: {} });
  return user.id;
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

/**
 * 等到有 n 个后端卡在锁上（`wait_event_type = 'Lock'`），并**返回它们正在执行的语句**。
 *
 * 与 `postings.test.ts` 里那个同名 helper 同一形状（此处不共用：把测试装置提到
 * `tests/helpers/` 是一次真正的共享决定，而今天只有两条用例用它）。
 * 返回语句这件事不是装饰：**光看见「有后端在等锁」推不出「它在等那把行锁」**——
 * Task 6 正是靠这一点量出「两个所谓的赛跑者其实被账户 INSERT 串行化了」（探针 p1/p2）。
 *
 * 观察者与 Prisma 用**同一个** `app_user` 连接：`pg_stat_activity` 的 `wait_event_type` /
 * `query` 只对「本会话属主」可见，两边同角色才看得见（换成属主去看反而读到 NULL，
 * 那会让这条构造**静默**失效）。
 */
async function waitForLockWaiters(client: Client, n: number): Promise<string[]> {
  for (let i = 0; i < 80; i += 1) {
    const r = await client.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (r.rows.length >= n) return r.rows.map((row) => row.query);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('2 s 内没有观察到等待锁的后端 —— 这条用例的时序前提不成立（构造失败，不是断言失败）');
}

describe('五个原语（§8.2 / §8.4）', () => {
  it('★ 额度只能发给**存在**的用户（C1）：格式合法但库里没有的 uuid 被拒，真用户被接受', async () => {
    // ## 它挡的缺陷形态（P2 最终全分支审查的 C1）
    //
    // `grantCredit` 此前对 `userId` 只做**格式**校验（DTO 的 `z.uuid()`），而
    // `resolveAccounts` 会把 `(USER_AVAILABLE, <任意 uuid>)` 按需 `INSERT` 进
    // `ledger.accounts`。于是给一个 `auth.users` 里**不存在**的 uuid 发额度会成功：
    // `created=true`、`USER_AVAILABLE +100`、`EXTERNAL_TOPUP −100` —— Σ=0 成立、
    // 五条不变式全绿、对账全绿、审计完整**且如实**，而**没有任何路由或任务能花掉这笔钱**
    // （没人能以此身份登录）。一次管理员的手误（UUID 差一个字符）因此**静默地销毁额度**，
    // 除了这一次发放，什么都不失败；每个不同的 uuid 还会永久留下两行。
    // 它是 P2 里**唯一一条外部可达的造钱路径**上的缺陷。
    //
    // 判据是**两件事**，缺一不可：
    //   ① 领域错误类型（`UnknownUserError`）——它让 HTTP 层能翻成 404，也让 P3 直接调用
    //      `grantCredit` 时**继承**这道门（服务层守卫，不是控制器守卫）；
    //   ② 库里**两行都没有**被造出来——错误类型对了但已经写进去再回滚，是另一回事。
    const ghost = uuidv7(); // 形状合法（RFC 9562）但 auth.users 里没有这一行
    const key = `ghost:${ghost}`;
    await expect(
      prisma.$transaction((tx) =>
        ledger.grantCredit(tx, { userId: ghost, amount: 100n, idempotencyKey: key }),
      ),
    ).rejects.toThrow(UnknownUserError);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(await prisma.ledgerAccount.count({ where: { ownerUserId: ghost } })).toBe(0);
    expect(await ledger.readBalances(prisma, ghost)).toEqual({ available: 0n, frozen: 0n });

    // ★ 接受方向的同伴（同一形状的调用 + 同一个入口）：一个**真的**用户 ⇒ 正常发放。
    //   没有它，上面那三条「0」也可能只是「grantCredit 怎么都拒」。
    const real = await realUser();
    const okKey = `ghost-ok:${real}`;
    await prisma.$transaction((tx) =>
      ledger.grantCredit(tx, { userId: real, amount: 100n, idempotencyKey: okKey }),
    );
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: okKey } })).toBe(1);
    expect(await prisma.ledgerAccount.count({ where: { ownerUserId: real } })).toBe(1);
    expect(await ledger.readBalances(prisma, real)).toEqual({ available: 100n, frozen: 0n });
  });

  it('§8.2 行 1 / 充值：DR EXTERNAL_TOPUP CR USER_AVAILABLE，kind = TOPUP', async () => {
    const userId = await realUser();
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
    const userId = await realUser();
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
    const userId = await realUser();
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
    const buyerId = await realUser();
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
    const buyerId = await realUser();
    const sellerId = await realUser();
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
    const buyerId = await realUser(); // 1 分钱的托管也能建起来（发 1 分、锁 1 分）
    const sellerId = await realUser();
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
    const buyerId = await realUser();
    const sellerId = await realUser();
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

  it('★ 托管**不透支**（不变式 #4 在 P2 里可强制的那一半）：超出托管余额的释放被拒、恰好等于的释放被接受', async () => {
    // ## 它挡的缺陷形态（P2 最终全分支审查的 I1）
    //
    // `applyBalances` 的守卫此前写成 `isUserAccountKind(snapshot.kind) ? {id, balance: {gte: x}} : {id}`
    // ——而 `PLATFORM_ESCROW` 是**系统** kind（`account-kind.ts` 的三张表之一）⇒ 托管账户的借方
    // 是**无条件**扣减。于是「释放得比锁进来的更多」这件事不会被任何东西拦住：
    // 托管被扣成负的、差额付给卖家 ⇒ **平台付了它从未持有的钱**，而 Σ=0 成立、五条不变式全绿、
    // 对账全绿、审计也如实。审查逐条核过 `tests/` 里全部 7 个 `releaseEscrow` 调用点：
    // 每一个释放的都恰好是它锁进来的 ⇒ **此前没有任何见证看着这条规则**。
    //
    // 而 §8.3 的不变式 #4 原文就是「`Σ PLATFORM_ESCROW ≥ Σ 未结算托管义务`（**托管不透支**）」——
    // 独立义务来源（`EscrowRecord`）属 P3，但「托管余额不得为负」这一半在 P2 里**是可强制的**，
    // 本条用例看着它。两个方向都在，缺任何一半这条断言都可能只是「怎么都拒」或「怎么都放」：
    //   ① 拒绝方向：释放 `托管余额 + 1` ⇒ 领域错误，托管与卖家两侧都一字未动；
    //   ② 接受方向：释放**恰好**托管余额 ⇒ 成功，且托管归零。
    const buyerId = await realUser();
    const sellerId = await realUser();
    // 先把托管撑起来（发 10000 给买家、全额锁进托管）。断言一律写成**前后差**：
    // 托管是全局共享账户，别的用例也会动它。
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: buyerId, amount: 10_000n, idempotencyKey: `overrelease-topup:${buyerId}` });
      await ledger.lockToEscrow(tx, { buyerId, amount: 10_000n, idempotencyKey: `overrelease-lock:${buyerId}` });
    });
    const escrowNow = await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null);
    expect(escrowNow, '托管余额必须为正，否则「超一分」这个构造没有判别力').toBeGreaterThan(0n);

    // ① **拒绝方向**：多释放 1 分。
    const refusedKey = `overrelease:${sellerId}`;
    await expect(
      prisma.$transaction((tx) =>
        ledger.releaseEscrow(tx, { sellerId, gross: escrowNow + 1n, feeBps: 0, idempotencyKey: refusedKey }),
      ),
    ).rejects.toThrow(InsufficientFundsError);
    // 拒绝必须**什么都没留下**：那笔交易不存在、托管余额一分未动、卖家一分未得。
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: refusedKey } })).toBe(0);
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null)).toBe(escrowNow);
    expect(await ledger.readBalances(prisma, sellerId)).toEqual({ available: 0n, frozen: 0n });

    // ② **接受方向**（同一形状的请求、同一个原语）：释放**恰好**托管余额 ⇒ 成功，托管归零。
    //    没有这一句，上面那条拒绝也可能只是「releaseEscrow 怎么都拒」。
    const okKey = `exactrelease:${sellerId}`;
    const ok = await prisma.$transaction((tx) =>
      ledger.releaseEscrow(tx, { sellerId, gross: escrowNow, feeBps: 0, idempotencyKey: okKey }),
    );
    expect(ok.created).toBe(true);
    expect(await balanceOf(ACCOUNT_KINDS.PLATFORM_ESCROW, null)).toBe(0n);
    expect(await ledger.readBalances(prisma, sellerId)).toEqual({ available: escrowNow, frozen: 0n });
  });

  it('§8.2 行 3 / 悔拍没收由**通用 post** 走通（D12：金额规则属 P4，本用例只把它当参数），kind = FORFEIT', async () => {
    const loserId = await realUser();
    const sellerId = await realUser();
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
    const payerId = await realUser();
    const receiverId = await realUser();
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
    const userId = await realUser();
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

  it('★ 解冻的借方守卫对 `USER_FROZEN` **同样**成立（确定性构造：预判放行、由受影响行数拦下 ⇒ stage = conditional-update）', async () => {
    // 为什么单独要这一条：`applyBalances` 的余额守卫是**条件化**的——
    // `isUserAccountKind(kind) ? {id, balance: {gte: x}} : {id}`。已有的并发用例
    // （postings.test.ts 的「并发扣款」与那条确定性用例）借的都是 `USER_AVAILABLE`，
    // 而 `unfreeze` 借的是 `USER_FROZEN` ⇒ 「守卫对冻结余额也生效」这件事**今天没有任何见证**：
    // 把守卫收窄成「只有 USER_AVAILABLE 才带 balance >= x」，整个套件一条都不会红
    // （探针 **p-frozen-guard**：删掉它 ⇒ 恰好这一条变红）。
    // 后果不是账面好看不好看：那会让**冻结余额被透支**（不变式 #3），唯一挡在前面的是
    // 迁移里那条条件化 CHECK，而它经 Prisma 退化成 `DriverAdapterError`（C28 的同一个洞）。
    //
    // 构造是确定性的，不靠 sleep 猜时序（与 postings.test.ts 那条同一形状）：
    //   W：一笔**合法的**解冻（冻结 10000 → 6000），扣款之后把事务挂住 ⇒ 那一行的写锁已持有；
    //   A：另一笔解冻（同样 6000）⇒ 读到的快照是旧的 10000 ⇒ 预判放行 ⇒ 卡在那把行锁上；
    //   观察者逐字确认**等锁的语句就是那条带守卫的 UPDATE**（否则这条用例证明的不是这回事）；
    //   放行 W ⇒ A 的条件更新重新求值（4000 >= 6000 为假）⇒ count = 0 ⇒ conditional-update。
    const userId = await realUser();
    // 两行账户都要先建出来：`grantCredit` 建 `USER_AVAILABLE`、`freeze` 建 `USER_FROZEN`。
    // 不先建的话先到的那个请求会卡在**账户 INSERT** 上，等它提交后另一笔才读快照 ⇒
    // 由纯核心的预判拦下（`predicted`），条件更新那条路一次都走不到（Task 6 的 p1/p2 实测）。
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId, amount: 10_000n, idempotencyKey: `topup:${userId}` });
      await ledger.freeze(tx, { userId, amount: 10_000n, idempotencyKey: `freeze:${userId}` });
    });

    let writerHoldsTheRow!: () => void;
    const writerLocked = new Promise<void>((resolve) => { writerHoldsTheRow = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = prisma.$transaction(
      async (tx) => {
        const result = await ledger.unfreeze(tx, { userId, amount: 6_000n, idempotencyKey: `unfreeze:${userId}:1` });
        writerHoldsTheRow(); // `applyBalances` 的 updateMany 已经发过 ⇒ USER_FROZEN 那一行的写锁已持有
        await gate;          // 事务保持打开：锁不放、改动不提交
        return result;
      },
      { timeout: 20_000 },   // Prisma 交互式事务默认 5 s 超时；显式放宽，免得慢 CI 把它变成超时
    );
    await writerLocked;

    const blocked = prisma.$transaction((tx) =>
      ledger.unfreeze(tx, { userId, amount: 6_000n, idempotencyKey: `unfreeze:${userId}:2` }),
    );

    const observer = new Client({ connectionString: pg.appUri });
    await observer.connect();
    let blockedStatements: string[];
    try {
      blockedStatements = await waitForLockWaiters(observer, 1);
    } finally {
      await observer.end();
    }
    expect(
      blockedStatements.filter((sql) => /UPDATE\s+"ledger"\."accounts"[\s\S]*"balance" >=/.test(sql)),
      `等锁的语句必须**是那条带余额守卫的条件更新**（否则这条用例证明的不是「守卫对冻结余额生效」）。实测等锁语句：${JSON.stringify(blockedStatements)}`,
    ).toHaveLength(1);

    release();
    const rejected = await blocked.then(() => null, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(InsufficientFundsError);
    expect((rejected as InsufficientFundsError).kind).toBe(ACCOUNT_KINDS.USER_FROZEN); // ← 借的是**冻结**那一行
    expect((rejected as InsufficientFundsError).stage).toBe('conditional-update');
    await expect(writer).resolves.toMatchObject({ created: true });
    // 结果方向：恰好一笔生效（冻结 10000 − 6000 = 4000，解冻进可用 6000）。
    expect(await ledger.readBalances(prisma, userId)).toEqual({ available: 6_000n, frozen: 4_000n });
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `unfreeze:${userId}:2` } })).toBe(0);
  }, 120_000);
});
