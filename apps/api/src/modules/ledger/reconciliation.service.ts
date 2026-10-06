import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';

/**
 * 一个**非零余额**账户在报告里的形状。
 *
 * `kind` 是 `string` 而不是 `AccountKind`：报告是**运维读的证物**，不是过账的输入。
 * §8.1 之外的 kind 若真的进了库（只有绕过账本才做得到），这里要把它**原样报出来**，
 * 而不是抛 `UnknownAccountKindError` 让整份报告作废——那正是你会需要这份报告的时刻。
 * （`account-kind.ts` 的 `assertAccountKind` 是**写路径**的执行点：`resolveAccounts` /
 * `loadSnapshots`。读路径刻意不设那道门，见本文件「它看不见什么」第 3 条。）
 */
export interface ReconciliationAccount {
  readonly id: string;
  readonly kind: string;
  readonly ownerUserId: string | null;
  /** 物化余额（**分**）。 */
  readonly balance: bigint;
}

/**
 * 一次对账的结果（不变式 #2 的完整读数）。
 *
 * 判据只有前四个量里的两个：`totalBalance` 与 `totalEntryAmount`（见 `isBalanced`）。
 * `accountCount` / `entryCount` 是**非空转的前提**（「0」在空账本上恒成立），
 * `nonzeroAccounts` 是**给人看的**——系统账户为负是正常的，它不是判据。
 */
export interface ReconciliationReport {
  readonly accountCount: bigint;
  readonly entryCount: bigint;
  /** Σ `accounts.balance`（**分**）。不变式 #2 的左式（设计 §8.3 第 2 条）。 */
  readonly totalBalance: bigint;
  /** Σ `entries.amount` —— 与余额**独立**的第二个量，恒为 0（它同时是不变式 #1 的全局形式）。 */
  readonly totalEntryAmount: bigint;
  /** 余额非零的账户。系统账户为负是**正常**的，因此这里只报出来，不当判据。 */
  readonly nonzeroAccounts: readonly ReconciliationAccount[];
}

/**
 * 一个**逐账户**上的差：物化余额 vs 由分录推导的余额（P3 / Task 5）。
 *
 * 它是 `reconcile()` 那份报告**结构上**给不出的东西：全局报告只有两个标量，
 * 而「钱被搬到了别人的账户上」在这两个标量上**一个字都看不出来**（见 `reconcilePerAccount`）。
 */
export interface PerAccountDrift {
  readonly accountId: string;
  /** 物化余额（**分**）。账户行不存在时为 `0n`（与 `readBalances` 同一条约定，D2）。 */
  readonly materialized: bigint;
  /** `Σ entries.amount`（**分**）。该账户没有任何分录时为 `0n`。 */
  readonly derived: bigint;
  /** `materialized - derived`（**分**）。非 0 就是漂移。 */
  readonly drift: bigint;
}

/**
 * 逐账户对账的完整读数：**四个量 + 恰好有漂移的那些账户**。
 *
 * `drifts` 的契约是「**恰好**有漂移的那些账户」——干净时是**空数组**，不是「一个全是 0 的数组」。
 * 这个区别是判据本身：把没有漂移的账户也放进来，`isPerAccountClean` 就必须自己去过滤，
 * 于是「报告 0 行」这件事会变成「报告 N 行然后被过滤掉」——两者对运维是不同的东西
 * （前者是「没问题」，后者是「有问题但被吞了」）。
 */
export interface PerAccountReport {
  readonly totalBalance: bigint;
  readonly totalEntryAmount: bigint;
  readonly accountCount: bigint;
  readonly entryCount: bigint;
  /** **恰好**有漂移的那些账户（干净时是空数组）。按 `accountId` 升序，报告可以做 diff。 */
  readonly drifts: readonly PerAccountDrift[];
}

