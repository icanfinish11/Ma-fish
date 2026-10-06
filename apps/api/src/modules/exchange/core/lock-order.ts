import { rowLockOrder } from '../../../common/db/lock-order.js';
import { UnknownLockOrderError } from './errors.js';

/**
 * 全局资产锁序（C35 / 控制器裁定 ⑧；预检 §B.1 的实测）。**双锁流程的唯一取锁顺序来源。**
 *
 * ## 判据的形状：**字节序**，不是「数值序」，也不是 locale 序
 * `assetId` 是 UUIDv7 的十六进制小写定长字符串。定长 ⇒ 字典序 = 字节序；
 * 而它们**同时**是时间有序的（C4：UUIDv7 含时间序）⇒ 按它排序顺带让「先创建的作品
 * 先被锁」，争用时的一致性更好（不是正确性要求，只是让两类死锁在日志里更容易读）。
 * **绝不要**用 `localeCompare`（它受 locale 影响，而锁序必须是全进程一致的）。
 *
 * ## 「先取全部行锁、再动任何一行」
 * C35 的后半句是承重的：把这一组 id 排好序**之后**才允许开始取锁，而取的过程中
 * 不得插入任何别的写动作。`assertLockOrderHeld` 是这条纪律的运行期判据
 * （Task 7/8 的每条双锁路径在取锁前调它）。
 *
 * ## 它与账本那一侧的关系（Task 4 之后的实况）
 * 预检 §B.1 第（3）条实测：`applyBalances` 的「按金额升序、借方先」**不是全局锁序**
 * ——它连自己那条路径上的取锁点都没覆盖全（`entries.createMany` 对被引用账户取
 * `FOR KEY SHARE`，先于它）。因此**账户行**的锁序是 Task 4 的另一条判据
 * （`tests/integration/ledger/account-lock-order.test.ts`）。
 * **据实记载一次结构变更**：Task 4 落地时发现「两边各排一次序」是唯一不做提取的写法，
 * 于是把**顺序判据本身**提到了 `common/db/lock-order.ts`（`rowLockOrder`），
 * 本文件的 `lockOrder` 与账本的 `lockAccountRows` **import 同一个函数**。
 * 两个调用方各自只证明自己那一半（资产侧是纯判据、账户侧是真库取锁顺序），
 * 而「它们是同一个决定」由变异探针 `P-ORDER-SHARED` 见证。
 */

/**
 * 把任意一组资产 id 排成**全局锁序**：`assetId` 升序，按**字节**比较，去重。
 *
 * 返回的是**新数组**（不就地排序入参）：调用方手里的 `[assetAId, assetBId]` 是合约行
 * 的字段，就地排序会把「排序」这件事漏回给读那一行的人——而锁序必须是**取锁那一刻**
 * 算出来的东西，不是某个对象上被别人改过的状态。
 *
 * ## ★ 顺序判据本身在 `common/db/lock-order.ts`（Task 4 的提取，据实记载一次结构变更）
 * Task 4 要把**同一条判据**施加到**账户行**上，而 `ledger` 不能 import `exchange/core/*`
 * （`no-cross-module-internals`：跨模块只走 `index.ts`）。不提取的话唯一可行的写法是
 * **两边各排一次序**——两份「逐字相同」的实现会在第一次有人只改一边时分开，而后果只在
 * 真并发下现身。⇒ 判据被提到 `common/db/`，本函数变成它的**资产侧具名包装**：
 * 名字与领域词汇（「资产锁序」）留在这里，决定只有一份。
 * 见证（变异探针 `P-ORDER-SHARED`）：把 `common/db/lock-order.ts` 的比较器反过来，
 * `tests/unit/exchange/lock-order.test.ts` 与 `tests/integration/ledger/account-lock-order.test.ts`
 * **同时**变红——那正是「一个实现、两个调用方」与「两份实现」的区别。
 */
export function lockOrder(assetIds: readonly string[]): readonly string[] {
  return rowLockOrder(assetIds);
}

/** 双锁流程的具名包装：恰好两个资产，且**已经按全局锁序**。 */
export function lockPair(a: string, b: string): readonly [string, string] {
  const [first, second] = lockOrder([a, b]);
  // `lockOrder` 对两个**不同**的 id 必然给出两项；相同 id 时去重成一项 —— 而那种输入
  // 在业务上不可能（一份合约的两件作品是两个不同的 `assetId`，`proposeOffer` 里判过），
  // 因此这里不造一个「第二项为空」的静默形状，而是让类型层要求两项。
  //
  // **据实记载两件事**：
  //   1. `swap_contracts` 上**没有** `asset_a_id <> asset_b_id` 这条 CHECK（Task 2 的迁移
  //      实测），因此「同一件作品换来换去」这种行是**能进库的** —— 这里因此不是死代码，
  //      而是一道结构性的兜底（约定上的第一道守卫是 Task 6 的 `proposeOffer`）；
  //   2. 它抛的是一个**朴素 `Error`**（不是领域错误族里的一个）：这条分支真被走到
  //      说明库里有一行自指的合约，那是**我们的 bug**，HTTP 侧应当是 500。控制器若希望
  //      它进 `errors.ts` 的翻译表（从而有一个具名的 `code`），那是 Task 6 的一次改动：
  //      本任务不替它选一个名字。
  if (first === undefined || second === undefined) {
    throw new Error(`双锁需要两个不同的 assetId，收到 [${a}, ${b}]`);
  }
  return [first, second];
}

/**
 * **ABBA 的可执行判据**（Task 7/8 的每条双锁路径都要在取锁前调它）。
 *
 * `held` 是本次事务**已经**持有行锁的资产（按取的先后），`wanted` 是即将要取的。
 * 判据：`held + wanted` 必须仍然是升序的。反向取锁时它抛
 * {@link UnknownLockOrderError}——而那个错误是 500（**我们的 bug**，不是调用方的）。
 *
 * 相等的 id 不算倒序（`>` 而不是 `>=`）：对同一个 assetId 再取一次锁是幂等的空操作，
 * 而把它判成 ABBA 会让「先锁一件、再确认它已经锁着」这种写法无法表达。
 */
export function assertLockOrderHeld(held: readonly string[], wanted: readonly string[]): void {
  const combined = [...held, ...wanted];
  for (let i = 1; i < combined.length; i += 1) {
    if (combined[i - 1]! > combined[i]!) throw new UnknownLockOrderError(held, wanted);
  }
}
