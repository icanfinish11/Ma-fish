import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@vca/shared';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { AdminDirectory } from '@vca/api/modules/auth/admin-directory.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { LedgerService } from '@vca/api/modules/ledger/ledger.service.js';
import { LedgerReconciliationService } from '@vca/api/modules/ledger/reconciliation.service.js';
import { ACCOUNT_KINDS } from '@vca/api/modules/ledger/core/account-kind.js';
import { TRANSACTION_KINDS } from '@vca/api/modules/ledger/core/types.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 对账（P2 / Task 9）—— **不变式 #2 的真库判据**（设计 §8.3 第 2 条：全局 `Σ 所有账户余额 = 0`）。
 *
 * ## 为什么它只能是对账，不是每次提交的检查（预检 §B.5 / §B.7 的实测）
 *
 * 全表 20 万行求和 **11.2 ms**——便宜，但①那是 **O(全表)/提交**，而且会把所有并发过账**串行化**；
 * ②它**拦不住**绕过账本的直接写（预检实测：直接 `UPDATE balance` 之后全库 Σ = 18014398508486383 ≠ 0）。
 * ⇒ 不变式 #2 的职责是 **事后发现**，不是事前阻止。**周期性执行者属 P3**（计划 D11：
 * P2 里没有任何 worker 侧的账本写者；复访触发条件 = worker 第一次真正写账本时）。
 * 本文件交付的是**可调用的判据**，不是调度器（C16）。
 *
 * ## ★ 本文件的规矩：每条「和为 0」的断言都必须有一条**能看到非零**的伴生证据
 *
 * 「空账本 Σ = 0」这句话有一个众所周知的形态：**一个恒返回 0 的查询也满足它**。
 * 本项目已经为此付过代价（P0 的恒真 `expect([200,429]).toContain(last)`、P1 的「1000 分按 5%
 * 拆分恰好整除」）。因此这里**每一条 0 都配一条「同一个查询、同一个库，注入之后看得见」**：
 *
 * | 断言 | 伴生证据（本文件里） |
 * |---|---|
 * | 空账本 `totalBalance = 0` | 同一容器里直接 +1 ⇒ 同一查询报 `1n`（用例 1 的后半段） |
 * | 非空账本 `totalBalance = 0` | **绕过账本**直接改余额 ⇒ 报不平衡且**指认到具体账户**（用例 3） |
 * | `totalEntryAmount = 0` | 绕开不变式 #1 的延迟触发器 ⇒ 该量报非零（用例 6） |
 *
 * ## ★ 据实记载的边界：这两条判据**看不见什么**
 *
 * 用例 5 把它变成可判定的：**一次保持 Σ 的直接改写（A −300 / B +300）对账完全看不见**——
 * 两个量都不动，`isBalanced` 照样返回 `true`，而库里已经与分录对不上了。
 * 全局求和是**一个数**；它只能发现「总量上多出/少了钱」，发现不了「钱被搬到了别人的账户上」。
 * 见 `reconciliation.service.ts` 文件头的「它看不见什么」一节。
 *
 * ## 装置
 * 每个用例用新的**真实**用户当事人（C1：`grantCredit` 的收款人必须存在于 `auth.users`）
 * ⇒ 互不干扰；对**全局系统账户**的断言一律写成**前后差**。
 * 用例 1 用**自己的** testcontainer（它断言的是「一条分录都没有」的形态，与共享容器互相污染）。
 */
let pg: TestPg;
let prisma: PrismaService;
let ledger: LedgerService;
let recon: LedgerReconciliationService;

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  ledger = new LedgerService(prisma, new AuditService(prisma), new AdminDirectory(prisma));
  recon = new LedgerReconciliationService(prisma);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
});

/**
 * 一个**真的**存在于 `auth.users` 的用户（C1：额度发放的收款人必须存在）。
 *
 * 为什么这些用例不再用 `uuidv7()` 当当事人：审查 C1 之前 `grantCredit` 会给一个
 * `auth.users` 里不存在的 uuid 发额度（账平、五条不变式全绿、**钱永远花不掉**）。
 */
