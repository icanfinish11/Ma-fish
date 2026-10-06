import { Injectable } from '@nestjs/common';
import { ROLES } from '@vca/shared';
import { PrismaService } from '../../db/prisma.service.js';

/**
 * 「这个人是不是管理员」—— auth 模块对外的**唯一**新增能力（P2 / Task 10）。
 *
 * ## 为什么它必须住在 auth 里，而不是让 ledger 自己查 `auth.users`
 *
 * C5：每模块独占自己的 Postgres schema，**禁止跨模块 join 或直接写对方表**。`role` 列归
 * auth，因此判定只能由 auth 提供。这也是 `packages/shared` 里的 `ROLES.ADMIN` 第一次
 * 被真的用上（此前它只是一个常量）。
 *
 * ## 为什么返回值是 boolean 而不是用户对象
 *
 * 最小披露：调用方（策略条件）只需要一个是非。返回整个用户行会把 `email`、`creditScore`
 * 这些与本判定无关的字段带进 ledger 的作用域——C11 的边界从「不记日志」延伸到
 * 「不必要地传递」。判据不只是这一句话：返回类型是 `Promise<boolean>`，**没有**任何
 * 路径能从这里拿到用户行（`select` 里也只有 `role`）。
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
}
