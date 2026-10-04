import { Global, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { CsrfGuard } from './csrf.guard.js';
import { CsrfMiddleware } from './csrf.middleware.js';
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
 * 因为那是 v6 的文档形态，也是将来要加 `storage`（Redis 共享桶）时唯一能扩展的位置：
 * 数组形式下 `commonOptions` 被硬置为 `{}`（`throttler.guard.js` 第 52–54 行），
 * 想加 `storage` 就必须改结构。数值全部来自 `RATE_LIMITS`，与 brief 逐条一致。
 *
 * ## 为什么 `ThrottlerGuard` 的注册**不在这里**
 *
 * 全局守卫的执行顺序由 `APP_GUARD` 数组顺序决定，而那个数组在 `app.module.ts`
 * （唯一能看到「限流 → CSRF → 授权」三者相对顺序的地方）。在子模块里注册会让它
 * 跑到 `PolicyGuard` 后面甚至前面，顺序语义就散在两个文件里了。
 */
@Global()
@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: throttlerOptions() })],
  providers: [CsrfGuard, CsrfMiddleware],
  // `CsrfMiddleware` 必须**导出**：它在 `AppModule.configure` 里注册，而 Nest 从
  // **注册它的那个模块**解析中间件的依赖（见 `auth.module.ts` 的实测说明）。
  // `ThrottlerModule` 一并导出，供将来按 `@Throttle` 覆盖数值的业务模块使用。
  exports: [CsrfGuard, CsrfMiddleware, ThrottlerModule],
})
export class SecurityModule {}
