import { describe, expect, it } from 'vitest';
import type { Prisma } from '@vca/api/generated/prisma/client.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { AdminDirectory } from '@vca/api/modules/auth/admin-directory.service.js';

/**
 * ## 这个文件守的是什么（P3 / Task 2 / Item 0 —— 两笔 P2 欠账）
 *
 * ### 一句话
 *
 * **「`tx` 必填」不是一条机器守卫，而参数类型里那条否定约束才是。** 本文件把那个形状
 * 钉在 P2 的两个落点上（`AuditService.record` 与 `AdminDirectory.userExists`）。
 *
 * ### 来路（Task 1 用实测量推翻的一条控制器裁定的前提）
 *
 * P2 收尾波把 `userExists(userId, tx)` 的 `tx` 改成**必填**，控制器把它批准为
 * 「机器守卫」。Task 1 实测那条前提**是错的**（原始量具留在
 * `evidence/t1-probe-type-guard-source.ts.txt` / `t1-probe-type-guard-green.txt`）：
 *
 * ```
 * F1  '$transaction' extends keyof Prisma.TransactionClient   === true
 *     （Prisma 7.10.0 的 denylist 是 ["$connect","$disconnect","$on","$use","$extends"]；
 *       Prisma ≤6 把 `$transaction` 放在里面。计划 D1 那句「它没有 $transaction」今天不成立。）
 * F2  const tx: Prisma.TransactionClient = prismaService;      ← **编译通过**
 * ```
 *
 * 原因是 TS 的结构化判定：`PrismaService` 继承 `PrismaClient`，成员**更多**，
 * 于是它满足 `Prisma.TransactionClient`——**多出来的成员从来不会让赋值失败**。
 * ⇒ 「必填」只把「少写一个参数」换成了「先构造一个假事务」，而后者恰恰最顺手
 * （`this.prisma` 就在手边）。它挡不住任何东西。
 *
 * ### 真正承重的形状（Task 1 建的，本文件把它推广到另外两个落点）
 *
 * ```ts
 * tx: Prisma.TransactionClient & { readonly $connect?: never }
 * ```
 *
 * `$connect` 在 denylist 里 ⇒ **真实事务客户端没有它**（实测 F6），而 `PrismaService`
 * **有**（它继承 `PrismaClient`）⇒ 编译期拒收（实测 F4：`Type '() => Promise<void>' is not
 * assignable to type 'undefined'`）。真实调用方不受影响（实测 F5/F11；本文件下面的
 * 「验收对照」那两条见证把同一件事**在本文件里**再证一次，不靠别的文件的结论）。
 *
 * ### 为什么这个文件里每个落点有**两条**见证（一条拒绝 + 一条验收）
 *
 * 只写拒绝面时，「怎么都拒」的实现也能满足它——把参数类型写成 `never` 会让下面那两条
 * `@ts-expect-error` 一起变绿，而真实调用方会在别处炸。因此每个落点都必须有它的
 * **验收对照**：`Prisma.TransactionClient`（`ledger.service.ts` 里那些 `tx` 参数的静态类型）
 * 仍然可以赋给它。
 *
 * ### 判据全在**编译期**，由 `pnpm typecheck` 执行
 *
 * `pnpm -r typecheck` 覆盖 `tests/` 这个 workspace 包（`tests/tsconfig.json` 的 `include`
 * 把 `tests/` 下**全部** `.ts` 收进来），vitest 在 ESM 下看不到类型。因此本文件的判据是
 * `tsc` 的，`describe` 里那一条运行期用例只是给「这个文件被真的执行过」留一个落点。
 * 三条见证的判别力**全部由变异探针实测过**（Task 2 报告的探针 D-A1 / D-A2）。
 */

/** `AuditService.record` 的**第二个**参数（`tx?`），剥掉 `| undefined` 之后就是它自身。 */
type RecordTxParam = Parameters<typeof AuditService.prototype.record>[1];

/** `AdminDirectory.userExists` 的**第二个**参数。 */
type UserExistsTxParam = Parameters<typeof AdminDirectory.prototype.userExists>[1];

/**
 * ① **拒绝面**：`PrismaService` 不能当 `record` 的 `tx`。
 *
 * `@ts-expect-error` 在这里**是被使用的**（那一句赋值确实报错）。把
 * `& { readonly $connect?: never }` 从 `audit.service.ts` 的签名里去掉 ⇒ 赋值重新合法
 * ⇒ 本指令**未使用** ⇒ **TS2578** ⇒ `pnpm typecheck` 红。这正是探针 D-A1 的判据。
 */
function witnessRecordRejectsPrismaService(): void {
  // @ts-expect-error `PrismaService` 有 `$connect`（它继承 `PrismaClient`），不是事务客户端
  const notATx: RecordTxParam = null as unknown as PrismaService;
  void notATx;
}
void witnessRecordRejectsPrismaService;

/**
 * ② **验收对照**：一个**真的**事务客户端（`Prisma.TransactionClient`）仍然赋得进去。
 *
 * 它挡的是「把参数收窄成 `never`」那类过度收紧——那种实现会让 ① 变绿，而
 * `ledger.service.ts` 的 `postLegs(tx: Prisma.TransactionClient, …)` 里那一句
 * `this.audit.record(…, tx)` 变成编译错误。两方向都在，判据才成立。
 */
type PlainTransactionClientIsAcceptedByRecord = Prisma.TransactionClient extends Exclude<
  RecordTxParam,
  undefined
>
  ? true
  : false;
const plainTxIsAcceptedByRecord: PlainTransactionClientIsAcceptedByRecord = true;
void plainTxIsAcceptedByRecord;

/**
 * ③ **拒绝面**：`PrismaService` 不能当 `userExists` 的 `tx`。
 *
 * 这一条对应的历史最直接：P2 收尾波的 C1 修复把 `tx` 改成必填，控制器把它批准为
 * 「机器守卫」——**那条批准的前提是错的**（见文件头）。探针 D-A2 的判据与 ① 同形。
 */
function witnessUserExistsRejectsPrismaService(): void {
  // @ts-expect-error `PrismaService` 有 `$connect`，不是事务客户端
  const notATx: UserExistsTxParam = null as unknown as PrismaService;
  void notATx;
}
void witnessUserExistsRejectsPrismaService;

/** ④ **验收对照**：`Prisma.TransactionClient` 仍然赋得进 `userExists` 的第二个参数。 */
type PlainTransactionClientIsAcceptedByUserExists = Prisma.TransactionClient extends UserExistsTxParam
  ? true
  : false;
const plainTxIsAcceptedByUserExists: PlainTransactionClientIsAcceptedByUserExists = true;
void plainTxIsAcceptedByUserExists;

describe('事务客户端的否定约束（P3 / Task 2 / Item 0 债务 A）', () => {
  /**
   * 这个文件的判据在编译期（①②③④），运行期只有这一条。
   *
   * 它**不是**装饰：`AuditService` 与 `AdminDirectory` 都必须能被**构造**出来，
   * 而两个类的构造函数都要一个 `PrismaService`——把依赖删掉或改名会让这一行在
   * 运行期就炸，而不是等到某条集成用例的 beforeAll。判据本身（`typeof`）恒真，
   * 值在那一句**构造**上，注释据实说明这一点，免得它被读成一条安全断言。
   */
  it('两个类都还构造得出来（判据在编译期，这里只证明文件真的被执行过）', () => {
    const prisma = null as unknown as PrismaService;
    expect(new AuditService(prisma)).toBeInstanceOf(AuditService);
    expect(new AdminDirectory(prisma)).toBeInstanceOf(AdminDirectory);
  });
});
