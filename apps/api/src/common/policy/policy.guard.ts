import { ForbiddenException, Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { currentContext } from '../context/request-context.js';
import { POLICY_KEY, PUBLIC_KEY, type PolicyDecl } from './policy.decorator.js';

/** 条件函数的入参。 */
export interface PolicyContext {
  req: Request;
  decl: PolicyDecl;
  /** 当事人。**条件被调用时它必然存在**（匿名请求在进入条件之前就被拒绝了，见 `canActivate`）。 */
  userId?: string;
}

/**
 * 命名条件：`true` 放行，`false` 拒绝。
 *
 * 之所以让各模块自己注册而不是在这里 `switch`：条件是**业务知识**（「是不是这份 Asset 的所有者」
 * 「要约是不是 SENT」），守卫只该知道「怎么找到并调用它」。未注册的条件一律拒绝（fail-closed），
 * 因此漏注册的表现是「本模块的路由全部 403」，而不是「悄悄放行」。
 */
export type PolicyCondition = (ctx: PolicyContext) => boolean | Promise<boolean>;

/**
 * 全局授权守卫：**默认拒绝**（设计 §9 / 威胁 #1）。
 *
 * 判定顺序是承重的，四步都不可交换：
 *
 * 1. `@Public()` → 放行。这是唯一的白名单，且必须**显式**书写；
 * 2. 无任何声明 → 拒绝（403）+ 告警。这就是「默认拒绝」的全部含义：没写声明 = 没被授权，
 *    而不是「未声明即公开」；
 * 3. 有条件声明 → **先要求身份**，再求值条件。顺序不能反：条件做的判定是「这个人能不能」，
 *    匿名请求下让它返回 true 就等于把「谁」这一列从矩阵里抹掉；
 * 4. 有条件但条件未注册 → 拒绝（fail-closed）。
 *
 * 无条件的声明（`@Policy({resource, action})`）不要求身份，对应 §9 中「谁 = 所有人」的行
 * （`Asset` 元数据 read、`Bid.amount` read）。需要「登录即可」的路由应显式注册一个判定
 * `userId` 的条件，而不是依赖省略条件来表达——省略表达的是「对所有人成立」。
 *
 * `Reflector` 走**构造函数注入**（NestJS 惯用法）：本仓库是 ESM，`require()` 在运行期不存在，
 * 守卫里绝不能出现动态 `require`。
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  private readonly logger = new Logger(PolicyGuard.name);
  private readonly conditions = new Map<string, PolicyCondition>();

  constructor(private readonly reflector: Reflector) {}

  /**
   * 注册命名条件（如 Asset 的所有者判定）。各业务模块在初始化时注册自己的条件。
   *
   * 注册到**本实例**上，因此 `PolicyModule` 必须把 `PolicyGuard` 作为 provider 导出、
   * `AppModule` 必须用 `useExisting`（而非 `useClass`）把它接到 `APP_GUARD`：
   * 否则全局守卫与各模块注入到的是两个不同实例，注册的条件到不了真正拦截请求的那一个。
   * 同名条件的后注册者会覆盖先注册者（当前无调用方依赖该行为，见任务报告 §concerns）。
   */
  registerCondition(name: string, fn: PolicyCondition): void {
    this.conditions.set(name, fn);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const decl = this.readDecl(context);
    if (decl === 'public') return true;

    const ctx = currentContext();

    if (decl === null) {
      // 默认拒绝。这条日志在两种情况下有价值：开发者漏写声明（是 bug，CI 的覆盖率门也会拦），
      // 或者有人在探测路由。命名与措辞保持稳定，便于告警规则按它匹配。
      this.logger.warn(`未声明策略的访问被默认拒绝 traceId=${ctx?.traceId ?? '-'}`);
      throw new ForbiddenException('该资源未被授权访问');
    }

    if (decl.condition === undefined) {
      // §9 中「谁 = 所有人」的行：声明本身就表示对所有调用方成立，因此不要求身份。
      return true;
    }

    // 有条件的声明必须有当事人：匿名请求不进条件判定，即使条件函数对匿名返回 true。
    if (!ctx?.userId) throw new ForbiddenException('需要登录');

    const condition = this.conditions.get(decl.condition);
    if (!condition) {
      // fail-closed：声明了条件却没有实现。这是接线错误，因此用 error 级别而不是 warn。
      this.logger.error(`策略条件未注册，按默认拒绝处理：${decl.condition}`);
      throw new ForbiddenException('该资源未被授权访问');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const allowed = await condition({ req, decl, userId: ctx.userId });
    if (!allowed) throw new ForbiddenException('该资源未被授权访问');
    return true;
  }

  /**
   * 读当前路由的声明。方法级优先于类级（`getAllAndOverride`），与 `PolicyRegistry.listRoutes`
   * 的取值优先级必须一致——否则 CI 门看到的声明会与运行期执行的声明不同。
   *
   * 注意「公开」判断排在策略判断**之前**，因此类级 `@Public()` 会覆盖其下所有方法，
   * 包括那些显式声明了 `@Policy` 的方法（`getAllAndOverride` 的语义就是「就近取第一个
   * 非 undefined 值」）。这是 Nest 社区 `@Public()` 的惯用语义，也意味着 `@Public()`
   * 只应打在**确实整体免鉴权**的控制器上（健康检查、登录入口），不要用它给某个控制器
   * 「开个口子」——那会让其中本就该判权的路由悄悄失去保护。
   */
  private readDecl(context: ExecutionContext): PolicyDecl | 'public' | null {
    const handler = context.getHandler();
    const cls = context.getClass();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, cls]) ?? false;
    if (isPublic) return 'public';
    return this.reflector.getAllAndOverride<PolicyDecl>(POLICY_KEY, [handler, cls]) ?? null;
  }
}
