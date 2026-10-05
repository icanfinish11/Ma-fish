import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ACCOUNT_KINDS, isUserAccountKind, type AccountKind,
} from '@vca/api/modules/ledger/core/account-kind.js';
import { computeFeeSplit } from '@vca/api/modules/ledger/core/fee-split.js';
import { applyPosting, movesToLegs } from '@vca/api/modules/ledger/core/posting.js';
import type { AccountRef, AccountSnapshot, MoneyMove, PostingLeg } from '@vca/api/modules/ledger/core/types.js';
import { POSTINGS_PER_SEQUENCE, PROPERTY_NUM_RUNS } from './property-config.js';

/**
 * 五条不变式的**随机序列**属性测试（设计 §8.3 / §13.3；计划 Task 8）——P2 的第一条验收判据。
 *
 * ## 这里断言的是**模型**，不是**约束**（预检 §D.7 / §B.7，不得含糊）
 *
 * 五条不变式各有几个执行者，本文件只承担其中一层。逐条如实：
 *
 * | # | 不变式 | 谁强制 / 谁断言 | 本文件是否承担 |
 * |---|---|---|---|
 * | 1 | 每笔交易 `Σ借 = Σ贷` | ① 应用侧显式断言（`applyPosting` / `postLegs`，产生稳定领域错误）② 迁移里那条 `DEFERRABLE` 约束触发器（COMMIT 时刻的回退防线，D7）③ **本文件的模型**（逐笔断言腿和恒为 0、腿数 ≥ 2、无零金额腿） | ✅ 第 ③ 层 |
 * | 2 | 全局 `Σ 所有账户余额 = 0` | **对账**（Task 9 的真库判据；预检 §B.5 实测：全表求和 11.2 ms / 20 万行，但**不能**每次提交都跑，也拦不住绕过账本的直接写） | ⚠️ 只有模型层（内存里 Σ = 0）。**真库的那一半属 Task 9，不在本文件** |
 * | 3 | `USER_AVAILABLE ≥ 0` 且 `USER_FROZEN ≥ 0` | 条件化 `CHECK`（库）+ 条件更新（并发权威，C25/D8）+ 纯核心预判（领域错误） | ✅ 模型层（用 `applyPosting` 的预判） |
 * | 4 | `Σ PLATFORM_ESCROW ≥ Σ 未结算托管义务` | **跨模块**：义务的**独立**来源是 P3 的托管记录（`EscrowRecord`，D3/C29/C5 禁止跨 schema 表达）——**P2 没有它** | ⚠️ 只有**代理残差**，见下 |
 * | 5 | 分录 append-only | 逐表 `REVOKE` + 双角色 + 运行期角色断言（Task 3/4） | ❌ 与本文件无关（DB 层） |
 *
 * ## ★ 不变式 #4：为什么是**等式残差**，而不是 §8.3 的「≥」（不许悄悄改回那条恒真断言）
 *
 * §8.3 的原文是「`Σ PLATFORM_ESCROW ≥ Σ 所有未结算托管义务`」。在 P2 的模型里，义务侧只有
 * 一个**代理量**（`locked`：谁锁了多少还没释放），它与托管余额在**同一次** `apply()` 里被
 * **同一个** `gross` 同向移动、且初值都是 0 ⇒ 原文那条 `expect(escrowTotal).toBeGreaterThanOrEqual(obligation)`
 * **只能是 `x >= x`**，是一条**不可能失败**的断言（计划的自审第 4 条核过；本任务另用一条
 * 真测量证明它：把 `computeFeeSplit` 改成两侧各自向下取整——那条**会让等式残差变红**的变异
 * ——`≥` 形态依然全绿）。
 *
 * P2 里站得住的是**等式残差**：`escrowTotal − obligation === 0`（「托管实际动了多少」必须等于
 * 「义务登记动了多少」）。它比较的是两个**可以分叉**的量：左边由**腿**驱动（`movesToLegs` +
 * `applyPosting`），右边由**操作**驱动（`operation.gross`），而它们分叉正是「释放漏了一条腿」
 * 或「拆分不再守恒」的形状。
 *
 * ⇒ **据实记载的限制**：§8.3 那个「≥」需要**独立的**义务来源，P2 没有（D3：不建 `EscrowRecord`；
 * C5：不跨 schema）。P3 的托管记录落地时，这条不变式才恢复它在 §8.3 里的原义。
 *
 * ## 反 vacuity（本仓库反复抓到的那类缺陷）
 *
 * 一条「不可能失败」的属性比没有属性更坏——它让人以为某件事被看着。因此除了主属性之外还有
 * 三条**覆盖率**用例（用固定种子抽样，可复现）：每一类操作都必须**被接受**过；拒绝路径必须
 * 真的被行使过；#4 的残差必须不是「0 减 0」（抽样里真的有带手续费的释放）。
 *
 * ## 预算与热路径的写法
 *
 * 预算 = `PROPERTY_NUM_RUNS`（10 万）× `POSTINGS_PER_SEQUENCE`（20 笔）= 设计 §13.3 要求的
 * 「≥10 万次随机交易序列，每次 20 笔」——**一个数都没有下调**。
 * 每个操作之后都断言一遍不变式，因此在 10 万次运行里 `assertModelInvariants` 会被调用
 * **200 万次**。热路径里用 `if (…) throw new Error(…)` 而不是 `expect(…)`：判据一字不减，
 * 只是不去构造 vitest 的断言对象（实测的差额见任务报告；`expect` 在这个调用量下会成为
 * 主要成本，而`testTimeout: 300_000` 是承重的、不是可以随便烧的）。覆盖率那三条不在热路径上，
 * 照常用 `expect`。
 *
 * ## 生成器**到不了**的地方（据实划界，别把它读成「全覆盖」）
 *
 * * 不经过 `LedgerService`：没有 SQL、没有条件更新、没有幂等键、没有审计行、没有并发交错、
 *   没有 `kind` 落库（那些各有真库用例：`tests/integration/ledger/*`）。预检 §D.7 的分工就是
 *   这样划的——属性测试覆盖**纯逻辑**。
 * * `movesOf` 是五个原语**资金转移形状**的镜像，不是它们的调用方（原语要 `Prisma.TransactionClient`）。
 *   两者共用同一个纯核心（`movesToLegs` / `applyPosting` / `computeFeeSplit`），但「原语把方向写反了」
 *   这类错误**本文件看不见**——那由 Task 7 的 11 条真库用例与探针看着。
 * * §8.2 第 3 行（悔拍没收 `DR USER_FROZEN CR PLATFORM_REVENUE + 另一用户的 USER_AVAILABLE`）
 *   **不在生成器里**：它没有命名原语（D12：金额规则属 P4），是通用 `post` 的形状。
 *   本生成器因此**到不了**「钱在用户之间转移（不经过托管）」这条路径。
 * * `feeBps` 的上界取 20 000（> 10⁴ ⇒ 钳制分支被行使）；`computeFeeSplit` 的**全域**（含
 *   `bps` 到 100 000）由 `tests/property/ledger-fee-split.test.ts` 承担，本文件不重复。
 */

