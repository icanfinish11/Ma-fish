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

/** 只读元数据、无状态；`ThrottlerGuard` 的 `skipIf` 是纯函数签名，拿不到 DI 容器。 */
const reflector = new Reflector();

/** 本路由是否**显式**声明了名为 `name` 的限流层（`skipIf` 的判据，见 `throttlerOptions`）。 */
function declaresRateLimit(context: ExecutionContext, name: RateLimitName): boolean {
  return reflector.getAllAndOverride<RateLimitName>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]) === name;
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
 * 桶键会进限流存储（当前是进程内 Map，将来是 Redis），而「用户标识」不该以明文形式
 * 落在那里。大小写与首尾空白先归一：`A@b.co` 与 `a@b.co` 是同一个账号，
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
 * **代价（如实记录）**：新增路由时漏写 `@RateLimited` 的失效形态是**不限流**（静默）。
 * 反向写法（默认全部生效 + 逐路由 `@SkipThrottle`）会让「漏写」表现为**过度限流**，
 * 但它同时要求测试里的探针路由、`/health`、`/auth/me` 全部逐条声明豁免，
 * 且五层叠加的语义（任一命中即拒）与设计里的「每类端点一个桶」并不一致。
 * 权衡后选前者，并用端到端用例把 P0 现有的两条受限路由钉住。
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