async function realUser(): Promise<string> {
  const user = await prisma.user.create({ data: {} });
  return user.id;
}

/** 某个用户账户的当前余额（`ownerUserId` 传 null 表示系统账户）。 */
async function balanceOf(kind: string, ownerUserId: string | null): Promise<bigint> {
  const rows = await prisma.ledgerAccount.findMany({ where: { kind, ownerUserId }, select: { balance: true } });
  return rows[0]?.balance ?? 0n;
}

/** 某个用户「可用」账户的行 id（账户是惰性创建的，因此调用前必须先有过一笔过账）。 */
async function availableAccountId(userId: string): Promise<string> {
  const row = await prisma.ledgerAccount.findFirst({
    where: { ownerUserId: userId, kind: ACCOUNT_KINDS.USER_AVAILABLE },
    select: { id: true },
  });
  if (!row) throw new Error(`这个用户还没有账户行（构造失败，不是断言失败）：${userId}`);
  return row.id;
}

/**
 * **按分录推导**的账户余额（`Σ entries.amount`）——它与物化的 `accounts.balance` 是两个独立的量。
 *
 * 它在本文件里的用途只有一个：证明用例 5 的「漂移」**真的发生了**。少了它，「对账说平衡」
 * 这句话在「其实什么都没改」的世界里同样成立——那正是本文件开头说的那种空转。
 */
async function derivedBalance(accountId: string): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ d: string }[]>`
    SELECT COALESCE(sum("amount"), 0)::text AS d FROM "ledger"."entries" WHERE "account_id" = ${accountId}::uuid`;
  return BigInt(rows[0]!.d);
}

/** 用例 2 的六行操作序列（§8.2），返回三个当事人。 */
async function runDesignExample(): Promise<{ buyer: string; seller: string; loser: string }> {
  const buyer = await realUser();
  const seller = await realUser();
  const loser = await realUser();
  await prisma.$transaction(async (tx) => {
    await ledger.grantCredit(tx, { userId: buyer, amount: 10_000n, idempotencyKey: `recon:topup:${buyer}` });
    await ledger.freeze(tx, { userId: buyer, amount: 2_000n, idempotencyKey: `recon:freeze:${buyer}` });
    await ledger.unfreeze(tx, { userId: buyer, amount: 2_000n, idempotencyKey: `recon:unfreeze:${buyer}` });
    await ledger.lockToEscrow(tx, { buyerId: buyer, amount: 10_000n, idempotencyKey: `recon:lock:${buyer}` });
    await ledger.releaseEscrow(tx, { sellerId: seller, gross: 10_000n, idempotencyKey: `recon:release:${buyer}` });
    await ledger.grantCredit(tx, { userId: loser, amount: 1_000n, idempotencyKey: `recon:topup:${loser}` });
    await ledger.freeze(tx, { userId: loser, amount: 1_000n, idempotencyKey: `recon:freeze:${loser}` });
    // §8.2 行 3（悔拍没收）：由**通用 `post`** 走通（D12：金额规则属 P4，不建命名包装）。
    await ledger.post(tx, {
      kind: TRANSACTION_KINDS.FORFEIT,
      idempotencyKey: `recon:forfeit:${loser}`,
      moves: [
        {
          from: { kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: loser },
          to: { kind: ACCOUNT_KINDS.PLATFORM_REVENUE, ownerUserId: null },
          amount: 600n,
        },
        {
          from: { kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: loser },
          to: { kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: seller },
          amount: 400n,
        },
      ],
    });
  });
  return { buyer, seller, loser };
}

