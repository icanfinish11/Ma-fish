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
 *    `balance` 逐行比对（`derivedBalance` 那种查询）。那是 P3 加周期执行者时**同一次**
 *    要一并落地的东西——本类的形状（一份报告 + 一个判据）留得下它。
 * 2. **`Σ 分录` 恒为 0 是「不变式 #1 的触发器还在」的推论**，不是本类自己挣来的。
 *    实测（用例 6）：属主在事务里 `SET LOCAL session_replication_role = replica` 之后，
 *    一笔不平衡的分录**真的提交了**，该量立刻变成 −12 345。
 *    ⇒ 这条判据的强度**上限**等于不变式 #1 那道数据库防线的强度。
 * 3. **`kind` 不做校验**：§8.1 之外的 kind（例如 §8.2 里的 `SELLER_AVAILABLE`）若被直接
 *    插进 `ledger.accounts`，迁移里那条**条件化** CHECK 对它**不成立**（它只点名
 *    `USER_AVAILABLE` / `USER_FROZEN` 两个值），于是这一行会**正常地**计入 Σ，
 *    负余额也不会被拒。它只在余额非零时出现在 `nonzeroAccounts` 里。
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
}