/**
 * 对账（设计 §8.3 的不变式 #2：全局 `Σ 所有账户余额 = 0`）—— **P2 / Task 9**。
 *
 * ## 它**不是**每次提交都跑的检查（预检 §B.5 / §B.7 的实测，不是判断）
 *
 * 全表 20 万行求和 **11.2 ms**（对照：一次空查询 1.6 ms）。便宜，但有两条硬理由让它
 * 不能做成触发器：
 * ① 那是 **O(全表)/提交**，而且会把**所有并发过账串行化**（每一笔提交都要读完整张表）；
 * ② 它**拦不住**绕过账本的直接写——预检实测：直接 `UPDATE balance` 之后全库
 *    Σ = 18014398508486383 ≠ 0。触发器挡不住「没人经过它」的写入。
 * ⇒ 不变式 #2 的职责是**事后发现**，不是事前阻止。**这个分工是刻意的，不是妥协**。
 *
 * ## 为什么是**两个**独立的量，而不是一个
 * `Σ accounts.balance`（物化的余额）与 `Σ entries.amount`（唯一的事实来源，C27）是同一个
 * 事实的两条独立记录。**两个同时为 0** 才说明余额没有被绕过账本改动过；只有一个为 0
 * 意味着两者已经**分叉**——那正是要报出来的事。`tests/integration/ledger/reconciliation.test.ts`
 * 的用例 3（余额侧 +1）与用例 6（分录侧非零）**分别**把两个量打成非零，因此
 * `isBalanced` 的**两个合取项各自都有一条会红的见证**，没有一项是装饰。
 *
 * ## ★ 周期性执行者**不在 P2**（计划 D11 / C16）
 * P2 里**没有任何 worker 侧的账本写者**，装一个没人调用它的定时任务属于 C16 意义上的空抽象。
 * **复访触发条件（逐字取自 D11）：worker 第一次真正写账本时（P3 结算），同一次改动里必须
 * 同时加周期执行者。** 在那之前，本类的消费者是集成测试判据与（P5/P6 的）运维入口。
 *
 * ## ★ 它**看不见什么**（据实划界，见 `tests/integration/ledger/reconciliation.test.ts` 的用例 5）
 *
 * 1. **保持 Σ 的改写**。全局零和是**一个数**：它发现得了「总量上多出/少了钱」，
 *    发现不了「钱被搬到了别人的账户上」。实测（同一份用例）：A −300 / B +300 之后，
 *    物化余额已经是 700 / 1300，而按分录推导仍是 1000 / 1000——**每条差 300 分**，
 *    可是两个量一个都没动，`isBalanced` 照样返回 `true`。要看见这件事需要的**不是**
 *    更好的求和，而是**逐账户**的对账：把每个账户的 `Σ entries.amount` 与物化的
 *    `balance` 逐行比对。**那已经落地**（P3 / Task 5 的 `reconcilePerAccount`），
 *    且它带自己的两个方向：漂移 ⇒ 恰好 2 行（±300）、修回去 ⇒ 0 行。
 * 2. **`Σ 分录` 恒为 0 是「不变式 #1 的触发器还在」的推论**，不是本类自己挣来的。
 *    实测（用例 6）：属主在事务里 `SET LOCAL session_replication_role = replica` 之后，
 *    一笔不平衡的分录**真的提交了**，该量立刻变成 −12 345。
 *    ⇒ 这条判据的强度**上限**等于不变式 #1 那道数据库防线的强度。
 * 3. **`kind` 不做校验**：§8.1 之外的 kind（例如 §8.2 里的 `SELLER_AVAILABLE`）若被直接
 *    插进 `ledger.accounts`，**计入 Σ 这件事不会被拦**（I1 之后那条 CHECK 的允许名单
 *    恰好只有 `EXTERNAL_TOPUP`，因此一个未知 kind 落到「必须非负」那一侧：**负余额会被拒，
 *    正余额照收**——数据库无法枚举五个 kind，那是应用层 `assertAccountKind` 的活，C30）。
 *    它只在余额非零时出现在 `nonzeroAccounts` 里。
 *
 * ## 要让违反**不可能**，而不是「可发现」，需要什么（据实说清，不承诺）
 * 今天能绕过的路径是「写 `ledger.accounts` 而不写 `entries`」。三条可行方向，代价各不同：
 * ① **不给 `accounts` 写权限**：把 `balance` 的写入收进一个 `SECURITY DEFINER` 函数，
 *    运行期角色 `app_user` 只能调它——但**属主仍然绕得过**（P0/预检 §B.6 实测：属主的
 *    `REVOKE` 是空操作），因此它把「绕过的门槛」从「一条 UPDATE」抬到「一次 DDL/超级用户」，
 *    不改变「有人能绕过」这个事实。
 * ② **不物化余额**：余额一律由 `Σ entries.amount` 推导 ⇒ 不变式 #2 从「一条要跑的判据」
 *    变成「不变式 #1 的定理」，任何绕过账本的写都**不可能**改动它。代价是两处真实成本：
 *    余额读取从「一次主键查找」变成「一次分组聚合」，以及 C25/D8 那条**条件更新**
 *    （`updateMany(where balance >= x)` + 受影响行数作并发权威）失去落脚点——
 *    那正是 P2 实测过、且唯一不需要重试路径的并发机制（D8 的裁定）。
 * ③ **周期对账 + 告警**（D11 的 P3 落点）：仍然只是「发现」，但它把发现的时间从
 *    「下一次有人跑测试」压到「下一个周期」。
 * **P2 选的是「可发现 + 说清边界」**：以上三条都不是 P2 能付得起的改动，而把边界写成
 * 一条会红的用例（用例 5 / 用例 6）比写一句「已覆盖」诚实。
 */
