import { applyDecorators, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { normalizeIp, Throttle, type ThrottlerGetTrackerFunction, type ThrottlerOptions } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { currentContext } from '../context/request-context.js';

/**
 * 分层令牌桶限流表（威胁 #13 / C12）。
 *
 * **数值改动必须同步设计文档 §4.1 威胁 #13**：本文件是那张表在代码里的唯一落点，
 * 而 `tests/security/rate-limit.test.ts` 逐条断言它与设计一致——改这里而不改文档
 * （或反过来）会让测试变红，这是刻意的：限流阈值是**安全参数**，
 * 一次「顺手调大」等于关掉一层防护，不该无声发生。
 */
export const RATE_LIMITS = {
  login: { limit: 5, ttlMs: 15 * 60_000, by: 'ip+account' },
  register: { limit: 3, ttlMs: 60 * 60_000, by: 'ip' },
  bid: { limit: 30, ttlMs: 60_000, by: 'user' },
  upload: { limit: 10, ttlMs: 24 * 60 * 60_000, by: 'user' },
  search: { limit: 60, ttlMs: 60_000, by: 'ip' },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** 分桶维度：`ip` 按客户端 IP，`ip+account` 再叠一层账号，`user` 按已认证的当事人。 */
export type RateLimitBasis = (typeof RATE_LIMITS)[RateLimitName]['by'];

/**
 * 「本路由声明了哪一层」的元数据键。
 *
 * 为什么要有自己的键（而不是去读 `@nestjs/throttler` 的 `THROTTLER:LIMIT<name>`）：
 * 那个常量**没有**从包的入口导出（`dist/index.d.ts` 只导出 `throttler.decorator` 等，
 * 不含 `throttler.constants`），照抄字符串就等于把内部实现细节写进我们的代码——
 * 包升级时它改名，我们的 `skipIf` 会静默地永远返回「未声明」，于是**所有限流消失**
 * 而没有任何报错。用自己的键，唯一依赖是包的公开装饰器 `@Throttle`。
 */
const RATE_LIMIT_KEY = 'vca:rate-limit';

/**
 * 声明本路由受名为 `name` 的那一层限流。
 *
 * 同时写入两处：包自己的 `@Throttle`（提供该层的 `limit`/`ttl` 覆盖）与我们的元数据键
 * （供下方的 `skipIf` 判断「本路由**是否**声明了这一层」）。
 * 两者必须成对出现，因此包装成一个装饰器——只写 `@Throttle` 时数值会被包读到，
 * 但我们的 `skipIf` 认为「没声明」，于是这一层**不会**生效（见下）。
 */
export function RateLimited(name: RateLimitName): MethodDecorator & ClassDecorator {
  const spec = RATE_LIMITS[name];
  return applyDecorators(
    SetMetadata(RATE_LIMIT_KEY, name),
    Throttle({ [name]: { limit: spec.limit, ttl: spec.ttlMs } }),
  );
}

/**
 * 「本路由**有意**不限流」的元数据键（修复轮 1 / C-4：覆盖率门的第二个合法状态）。
 */
const RATE_LIMIT_SKIP_KEY = 'vca:rate-limit-skip';

/**
 * 显式声明「本路由有意不限流」（威胁 #13 的覆盖面上限之外的路径）。
 *
 * ## 为什么需要它：把「忘记声明」与「有意不限流」分开
 *
 * 运行期的规则是「每层只对显式声明它的路由生效」（见 `throttlerOptions`），
 * 因此**未声明的路由本来就不限流**——于是「新路由漏写 `@RateLimited`」的失效形态是
 * **静默不限流**，没有任何测试会红。这与本仓库已经抓到过的四次缺陷同一形状
 * （空操作的 `REVOKE`、漏掉 `.tsx` 的扫描器、死代码规则、恒真断言）。
 *
 * `tests/security/rate-limit-coverage.test.ts` 是那道门：它用 `RouteDeclarationRegistry` 枚举
 * 全部已注册路由，要求每条路由**要么**声明了某一层、**要么**打了这个标。
 * 于是「漏写」在 CI 里就是一条列出「哪个 controller、哪个方法、哪条路径」的失败，
 * 而不是线上一个不限流的接口。
 *
 * ## 这个装饰器在**运行期不做任何事**（据实记载，别误以为是 `@Public()` 那样的一票通过）
 *
 * `skipIf` 只读层名（`RATE_LIMIT_KEY`），**不读**这个键：未被任何层声明的路由在运行期
 * 本来就不受限，加不加它，请求行为完全一样。它的**唯一**消费者是覆盖率门。
 * 之所以仍然值得存在：门需要区分「作者想过这件事并写了『不限流』」与「作者没想过」，
 * 而后者才是要拦的。
 *
 * 反向的诱惑（让运行期「显式豁免优先于层声明」）**没有**采纳：一个同时打了层声明与豁免标的
 * 路由，两种写法在说谎；此时让豁免生效等于朝 fail-open 方向消解矛盾。现在的规则是
 * 「层声明照旧生效（fail-strict），矛盾由门在 CI 里报出来」。
 */
export function SkipRateLimit(): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_SKIP_KEY, true);
}