/** 一个随机操作。金额刻意从 **0** 开始：0 金额必须被应用层拒（`movesToLegs` 的 `InvalidAmountError`）。 */
type Operation =
  | { op: 'TOPUP'; user: string; amount: bigint }
  | { op: 'FREEZE'; user: string; amount: bigint }
  | { op: 'UNFREEZE'; user: string; amount: bigint }
  | { op: 'ESCROW_LOCK'; user: string; amount: bigint }
  | { op: 'ESCROW_RELEASE'; user: string; gross: bigint; feeBps: number };

interface Model {
  /** 账户快照，键 = `modelKey`（与纯核心的 `accountKey` 同形）。 */
  readonly accounts: Map<string, AccountSnapshot>;
  /** `id → modelKey`（`applyPosting` 只回 id）。 */
  readonly idToKey: Map<string, string>;
  /** 义务侧：userId → 已锁进托管、尚未释放的金额（#4 的右式）。 */
  readonly locked: Map<string, bigint>;
  readonly stats: { readonly applied: Record<string, number>; readonly rejected: Record<string, number> };
  /** 已应用释放累计的手续费（#4 的**非平凡性**锚点：它必须 > 0，残差才不是「0 减 0」）。 */
  feeCharged: bigint;
  /** 最近一个操作（只在断言失败时用来构造消息，热路径上不建字符串）。 */
  lastOperation: Operation | null;
}

