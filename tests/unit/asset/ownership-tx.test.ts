import { describe, expect, it } from 'vitest';
import type { Prisma } from '@vca/api/generated/prisma/client.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { OwnershipService } from '@vca/api/modules/asset/ownership.service.js';

/**
 * `transferOwnership` 的 `tx` 是**必填**的（Task 1 / 预检 §0.1 / P2 裁定 C-1）。
 *
 * ## 为什么这条用例住在 unit 而不是 integration
 *
 * 它问的不是「转让能不能回滚」（那要真库，见 `tests/integration/asset/ownership.test.ts`
 * 的两条方向用例），而是「**签名允不允许一个不带事务的调用**」。后者是纯类型层的事实，
 * 一秒能跑完，而且它就是缺陷的**根因位置**：预检实测的构造之所以成立，唯一的原因是
 * 方法签名里**连一个 `tx` 参数都没有**。
 *
 * ## ★ 判据几乎全在**编译期**（这是本文件与计划字面最大的偏离，逐条有实测）
 *
 * 计划 Step 1 给的两条里，有一条（`expect(true).toBe(true)`）是**恒真**的，另一条
 * （`Function.length === 2`）**分不出 required 与 optional**。本文件因此改成：
 *
 * | 判据 | 在哪一层 | 什么改动会打红它 |
 * |---|---|---|
 * | ① `TxIsRequired` | 编译期 | `tx` 改成 `tx?` ⇒ 变成 `false` ⇒ TS2322 |
 * | ② `TxIsTransactionClient` | 编译期 | `tx` 被删掉/换成别的类型 ⇒ 变成 `false` ⇒ TS2322 |
 * | ③ `@ts-expect-error`（PrismaService 不能当 tx） | 编译期 | 否定约束（`$connect`）被去掉 ⇒ 指令**不再被使用** ⇒ TS2578 |
 * | ④ `Function.length === 2` | 运行期 | `tx` 参数被**整个删掉** ⇒ 1 |
 *
 * 判据 ①②③ 由 `pnpm typecheck`（`pnpm -r typecheck` 覆盖 `tests/` 这个 workspace 包）
 * 执行，`vitest` 只执行 ④——ESM 下类型在运行期不存在，这一点没法绕开，因此它写在明处。
 *
 * ## ★★ 为什么必须给参数类型加一条否定约束（**这是与计划 D1 的实测分歧**）
 *
 * 计划 D1 与 Step 1 都写着：「必填之后 `PrismaService` **不再**结构上满足
 * `Prisma.TransactionClient`（它没有 `$transaction`）」。**实测与此相反**：
 *
 * ```
 * F1  '$transaction' extends keyof Prisma.TransactionClient   === true
 *     （@prisma/client/runtime/client.d.ts:467 的 denylist 是
 *       ["$connect","$disconnect","$on","$use","$extends"] —— Prisma 7 把 `$transaction`
 *        从 denylist 里**移除了**；Prisma ≤6 它在里面。）
 * F2  const f2: Prisma.TransactionClient = prismaService;      ← **编译通过**
 * ```
 *
 * 两条合起来：`PrismaService`（继承 `PrismaClient`，成员**更多**）在 TS 的结构化判定下
 * 满足 `Prisma.TransactionClient`——**多出来的成员从来不会让赋值失败**。于是
 * 「必填的 `tx: Prisma.TransactionClient`」**不是**一条机器判据：`transferOwnership(this.prisma, input)`
 * 照样编译通过，「忘了传 tx」只从「少写一个参数」变成了「先构造一个假事务」，
 * 而后者恰恰是最容易顺手写下的形状（`this.prisma` 就在手边）。
 *
 * 真正的结构差异只剩 denylist 里的那五个成员。`PrismaService` **有** `$connect`，
 * 事务客户端**没有**：
 *
 * ```
 * F6  '$connect' extends keyof Prisma.TransactionClient       === false
 * F4  const f4: Prisma.TransactionClient & { readonly $connect?: never } = prismaService;
 *     ⇒ error TS2322: Types of property '$connect' are incompatible.
 *        Type '() => Promise<void>' is not assignable to type 'undefined'.
 * F5/F11 真实 `$transaction` 回调的 tx 赋给同一类型            ← **编译通过**（不误伤调用方）
 * ```
 *
 * ⇒ 判据取「`Prisma.TransactionClient` **且**没有 `$connect`」。它同时满足两件事：
 * `PrismaService` 被拒，真实事务客户端通过。
 *
 * ## 判据自己的守卫（复访触发条件）
 *
 * 这条判据**依赖 Prisma 的 denylist 内容**。若哪天 `$connect` 也被移出 denylist
 * （TransactionClient 于是也有 `$connect`），判据 ③ 会以 **TS2578（未使用的
 * `@ts-expect-error`）**变红，而真实调用点会以 TS2322 变红——两条都**响亮**，
 * 不会静默失效。若 `$transaction` 被移回 denylist，判据仍然成立，只是此后
 * 可以简化成裸的 `Prisma.TransactionClient`（那时 ③ 会提示这件事）。
 */