/** 一条路由的限流声明（运行期 `skipIf` 的判据，也是覆盖率门的输入）。 */
export interface RateLimitDeclaration {
  /** 本路由声明的层名；未声明为 `null`。 */
  tier: RateLimitName | null;
  /** 是否显式标记了「有意不限流」。 */
  unlimited: boolean;
}

/**
 * 元数据读取的目标：处理器函数或控制器类。
 *
 * 类型从 `Reflector` 自己的签名里取（`(Type<any> | Function)[]` 的元素），
 * 而不是手写 `Function`——后者会被 `@typescript-eslint/no-unsafe-function-type` 拦下，
 * 而且手写的类型一旦与 `Reflector` 的签名漂移，报错点会跑到调用方去。
 */
type RouteTarget = Parameters<Reflector['getAllAndOverride']>[1][number];

/**
 * 读一条路由的限流声明。
 *
 * **两处消费者共用这一个函数**是刻意的：运行期的 `skipIf` 与 CI 的覆盖率门
 * （`RouteDeclarationRegistry.listRateLimitGaps()`）若各读各的元数据、各写一套优先级，
 * 两者迟早漂移——而漂移方向通常是「门看到的是声明了的、守卫看到的是没声明」，
 * 也就是门绿灯而线上不限流。方法与类同时存在时方法优先（`getAllAndOverride`）。
 */
export function readRateLimitDecl(handler: RouteTarget, controller: RouteTarget): RateLimitDeclaration {
  return {
    tier: reflector.getAllAndOverride<RateLimitName>(RATE_LIMIT_KEY, [handler, controller]) ?? null,
    unlimited: reflector.getAllAndOverride<boolean>(RATE_LIMIT_SKIP_KEY, [handler, controller]) === true,
  };
}

/** 只读元数据、无状态；`ThrottlerGuard` 的 `skipIf` 是纯函数签名，拿不到 DI 容器。 */
const reflector = new Reflector();

/** 本路由是否**显式**声明了名为 `name` 的限流层（`skipIf` 的判据，见 `throttlerOptions`）。 */
function declaresRateLimit(context: ExecutionContext, name: RateLimitName): boolean {
  return readRateLimitDecl(context.getHandler(), context.getClass()).tier === name;
}

/**
 * 按 `by` 生成该层的分桶键。
 *
 * `by` 不是注释：三种语义各自决定「谁的桶会被填满」，而那正是安全语义所在。
 * 全都退回默认的「只按 IP」时，限流**看起来**照常工作（一样会 429），
 * 差别是「同一个 NAT 后的所有人共用一个桶」（大范围误伤）或
 * 「一个攻击者能把受害者的账号锁死」。因此 `tests/security/rate-limit.test.ts`
 * 对三种维度各有一条判别性断言，登录层还有一条端到端断言（换账号应当放行）。
 */
export function trackerFor(basis: RateLimitBasis): ThrottlerGetTrackerFunction {
  switch (basis) {
    case 'ip':
      return (req) => clientIp(req);
    case 'ip+account':
      return (req) => `${clientIp(req)}|${accountKey(req['body'])}`;
    case 'user':
      // 已认证 ⇒ 按当事人分桶；匿名 ⇒ 退回按 IP。
      // 匿名时**不能**统一落到一个常量桶（例如 `'anonymous'`）：那会让所有未登录用户
      // 共用一份配额，一个爬虫就能把所有人的额度吃光。这类请求随后会被守卫 403，
      // 但在那之前它已经占掉了桶。
      return (req) => currentContext()?.userId ?? `ip:${clientIp(req)}`;
  }
}

