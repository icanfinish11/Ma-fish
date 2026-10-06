import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KINDS, SYSTEM_ACCOUNT_KINDS, USER_ACCOUNT_KINDS,
  accountKey, assertAccountKind, isUserAccountKind, normalizeRef,
} from '@vca/api/modules/ledger/core/account-kind.js';
import {
  EmptyPostingError, InsufficientFundsError, InvalidAmountError, InvalidFeeRateError, MissingAccountError,
  NetZeroLegError, SelfMoveError, UnbalancedPostingError, UnknownAccountKindError, ZeroAmountLegError,
} from '@vca/api/modules/ledger/core/errors.js';
import { computeFeeSplit } from '@vca/api/modules/ledger/core/fee-split.js';
import { applyPosting, assertBalanced, movesToLegs, sameLegs } from '@vca/api/modules/ledger/core/posting.js';
// ★ 两个类型名必须**显式 import**（自审第 8 条：原文里 `AccountRef` / `AccountSnapshot` 直接用了
//   却没导入，而 `AccountSnapshot` 的形状还多一个 `balance` —— `strict: true` 下第一处就编译不过）。
//   原文同时列了 `type AccountKind`，但这一版用例里没有任何一处用到它——**不 import 用不到的东西**
//   （lint 的 `@typescript-eslint/no-unused-vars` 会立刻红，本任务实测过）。
//   值（`TRANSACTION_KINDS`）与类型**合并成同一条 import**：同一个模块导入两次是坏味道。
import {
  TRANSACTION_KINDS, type AccountRef, type AccountSnapshot,
} from '@vca/api/modules/ledger/core/types.js';

describe('账户类型（§8.1 的五个 / C30）', () => {
  it('取值集合**恰好**是 §8.1 的五个，且用户/系统之分是一张显式的表', () => {
    expect(Object.values(ACCOUNT_KINDS)).toEqual([
      'USER_AVAILABLE', 'USER_FROZEN', 'PLATFORM_ESCROW', 'PLATFORM_REVENUE', 'EXTERNAL_TOPUP',
    ]);
    expect(USER_ACCOUNT_KINDS).toEqual(['USER_AVAILABLE', 'USER_FROZEN']);
    expect(SYSTEM_ACCOUNT_KINDS).toEqual(['PLATFORM_ESCROW', 'PLATFORM_REVENUE', 'EXTERNAL_TOPUP']);
    // 两张表必须**恰好**覆盖五个值（多一个少一个都红）——「不变式 #3 只管用户账户」的依据就是它
    expect([...USER_ACCOUNT_KINDS, ...SYSTEM_ACCOUNT_KINDS].sort())
      .toEqual([...Object.values(ACCOUNT_KINDS)].sort());
  });

  it('§8.2 里的 `SELLER_AVAILABLE` 之流**不是** kind（C30：那会让取值集合与 §8.1 脱钩）', () => {
    for (const fake of ['SELLER_AVAILABLE', 'BUYER_AVAILABLE', 'PAYER_AVAILABLE', 'RECEIVER_AVAILABLE', 'TEST']) {
      expect(isUserAccountKind(fake)).toBe(false);
      expect(() => assertAccountKind(fake)).toThrow(UnknownAccountKindError);
    }
  });

  it('`assertAccountKind` 接受五个、拒绝其余（它是 C30 在库读回值上的执行点）', () => {
    for (const kind of Object.values(ACCOUNT_KINDS)) expect(() => assertAccountKind(kind)).not.toThrow();
    expect(() => assertAccountKind('PLATFORM_ESCROW ')).toThrow(UnknownAccountKindError);   // 尾部空白也不行
  });

  it('`accountKey` / `normalizeRef`：用户 UUID 一律小写、系统账户的 owner 记为空串', () => {
    const UPPER = '018F2A00-0000-7000-8000-00000000000A';
    const user = { kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: UPPER } as const;
    expect(normalizeRef(user).ownerUserId).toBe(UPPER.toLowerCase());
    // accountKey **自己**也归一化：调用方拿到的可能是未规范化的取值（判自转那条路径）
    expect(accountKey(user)).toBe(accountKey({ ...user, ownerUserId: UPPER.toLowerCase() }));
    expect(accountKey({ kind: ACCOUNT_KINDS.PLATFORM_ESCROW, ownerUserId: null })).toBe('PLATFORM_ESCROW:');
  });
});