/**
 * 两个用户（**实测驱动**）：链式操作（冻结→解冻、进托管→释放）要求**同一个用户**先把钱锁住。
 * 序列只有 20 笔，用户越多、每个用户分到的操作越少 ⇒ 链条越难成立。实测（同一份种子、
 * 同一套权重，只改用户数）：4 个用户时 10 000 笔里只有 **30** 次带手续费的释放，
 * 2 个用户时是 **89** 次。两个用户仍然保留「跨用户的隔离」这条路径
 * （另一个用户没有锁却发起释放 ⇒ `NoOutstandingLock`，实测被拒 1 202 次）。
 */
const USERS = ['u0', 'u1'] as const;

/** 模型里账户的唯一身份键（与 `accountKey` 同形：kind + owner，系统账户 owner 记为 `-`）。 */
const modelKey = (ref: { kind: AccountKind; ownerUserId: string | null }): string =>
  `${ref.kind}:${ref.ownerUserId ?? '-'}`;

const escrowRef = { kind: ACCOUNT_KINDS.PLATFORM_ESCROW, ownerUserId: null } as const;
const revenueRef = { kind: ACCOUNT_KINDS.PLATFORM_REVENUE, ownerUserId: null } as const;
const topupRef = { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null } as const;
const availRef = (user: string): AccountRef => ({ kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: user });
const frozenRef = (user: string): AccountRef => ({ kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: user });

/**
 * 金额生成器：**四个分支，边界值与小额都被刻意抬高**。
 *
 * 这不是「调参直到绿」——两个理由都是**量出来的**（三次实测的完整分布见任务报告）：
 *
 * 1. **边界值必须够密**。均匀取 `[0, 10⁶]` 时 `amount = 0` 的概率是 1e-6 ⇒「零金额必须被拒过」
 *    那条覆盖率断言在 500 条序列（10 000 笔）里期望出现 0.01 次，**实际上永远不会红**——
 *    那正是本项目反复抓到的「不可能失败的断言」。
 * 2. **序列必须真的累积出状态**。若金额都取 10⁶ 量级，绝大多数冻结 / 托管 / 释放会因为
 *    「余额不足」被拒（实测：等权 + 4 个用户时只有 **18%** 的操作被接受，带手续费的释放
 *    在 10 000 笔里只有 **22** 次）——那样五条不变式虽然每一步都断言，却几乎全在**没有变化的
 *    模型**上成立，接近空洞。抬高小额分支（并且见下面「两个用户」的理由）之后，同一份种子下
 *    实测：接受率 **31%**、带手续费的释放 **89** 次 / 10 000 笔。
 *
 * 零与一各自成支，是因为它们是最容易出错的边界：0 走 `InvalidAmountError`（应用层拒绝，库里那条
 * 条件化 CHECK 对它放行），1 走「手续费向上取整吃掉全款、净额腿不构造」那条分支。
 */
const amountArb = fc.oneof(
  fc.constant(0n),
  fc.constant(1n),
  fc.bigInt({ min: 0n, max: 100n }),
  fc.bigInt({ min: 0n, max: 10n ** 6n }),
);

/** 操作类型：**充值被刻意加权**（它是唯一的资金来源——见下面 `opArb` 的注释）。 */
type OperationKind = 'TOPUP' | 'FREEZE' | 'UNFREEZE' | 'ESCROW_LOCK' | 'ESCROW_RELEASE';

