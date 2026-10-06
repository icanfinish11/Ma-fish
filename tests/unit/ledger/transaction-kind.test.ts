import { describe, expect, it } from 'vitest';
import { TRANSACTION_KINDS, assertTransactionKind } from '@vca/api/modules/ledger/core/types.js';
import { UnknownTransactionKindError } from '@vca/api/modules/ledger/core/errors.js';

/**
 * 交易 `kind` 的运行期执行者（P3 / Task 4；D5 / 控制器裁定 ⑦）。
 *
 * ## 为什么它必须存在（预检 §D.1 的 `[E3]` 实测，逐字）
 * ```
 * [E3] ledger.transactions 上的约束 = [{"conname":"transactions_pkey","def":"PRIMARY KEY (id)"}]
 * [E3] 用一个 §8.2 之外的 kind 过账 ⇒ 成功（没有任何东西拦住它）
 * [E3] 库里 kind = NOT_A_KIND 的行数 = 1
 * ```
 * 也就是说 §8.1 的五个**账户** kind 有 `assertAccountKind`，而 §8.2 的六个**交易** kind
 * **只有 TypeScript 类型**。类型在运行期不存在，而 `kind` 是**调用方给的字符串**。
 *
 * ## 为什么它比 `assertAccountKind` 更值得有
 * `accounts.kind` 至少有迁移里的条件化 CHECK 兜着（§8.1 之外的值落到「必须非负」那一侧，
 * 负余额会被拒）；而 `transactions.kind` 那**一列上什么约束都没有**（迁移实测）。
 * 一个错的 kind 会污染幂等重放判别式（P2 的 I2 刚把 kind 加进去）与审计。
 *
 * ## 两条方向的形状（本项目的既定要求：每条拒绝都要有验收对照）
 * - **验收面**：穷举 `TRANSACTION_KINDS` 的**每一个**取值 ⇒ 全部被接受；
 * - **拒绝面**：预检实测的那个取值 `NOT_A_KIND` 与一批闭集外的写法（含大小写、首尾空格）
 *   ⇒ 一律抛 `UnknownTransactionKindError`。
 * 少了验收面，一个「什么都拒」的实现也能让下面全部变绿。
 */
/**
 * 捕获 `fn` 抛出的错误对象（没抛 ⇒ `null`）。
 *
 * ## ★ 为什么不用 `expect(fn).toThrow(UnknownTransactionKindError)`
 *
 * 那是本仓库反复抓到的那一类**不可能失败的断言**，而它在这次 TDD 的**第一次运行**里
 * 就现身了（实测见 `evidence/t4-tdd-red-transaction-kind.txt`）：
 * 实现还不存在时 `UnknownTransactionKindError` 的导入值是 `undefined`，而
 * **`toThrow(undefined)` 在 vitest 里的语义是「任何错误都算通过」**——于是 8 条拒绝面
 * 断言在**红阶段全部假绿**：真正的 `TypeError: assertTransactionKind is not a function`
 * 被当成了「如期被拒」。
 *
 * 它的失效方向不止于红阶段：实现存在但**抛错了东西**（拼错类名、抛 `TypeError`、
 * 抛别的领域错误）时，`toThrow` 版本同样放行——而「拒绝面拒绝的是**哪一种**失败」
 * 正是这条判据的全部内容。
 *
 * `toBeInstanceOf(undefined)` 则是**失败**的（`expected value to be an instance of
 * undefined, but it was not`），`null` 也失败 ⇒ 判据既能红在「没实现」，也能红在「抛错了」。
 */
function capture(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('交易 kind 的执行者（D5）', () => {
  it('§8.2 的六个 kind 全部被接受（**验收面**：穷举 `TRANSACTION_KINDS` 的每个取值）', () => {
    // 六个都断言一遍，且**顺带钉住条数**：将来往 `TRANSACTION_KINDS` 里加第七行时，
    // 这条用例会以「6 → 7」变红，逼实现者回答「§8.2 有这一行吗」。
    // 它同时是「拒绝面不是恒真」的对侧证据：同一个函数在合法取值上必须安静地返回。
    expect(Object.values(TRANSACTION_KINDS)).toHaveLength(6);
    for (const kind of Object.values(TRANSACTION_KINDS)) {
      expect(() => assertTransactionKind(kind), `${kind} 应当被接受`).not.toThrow();
    }
  });

  it('★ 预检实测的那个取值被拒：`NOT_A_KIND`', () => {
    expect(capture(() => assertTransactionKind('NOT_A_KIND'))).toBeInstanceOf(UnknownTransactionKindError);
  });

  it('★ 拒绝时带上**那个取值**本身（错误对象里有 kind，排障不必去猜）', () => {
    // 只断言「抛了」会让一个「无论什么都抛同一个空错误」的实现通过；
    // 这条钉住错误对象承载的信息（与 `UnknownAccountKindError.kind` 同形）。
    const error = capture(() => assertTransactionKind('NOT_A_KIND'));
    expect(error).toBeInstanceOf(UnknownTransactionKindError);
    expect((error as UnknownTransactionKindError).kind).toBe('NOT_A_KIND');
    expect((error as UnknownTransactionKindError).name).toBe('UnknownTransactionKindError');
  });

  it.each(['', 'topup', 'TOPUP ', ' TOPUP', 'ESCROW_RELEASE ', 'NOT_A_KIND', 'DROP TABLE'])(
    '闭集外的取值一律被拒：%j',
    (bad) => {
      // **大小写与空格是承重的**：`' TOPUP'` / `'TOPUP '` 在 SQL 与 JSON 里都长得像合法值，
      // 而它们落到 `transactions.kind` 那一列上与 `'TOPUP'` 是**不同的值**——
      // 幂等重放的判别式（`existing.kind === request.kind`）与对账都会静默看错。
      // 不做 trim、不做大写归一化（§8.2 的六行是全大写英文，闭集就是闭集）。
      expect(capture(() => assertTransactionKind(bad))).toBeInstanceOf(UnknownTransactionKindError);
    },
  );
});