describe('对账：不变式 #2（全局 Σ 余额 = 0 且 Σ 分录 = 0）', () => {
  it('空账本 ⇒ 0（COALESCE 分支）：同一个查询立刻能看到非零，因此这个 0 不是恒零', async () => {
    // 用**一次性库**断言「一条分录都没有时」的形态：与下面的用例共用容器会互相污染。
    const empty = await startPostgres();
    const emptyPrisma = new PrismaService(empty.appUri);
    await emptyPrisma.$connect();
    const owner = new Client({ connectionString: empty.ownerUri });
    await owner.connect();
    try {
      const emptyRecon = new LedgerReconciliationService(emptyPrisma);
      const report = await emptyRecon.reconcile();

      // ★ 「先验再做」要求的**返回类型实测**（不靠推断）：四个量都必须是 JS `bigint`。
      //   背景（本机实测，原始输出在 evidence/t9-step0-measure-raw.txt）：
      //   `sum(bigint)` 在 PostgreSQL 里是 **numeric**，Prisma 把它读成 `Decimal2` 对象
      //   （`typeof === 'object'`，`Object.prototype.toString` = `[object Decimal]`）；
      //   `count(*)` 是 int8，Prisma 读成 `bigint`。走 `::text` 之后两个都是确定的形态。
      //
      // ★ 为什么这四条排在**数值断言之前**（探针 p-trust-prisma-type 逼出来的顺序）：
      //   把 `::text` 去掉、并且不再 `BigInt(...)` 转换之后，`totalBalance` 变成一个
      //   `Decimal2`。如果数值断言排在前面，先失败的是 `expect(report.totalBalance).toBe(0n)`
      //   （实测消息：`expected 0 to be 0n`），**类型断言根本走不到**——于是它没有独立见证。
      //   排在前面之后，同一次变异红的正是 `expected 'object' to be 'bigint'`。
      expect(typeof report.accountCount).toBe('bigint');
      expect(typeof report.entryCount).toBe('bigint');
      expect(typeof report.totalBalance).toBe('bigint');
      expect(typeof report.totalEntryAmount).toBe('bigint');

      expect(report.accountCount).toBe(3n); // 只有迁移种子化的三个系统账户（D2）
      expect(report.entryCount).toBe(0n);
      expect(report.totalBalance).toBe(0n);
      expect(report.totalEntryAmount).toBe(0n);
      expect(report.nonzeroAccounts).toEqual([]);
      expect(LedgerReconciliationService.isBalanced(report)).toBe(true);

      // ★★ 非空转伴生证据（**同一个查询、同一个库**）：直接给一个种子账户 +1 分。
      await owner.query(`UPDATE ledger.accounts SET balance = balance + 1 WHERE kind = 'EXTERNAL_TOPUP'`);
      const injected = await emptyRecon.reconcile();
      expect(injected.totalBalance).toBe(1n); // ← 查询看得见非零，上面那个 0 不是恒零
      expect(LedgerReconciliationService.isBalanced(injected)).toBe(false);

      // 复原（这个容器随后就被丢掉了，但「能回到 0」本身也是一条方向证据）
      await owner.query(`UPDATE ledger.accounts SET balance = balance - 1 WHERE kind = 'EXTERNAL_TOPUP'`);
      expect(LedgerReconciliationService.isBalanced(await emptyRecon.reconcile())).toBe(true);
    } finally {
      await owner.end().catch(() => undefined);
      await emptyPrisma.$disconnect().catch(() => undefined);
      await empty.stop();
    }
  }, 180_000);

  it('跑完 §8.2 的六行记账示例之后 ⇒ 两个独立的量都是 0（分录数 > 0，说明不是空账本）', async () => {
    // 这条同时是 §13.3 在**真库**上的小样本见证：模型层的 10 万次在 Task 8，
    // 这里证明「真的落库之后」Σ 仍然是 0。
    await runDesignExample();

    const report = await recon.reconcile();
    expect(report.totalEntryAmount).toBe(0n);
    expect(report.totalBalance).toBe(0n);
    expect(LedgerReconciliationService.isBalanced(report)).toBe(true);
    expect(report.entryCount).toBeGreaterThan(0n); // 非空转前提：真的写了分录
  });

  it('★ 绕过账本直接改余额 ⇒ 对账必须报告不平衡，并**指认**到被改的那个账户', async () => {
    // 以**属主**身份直接改（app_user 也能改 accounts——它是可写表；用属主更直接地表达
    // 「有人绕过了账本」）。预检实测：直接 UPDATE balance 后全库 Σ = 18014398508486383 ≠ 0。
    //
    // 为什么受害者是一个**新建的**用户账户而不是随便挑一行：断言要能指认**哪一个**账户，
    // 而「恰好一条余额为 1」这种写法依赖「别的账户恰好没有 1 分」——那是一个跨用例的隐含前提。
    // 这里把它变成身份：我改的是 `victim` 的可用账户，报告里就必须出现 **victim 这一行**。
    const victim = await realUser();
    await prisma.$transaction((tx) =>
      ledger.grantCredit(tx, { userId: victim, amount: 7n, idempotencyKey: `recon:victim:${victim}` }),
    );

    const owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
    try {
      const before = await recon.reconcile();
      // 前提检查（不是断言装饰）：分录侧此刻是平的，因此下面的分叉只能来自我这一次改写。
      expect(before.totalEntryAmount).toBe(0n);

      await owner.query(
        `UPDATE ledger.accounts SET balance = balance + 1
          WHERE owner_user_id = $1::uuid AND kind = 'USER_AVAILABLE'`,
        [victim],
      );

      const after = await recon.reconcile();
      expect(after.totalBalance).toBe(before.totalBalance + 1n); // 余额侧动了
      expect(after.totalEntryAmount).toBe(before.totalEntryAmount); // 分录侧**一点没动** ⇒ 两个量分叉
      expect(LedgerReconciliationService.isBalanced(after)).toBe(false);

      // 报告要能**指认**是哪个账户，否则运维拿到的是一句没有下文的「不相等」。
      const hit = after.nonzeroAccounts.filter((a) => a.ownerUserId === victim);
      expect(hit).toHaveLength(1);
      expect(hit[0]!.kind).toBe(ACCOUNT_KINDS.USER_AVAILABLE);
      expect(hit[0]!.balance).toBe(8n); // 7 + 1，逐分对得上
      expect(hit[0]!.id).toBe(await availableAccountId(victim));
    } finally {
      // 复原：别的用例共享同一个 testcontainer 的 Σ=0 前提。
      await owner.query(
        `UPDATE ledger.accounts SET balance = balance - 1
          WHERE owner_user_id = $1::uuid AND kind = 'USER_AVAILABLE'`,
        [victim],
      );
      expect(LedgerReconciliationService.isBalanced(await recon.reconcile())).toBe(true);
      await owner.end();
    }
  });

  it('余额非零的**系统**账户不得被当成异常（`PLATFORM_*` / `EXTERNAL_TOPUP` 天然为负）', async () => {
    // 判据只有两个量：`nonzeroAccounts` 是**给人看的**，不是判据。
    // 这条用例把这件事写死，免得下一个人把「有非零账户」当成失败条件。
    // ★ P2 最终审查 I1 的措辞更正：「系统账户天然为负」这句话**只对注入端成立**——
    //   `PLATFORM_ESCROW` / `PLATFORM_REVENUE` 今天不允许为负（`mayGoNegative()` 的名单
    //   恰好只有 `EXTERNAL_TOPUP`）。本用例真正说的是「非零**不是**失败条件」，
    //   负余额这一半由读路径**原样报出来**（正是这条断言看的东西）。
    const userId = await realUser();
    await prisma.$transaction((tx) =>
      ledger.grantCredit(tx, { userId, amount: 1n, idempotencyKey: `recon:system-visible:${userId}` }),
    );

    const report = await recon.reconcile();
    const systemRows = report.nonzeroAccounts.filter((a) => a.ownerUserId === null);
    expect(systemRows.length).toBeGreaterThan(0);
    expect(systemRows.some((a) => a.balance < 0n)).toBe(true); // EXTERNAL_TOPUP 为负是**正常**的
    expect(report.nonzeroAccounts.some((a) => a.ownerUserId === userId && a.balance === 1n)).toBe(true);
    expect(LedgerReconciliationService.isBalanced(report)).toBe(true);
  });

  it('★ 据实记载的边界一：**保持 Σ** 的直接改写（A −300 / B +300）对账看不见', async () => {
    // 全局零和是**一个数**。它只能发现「总量上多出/少了钱」，发现不了「钱被搬到了别的账户上」。
    // 这条用例把那个边界变成可判定的，并且**同时证明漂移真的发生了**（否则「对账说平衡」
    // 在「其实什么都没改」的世界里同样成立——那正是本文件开头说的那种空转）。
    const a = await realUser();
    const b = await realUser();
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: a, amount: 1_000n, idempotencyKey: `recon:drift-a:${a}` });
      await ledger.grantCredit(tx, { userId: b, amount: 1_000n, idempotencyKey: `recon:drift-b:${b}` });
    });
    const accountA = await availableAccountId(a);
    const accountB = await availableAccountId(b);

    const owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
    try {
      const before = await recon.reconcile();
      await owner.query(`UPDATE ledger.accounts SET balance = balance - 300 WHERE id = $1::uuid`, [accountA]);
      await owner.query(`UPDATE ledger.accounts SET balance = balance + 300 WHERE id = $1::uuid`, [accountB]);
      const after = await recon.reconcile();

      // ① 漂移是真的：物化余额已经与分录对不上（每条 300 分）。
      expect(await balanceOf(ACCOUNT_KINDS.USER_AVAILABLE, a)).toBe(700n);
      expect(await balanceOf(ACCOUNT_KINDS.USER_AVAILABLE, b)).toBe(1_300n);
      expect(await derivedBalance(accountA)).toBe(1_000n);
      expect(await derivedBalance(accountB)).toBe(1_000n);
      expect((await derivedBalance(accountA)) - (await balanceOf(ACCOUNT_KINDS.USER_AVAILABLE, a))).toBe(300n);
      expect((await derivedBalance(accountB)) - (await balanceOf(ACCOUNT_KINDS.USER_AVAILABLE, b))).toBe(-300n);

      // ② 而不变式 #2（全局 Σ）**两个量都不动**，因此它报「平衡」。
      //    ——这一条是**据实记载的边界**，不是「通过」：它记录的是这条判据的能力上限。
      expect(after.totalBalance).toBe(before.totalBalance);
      expect(after.totalEntryAmount).toBe(before.totalEntryAmount);
      expect(LedgerReconciliationService.isBalanced(after)).toBe(true); // ← 看不见
    } finally {
      await owner.query(`UPDATE ledger.accounts SET balance = balance + 300 WHERE id = $1::uuid`, [accountA]);
      await owner.query(`UPDATE ledger.accounts SET balance = balance - 300 WHERE id = $1::uuid`, [accountB]);
      expect(LedgerReconciliationService.isBalanced(await recon.reconcile())).toBe(true);
      await owner.end();
    }
  });

  it('★ 据实记载的边界二：`Σ 分录` 是「不变式 #1 的触发器还在」的**推论**，把触发器绕开它就非零', async () => {
    // 为什么必须有这一条：`totalEntryAmount` 在本文件里**每一条用例都是 0**——一个恒为 0 的
    // 查询也能满足它。它是真判据的前提是「每一笔交易的 Σ 腿 = 0」由延迟约束触发器守着
    // （不变式 #1 的数据库强制点，Task 4 交付）。这里把那道防线**临时**绕开一次，
    // 让这个量真的非零，从而证明：① 查询看得见非零；② `isBalanced` 的第二个合取项有牙。
    //
    // 怎么绕：属主（testcontainer 的 `vca_owner` 是超级用户）在事务里 `SET LOCAL
    // session_replication_role = replica`——它让非 replica 触发器不触发，因此 COMMIT 时刻
    // 那次「Σ 腿 = 0」的检查不发生。这是**越权**动作（运行期角色 `app_user` 做不到），
    // 正因如此它精确地对应「有人绕过了账本」；用完立刻删掉那两行。
    const owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
    const txId = uuidv7();
    try {
      const before = await recon.reconcile();
      expect(before.totalEntryAmount).toBe(0n); // 前提：此刻分录侧是平的

      await owner.query('BEGIN');
      await owner.query(`SET LOCAL session_replication_role = replica`);
      await owner.query(
        `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1::uuid, 'PROBE', $2)`,
        [txId, `recon:probe-unbalanced:${txId}`],
      );
      await owner.query(
        `INSERT INTO ledger.entries (id, transaction_id, account_id, amount)
          SELECT $1::uuid, $2::uuid, a.id, -12345 FROM ledger.accounts a WHERE a.kind = 'PLATFORM_ESCROW'`,
        [uuidv7(), txId],
      );
      await owner.query('COMMIT');

      const after = await recon.reconcile();
      expect(after.totalEntryAmount).toBe(-12_345n); // ← 这个量看得见非零
      expect(after.totalBalance).toBe(before.totalBalance); // 余额侧没动 ⇒ 两个量分叉
      expect(after.entryCount).toBe(before.entryCount + 1n);
      expect(LedgerReconciliationService.isBalanced(after)).toBe(false); // ← 第二个合取项在这里有牙

      // 对照：**同样**的插入不放宽 `session_replication_role` ⇒ 在 COMMIT 被触发器拒绝。
      const strictTxId = uuidv7();
      await expect(
        (async () => {
          await owner.query('BEGIN');
          await owner.query(
            `INSERT INTO ledger.transactions (id, kind, idempotency_key) VALUES ($1::uuid, 'PROBE', $2)`,
            [strictTxId, `recon:probe-strict:${strictTxId}`],
          );
          await owner.query(
            `INSERT INTO ledger.entries (id, transaction_id, account_id, amount)
              SELECT $1::uuid, $2::uuid, a.id, -12345 FROM ledger.accounts a WHERE a.kind = 'PLATFORM_ESCROW'`,
            [uuidv7(), strictTxId],
          );
          await owner.query('COMMIT');
        })(),
      ).rejects.toThrow(/借贷不平衡|23514/);
      await owner.query('ROLLBACK');
    } finally {
      // 复原：先删分录再删交易（外键是 ON DELETE RESTRICT）。删分录时触发器**会**触发，
      // 但那时那笔交易已经一条分录都不剩 ⇒ Σ = 0 ⇒ 放行。
      await owner.query(`DELETE FROM ledger.entries WHERE transaction_id = $1::uuid`, [txId]);
      await owner.query(`DELETE FROM ledger.transactions WHERE id = $1::uuid`, [txId]);
      expect(LedgerReconciliationService.isBalanced(await recon.reconcile())).toBe(true);
      await owner.end();
    }
  });

  it('报告的形状：只含**非零余额**的行，且按 (kind, id) 稳定排序（两次读出来逐条相同）', async () => {
    // 两件事各有一个理由：
    // ① 「只含非零行」——`nonzeroAccounts` 的过滤条件如果被改空（`where: {}`），报告里会混进
    //    一堆 0 余额的行。按身份过滤（`filter(a => a.ownerUserId === victim)`）**看不见**这件事，
    //    所以判据必须是「**每一条**的余额都不为 0」。
    // ② 「稳定排序」——报告是给人做 diff 的，同一状态两次读出来的顺序必须一致。
    // 自带的非空转前提：先用两个新当事人造出至少两行非零余额，否则 `every(...)` 在空数组上恒真。
    const a = await realUser();
    const b = await realUser();
    await prisma.$transaction(async (tx) => {
      await ledger.grantCredit(tx, { userId: a, amount: 5n, idempotencyKey: `recon:shape-a:${a}` });
      await ledger.grantCredit(tx, { userId: b, amount: 9n, idempotencyKey: `recon:shape-b:${b}` });
    });

    const first = await recon.reconcile();
    const second = await recon.reconcile();

    expect(first.nonzeroAccounts.length).toBeGreaterThanOrEqual(3); // 至少：EXTERNAL_TOPUP + a + b
    expect(first.nonzeroAccounts.every((row) => row.balance !== 0n)).toBe(true);
    expect(second.nonzeroAccounts.map((row) => row.id)).toEqual(first.nonzeroAccounts.map((row) => row.id));
    const keys = first.nonzeroAccounts.map((row) => `${row.kind}|${row.id}`);
    expect(keys).toEqual([...keys].sort());
  });
});