/** `transferOwnership` 的**第一个**参数类型（判据 ①②③ 全从它推出）。 */
type TxParam = Parameters<typeof OwnershipService.prototype.transferOwnership>[0];

// ① **必填**：`tx?` 会把 `undefined` 并进第一个参数的类型里（实测 F8a），
//    于是 `TxIsRequired` 变成 `false`，下一行以 TS2322 红。
type TxIsRequired = undefined extends TxParam ? false : true;
const txIsRequired: TxIsRequired = true;

// ② **是**事务客户端：没有这一条，把 `tx` 整个删掉会让 ① 依然为 `true`
//    （第一个参数变成业务入参，`undefined` 照样不满足它）。两条件必须合看。
type TxIsTransactionClient = TxParam extends Prisma.TransactionClient ? true : false;
const txIsTransactionClient: TxIsTransactionClient = true;

/**
 * 上面两条见证**在运行期一次都不被读**——ESM 下类型不存在，`tsc` 是唯一的判据
 * （`pnpm typecheck` 覆盖 `tests/` 这个 workspace 包）。
 *
 * `void` 写在这里是为了让 `@typescript-eslint/no-unused-vars` 看明白它们不是漏写。
 * **刻意不用 `expect(txIsRequired).toBe(true)` 那样的运行期断言**：类型被擦除之后
 * 那一句恒真，正是本项目反复抓到的那类「不可能失败的断言」。
 */
void txIsRequired;
void txIsTransactionClient;

/**
 * ③ **`PrismaService` 被编译期拒收**（本任务的机器判据本体）。
 *
 * 这一行**永远不被执行**（函数不被调用），它存在的唯一目的是让 `tsc` 检查那一句赋值。
 * 把参数类型里的 `& { readonly $connect?: never }` 去掉 ⇒ 这句赋值**合法**了 ⇒
 * `@ts-expect-error` 变成未使用 ⇒ **TS2578** ⇒ `pnpm typecheck` 红。这正是探针 P-B。
 */
function typeWitnessPrismaServiceIsNotATx(): void {
  // @ts-expect-error `PrismaService` 有 `$connect`（它继承 `PrismaClient`），不是事务客户端
  const notATx: TxParam = null as unknown as PrismaService;
  void notATx;
}
void typeWitnessPrismaServiceIsNotATx;

// ④（运行期）见下面 `describe` 里的说明。

describe('转让的 tx 必填（Task 1 / 预检 §0.1）', () => {
  /**
   * 声明了**两个**参数，所以第一个是 `tx`。
   *
   * **据实记载这一条的判别力边界**：`Function.length` 数的是「第一个带默认值或 rest
   * 之前的形参个数」，而 TypeScript 的**可选参数不带默认值**（`tx?: T` 编译后仍是
   * `transferOwnership(tx, input)`）⇒ 实测 `length` 在「必填」与「可选」两种写法下**都是 2**。
   * 它打红的是「`tx` 参数被整个删掉」（`length === 1`，正是本用例落地前的实测红灯），
   * **不是**「`tx` 变成可选」——后者由 ① 在编译期打红。两者是**不同**的改动，各有一条判据。
   */
  it('transferOwnership 声明了两个形参（第一个是 tx）', () => {
    expect(OwnershipService.prototype.transferOwnership.length).toBe(2);
  });
});
