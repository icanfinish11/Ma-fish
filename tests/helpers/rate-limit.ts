import { ThrottlerStorage } from '@nestjs/throttler';
import type { TestingModuleBuilder } from '@nestjs/testing';

/**
 * 测试专用的「不拦截」限流存储（**唯一**一处关闭限流的地方）。
 *
 * ## 为什么需要它（以及它**不是**什么）
 *
 * C12 的注册层是「3 次/小时，按 IP」。而 `tests/integration/auth/auth-pipeline.test.ts`
 * 在**同一个 IP** 上注册十几个用户（每个用例都要一个真实账号，走真实 Redis 与
 * Argon2id）——真实阈值下从第 4 次起就会 429，那是**限流按设计生效**，不是缺陷。
 *
 * 于是只有两条路：削弱阈值（改 `RATE_LIMITS`，等于改安全参数去迁就测试），
 * 或者在**这一个**套件里把计数关掉。选后者，并把它做成显式、可搜到的开关。
 *
 * 它**不**削弱安全断言：`tests/security/rate-limit.test.ts` 用**真实**存储断言
 * 「第 4 次注册 429、第 6 次登录 429、换账号放行」，因此「限流被接线了」这件事
 * 仍有一条会红的用例；本开关只让**别的**套件不必为限流让路。
 *
 * 实现上只替换 `ThrottlerStorage` 这一个 provider：`forRoot` 里的层定义、每层的
 * `skipIf`（「只对声明了该层的路由生效」）与 `getTracker`（分桶维度）全部**保持真身**，
 * 因此被关掉的只有「计数与拦截」，不是整条限流逻辑。
 */
const noLimitStorage: ThrottlerStorage = {
  increment: () =>
    Promise.resolve({ totalHits: 0, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
};

/**
 * 关掉这一个应用实例的限流计数。
 *
 * 两种用法同一份实现（`TestingModuleBuilder → TestingModuleBuilder`）：
 *
 * - `createTestApp({ overrides: [disableRateLimit, …] })`（helper 引导）；
 * - 手工 `Test.createTestingModule(...).overrideProvider(...)` 的引导里直接调它。
 */
export function disableRateLimit(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder.overrideProvider(ThrottlerStorage).useValue(noLimitStorage);
}