describe('手续费拆分（D4 / C23）', () => {
  /**
   * 每一行的期望值**写死**。
   *
   * 候选行刻意用**不能整除**的数（999 / 1 / 7 / 100 分），因为「把 1000 分按 5% 拆」
   * 两侧向下取整**恰好整除**（50 + 950 = 1000），差为 0——**那个例子什么也证明不了**
   * （预检 A.4 的诚实边界原文）。整除的两行（1000 / 0）照样留着，它们钉的是边界不是舍入。
   *
   * 元组类型显式写出（`Array<[bigint, number, bigint, bigint]>`）：内联的字面量数组会被
   * 推断成 `(bigint | number)[]`，`strict: true` 下 `computeFeeSplit(gross, bps)` 直接编译不过
   * （本仓库既有用例 `bootstrap-guard.test.ts` 用的是同一种写法）。
   */
  const SPLIT_CASES: Array<[bigint, number, bigint, bigint]> = [
    [999n, 500, 50n, 949n],   // 49.95 → 向上取整 50（两侧向下取整会得到 49+949=998）
    [1n, 500, 1n, 0n],        // 0.05 → 向上取整 1（两侧向下取整会得到 0+0=0，丢掉整整 1 分）
    [7n, 300, 1n, 6n],        // 0.21 → 向上取整 1
    [100n, 3333, 34n, 66n],   // 33.33 → 向上取整 34
    [1000n, 500, 50n, 950n],  // 整除的情形照样在
    [0n, 500, 0n, 0n],
  ];

  it.each(SPLIT_CASES)('gross=%s bps=%s ⇒ fee=%s net=%s', (gross, bps, fee, net) => {
    expect(computeFeeSplit(gross, bps)).toEqual({ fee, net });
  });

  it('两侧各自向下取整是**唯一会把账做不平**的写法（预检实测的最小反例 1 分 / 5%）', () => {
    const wrongFee = (1n * 500n) / 10_000n;   // 0n（向下取整）
    const wrongNet = 1n - wrongFee;           // 1n —— 「净额 = 总额 − 费用」仍然是守恒的！
    // 反例要的是「两侧各自取整」那种写法：net 也独立算一遍并向下取整 ⇒ 0 + 0 = 0 ≠ 1。
    const independentNetFloor = (1n * (10_000n - 500n)) / 10_000n;  // 0n
    expect(wrongFee + independentNetFloor).toBe(0n);                // 丢了 1 分
    expect(wrongNet).toBe(1n);                                      // 「减出来」就守恒——这正是 D4 的规则
    expect(computeFeeSplit(1n, 500).fee + computeFeeSplit(1n, 500).net).toBe(1n);  // 我们的写法守恒
  });

  it('拒绝面：负金额与非法费率各自抛自己的领域错误（不是笼统的 Error）', () => {
    // 负金额：`fee + net === gross` 在负数上照样"成立"，但一笔负金额的拆分没有意义
    // （过账的转移金额必须为正，见 `movesToLegs`）。
    expect(() => computeFeeSplit(-1n, 500)).toThrow(InvalidAmountError);
    // 费率：小数 / 负数 / NaN 都不是合法的 bps（C3：绝不用浮点算钱）。
    expect(() => computeFeeSplit(100n, -1)).toThrow(InvalidFeeRateError);
    expect(() => computeFeeSplit(100n, 1.5)).toThrow(InvalidFeeRateError);
    expect(() => computeFeeSplit(100n, Number.NaN)).toThrow(InvalidFeeRateError);
  });

  it('上限钳制：bps > 10000 时净额不得变负（属性测试会喂**任意** bps，这条是它的边界）', () => {
    // 100% 以上：`ceil` 会超过 gross，于是净额变负——那会把卖家从「收钱」变成「付钱」，
    // 而且它会撞上不变式 #3（用户账户不得为负）。钳到 gross 之后两条不变式同时成立。
    expect(computeFeeSplit(100n, 20_000)).toEqual({ fee: 100n, net: 0n });
    expect(computeFeeSplit(100n, 10_000)).toEqual({ fee: 100n, net: 0n });
    expect(computeFeeSplit(0n, 20_000)).toEqual({ fee: 0n, net: 0n });
  });
});

