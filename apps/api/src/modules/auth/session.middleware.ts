import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { currentContext, requestContext } from '../../common/context/request-context.js';
import { SESSION_COOKIE } from '../../common/http/cookie.js';
// **必须是值导入，不能写 `import type`。** 这是本任务踩到并实测确认的一个坑：
// 构造函数参数的类型元数据（`design:paramtypes`）只有在参数类型是**值**导入时才被写进
// 产物。写成 `import type { SessionService }` 后，tsc 会把元数据 emit 成 `[Function]`，
// Nest 于是拿 `Function` 当注入令牌去查找提供者、失败并抛
// `Nest can't resolve dependencies of the SessionMiddleware (?)`——
// 报错信息里那个 `(?)` 就是「令牌是 Function，名字都没有」的表现。
// 实测对照：本文件用 `import type` 时产出的元数据是 `[Function]`；
// 同目录 `session.service.ts` 用值导入 `Redis` 时产出的是 `[Redis]`。
// eslint 的 `consistent-type-imports` 若将来启用，这里需要一条豁免注释。
import { SessionService } from './session.service.js';

/**
 * 会话身份填充（**Step 0：本任务的前置交付，不在 brief 里**）。
 *
 * ## 它解决的到底是什么问题
 *
 * Task 5 的 `PolicyGuard` 对任何非 `@Public()` 的声明都要求身份（方案 B），
 * 而 `/auth/me`、`/auth/logout` 声明的正是**无 condition** 的策略
 * （`@Policy({ resource: 'Session', action: 'read' | 'destroy' })`）。
 * 身份来自 `currentContext()?.userId`，而在 Task 6 之前**没有任何中间件往里写它**——
 * 于是这两条路由对**任何**请求都 403，包括带着合法会话的请求。
 * 那 403 是 fail-closed 的**正确**表现，不是缺陷；缺的是「把身份填进去」这一步。
 *
 * ## 四条硬约束（每一条都有对应的失败形态）
 *
 * 1. **绝不自己拒绝请求。** 没有 cookie、cookie 是伪造的、会话已过期——一律只是
 *    「没有身份」，照常 `next()`，由守卫决定放不放行。中间件里再写一遍鉴权逻辑，
 *    就等于把「谁能访问」这件事表达两次，两者迟早会漂移；而漂移的方向通常是
 *    中间件那份先松掉。**未认证不是错误，是状态。**
 * 2. **绝不因为基础设施故障而 403。** Redis 不可达时 `verify` 会抛。这里**刻意吞掉**
 *    并降级为「无身份」：结果是「已登录用户被守卫拒绝」（403），而不是「整个服务 500」。
 *    两者都不可用，但前者的爆炸半径是**单请求**，且健康探针不受影响。
 *    这条取舍必须与「Redis 是会话的必需品」一起读——Redis 挂了本来就没有任何会话可用。
 * 3. **必须在 `TraceMiddleware` 的 ALS 作用域**内运行（`AppModule.configure` 里
 *    `TraceMiddleware` 先注册、本中间件后注册）。若顺序写反，本中间件为了补上 `userId`
 *    而 `run()` 一个新上下文，会把 `traceId` **整个丢掉**——表现为「请求内的日志全都
 *    没有 traceId」，而这与「Task 4 白做了」等价。测试用「传入的 x-trace-id 必须原样
 *    出现在处理器读到的上下文里」把顺序钉死（`auth-pipeline.test.ts`）。
 * 4. **不无条件 `run()` 新上下文。** 没有会话时只是 `next()`，让上层的上下文原样透传。
 *    只有确实要写入身份时才 `run()` 一个 `{ ...currentContext(), userId, sessionId }`
 *    的新上下文——**继承**而非替换。写成 `run({ userId, sessionId })` 同样会丢 `traceId`。
 *
 * ## 为什么读 `req.cookies` 而不是自己解析 `Cookie` 头
 *
 * `cookie-parser` 已在 `main.ts` 里全局挂上（`app.use` 先于 Nest 的中间件链执行）。
 * 自己再解析一遍会得到**第二份** cookie 语义（引号、URL 解码、重复键取哪一个），
 * 而两份语义在边界输入上必然分叉——安全相关的解析只能有一处。
 * 类型上 `req.cookies` 由 `@types/cookie-parser` 声明，无需断言。
 *
 * ## 对每个请求的代价（据实记录）
 *
 * 会话一旦存在，每个请求多一次 Redis `HGETALL` + 一次 `EXPIRE`（滑动续期）。
 * 这是「服务端会话」的固有成本（C13 明确选择了它而不是自包含令牌）。
 * 没有 cookie 的请求**零** Redis 往返——健康探针与静态资源因此不受影响。
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private readonly sessions: SessionService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const sessionId = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!sessionId) {
      next();
      return;
    }

    let userId: string | undefined;
    try {
      userId = (await this.sessions.verify(sessionId))?.userId;
    } catch {
      // Redis 不可达/超时：降级为「无身份」，让守卫按匿名处理（见约束 2）。
      userId = undefined;
    }

    if (!userId) {
      // 会话不存在或已过期：同样只是「没有身份」。**不要**在这里清 cookie——
      // 响应头的写入属于控制器（`logout`）的职责，中间件顺手清会掩盖「cookie 名写错」
      // 这类接线错误（表现为「登录后每个请求都被清 cookie」而不是找不到原因）。
      next();
      return;
    }

    // 继承既有上下文（含 traceId），只补身份字段。
    // `?? '-'` 是给「本中间件被单独挂载、外层没有 TraceMiddleware」这种情况的兜底：
    // 类型上 `traceId` 是必填，运行期缺了它也照样要能工作（'production 里没人挂错' 不是
    // 一个可以被静态类型保证的事实，而这里多一个字符的代价是零）。
    const ctx = { ...currentContext(), traceId: currentContext()?.traceId ?? '-', userId, sessionId };
    requestContext.run(ctx, () => next());
  }
}
