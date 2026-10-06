import { describe, expect, it } from 'vitest';
import { OwnershipService } from '@vca/api/modules/asset/ownership.service.js';

/**
 * ## 这个文件守的是什么（P3 / Task 2 / Item 0 —— 债务 B）
 *
 * ### 一句话
 *
 * `OwnershipService` **不再持有任何数据库客户端**，因此「绕开调用方的事务、自己开一个」
 * 这件事在本类里**结构上不可能**。
 *
 * ### 为什么删一个「没人用的字段」是一件承重的事（控制器裁定）
 *
 * Task 1 把 `transferOwnership` 改成收调用方的 `tx` 之后，`private readonly prisma`
 * **一个调用点都没有了**（实测 `this.prisma` 在方法体里零匹配）。控制器裁定**移除**它，
 * 理由逐字：**它唯一可能的用途就是绕开调用方的事务**——也就是构造出设计 §6.3:294
 * 所禁止的那个缺陷（「`RELEASED` 必须在单一数据库事务内完成…不留半成品所有权」）的
 * **最后一条路**。「一个没有所有者、却能开启禁区模式的把手，不是无害残留，是一把上了膛的枪。」
 * 而本项目自己的标准（P2 记录 `no-orphans` 警告而不是加 depcruise 例外）就写着：
 * **结构性不可能 > 约定**。
 *
 * 把字段留着、靠「大家记得别用 `this.prisma.$transaction`」约束，正是本仓库反复抓到的那类
 * 「声明了但未强制」。删掉之后，那个变异（探针 P-2 在 Task 1 用来复现 §0.1 的 `[B6]` 构造）
 * **连写都写不出来**：类里没有一个能开事务的对象。
 *
 * ### ★ 为什么判据落在**构造函数**上，而不是 `keyof`
 *
 * 初稿想写 `'prisma' extends keyof OwnershipService ? true : false`。**实测这个方向不成立**：
 *
 * ```
 * Q3  'prisma' extends keyof OwnershipService                       === false   ← 今天就 false
 * Q4  OwnershipService extends { readonly prisma: unknown }         === false   ← 今天就 false
 * ```
 *
 * 原因：`private` 成员**不进 `keyof`**，而且带私有成员的类在结构化判定下是**名义**的
 * （只有同一声明能相互赋值）。⇒ 那两条见证**今天就是 true→false 的方向**，
 * 属于本项目反复抓的「不可能失败的断言」（P0 的恒真 `toContain`、P1 的整除拆分、
 * P2 的 `--passWithNoTests`）。**据实记下这次否决**，免得下一个人再写一遍。
 *
 * 判别力因此落在一个**看得见的**结构事实上：**构造函数还要不要一个 `PrismaService`**。
 * 字段回来了（`private readonly prisma: PrismaService` 是参数属性）⇒ 构造函数多一个参数
 * ⇒ 下面两条见证一起变红。这个方向由探针 D-B1 实测过。
 */

/**
 * ① **编译期见证**：构造函数**不收任何参数**。
 *
 * `ConstructorParameters<typeof X>` 对参数属性照样成立（它就是构造函数签名）。
 * 字段被加回来 ⇒ 这个元组变成 `[prisma: PrismaService]` ⇒ 不再 `extends []` ⇒
 * `CtorAcceptsNothing` 变成 `false` ⇒ 下面那一行 TS2322。
 *
 * 判别力边界（据实）：它抓的是「构造函数多了一个参数」这一类改动，而**不**区分那个参数
 * 是不是 `PrismaService`——本仓库里给这个类注入别的东西同样会让它红。那是对的方向：
 * 这个类按设计**什么都不该持有**（它只做「指针 + 一行历史」两件事，全部在调用方的 `tx` 里）。
 */
type CtorParams = ConstructorParameters<typeof OwnershipService>;
type CtorAcceptsNothing = CtorParams extends [] ? true : false;
const ctorAcceptsNothing: CtorAcceptsNothing = true;
void ctorAcceptsNothing;

describe('转让服务不持有任何数据库客户端（P3 / Task 2 / Item 0 债务 B）', () => {
  /**
   * ② **运行期见证**：实例上**没有**任何自有属性。
   *
   * 为什么它是真的判据（不是「测实现细节」）：TypeScript 的**参数属性**
   * （`constructor(private readonly prisma: PrismaService)`）在 JS 里就是构造函数里的
   * 一句 `this.prisma = prisma`——它必然是一个**自有可枚举属性**。因此
   * 「实例的自有属性集合是不是空」精确地等于「这个类有没有持有注入的把手」。
   *
   * 本文件的第一次运行就是这条判据的**测量**：那时字段还在，实测值是
   * `['prisma']`（红灯），删掉之后是 `[]`（绿灯）。探针 D-B1 再把字段加回去，
   * 这条会以同一条消息变红。
   *
   * 断言写成 `toEqual([])` 而不是 `not.toContain('prisma')`：后者只挡一个名字，
   * 而这个类的契约是「什么都不持有」——换一个名字的把手（`this.client`）同样能把
   * 禁区模式打开，因此判据必须对**名字**无差别。
   */
  it('实例没有任何自有属性（没有任何可用来开第二个事务的把手）', () => {
    const service = new OwnershipService();
    expect(
      Object.getOwnPropertyNames(service),
      'OwnershipService 的实例上出现了自有属性——若那是注入的数据库客户端，' +
        '「绕开调用方事务」这条路就重新可写了（控制器裁定：结构性不可能 > 约定）',
    ).toEqual([]);
  });

  /**
   * ③ **两个方向都摆在这里**：零参数构造**必须成功**（否则 ② 可能只是因为构造就炸了）。
   *
   * 只写 ② 时，一个「构造出来就没有实例」的实现也能骗过它。
   */
  it('零参数构造成功，且转让方法仍然在原型上（验收对照）', () => {
    const service = new OwnershipService();
    expect(service).toBeInstanceOf(OwnershipService);
    expect(typeof service.transferOwnership).toBe('function');
  });
});