/**
 * 操作类型的权重：`TOPUP` 出现 3 次、其余各 2 次（**实测驱动**，理由见报告）。
 *
 * 五类等权时，20 笔的序列里只有约 4 笔充值，而充值又随机落到用户之一、金额还可能是 0 ⇒
 * 实测只有 **18%** 的操作被接受，其余全部是「余额不足 / 零金额 / 没有对应的锁」。
 * 充值是这套模型里唯一的资金来源，把它按真实业务里的频率（每次成交前都有一次入账）
 * 抬到 3/11 之后，真正的状态转移（冻结 / 解冻 / 进托管 / 带手续费释放）才成为序列的主体。
 */
const opKindArb = fc.constantFrom<OperationKind>(
  'TOPUP', 'TOPUP', 'TOPUP',
  'FREEZE', 'FREEZE',
  'UNFREEZE', 'UNFREEZE',
  'ESCROW_LOCK', 'ESCROW_LOCK',
  'ESCROW_RELEASE', 'ESCROW_RELEASE',
);

const opArb: fc.Arbitrary<Operation> = fc
  .tuple(opKindArb, fc.constantFrom(...USERS), amountArb, fc.nat({ max: 20_000 }))
  .map(([op, user, amount, feeBps]): Operation => {
    switch (op) {
      case 'TOPUP':
      case 'FREEZE':
      case 'UNFREEZE':
      case 'ESCROW_LOCK':
        return { op, user, amount };
      // 费率上界 20 000（> 10⁴ ⇒ `computeFeeSplit` 的上限钳制分支被行使到）；
      // 它的**全域**（bps 到 100 000）由 `ledger-fee-split.test.ts` 承担，本文件不重复。
      case 'ESCROW_RELEASE':
        return { op, user, gross: amount, feeBps };
    }
  });

/** 一条序列 = 20 个操作（`POSTINGS_PER_SEQUENCE`，口径与设计 §13.3 的「每次 20 笔」一致）。 */
const sequenceArb: fc.Arbitrary<Operation[]> = fc.array(opArb, {
  minLength: POSTINGS_PER_SEQUENCE,
  maxLength: POSTINGS_PER_SEQUENCE,
});

/** 覆盖率用例的种子与规模：**固定种子** ⇒ 覆盖率断言是可复现的，不会偶尔红。 */
const SAMPLE_SEED = 20_261_006;
const SAMPLE_SEQUENCES = 500;

function freshModel(): Model {
  const accounts = new Map<string, AccountSnapshot>();
  const idToKey = new Map<string, string>();
  const add = (ref: AccountRef, id: string): void => {
    accounts.set(modelKey(ref), { ...ref, id, balance: 0n });
    idToKey.set(id, modelKey(ref));
  };
  add(escrowRef, 'sys-escrow');
  add(revenueRef, 'sys-revenue');
  add(topupRef, 'sys-topup');
  for (const user of USERS) {
    add(availRef(user), `avail-${user}`);
    add(frozenRef(user), `frozen-${user}`);
  }
  return { accounts, idToKey, locked: new Map(), stats: { applied: {}, rejected: {} }, feeCharged: 0n, lastOperation: null };
}

