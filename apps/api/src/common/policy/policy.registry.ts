import { Injectable, type Type } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { POLICY_KEY, PUBLIC_KEY, type PolicyDecl } from './policy.decorator.js';

/** 一条已注册路由及其策略声明（覆盖率门的输入）。 */
export interface RouteEntry {
  controller: string;
  handler: string;
  /** 归一化后的路径，只用于**报错信息**里指认漏声明的路由（不是路由表本身）。 */
  path: string;
  decl: PolicyDecl | null;
  isPublic: boolean;
}

/**
 * 策略声明的**发现**层：枚举「应用里到底有哪些路由、各自声明了什么」。
 *
 * 它只服务于一个消费者：CI 的覆盖率门（`tests/security/policy-route-coverage.test.ts`）。
 * 运行期的放行判定**不**经过这里——`PolicyGuard` 直接读装饰器元数据，那是每个请求的热路径，
 * 不该付「遍历全部 controller」的代价。
 *
 * 两者读的是**同一个** `POLICY_KEY` / `PUBLIC_KEY`、同一套优先级（方法优先于类，见下），
 * 因此门禁看到的声明与守卫实际执行的声明不会漂移。
 */
@Injectable()
export class PolicyRegistry {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** 枚举全部已注册路由及其策略声明。守护与覆盖率测试共用同一份真相。 */
  listRoutes(): RouteEntry[] {
    const out: RouteEntry[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | null;
      // 控制器实例在极端情况下可能为空（例如请求作用域下尚未实例化）：跳过而不是抛错，
      // 因为覆盖率门的语义是「已注册的路由都必须有声明」，而不是「发现层不能失败」。
      if (!instance) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      const controllerPath = this.reflector.get<string>('path', wrapper.metatype as Type) ?? '';
      const controllerPublic = this.reflector.get<boolean>(PUBLIC_KEY, wrapper.metatype as Type) ?? false;
      const controllerPolicy = this.reflector.get<PolicyDecl>(POLICY_KEY, wrapper.metatype as Type) ?? null;

      for (const methodName of this.scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[methodName];
        // `typeof === 'function'` 既是过滤器也是**类型收窄**：Reflector 的 `target` 只接受
        // `Type | Function`，先收窄再传，才不需要 `as object` 这类会把重载解析带偏的断言
        // （实测：写成 `handler as object` 会让 tsc 报 TS2345/TS2739，而 vitest 照样全绿）。
        if (typeof handler !== 'function') continue;
        const routePath = this.reflector.get<string>('path', handler);
        // 没有路径元数据 = 不是路由方法（私有辅助方法等），不属于「路由」的范畴。
        // 注意 `@Get()` 不带参数时路径元数据是 `'/'`（Nest 的 `defaultMetadata`），
        // 因此「空路径」与「未声明」不会被混为一谈。
        if (routePath === undefined) continue;
        const isPublic = (this.reflector.get<boolean>(PUBLIC_KEY, handler) ?? false) || controllerPublic;
        const decl = this.reflector.get<PolicyDecl>(POLICY_KEY, handler) ?? controllerPolicy;
        out.push({
          controller: (wrapper.metatype as Type).name,
          handler: methodName,
          // 归一化：合并重复斜杠，并去掉尾斜杠（`@Controller('health')` + `@Get()` 的真实路径是
          // `/health`，若报成 `/health/` 会让照着报错去找路由的人白跑一趟）。
          path: normalizePath(`/${controllerPath}/${routePath}`),
          decl: decl ?? null,
          isPublic,
        });
      }
    }
    return out;
  }

  /**
   * 覆盖率测试用：既未标 `@Public()`、又无策略声明的路由（应当为空）。
   *
   * 「未声明」= 默认拒绝的对象。它**不是**「拒绝名单」：拒绝是守卫的默认行为，
   * 这份列表存在的意义是让**开发者**在 CI 里就看到自己漏了声明，而不是等线上 403。
   */
  listUndeclaredRoutes(): string[] {
    return this.listRoutes()
      .filter((r) => !r.isPublic && r.decl === null)
      .map((r) => `${r.controller}.${r.handler}  ${r.path}`);
  }

  /** 按「控制器类名 + 方法名」定位一条路由（供需要精确查声明的测试使用）。 */
  find(controllerName: string, handlerName: string): RouteEntry | undefined {
    return this.listRoutes().find((r) => r.controller === controllerName && r.handler === handlerName);
  }
}

/** 合并重复斜杠；保留根路径 `/`，其余去掉尾斜杠。 */
function normalizePath(path: string): string {
  const collapsed = path.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}
