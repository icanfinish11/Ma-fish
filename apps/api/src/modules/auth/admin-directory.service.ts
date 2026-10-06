import { Injectable } from '@nestjs/common';
import { ROLES } from '@vca/shared';
import { PrismaService } from '../../db/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * 「这个人是不是管理员」与「这个人在不在」—— auth 模块对外的**两个**判断能力
 * （判管理员是 P2 / Task 10 加的，判存在是 P2 最终审查 C1 加的）。
 *
 * ## 为什么它必须住在 auth 里，而不是让 ledger 自己查 `auth.users`
 *
 * C5：每模块独占自己的 Postgres schema，**禁止跨模块 join 或直接写对方表**。`role` 列归
 * auth，因此判定只能由 auth 提供。这也是 `packages/shared` 里的 `ROLES.ADMIN` 第一次
 * 被真的用上（此前它只是一个常量）。
 *
 * ## 为什么返回值是 boolean 而不是用户对象
 *
 * 最小披露：调用方（策略条件 / 额度发放）只需要一个是非。返回整个用户行会把 `email`、
 * `creditScore` 这些与本判定无关的字段带进 ledger 的作用域——C11 的边界从「不记日志」延伸到
 * 「不必要地传递」。判据不只是这一句话：两个方法的返回类型都是 `Promise<boolean>`，
 * **没有**任何路径能从这里拿到用户行（`select` 里只有 `role` / `id`）。
 *
 * ## 为什么 `role` 的比较用 `ROLES.ADMIN` 而不是字面量 `'ADMIN'`
 *
 * 库里那一列是 `String @default("USER")`（不是数据库枚举），因此「管理员是哪几个字符串」
 * 这件事**只有一个来源**：`@vca/shared` 的 `ROLES`。写死字面量会让「改一次角色名」
 * 变成一次跨仓库搜索。
 */
@Injectable()
export class AdminDirectory {
  constructor(private readonly prisma: PrismaService) {}

  /** 「这个用户是不是管理员」。**绝不**在校验之外暴露任何用户字段（C11 的最小披露）。 */
  async isAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    // 用户不存在 ⇒ false（不是抛错）：策略条件的语义是「能不能」，而一个查不到的当事人
    // 显然不能。抛错会让守卫的默认拒绝变成 500，那是另一件事。
    return user?.role === ROLES.ADMIN;
  }

  /**
   * 「这个用户在不在」。**只回一个是非**（C11：不把用户行带进调用方的域）。
   *
   * ## 为什么 P2 需要它（最终全分支审查 C1）
   *
   * `grantCredit` 此前只校验 `userId` 的**格式**，而 `resolveAccounts` 会把
   * `(USER_AVAILABLE, <任意 uuid>)` 按需 `INSERT` 进 `ledger.accounts`。于是给一个
   * `auth.users` 里不存在的 uuid 发额度会**成功**：账平、五条不变式全绿、对账全绿、
   * 审计如实，而**没有任何路由或任务能花掉那笔钱**（没人能以此身份登录）——
   * 管理员的一次手误因此静默地销毁额度。它是 P2 里唯一一条外部可达的造钱路径上的缺陷。
   *
   * ## ★ `tx` 必填**加上**否定约束（`& { readonly $connect?: never }`）
   *
   * P2 收尾波把 `tx` 改成必填，控制器当时把它批准为「机器守卫」。**那条批准的前提是错的**
   * （P3 / Task 1 的实测，见 `apps/api/src/modules/asset/ownership.service.ts` 的类注释与
   * `tests/unit/db/transaction-client-guard.test.ts`）：
   *
   * ```
   * '$transaction' extends keyof Prisma.TransactionClient  === true
   * const tx: Prisma.TransactionClient = prismaService;     ← **编译通过**
   * ```
   *
   * Prisma 7 把 `$transaction` 从 denylist 里移出去了，而 `PrismaService` 继承
   * `PrismaClient`（成员更多）——TS 的结构化判定**不惩罚多出来的成员**。因此
   * 「必填的 `tx: Prisma.TransactionClient`」挡不住 `this.prisma`：类型层允许
   * `userExists(id, this.prisma)`，而那正是「读一个和那笔过账无关的快照」的形状。
   *
   * 参数类型因此写成「事务客户端 **且** 没有 `$connect`」：真实事务客户端没有 `$connect`
   * （它在 denylist 里），而 `PrismaService` 有 ⇒ 编译期拒收，真实调用方不受影响
   * （`ledger.service.ts` 的 `assertUserExists(tx: Prisma.TransactionClient, …)` 传进来
   * 的那一个照样赋得进去——实测 `Prisma.TransactionClient` 满足这条约束）。
   *
   * 传**调用方自己的事务**还有一个实际好处：这一次读与那笔过账在同一个快照里，
   * 不额外占一条连接（额度发放总是已经在一个事务里）。
   */
  async userExists(
    userId: string,
    tx: Prisma.TransactionClient & { readonly $connect?: never },
  ): Promise<boolean> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    return user !== null;
  }
}