const ALICE = '018f2a00-0000-7000-8000-00000000000a';
const BOB = '018f2a00-0000-7000-8000-00000000000b';
const CAROL = '018f2a00-0000-7000-8000-00000000000c';
const available = (id: string) => ({ kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: id }) as const;
const frozen = (id: string) => ({ kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: id }) as const;
const escrow = { kind: ACCOUNT_KINDS.PLATFORM_ESCROW, ownerUserId: null } as const;
const revenue = { kind: ACCOUNT_KINDS.PLATFORM_REVENUE, ownerUserId: null } as const;
const topup = { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null } as const;

/** 账户 id 由 (kind, owner) 派生，纯核心的测试因此不需要数据库。 */
const resolvedOf = (...refs: readonly AccountRef[]): (AccountRef & { id: string })[] =>
  refs.map((ref, i) => ({ ...ref, id: `acc-${String(i)}` }));
/**
 * 把「已解析的账户」与「余额数组」拼成快照。
 *
 * **入参是 `resolvedOf` 的产物，不是 `AccountSnapshot[]`**（自审第 8 条：原文写成
 * `refs: readonly AccountSnapshot[]`，而 `resolvedOf` 的产物**没有** `balance`——
 * 调用点 `snapshotsOf([100n, 0n], refs)` 因此过不了类型检查）。`balance` 正是本函数补上的那一半。
 */
const snapshotsOf = (
  balances: readonly bigint[],
  refs: readonly (AccountRef & { id: string })[],
): AccountSnapshot[] => refs.map((ref, i) => ({ ...ref, balance: balances[i] ?? 0n }));