/** 一个操作展开成的转移（纯数据）+ 这次释放的手续费。 */
function movesOf(operation: Operation): { moves: MoneyMove[]; fee: bigint } {
  switch (operation.op) {
    case 'TOPUP':
      return { moves: [{ from: topupRef, to: availRef(operation.user), amount: operation.amount }], fee: 0n };
    case 'FREEZE':
      return { moves: [{ from: availRef(operation.user), to: frozenRef(operation.user), amount: operation.amount }], fee: 0n };
    case 'UNFREEZE':
      return { moves: [{ from: frozenRef(operation.user), to: availRef(operation.user), amount: operation.amount }], fee: 0n };
    case 'ESCROW_LOCK':
      return { moves: [{ from: availRef(operation.user), to: escrowRef, amount: operation.amount }], fee: 0n };
    case 'ESCROW_RELEASE': {
      const { fee, net } = computeFeeSplit(operation.gross, operation.feeBps);
      const moves: MoneyMove[] = [];
      // 零额的那条转移**不构造**（Task 7 实测：`movesToLegs` 会以 InvalidAmountError 拒 0 金额；
      // 库里的 `entries_amount_nonzero` 也拦）。于是「手续费腿在不在」这件事是可判定的。
      if (net > 0n) moves.push({ from: escrowRef, to: availRef(operation.user), amount: net });
      if (fee > 0n) moves.push({ from: escrowRef, to: revenueRef, amount: fee });
      return { moves, fee };
    }
  }
}

/** 把一条操作写成一行（**只在断言失败时**调用）。 */
function describeOperation(operation: Operation | null): string {
  if (operation === null) return '<无>';
  switch (operation.op) {
    case 'ESCROW_RELEASE':
      return `${operation.op}(${operation.user}, gross=${operation.gross.toString()}, bps=${String(operation.feeBps)})`;
    default:
      return `${operation.op}(${operation.user}, ${operation.amount.toString()})`;
  }
}

/** 一次应用的结果：要么被领域错误**拒**（记下错误名），要么成了一笔。 */
type ApplyOutcome = { readonly rejected: string } | { readonly applied: true };

/** 把一个操作应用到模型上；**被拒（领域错误）是合法结果**，只记 stats（等价于真库里的事务回滚）。 */
function applyOperation(model: Model, operation: Operation): void {
  // 先记下当前操作：下面两条断言都会把它写进失败消息，而它在任何断言之前就必须是对的。
  model.lastOperation = operation;
  const outcome = tryApply(model, operation);
  if ('rejected' in outcome) {
    // 键里必须带**错误名**：否则「余额不足被拒过」与「零金额被拒过」在统计上分不开，
    // 拒绝覆盖率那条用例就只能数「有没有被拒」，那是一个弱得多的判据。
    const key = `${operation.op}:${outcome.rejected}`;
    model.stats.rejected[key] = (model.stats.rejected[key] ?? 0) + 1;
  } else {
    model.stats.applied[operation.op] = (model.stats.applied[operation.op] ?? 0) + 1;
    // （#1 的模型断言不在这里：它在 `tryApply` 里、`applyPosting` 之前——理由见那里的注释。）
  }
  assertModelInvariants(model);
}

/**
 * 尝试应用一个操作。返回腿（成功）或被拒的**领域错误名**。
 *
 * **只有** `movesToLegs` / `applyPosting` 的领域错误会被吞掉并算作「被拒」；模型上的写入
 * （余额回写、义务登记）在 try **之外**，因此写回路径上的任何异常都会直接让属性变红。
 */
