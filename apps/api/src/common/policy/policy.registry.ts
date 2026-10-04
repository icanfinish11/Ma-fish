import { Injectable, type Type } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { POLICY_KEY, PUBLIC_KEY, type PolicyDecl } from './policy.decorator.js';
import { readRateLimitDecl, type RateLimitName } from '../security/throttler.js';

/** 一条已注册路由及其策略声明（覆盖率门的输入）。 */
export interface RouteEntry {
  controller: string;
  handler: string;
  /** 归一化后的路径，只用于**报错信息**里指认漏声明的路由（不是路由表本身）。 */
  path: string;
  decl: PolicyDecl | null;
  isPublic: boolean;
  /** 本路由声明的限流层（`@RateLimited`）；未声明为 `null`。 */
  rateLimit: RateLimitName | null;
  /** 本路由是否显式标记了「有意不限流」（`@SkipRateLimit()`）。 */
  rateLimitSkipped: boolean;
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
 *
 * ## 修复轮 1（C-4）：**同一个**注册表也报告限流声明，而不是再加一个并行的 walker
 *
 * 限流的覆盖率门（`tests/security/rate-limit-coverage.test.ts`）与策略门问的是同一个问题：
 * 「这条已注册的路由声明了它的安全归属吗」。再写一遍 `DiscoveryService` + `MetadataScanner`
 * 的遍历等于把「哪些是路由」这件事表达两次——两份实现迟早漂移，而漂移方向通常是
 * 「一条新路由被其中一份漏掉」，正是门要防的东西。因此这里扩展同一份 `RouteEntry`。
 *
 * 声明本身仍由 `throttler.ts` 的 `readRateLimitDecl()` 读（守卫的 `skipIf` 用的是同一个函数），
 * 注册表只负责「枚举路由」这一件事。
 *
 * **名字保留 `PolicyRegistry`**：它是 Task 5 的既有名字，改名会波及既有断言面，
 * 属于修复轮之外的改动。它的职责应读作「路由声明的注册表」。
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
        const rateLimit = readRateLimitDecl(handler, wrapper.metatype as Type);
        out.push({
          controller: (wrapper.metatype as Type).name,
          handler: methodName,
          // 归一化：合并重复斜杠，并去掉尾斜杠（`@Controller('health')` + `@Get()` 的真实路径是
          // `/health`，若报成 `/health/` 会让照着报错去找路由的人白跑一趟）。
          path: normalizePath(`/${controllerPath}/${routePath}`),
          decl: decl ?? null,
          isPublic,
          rateLimit: rateLimit.tier,
          rateLimitSkipped: rateLimit.unlimited,
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

  /**
   * 限流覆盖率门用：**没有**限流归属的路由（应当为空）。
   *
   * 两种形态都算「没有归属」，因此错误信息必须分得清：
   *
   * 1. `rateLimit === null && !rateLimitSkipped` —— 漏声明。新增路由时最容易发生，
   *    而它在运行期的表现是**完全不限流**；
   * 2. `rateLimit !== null && rateLimitSkipped` —— 自相矛盾：既声明了某一层、
   *    又要求豁免。运行期以层声明为准（fail-strict），但两种声明里必有一个在说谎，
   *    所以一样报出来，而不是静默挑一个执行。
   */
  listRateLimitGaps(): string[] {
    return this.listRoutes()
      // **两个条件必须是「异或」，不是「或」**：合法状态有两种——只声明层、或只标豁免，
      // 因此「缺归属」= 恰好只有一个成立。写成 `rateLimit === null || rateLimitSkipped`
      // 会把**合法的**`@SkipRateLimit()` 路由（层为空 + 有标）一并报出来，
      // 于是门对着照规矩写的代码变红（修复轮 1 实测踩到过：`/health` 被误报）。
      .filter((r) => (r.rateLimit === null) === !r.rateLimitSkipped)
      .map((r) => {
        const where = `${r.controller}.${r.handler}  ${r.path}`;
        return r.rateLimitSkipped
          ? `${where}  ← 同时声明了 ${r.rateLimit} 层与 @SkipRateLimit()：两种声明矛盾`
          : `${where}  ← 既未声明 @RateLimited(...)，也未标 @SkipRateLimit()`;
      });
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