describe('纯核心：资金转移 → 复式腿（C25 / C28 / C30）', () => {
  it('展开：一条转移产出一借一贷、和为 0', () => {
    const resolved = resolvedOf(topup, available(ALICE));
    const legs = movesToLegs([{ from: topup, to: available(ALICE), amount: 500n }], resolved);
    expect(legs).toEqual([{ accountId: 'acc-0', amount: -500n }, { accountId: 'acc-1', amount: 500n }]);
    expect(() => assertBalanced(legs)).not.toThrow();
  });

  it('**净额合并**：两条同源转移合并成一条腿（release 形态：托管 −净额、托管 −费）', () => {
    const resolved = resolvedOf(escrow, available(ALICE), revenue);
    const legs = movesToLegs(
      [
        { from: escrow, to: available(ALICE), amount: 949n },
        { from: escrow, to: revenue, amount: 50n },
      ],
      resolved,
    );
    // 托管只有**一条** −999 的腿（不是两条）：一个账户一次过账只发一条 UPDATE，
    // 而 sameLegs 的比较因此有唯一表示。
    expect(legs).toEqual([
      { accountId: 'acc-0', amount: -999n },
      { accountId: 'acc-1', amount: 949n },
      { accountId: 'acc-2', amount: 50n },
    ]);
  });

  it('金额为 0 或负的转移被拒（一笔「转移 0 分」的过账是 bug）', () => {
    const resolved = resolvedOf(topup, available(ALICE));
    expect(() => movesToLegs([{ from: topup, to: available(ALICE), amount: 0n }], resolved)).toThrow(InvalidAmountError);
    expect(() => movesToLegs([{ from: topup, to: available(ALICE), amount: -1n }], resolved)).toThrow(InvalidAmountError);
    expect(() => movesToLegs([], resolved)).toThrow(/至少/);
  });

  it('转给自己被拒（否则会产出两条互相抵消的腿：一次看起来发生了的空过账）', () => {
    const resolved = resolvedOf(available(ALICE));
    expect(() => movesToLegs([{ from: available(ALICE), to: available(ALICE), amount: 1n }], resolved)).toThrow(SelfMoveError);
  });

  it('未解析的账户被拒（MissingAccountError）：`from` 与 `to` **两个方向**各自都要有', () => {
    const resolved = resolvedOf(topup);
    // ① `to` 方向
    expect(() => movesToLegs([{ from: topup, to: available(BOB), amount: 1n }], resolved)).toThrow(MissingAccountError);
    // ② `from` 方向。**这一条是变异探针逼出来的**：只写 ① 的时候，把 `if (!from)` 整行删掉
    //    **一条都不会红**（① 走的是 `!to` 那条守卫）——也就是说 `!from` 那条守卫当时没有任何见证。
    //    两个方向都写，两条守卫才各自有牙（探针 P8 现在红的就是本行）。
    expect(() => movesToLegs([{ from: available(BOB), to: topup, amount: 1n }], resolved)).toThrow(MissingAccountError);
    // 键必须指认**哪一个**引用没解析——否则调用方拿到的是一句没有信息量的错误。
    try {
      movesToLegs([{ from: available(BOB), to: topup, amount: 1n }], resolved);
    } catch (error) {
      expect((error as MissingAccountError).key).toBe(accountKey(available(BOB)));
    }
  });

  it('规范化：大写 UUID 与库里的那一行落在**同一个** key 上（P1 踩过：大写拼写绕过守卫）', () => {
    const upper = { kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: ALICE.toUpperCase() };
    const lower = normalizeRef(upper);
    expect(lower.ownerUserId).toBe(ALICE);
    expect(accountKey(lower)).toBe(accountKey(available(ALICE)));
    // 若不规范化，判自转/查账户都会 miss —— 正因为大写形式与库里那一行不相等。
    expect(accountKey(upper)).toBe(accountKey(available(ALICE)));
  });

  it('不变式 #3：用户账户被扣成负 ⇒ InsufficientFundsError（stage = predicted）', () => {
    const refs = resolvedOf(available(ALICE), available(BOB));
    const snapshots = snapshotsOf([100n, 0n], refs);
    const legs = [
      { accountId: 'acc-0', amount: -600n },
      { accountId: 'acc-1', amount: 600n },
    ];
    expect(() => applyPosting(snapshots, legs)).toThrow(InsufficientFundsError);
    try {
      applyPosting(snapshots, legs);
    } catch (error) {
      expect((error as InsufficientFundsError).stage).toBe('predicted');
    }
  });

  it('系统账户被扣成负 ⇒ 接受（充值路径的对手方天然为负）', () => {
    const refs = resolvedOf(topup, available(ALICE));
    const snapshots = snapshotsOf([0n, 0n], refs);
    const next = applyPosting(snapshots, [
      { accountId: 'acc-0', amount: -10_000n },
      { accountId: 'acc-1', amount: 10_000n },
    ]);
    expect(next.get('acc-0')).toBe(-10_000n);
    expect(next.get('acc-1')).toBe(10_000n);
  });

  it('一笔交易里某个账户净额为 0 ⇒ NetZeroLegError（不是静默丢掉那条腿）', () => {
    const resolved = resolvedOf(available(ALICE), frozen(ALICE));
    expect(() =>
      movesToLegs(
        [
          { from: available(ALICE), to: frozen(ALICE), amount: 10n },
          { from: frozen(ALICE), to: available(ALICE), amount: 10n },
        ],
        resolved,
      ),
    ).toThrow(NetZeroLegError);
  });

  it('零金额的腿被拒（ZeroAmountLegError）—— 和仍为 0，所以先过平衡断言，这一条才是被拒的原因', () => {
    // `movesToLegs` 走不到这里（它拒 0 金额的转移、也拒净额为 0 的腿），因此这是
    // `applyPosting` 自己的防线，与迁移里那条 `entries_amount_nonzero` CHECK 互为对偶：
    // 数据库层的探针（Task 4 P4）证明那条 CHECK 有牙，这一条证明**层内**也有。
    const refs = resolvedOf(available(ALICE), available(BOB), available(CAROL));
    const snapshots = snapshotsOf([100n, 100n, 100n], refs);
    const legs = [
      { accountId: 'acc-0', amount: -5n },
      { accountId: 'acc-1', amount: 5n },
      { accountId: 'acc-2', amount: 0n },
    ];
    expect(legs.reduce((sum, leg) => sum + leg.amount, 0n)).toBe(0n);   // 先证明它不是被平衡断言拦下的
    expect(() => applyPosting(snapshots, legs)).toThrow(ZeroAmountLegError);
  });

  it('applyPosting：腿指向**未解析**的账户 ⇒ MissingAccountError（快照与腿必须来自同一次解析）', () => {
    const refs = resolvedOf(available(ALICE), available(BOB));
    const snapshots = snapshotsOf([100n, 100n], refs);
    expect(() =>
      applyPosting(snapshots, [
        { accountId: 'acc-0', amount: -5n },
        { accountId: 'acc-9', amount: 5n },   // ← 这一条没有对应的快照
      ]),
    ).toThrow(MissingAccountError);
  });

  it('applyPosting：两条腿以下的过账 ⇒ EmptyPostingError（这条分支只有「单条 0 金额腿」能走到）', () => {
    // **据实说明这条分支的可达性**：非零的单腿会被 `assertBalanced` 先拦下（sum ≠ 0），
    // 空数组也被它拦下，因此 `legs.length < 2` 只剩「单条 0 金额腿」这一种输入能走到
    // （sum = 0 且 length = 1 恰好绕过平衡断言）。它当然也是 `movesToLegs` 产不出来的形状
    // ——`ZeroAmountLegError` 那条守卫排在它后面，所以这里观察到的是 EmptyPostingError。
    const refs = resolvedOf(available(ALICE));
    const snapshots = snapshotsOf([100n], refs);
    expect(() => applyPosting(snapshots, [{ accountId: 'acc-0', amount: 0n }])).toThrow(EmptyPostingError);
  });

  it('不平衡的腿 ⇒ UnbalancedPostingError（不变式 #1 的应用侧断言，C28）', () => {
    expect(() => assertBalanced([{ accountId: 'acc-0', amount: 1n }])).toThrow(UnbalancedPostingError);
    expect(() => assertBalanced([])).toThrow(UnbalancedPostingError);
  });

  it('sameLegs：顺序无关（重放比较不能因为腿的顺序不同而误判成 409）', () => {
    const a = [{ accountId: 'acc-0', amount: -1n }, { accountId: 'acc-1', amount: 1n }];
    const b = [{ accountId: 'acc-1', amount: 1n }, { accountId: 'acc-0', amount: -1n }];
    expect(sameLegs(a, b)).toBe(true);
    expect(sameLegs(a, [{ accountId: 'acc-1', amount: 2n }, { accountId: 'acc-0', amount: -2n }])).toBe(false);
    expect(sameLegs(a, [{ accountId: 'acc-0', amount: -1n }])).toBe(false);
  });
});