function tryApply(model: Model, operation: Operation): ApplyOutcome {
  // 释放**只能**针对已锁进托管、尚未释放的金额（义务侧不得为负——见 assertModelInvariants 的 #4）
  if (operation.op === 'ESCROW_RELEASE' && (model.locked.get(operation.user) ?? 0n) < operation.gross) {
    return { rejected: 'NoOutstandingLock' };
  }

  const { moves, fee } = movesOf(operation);
  const refs = new Map<string, AccountRef>();
  for (const move of moves) {
    refs.set(modelKey(move.from), move.from);
    refs.set(modelKey(move.to), move.to);
  }
  const resolved = [...refs.entries()].map(([key, ref]) => {
    const account = model.accounts.get(key);
    if (!account) throw new Error(`模型里没有账户 ${key}`);
    return { ...ref, id: account.id };
  });
  const snapshots = resolved.map((r) => model.accounts.get(modelKey(r)) as AccountSnapshot);

  let legs: readonly PostingLeg[];
  try {
    legs = movesToLegs(moves, resolved);
  } catch (error) {
    return { rejected: error instanceof Error ? error.name : 'UnknownError' };
  }

  // ★ #1 的模型断言落在**这里**——`applyPosting` **之前**、任何 try **之外**。两个位置都是必需的：
  //   ① 若放在 `applyPosting` 之后：`applyPosting` 的第一句也是平衡断言，它会先把不平衡的腿集
  //      变成一次「被拒」，于是这条断言**永远看不到**任何不平衡的腿集（结构上不可达）；
  //   ② 若放进上面那个 catch：同一件事——我的断言会被当成一次合法的拒绝而**静默吞掉**。
  //   实测：把 `movesToLegs` 的 `assertBalanced(out)` 去掉、并把贷方金额改成 `amount + 1n`
  //   之后，这条断言以 `#1 违反：一笔交易的 Σ腿 = 1 ≠ 0` 变红（探针 p1-unbalanced-legs）。
  assertTransactionBalanced(legs, model);

  let next: Map<string, bigint>;
  try {
    next = applyPosting(snapshots, legs);
  } catch (error) {
    // 到这里只剩「用户账户被扣成负」（#3 的预判）与「腿指向未解析的账户」两类领域错误。
    return { rejected: error instanceof Error ? error.name : 'UnknownError' };
  }

  // 到这里：要么全成、要么什么都没动（与真库的事务回滚同形）。
  for (const [accountId, balance] of next) {
    const key = model.idToKey.get(accountId);
    if (key === undefined) throw new Error(`模型里没有 id=${accountId} 对应的账户`);
    const account = model.accounts.get(key) as AccountSnapshot;
    model.accounts.set(key, { ...account, balance });
  }
  if (operation.op === 'ESCROW_LOCK') {
    model.locked.set(operation.user, (model.locked.get(operation.user) ?? 0n) + operation.amount);
  }
  if (operation.op === 'ESCROW_RELEASE') {
    // 义务侧取自**同一个 operation**（不是从余额反推——反推会让残差恒等于 0，那是同义反复）。
    model.locked.set(operation.user, (model.locked.get(operation.user) ?? 0n) - operation.gross);
    model.feeCharged += fee;
  }
  return { applied: true };
}

/**
 * #1：每笔交易 `Σ腿 = 0`（外加应用层那两条：腿数 ≥ 2、无零金额腿）。
 *
 * **判据的判别力逐条据实说明**（三条都首次即绿，因此都必须有见证——没有见证就说没有）：
 * * 「Σ腿 = 0」**有**独立见证：探针 `p1-unbalanced-legs`（去掉 `movesToLegs` 自己的
 *   `assertBalanced` 并把贷方改成 `amount + 1n`）实测让它以 `Σ腿 = 1 ≠ 0` 变红。
 * * 「无零金额腿」**有**独立见证：探针 `p1-zero-leg`（同时去掉 `movesToLegs` 的净额为零
 *   检查与转账金额检查）实测让它以「零金额腿」变红。
 * * 「腿数 ≥ 2」**没有**独立见证：要让它单独变红，得让 `movesToLegs` 产出一个长度 < 2
 *   而和又为 0 的腿集——那只有「一条 0 金额腿」或「空数组」两种形状，前者已被上面那条
 *   零金额断言吃掉、后者被 `movesToLegs` 的 `EmptyPostingError` 转成一次合法拒绝。
 *   **它留着是因为它把「一笔交易至少两条腿」这句话写在了断言里**（预检 B.2 的场景 3/4：
 *   库里对空事务与 0 金额单腿都放行），但它今天不是承重的那一道——据实记载，不包装成守卫。
 */
function assertTransactionBalanced(legs: readonly PostingLeg[], model: Model): void {
  const where = `操作：${describeOperation(model.lastOperation)}`;
  let sum = 0n;
  for (const leg of legs) {
    if (leg.amount === 0n) throw new Error(`#1 违反：出现零金额腿（accountId=${leg.accountId}）｜${where}`);
    sum += leg.amount;
  }
  if (sum !== 0n) throw new Error(`#1 违反：一笔交易的 Σ腿 = ${sum.toString()} ≠ 0｜${where}`);
  if (legs.length < 2) throw new Error(`#1 违反：一笔交易只有 ${String(legs.length)} 条腿｜${where}`);
}