/** 客户端 IP。用包自带的 `normalizeIp`（IPv6 按 /64 前缀归并），与默认 tracker 同语义。 */
function clientIp(req: Record<string, unknown>): string {
  const ip = req['ip'];
  return normalizeIp(typeof ip === 'string' ? ip : '');
}

/**
 * 账号维度只取**哈希前缀**（C11：日志/存储里不出现完整邮箱）。
 *
 * 桶键会进限流存储（**Redis**，见 `redis-throttler.storage.ts`；修复轮 1 从进程内 Map
 * 搬过来的），而「用户标识」不该以明文形式落在那里——它同时是「不落日志」和
 * 「不落共享存储」两条要求。大小写与首尾空白先归一：`A@b.co` 与 `a@b.co` 是同一个账号，
 * 不归一会让攻击者用一个字母的大小写变体把配额翻倍。
 */
function accountKey(body: unknown): string {
  const email = (body as { email?: unknown } | null | undefined)?.email;
  if (typeof email !== 'string' || email.trim() === '') return 'no-account';
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

/**
 * `ThrottlerModule.forRoot` 的配置：把 `RATE_LIMITS` 逐条翻译成库的选项。
 *
 * ## `skipIf` 是**承重**的（读库源码 + 实测得出，勿凭直觉删）
 *
 * `ThrottlerGuard.canActivate`（`@nestjs/throttler@6.7.1` 的 `throttler.guard.js`
 * 第 76–105 行）是「对**每一个**已配置的 throttler，逐个求值**当前路由**」：
 * `@Throttle({ name })` 只覆盖**同名**那一层的数值，其余各层照旧按 `forRoot` 里的
 * `limit`/`ttl` 生效。也就是说：不做这一层过滤时，**任何**未显式跳过的路由
 * （`/health`、`/auth/me`、测试里的探针路由…）都会被 5 层同时压住，
 * 其中最严的是「注册 3 次/小时」——健康探针第 4 次就 429，负载均衡会把整个实例判死。
 *
 * 另外两个坑也一并记在这里（都是读源码确认的，不是猜测）：
 *
 * 1. `@SkipThrottle()` **不带参数**等价于 `{ default: true }`，而我们的层名是
 *    `login`/`register`/…，**没有** `default` —— 所以那个写法在本配置下**什么都不做**。
 * 2. 具名层在响应头里带后缀：`X-RateLimit-Limit-login`、被限流时的 `Retry-After-register`
 *    （`name === 'default' ? '' : '-' + name`）。断言 `retry-after` 会永远失败。
 *
 * 结论：每层**只对显式声明它的路由生效**（`@RateLimited('login')` 等）。
 * 未被任何层声明的路由在本进程内不限流——这与设计一致：威胁 #13 只点名了 5 类端点，
 * 其余路径的第一层限流在 Nginx（§3.1 的部署图）。
 *
 * **这个选择的代价，以及修复轮 1 补上的那道门（C-4）**：新增路由时漏写 `@RateLimited`
 * 的失效形态是**不限流**（静默）。反向写法（默认全部生效 + 逐路由 `@SkipThrottle`）
 * 会让「漏写」表现为**过度限流**，但它要求测试里的探针路由、`/health`、`/auth/me`
 * 全部逐条声明豁免，且五层叠加的语义（任一命中即拒）与设计里的「每类端点一个桶」并不一致，
 * 因此**默认层**这条替代方案**没有**采纳（它还会把 `/health` 压到最严的一层，
 * 负载均衡因此会把整个实例判死）。
 *
 * 采纳的是与 Task 5 策略声明**同一形状**的覆盖率门：
 * `tests/security/rate-limit-coverage.test.ts` + `RouteDeclarationRegistry.listRateLimitGaps()`
 * 要求**每条已注册路由**要么声明了某一层、要么显式标 `@SkipRateLimit()`，
 * 于是「漏写」在 CI 里变红并点名到「哪个 controller、哪个方法、哪条路径」。
 * 门本身也有对照用例（探针模块里故意漏一条、故意矛盾一条，必须恰好报出那两条）。
 */
export function throttlerOptions(): ThrottlerOptions[] {
  return (Object.keys(RATE_LIMITS) as RateLimitName[]).map((name) => ({
    name,
    limit: RATE_LIMITS[name].limit,
    ttl: RATE_LIMITS[name].ttlMs,
    getTracker: trackerFor(RATE_LIMITS[name].by),
    skipIf: (context) => !declaresRateLimit(context, name),
  }));
}
