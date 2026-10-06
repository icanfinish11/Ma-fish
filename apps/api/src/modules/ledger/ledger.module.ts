import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { PolicyGuard } from '../../common/policy/policy.guard.js';
import { AuditModule } from '../audit/index.js';
import { AdminDirectory, AuthModule } from '../auth/index.js';
import { LedgerController, POLICY_CONDITIONS } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { LedgerReconciliationService } from './reconciliation.service.js';

/**
 * 账本模块（P2；Task 10 起被装配进 `AppModule`）。
 *
 * ## 策略条件的名字为什么从控制器 import 过来（而不是定义在本文件）
 *
 * 计划把它写在本文件里，**实测那样会成环**：`ledger.module.ts → ledger.controller.ts
 * → ledger.module.ts`，而 `@Policy({…})` 的实参在类定义期求值 ⇒ 三个 security 套件
 * 在收集阶段以 `TypeError: Cannot read properties of undefined (reading 'ledgerAdminGrant')`
 * 失败。完整实测与理由写在 `ledger.controller.ts` 里那个常量的头注释上。
 * 本文件因此只做**注册**（`registerCondition`），名字的所有权在声明方。
 *
 * ## 它为什么要 `registerCondition`
 *
 * §9 的权限矩阵里没有 `Ledger.grant` 这一行（矩阵只有 `LedgerEntry read`），而默认拒绝
 * 要求每条路由**显式表态**。「谁能发额度」是**业务知识**，因此按 `PolicyGuard`
 * 的设计（「条件是业务知识……守卫只该知道怎么找到并调用它」）注册在本模块里。
 * 未注册的条件一律拒绝（fail-closed），因此漏注册的表现是「这条路由 403」而不是放行。
 *
 * ## 为什么是 `onModuleInit` 而不是在字段初始化时
 *
 * `registerCondition` 必须落在**全局守卫那一个实例**上（`PolicyModule` 是 `@Global()`，
 * `AppModule` 用 `useExisting` 把同一个实例接到 `APP_GUARD`）。在 `onModuleInit` 里注册
 * 保证 DI 已经就绪，且注册发生在应用 `init()` 之前——`PolicyGuard.canActivate` 只会
 * 在 `init()` 之后被调用。
 *
 * ## 为什么 `AdminDirectory` 来自 `../auth/index.js` 而不是深引那个文件
 *
 * §3.3 第 2 条 + `no-cross-module-internals`：跨模块只走对方的 `index.ts`。
 * auth 的 `index.ts` 是 Task 10 新建的（ledger 是它的第一个真实调用方）。
 *
 * ## 为什么 `LedgerReconciliationService` 在这里被提供
 *
 * 它在 Task 9 落地时**没有**任何模块装配它（当时 `LedgerModule` 还不存在）。
 * 它今天**没有**路由、没有消费者，因此这里提供它**不是**为了被注入——
 * 据实记载：它唯一的作用是让「账本模块的三个服务住在一起」这件事在装配上成立，
 * 将来加对账端点时不必再动模块（复访触发条件写在那个类的头注释里：worker 第一次
 * 真正写账本时）。**不为它建路由**（§2.1 的 P2 行里没有读接口，D15）。
 */
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [LedgerController],
  providers: [LedgerService, LedgerReconciliationService],
})
export class LedgerModule implements OnModuleInit {
  constructor(
    @Inject(PolicyGuard) private readonly policy: PolicyGuard,
    private readonly admins: AdminDirectory,
  ) {}

  onModuleInit(): void {
    // 条件体只做一件事：把「这个人是不是管理员」交给 auth（C5：`role` 列归 auth）。
    // `userId === undefined` 时返回 false 而不是抛错——不过实际上守卫在条件之前
    // 就已经把匿名请求拒了（`PolicyGuard` 的判定顺序第 4 步），这一句是纵深防御。
    this.policy.registerCondition(POLICY_CONDITIONS.ledgerAdminGrant, async ({ userId }) =>
      userId !== undefined && (await this.admins.isAdmin(userId)),
    );
  }
}
