import { SetMetadata } from '@nestjs/common';

/** 策略声明的元数据键。守卫与覆盖率门读的是同一个键，改名会让两边同时失声，故集中在此。 */
export const POLICY_KEY = 'vca:policy';

/** 「无需鉴权」的元数据键。**必须显式标注**，否则「忘记声明」会被误当成公开。 */
export const PUBLIC_KEY = 'vca:public';

/**
 * 一条「资源-动作-条件」授权声明（设计 §9 权限矩阵的一行）。
 *
 * `condition` 缺省表示该「资源-动作」对所有调用方成立（§9 中「谁 = 所有人」的那些行，
 * 例如 `Asset` 元数据 read、`Bid.amount` read）；一旦声明了条件，**当事人身份就变成必需**
 * ——条件函数判定的正是「这个人能不能」，匿名请求没有可判定的主体，一律拒绝
 * （即使条件函数对匿名返回 true，见 `policy.guard.ts`）。
 */
export interface PolicyDecl {
  resource: string;
  action: string;
  /** 命名条件，由 `PolicyGuard.registerCondition` 注册的函数实现；未注册即拒绝（fail-closed）。 */
  condition?: string;
}

/** 显式声明「资源-动作-条件」。未使用本装饰器且未标 `@Public()` 的路由**默认拒绝**。 */
export const Policy = (decl: PolicyDecl): MethodDecorator & ClassDecorator => SetMetadata(POLICY_KEY, decl);

/** 标记无需鉴权的路由（健康检查、登录入口）。 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);