/** #2 / #3 / #4 的模型断言（**每个操作之后**都跑一次，不是只在序列末尾）。 */
function assertModelInvariants(model: Model): void {
  const where = `操作：${describeOperation(model.lastOperation)}`;

  // ── #2 全局 Σ 余额 = 0 与 #3 两个用户 kind 都不得为负 ──────────────────────
  // 两件事**合成一趟**扫描：这个函数在 10 万 × 20 次运行里会被调用 200 万次，
  // 而判据一字不减（同一个循环体里既累加总额、又逐账户判非负与托管额）。
  let total = 0n;
  let escrowTotal = 0n;
  for (const account of model.accounts.values()) {
    total += account.balance;
    if (isUserAccountKind(account.kind) && account.balance < 0n) {
      throw new Error(
        `#3 违反：${account.kind}(${account.ownerUserId ?? '-'}) 余额 = ${account.balance.toString()} < 0｜${where}`,
      );
    }
    if (account.kind === ACCOUNT_KINDS.PLATFORM_ESCROW) escrowTotal += account.balance;
  }
  if (total !== 0n) {
    throw new Error(`#2 违反：全局 Σ 余额 = ${total.toString()} ≠ 0（照理说任何一笔过账都不可能造出钱）｜${where}`);
  }

  // ── #4 义务侧非负 + 托管残差 = 0（见文件头：这是**代理残差**，不是 §8.3 的「≥」）──
  let obligation = 0n;
  for (const [user, locked] of model.locked) {
    if (locked < 0n) {
      throw new Error(
        `#4 违反：用户 ${user} 的义务侧为负（${locked.toString()}）——一次没有对应锁的释放被放行了｜${where}`,
      );
    }
    obligation += locked;
  }
  if (escrowTotal - obligation !== 0n) {
    throw new Error(
      `#4 残差 ≠ 0：托管实际持有 ${escrowTotal.toString()}，义务登记 ${obligation.toString()}，` +
        `差 = ${(escrowTotal - obligation).toString()}（腿与操作分叉了：漏腿？拆分不再守恒？）｜${where}`,
    );
  }
}

/** 跑一条序列并**在每个操作之后**断言不变式。 */
function runSequence(operations: readonly Operation[]): Model {
  const model = freshModel();
  for (const operation of operations) applyOperation(model, operation);
  return model;
}

interface SampleTotals {
  readonly applied: Record<string, number>;
  readonly rejected: Record<string, number>;
  readonly feeCharged: bigint;
  readonly sequences: number;
}

/** 固定种子抽样（覆盖率用例必须可复现：随机种子会让覆盖率断言偶尔红，那是不可接受的噪声）。 */
function sampleTotals(numRuns: number): SampleTotals {
  const applied: Record<string, number> = {};
  const rejected: Record<string, number> = {};
  let feeCharged = 0n;
  for (const operations of fc.sample(sequenceArb, { numRuns, seed: SAMPLE_SEED })) {
    const model = runSequence(operations);
    for (const [key, count] of Object.entries(model.stats.applied)) applied[key] = (applied[key] ?? 0) + count;
    for (const [key, count] of Object.entries(model.stats.rejected)) rejected[key] = (rejected[key] ?? 0) + count;
    feeCharged += model.feeCharged;
  }
  return { applied, rejected, feeCharged, sequences: numRuns };
}

const ALL_OPERATIONS = ['TOPUP', 'FREEZE', 'UNFREEZE', 'ESCROW_LOCK', 'ESCROW_RELEASE'] as const;

