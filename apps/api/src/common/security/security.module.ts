import { Global, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
// `REDIS` 令牌与它的提供者同处一地（`db/redis.module.ts`，Task 9 修复轮 1 前它定义在
// `modules/auth/session.service.ts`，于是平台层要反向 import 一个功能模块的内部文件）。
// 这里从平台层取同一个常量——令牌的唯一性正来自「所有人 import 的是同一处定义」。
import { REDIS } from '../../db/redis.module.js';
import { CsrfGuard } from './csrf.guard.js';
import { CsrfMiddleware } from './csrf.middleware.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { throttlerOptions } from './throttler.js';

/**
 * 安全能力的模块（CSRF 中间件/守卫 + 分层限流）。
 *
 * ## 为什么 `forRoot` 收一个对象而不是数组（据实记载：两种都能用）
 *
 * brief 的写法是 `ThrottlerModule.forRoot([{ name, ttl, limit }, …])`。读
 * `@nestjs/throttler@6.7.1` 的 `throttler.module.js`：`ThrottlerModuleOptions` 是
 * `Array<ThrottlerOptions> | { throttlers: Array<ThrottlerOptions>; … }`，**数组形式仍然可用**
 * （它被当作 legacy 形态，`onModuleInit` 里两条分支都处理）。此处用对象形式，
 * 因为那是 v6 的文档形态，也是加 `storage` 时唯一能扩展的位置：
 * 数组形式下 `commonOptions` 被硬置为 `{}`（`throttler.guard.js` 第 52–54 行），
 * 想加 `storage` 就必须改结构。数值全部来自 `RATE_LIMITS`，与 brief 逐条一致。
 *
 * ## 修复轮 1（C-1）：限流桶搬到 Redis，改成 `forRootAsync`
 *
 * 设计 §3.1 把「限流桶」与会话、锁一起放在 Redis。此前用的是库默认的
 * `ThrottlerStorageService`（**每个应用实例一份进程内 Map**），后果有二：
 * 横向扩到 N 个实例时每个阈值**静默变成 N 倍**；以及重启即清零。
 * 两者都是「声明了但没执行」，与 append-only 的空操作 `REVOKE`、C9 漏掉 `.tsx` 的扫描器、
 * C10 的死代码规则、brief 那条恒真断言同一个缺陷类。
 *
 * 现在的接线：`forRootAsync({ inject: [REDIS], useFactory })` → 工厂里
 * `new RedisThrottlerStorage(redis)` 作为 `storage` 交给库。
 * **为什么必须是「实例」而不是「类」**：库的 `ThrottlerStorageProvider`
 * （`throttler.providers.js` 第 16–24 行）是
 * `options.storage ? options.storage : new ThrottlerStorageService()`——
 * 它不做 DI 解析，只接受一个现成对象。
 *
 * `REDIS` 来自 `@Global()` 的 `RedisModule`，因此本模块不需要（也不该）重复 import 它；
 * `AppModule` 里 `RedisModule` 排在 `SecurityModule` 之前，注入边是明确的。
 *
 * 层定义（`throttlerOptions()`）与数值**一个字都没改**（C12）。
 *
 * ## 为什么 `ThrottlerGuard` 的注册**不在这里**
 *
 * 全局守卫的执行顺序由 `APP_GUARD` 数组顺序决定，而那个数组在 `app.module.ts`
 * （唯一能看到「限流 → CSRF → 授权」三者相对顺序的地方）。在子模块里注册会让它
 * 跑到 `PolicyGuard` 后面甚至前面，顺序语义就散在两个文件里了。
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({
        throttlers: throttlerOptions(),
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
  ],
  providers: [CsrfGuard, CsrfMiddleware],
  // `CsrfMiddleware` 必须**导出**：它在 `AppModule.configure` 里注册，而 Nest 从
  // **注册它的那个模块**解析中间件的依赖（见 `auth.module.ts` 的实测说明）。
  // `CsrfGuard` 导出，是为了让 `AppModule` 能用 `useExisting` 指向**同一个实例**（C-2）。
  // `ThrottlerModule` 一并导出，供将来按 `@Throttle` 覆盖数值的业务模块使用。
  exports: [CsrfGuard, CsrfMiddleware, ThrottlerModule],
})
export class SecurityModule {}
