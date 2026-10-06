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
 * | 判据 | 在哪一层 | 什么改动会打红它 | 谁把它打红过 |
 * |---|---|---|---|
 * | ① `TxParamIsRequiredTransactionClient` | 编译期 | `tx` 改成 `tx?` **或** `tx` 被删掉 ⇒ 变成 `false` ⇒ TS2322 | 探针 P-1（实测） |
 * | ② `@ts-expect-error`（`PrismaService` 不能当 `tx`） | 编译期 | 否定约束（`$connect`）被去掉 ⇒ 指令**不再被使用** ⇒ TS2578 | 见下面「复访触发条件」 |
 * | ③ `Function.length === 2` | 运行期 | `tx` 参数被**整个删掉** ⇒ 1（**分不出 required/optional**，理由写在用例上） | TDD 的首次红灯（实测 `expected 1 to be 2`） |
 *
 * 判据 ①② 由 `pnpm typecheck`（`pnpm -r typecheck` 覆盖 `tests/` 这个 workspace 包）
 * 执行，`vitest` 只执行 ③——ESM 下类型在运行期不存在，这一点没法绕开，因此它写在明处。
 * **判据的编号与「谁打红过」都必须逐条有实测**：本项目抓到过的缺陷里有一整类
 * 「断言红了，但红在别的机制上」，因此没有实测过的判别力一律不写在这里。
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

/** `transferOwnership` 的**第一个**参数类型（见证 ①③ 全从它推出）。 */
type TxParam = Parameters<typeof OwnershipService.prototype.transferOwnership>[0];

/**
 * ① **「是一个事务客户端，且必填」——一条见证，不是两条**。
 *
 * ## 为什么合成一条（探针 P-1 的实测逼出来的结论）
 *
 * 初稿把它写成两条独立的类型别名（`TxIsRequired` 与 `TxIsTransactionClient`），
 * 各配一行 `= true`。**探针 P-1 一次把两行都打红了**：
 *
 * ```
 * tests/unit/asset/ownership-tx.test.ts(79,7): error TS2322: Type 'true' is not assignable to type 'false'.
 * tests/unit/asset/ownership-tx.test.ts(84,7): error TS2322: Type 'true' is not assignable to type 'false'.
 * ```
 *
 * 那次输出说明了一件事：`undefined extends TxParam` 为真 **蕴含**
 * `TxParam extends Prisma.TransactionClient` 为假（`undefined` 不是对象类型的成员）
 * ⇒ **前一条永远不可能单独变红**，留着它就是一条「不可能失败的断言」——正是本项目
 * 反复抓到的那一类（P0 的恒真 `toContain`、P1 的整除拆分、P2 的 `--passWithNoTests`）。
 * 合成一条之后，两个方向仍然各自可判别：
 *
 * - `tx` 改成 `tx?`（**探针 P-1**）⇒ `undefined extends TxParam` ⇒ 这一行红；
 * - `tx` 被整个删掉（第一个参数退回业务入参）⇒ 第二个分支不成立 ⇒ **同一行**红。
 *
 * 判别力边界（据实写在这里，而不是留给读者猜）：这一条**不**能证明
 * `PrismaService` 被拒——那是 ③ 的活；`tx: Prisma.TransactionClient`（去掉否定约束）
 * 会让 ① 照旧绿，而 ③ 以 TS2578 红。两者覆盖**不同**的改动。
 */
type TxParamIsRequiredTransactionClient =
  undefined extends TxParam ? false : TxParam extends Prisma.TransactionClient ? true : false;
const txParamIsRequiredTransactionClient: TxParamIsRequiredTransactionClient = true;

/**
 * 上面这条见证**在运行期一次都不被读**——ESM 下类型不存在，`tsc` 是唯一的判据
 * （`pnpm typecheck` 覆盖 `tests/` 这个 workspace 包）。
 *
 * `void` 写在这里是为了让 `@typescript-eslint/no-unused-vars` 看明白它不是漏写。
 * **刻意不用 `expect(txParamIsRequiredTransactionClient).toBe(true)` 那样的运行期断言**：
 * 类型被擦除之后那一句恒真，正是上面那段说的同一类缺陷。
 */
void txParamIsRequiredTransactionClient;

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