describe('五条不变式（§8.3 / §13.3 / Task 8）', () => {
  it(`随机序列 × ${String(PROPERTY_NUM_RUNS)} 次：每一步之后五条不变式都成立`, () => {
    // ★ 断言函数必须**不返回任何值**：fast-check 4.10.2 的 `Property.run` 只把
    // `undefined` / `true` 当作通过，**返回真值也算失败**，而它给出的消息是
    // 「Property failed by returning false」——看起来像一条断言失败，其实是返回值形状。
    // （计划 Task 8 Step 1 的原文 `(operations) => runSequence(operations)` 正好踩中这条：
    //  `runSequence` 返回模型对象 ⇒ 属性在**第一个**测试用例上就红，与不变式毫无关系。
    //  本任务实测：`Error: Property failed after 1 tests` + `Shrunk 34 time(s)`。）
    fc.assert(
      fc.property(sequenceArb, (operations) => {
        runSequence(operations);
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('生成器覆盖率（反 vacuity）：五类操作各自都被**接受**过', () => {
    // 若生成器退化成只产出会被拒的操作，上面那条属性会在「什么都没发生」的模型上全部成立。
    const totals = sampleTotals(SAMPLE_SEQUENCES);
    for (const kind of ALL_OPERATIONS) {
      expect(
        totals.applied[kind] ?? 0,
        `${kind} 在 ${String(totals.sequences)} 条序列里一次都没被接受过：序列生成器退化了（统计：${JSON.stringify(totals.applied)}）`,
      ).toBeGreaterThan(0);
    }
  });

  it('★ 不变式 #4 的残差不是「0 减 0」：抽样里真的有带手续费的释放', () => {
    // 残差 = 托管实际持有 − 义务登记。若一次释放都没有、或每次的手续费都是 0，这条等式就退化成
    // 「0 = 0」——那时它什么也证明不了（正是本仓库反复抓到的缺陷形状）。这一条钉住它的非平凡性：
    // 抽样里必须真的发生过「进托管 → 带手续费释放」这件事，因此 Step 4 的变异
    // （让释放漏掉手续费腿、或让拆分不再守恒）**必然**改变残差。
    const totals = sampleTotals(SAMPLE_SEQUENCES);
    expect(totals.applied['ESCROW_LOCK'] ?? 0, '抽样里一次进托管都没有：残差是 0 减 0').toBeGreaterThan(0);
    expect(totals.applied['ESCROW_RELEASE'] ?? 0, '抽样里一次释放都没有：残差是 0 减 0').toBeGreaterThan(0);
    expect(
      totals.feeCharged,
      '抽样里释放的手续费累计为 0 ⇒「手续费腿」从来没被构造过，残差对它失明',
    ).toBeGreaterThan(0n);
  });

  it('拒绝路径同样被行使过：余额不足与零金额都被拒过（每一次拒绝旁边都有被接受的同类操作）', () => {
    const totals = sampleTotals(SAMPLE_SEQUENCES);
    const rejectedKeys = Object.keys(totals.rejected);
    // 生成器**两个方向都在**：上面那条证明「接受」不是空转，这条证明「拒绝」也不是空转。
    expect(
      rejectedKeys.some((key) => key.includes('InsufficientFundsError')),
      `没有一次余额不足的拒绝：拒绝路径没被行使过（统计：${JSON.stringify(totals.rejected)}）`,
    ).toBe(true);
    expect(
      rejectedKeys.some((key) => key.includes('InvalidAmountError')),
      `没有一次零金额的拒绝：0 金额必须由应用层挡住（库里对单条 0 金额腿是放行的，预检 B.2 场景 3）` +
        `（统计：${JSON.stringify(totals.rejected)}）`,
    ).toBe(true);
    // 每一条被拒的原因都必须配一个**被接受**的同类操作（否则「拒绝」可能只是整个生成器坏了）：
    // 余额不足的那两类操作（冻结/进托管/解冻）与零金额的那五类，在上面的覆盖率里都有接受计数。
    for (const kind of ALL_OPERATIONS) {
      expect(totals.applied[kind] ?? 0, `${kind} 只有拒绝、没有被接受过`).toBeGreaterThan(0);
    }
  });
});