@Injectable()
export class LedgerReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 读一次账本的全局面（**只读**：本类不写任何一行）。
   *
   * ## 为什么 `sum(...)` 必须 `::text`（本机实测，不是推断）
   * PostgreSQL 的 `sum(bigint)` 返回 **numeric**，而 Prisma 把 numeric 读成 **`Decimal2`
   * 对象**（`typeof === 'object'`，`Object.prototype.toString` = `[object Decimal]`），
   * 不是 `bigint`；`count(*)` 是 int8，Prisma 读成 `bigint`。走 `::text` → `BigInt(...)`
   * 让四个量落在**同一条已实测无损**的路径上，不引入第二套十进制类型。
   *
   * ## `::text` 到底是什么性质的一道保险（实测边界，逐字记录）
   * 在本机量到的数值上，**`BigInt(Decimal2)` 今天是成功的**（`Decimal` 有 `toString()`），
   * 所以去掉 `::text` 在今天的测试数据下**不会红**——它不是「否则会崩」。真正的边界在
   * **量级**上：decimal.js 的 `toExpPos` 让 `toString()` 从 **1e21** 起改用指数形式：
   *
   * ```
   * numeric 1e20            → bare=100000000000000000000 | BigInt(bare) = 100000000000000000000
   * numeric 1e21            → bare=1e+21                 | BigInt(bare) 抛 SyntaxError:
   *                                                        Cannot convert 1e+21 to a BigInt
   * numeric 1e21 ::text     → 1000000000000000000000     | BigInt(text) = 1000000000000000000000
   * ```
   *
   * `bigint` 列本身到不了 1e21（int8 上限 9.22e18），但 `sum()` 返回的是 numeric、
   * **没有上限**——一张 20 万行的表够得着。⇒ `::text` 是「聚合跨过 1e21 时仍然不崩」的
   * 那道保险，也是让返回类型**确定**的选择。（原始输出：`evidence/t9-step0-measure-raw.txt`。）
   *
   * ## 为什么 `COALESCE` 不能省
   * 空集上 `sum()` 返回 **NULL**（实测 `[M6] 空集 无 COALESCE → null`），而
   * `BigInt(null)` 抛 `TypeError`。`0` 这个默认值是「没有分录」与「Σ = 0」等价这件事的落点。
   */
  async reconcile(): Promise<ReconciliationReport> {
    const [balances] = await this.prisma.$queryRaw<{ total: string; n: bigint }[]>`
      SELECT COALESCE(sum("balance"), 0)::text AS total, count(*)::bigint AS n FROM "ledger"."accounts"`;
    const [amounts] = await this.prisma.$queryRaw<{ total: string; n: bigint }[]>`
      SELECT COALESCE(sum("amount"), 0)::text AS total, count(*)::bigint AS n FROM "ledger"."entries"`;
    const nonzeroAccounts = await this.prisma.ledgerAccount.findMany({
      where: { balance: { not: 0n } },
      select: { id: true, kind: true, ownerUserId: true, balance: true },
      // 稳定排序：报告是给人做 diff 的，同一状态两次读出来必须逐条一致。
      orderBy: [{ kind: 'asc' }, { id: 'asc' }],
    });
    return {
      accountCount: balances!.n,
      entryCount: amounts!.n,
      totalBalance: BigInt(balances!.total),
      totalEntryAmount: BigInt(amounts!.total),
      nonzeroAccounts,
    };
  }

  /**
   * 判据：**两个独立的量都必须为 0**。
   *
   * 为什么是 `&&` 而不是只看余额：两者来源不同（物化余额 vs 分录），因此**可以分叉**。
   * 两个合取项各自有一条会红的见证（用例 3 打非零余额侧、用例 6 打非零分录侧）。
   *
   * 为什么是 `static` 而不是实例方法：它**不碰数据库**，只读报告。这样「判据」与
   * 「读数」各自可以单独被检验——测试里可以直接对一个手工构造的报告求值。
   */
  static isBalanced(report: ReconciliationReport): boolean {
    return report.totalBalance === 0n && report.totalEntryAmount === 0n;
  }

  /**
   * ★ **逐账户**对账（P3 / Task 5；预检 §A.2 的实测）—— 与 `reconcile()` 是**两件**读数。
   *
   * ## 为什么必须有它（P2 自己的划界，逐字）
   * 「要看见这件事需要的**不是**更好的求和，而是**逐账户**的对账：把每个账户的
   * `Σ entries.amount` 与物化的 `balance` 逐行比对。」`reconcile()` 只能发现
   * 「总量上多出/少了钱」（实测：直接 `UPDATE balance` 之后全库 Σ ≠ 0），
   * **发现不了**「钱被搬到了别人的账户上」（A −300 / B +300 ⇒ 两个量都没动）。
   *
   * ## 为什么是 `FULL OUTER JOIN` 而不是 `JOIN`
   * 只 `JOIN` 会漏掉**两侧的孤儿**：一个有分录但没有账户行的账户（`INNER JOIN` 下它
   * 根本不出现），以及一个没有任何分录却有余额的账户（看起来完全正常，因为余额是个
   * 合法的数）。前者正是「钱去哪了」最该被抓到的形态，因此 `accounts` 从**左**
   * 全外连出来、`entries` 的聚合从**右**全外连出来。
   *
   * ## 为什么 `COALESCE(…, 0)` 不能省
   * 空集上 `sum()` 返回 **NULL**（P2 实测：`[M6] 空集 无 COALESCE → null`），
   * 而 `BigInt(null)` 抛 `TypeError`。`::text` 的理由与 `reconcile()` 逐字相同
   * （`sum(bigint)` 返回 numeric，Prisma 读成 `Decimal2`；跨过 1e21 时 `toString()`
   * 改指数形式而 `BigInt` 抛 SyntaxError）—— **四个量必须落在同一条已实测无损的路径上**。
   *
   * ## 代价（实测，不是预测）
   * 20 万条分录 / 1 万账户 **40 ms**（P2 的全局判据 8.2 ms）。**★ 据实更正一条计划里的
   * 预期**：D4 / 控制器裁定 ⑥ 加索引时以为这条查询会因此摆脱 `Seq Scan on entries`，
   * 实测**不会**——它要的是**全表** `Σ entries.amount`（按 `account_id` 分组），
   * 而分组必须读每一行；有索引与没索引都是 `Seq Scan on entries` + `HashAggregate`
   * （`evidence/t5-plan-probe-attempt4.txt`：删掉索引之后计划与耗时**逐字不变**，
   * 40.112 ms）。索引的落点是**逐账户**的读法（见 `driftOf`），不是这一条全表读法。
   * ⇒ 这条查询的规模上限由**分录总量**决定，与索引无关；它今天够用是因为 40 ms
   * 远超运维可接受的通知延迟。
   */
  async reconcilePerAccount(): Promise<PerAccountReport> {
    const drifts = await this.prisma.$queryRaw<
      { account_id: string; materialized: string; derived: string; drift: string }[]
    >`
      WITH derived AS (
        SELECT account_id, sum(amount) AS total FROM ledger.entries GROUP BY account_id
      )
      SELECT COALESCE(a.id, d.account_id)::text          AS account_id,
             COALESCE(a.balance, 0)::text                AS materialized,
             COALESCE(d.total, 0)::text                  AS derived,
             (COALESCE(a.balance, 0) - COALESCE(d.total, 0))::text AS drift
        FROM ledger.accounts a
        FULL OUTER JOIN derived d ON d.account_id = a.id
       WHERE COALESCE(a.balance, 0) <> COALESCE(d.total, 0)
       ORDER BY 1
    `;
    const [totals] = await this.prisma.$queryRaw<
      { total_balance: string; total_entry_amount: string; account_count: bigint; entry_count: bigint }[]
    >`
      SELECT COALESCE((SELECT sum(balance) FROM ledger.accounts), 0)::text AS total_balance,
             COALESCE((SELECT sum(amount)  FROM ledger.entries),  0)::text AS total_entry_amount,
             (SELECT count(*) FROM ledger.accounts)::bigint               AS account_count,
             (SELECT count(*) FROM ledger.entries)::bigint                AS entry_count
    `;
    return {
      totalBalance: BigInt(totals!.total_balance),
      totalEntryAmount: BigInt(totals!.total_entry_amount),
      accountCount: totals!.account_count,
      entryCount: totals!.entry_count,
      drifts: drifts.map((row) => ({
        accountId: row.account_id,
        materialized: BigInt(row.materialized),
        derived: BigInt(row.derived),
        drift: BigInt(row.drift),
      })),
    };
  }

  /**
   * ★ **单个账户**的同一笔比对（P3 / Task 5）—— 报告里被点到名之后，运维要钻进去看的那一步。
   *
   * ## 为什么它与 `reconcilePerAccount()` 是**两条查询**而不是一条的过滤版本
   * `reconcilePerAccount()` 必须先做**全表** `GROUP BY account_id` 才知道哪些账户有漂移
   * ——它的成本由分录总量决定（20 万行 40 ms，实测），**加索引也改不掉**（见该方法的注释）。
   * 而「已知是哪个账户之后再看一眼」是**完全不同的形状**：按一个 `account_id` 取值。
   * 这两件事共用一个实现，就等于让「钻进去看一个账户」永远付全表扫描的价钱。
   *
   * ## 索引的落点就是这里（D4 / 控制器裁定 ⑥ 的实测见证）
   * 20 万条分录 / 1 万账户上的实测（`evidence/t5-drill-plan-probe.txt`）：
   *
   * | | 计划 | 耗时 |
   * |---|---|---|
   * | `entries_account_id_idx` 在 | `Bitmap Index Scan on entries_account_id_idx` | **0.174 ms** |
   * | 索引删掉 | `Seq Scan on entries`（两次，两个标量子查询各一次） | **14.512 ms** |
   *
   * ⇒ **83 倍**，而这一条**正是** `pg_indexes` 里那条索引存在的理由。裁定 ⑥ 的原文
   * 「为一个**已交付功能**加索引不是投机抽象，是它的使能条件」在这里成立；
   * 而它对全表那一半**不**成立——那一半的计划两向逐字相同，这一点据实记在上面。
   *
   * ## 返回值：为什么是 `PerAccountDrift | null` 而不是一个永远有值的形状
   * `null` = 「库里的 `accounts` 与 `entries` **都没有**这个 id」——那是**调用方的问题**
   * （问了一个不存在的账户），不是「漂移为 0」。把它折成 `drift: 0n` 会让「账本上没有这个
   * 账户」与「这个账户完全对得上」变成同一个回答，而那正是本项目反复抓的那类合并。
   */
  async driftOf(accountId: string): Promise<PerAccountDrift | null> {
    const rows = await this.prisma.$queryRaw<
      { account_id: string; materialized: string; derived: string; drift: string }[]
    >`
      SELECT a.id::text                                                              AS account_id,
             COALESCE(a.balance, 0)::text                                            AS materialized,
             COALESCE((SELECT sum(e.amount) FROM ledger.entries e WHERE e.account_id = a.id), 0)::text AS derived,
             (COALESCE(a.balance, 0)
                - COALESCE((SELECT sum(e.amount) FROM ledger.entries e WHERE e.account_id = a.id), 0))::text AS drift
        FROM ledger.accounts a
       WHERE a.id = ${accountId}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      accountId: row.account_id,
      materialized: BigInt(row.materialized),
      derived: BigInt(row.derived),
      drift: BigInt(row.drift),
    };
  }

  /**
   * 判据：**三个量都要成立** —— 全局长和为零（不变式 #2）、分录全和为零（不变式 #1 的
   * 全局形式）、且**没有任何一个账户**有漂移。
   *
   * 为什么三个而不是一个：三者来源不同（物化余额 / 分录 / 逐账户比对），因此**可以分叉**。
   * 前两项各有 P2 的用例 3 / 用例 6 看着，第三项由本任务的逐账户用例看着——
   * 三个合取项**各自**都有一条会红的见证，没有一项是装饰。
   *
   * 为什么是 `static` 而不是实例方法：与 `isBalanced` 逐字同源——它**不碰数据库**，
   * 只读报告，因此测试里可以直接对一个手工构造的报告求值。
   */
  static isPerAccountClean(report: PerAccountReport): boolean {
    return (
      report.totalBalance === 0n && report.totalEntryAmount === 0n && report.drifts.length === 0
    );
  }
}
