import { accountKey, isUserAccountKind } from './account-kind.js';
import {
  EmptyPostingError, InsufficientFundsError, InvalidAmountError,
  MissingAccountError, NetZeroLegError, SelfMoveError, UnbalancedPostingError, ZeroAmountLegError,
} from './errors.js';
import type { AccountRef, AccountSnapshot, MoneyMove, PostingLeg } from './types.js';

/**
 * 把「一组资金转移」变成复式腿（D 系列的落点见文件内注释）。
 *
 * ## 为什么是「转移」而不是「腿」
 * 调用方（五个原语 / P3 / P4）想说的是「从可用扣 600 进托管」，不是「借贷哪两条腿」。
 * 让调用方自己造腿，等于把不变式 #1 的责任推给每一个调用点——而它恰恰是那个
 * 「每个调用点都要记得」的形状，本项目已经为此付过很多次代价。**腿由这里造。**
 *
 * ## 净额合并（一个账户一笔交易只有一条腿）
 * `releaseEscrow` 是「托管 → 卖家」与「托管 → 平台」两条转移，合并后托管只有一条腿。
 * 合并的好处有三：数据库一个账户只发一条 UPDATE（条件更新的守卫因此只判一次）、
 * 分录更少（触发器的逐行聚合更便宜）、而 `sameLegs` 的比较有唯一表示（重放判定不会
 * 因为腿的条数/顺序不同而误判）。**合并后的净额为 0 是错误**（NetZeroLegError）：
 * 那意味着这笔交易对某个账户什么都没做，把两条互相抵消的转移写进账本只会制造噪声。
 */
export function movesToLegs(
  moves: readonly MoneyMove[],
  resolved: readonly (AccountRef & { id: string })[],
): PostingLeg[] {
  if (moves.length === 0) throw new EmptyPostingError('一次过账至少要有一条资金转移');
  const byRef = new Map(resolved.map((a) => [accountKey(a), a]));
  const legs = new Map<string, bigint>();
  const add = (id: string, amount: bigint) => legs.set(id, (legs.get(id) ?? 0n) + amount);
  for (const move of moves) {
    if (move.amount <= 0n) throw new InvalidAmountError(`转移金额必须为正：${move.amount.toString()}`);
    const from = byRef.get(accountKey(move.from));
    const to = byRef.get(accountKey(move.to));
    if (!from) throw new MissingAccountError(accountKey(move.from));
    if (!to) throw new MissingAccountError(accountKey(move.to));
    if (from.id === to.id) throw new SelfMoveError(from.id);
    add(from.id, -move.amount);
    add(to.id, move.amount);
  }
  const out: PostingLeg[] = [];
  for (const [accountId, amount] of legs) {
    if (amount === 0n) throw new NetZeroLegError(accountId);
    out.push({ accountId, amount });
  }
  assertBalanced(out);
  return out;
}

/** 不变式 #1 的**应用侧**显式断言（C28：领域错误只能从这里产生）。 */
export function assertBalanced(legs: readonly PostingLeg[]): void {
  let sum = 0n;
  for (const leg of legs) sum += leg.amount;
  if (sum !== 0n || legs.length === 0) throw new UnbalancedPostingError(sum, legs.length);
}

/**
 * 纯函数：算出一组腿作用之后的余额。**不改任何传入对象**（属性测试靠这一点做模型）。
 * 抛出的错误就是领域错误——数据库层用它产生稳定的 4xx，属性测试用它跳过被拒的操作。
 */
export function applyPosting(accounts: readonly AccountSnapshot[], legs: readonly PostingLeg[]): Map<string, bigint> {
  assertBalanced(legs);
  if (legs.length < 2) throw new EmptyPostingError('一笔过账至少要有两条腿');
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const next = new Map<string, bigint>();
  for (const leg of legs) {
    const account = byId.get(leg.accountId);
    if (!account) throw new MissingAccountError(leg.accountId);
    if (leg.amount === 0n) throw new ZeroAmountLegError(leg.accountId);
    const balance = (next.get(leg.accountId) ?? account.balance) + leg.amount;
    // 不变式 #3 **只**约束用户账户（与迁移里那条条件化 CHECK 逐字同一条规则）
    if (isUserAccountKind(account.kind) && balance < 0n) {
      throw new InsufficientFundsError(account.id, account.kind, account.balance, -leg.amount, 'predicted');
    }
    next.set(leg.accountId, balance);
  }
  return next;
}

/**
 * 两组腿是不是**同一笔**过账（D9 的重放判定）。
 *
 * 顺序无关（按 accountId 排序后逐项比较）——腿的生成顺序取决于 `Map` 的插入顺序，
 * 而「同一笔」这件事与顺序无关；把它写成顺序敏感会让一个**合法重放**变成 409
 * （调用方拿到一个它无法理解的冲突，而交易其实已经在库里了）。
 */
export function sameLegs(
  a: readonly { accountId: string; amount: bigint }[],
  b: readonly { accountId: string; amount: bigint }[],
): boolean {
  if (a.length !== b.length) return false;
  const key = (l: { accountId: string; amount: bigint }) => `${l.accountId}:${l.amount.toString()}`;
  const sortA = a.map(key).sort();
  const sortB = b.map(key).sort();
  return sortA.every((v, i) => v === sortB[i]);
}