describe('交易类型（§8.2 的六行 / C29）', () => {
  it('取值集合**恰好**是 §8.2 那六行示例对应的六个字面量，且库里没有任何东西替我们看着它们', () => {
    // ## 为什么这条断言是**承重**的，而不是把常量抄了一遍
    //
    // 迁移里 `ledger.transactions.kind` 是 `TEXT NOT NULL`——Task 4 的三条手写 DDL 里
    // **没有**针对它的 CHECK（只有 accounts 的条件化非负 CHECK 与 entries 的金额非零 CHECK）。
    // 因此这六个字面量**唯一**的定义处就是这个常量，而它写错（少个字母、大小写不一致）
    // 会静默地把一个错误的 kind 写进账本：没有约束会红、没有对账会红（Σ 余额照样是 0）。
    // 这一条用例是它今天唯一的机器见证；Task 6/7 的用例会**消费**这些值，而不是**核对**它们。
    expect(Object.values(TRANSACTION_KINDS)).toEqual([
      'TOPUP', 'FREEZE', 'FORFEIT', 'ESCROW_LOCK', 'ESCROW_RELEASE', 'UNFREEZE',
    ]);
    // 键与值必须逐字相同（`TRANSACTION_KINDS.TOPUP === 'TOPUP'`）：不然「用常量当 kind」
      // 与「用字面量当 kind」会写出两种不同的字符串，而库里只存后者。
    for (const [key, value] of Object.entries(TRANSACTION_KINDS)) expect(value).toBe(key);
  });
});


