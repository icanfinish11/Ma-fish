import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { currentContext, requestContext } from '../../common/context/request-context.js';
import { SESSION_COOKIE } from '../../common/http/cookie.js';
// **必须是值导入，不能写 `import type`。** 这是本任务踩到并实测确认的一个坑：
// 构造函数参数的类型元数据（`design:paramtypes`）只有在参数类型是**值**导入时才被写进
// 产物。写成 `import type { SessionService }` 后，tsc 会把元数据 emit 成 `[Function]`，
// Nest 于是拿 `Function` 当注入令牌去查找提供者、失败并抛
// `Nest can't resolve dependencies of the SessionMiddleware (?)`。
//
// 两条**独立**的事实，不要把它们合成一条（修复轮 2 更正）：
// 1. `[Function]` 是**直接观察到的编译产物事实**——`tsc` 对 `import type` 版本的输出就是它；
// 2. 报错行里那个 `(?)` **不是**「令牌是 Function」的证据，它只表示**未解析出的参数下标**
//    （Nest `errors/messages.js` 把失败下标替换成 `?`）。上一轮报告曾用 `(?)` 反推第 1 条，
//    那个归因已被阴性对照实验推翻（正常元数据也能打出同样形状的 `(?)`）；第 1 条本身不变。
//
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
 * 2. **绝不因为基础设施故障而 403。** Redis 不可达时 `verify` 会抛。这里**吞掉异常**
 *    并降级为「无身份」：结果是「已登录用户被守卫拒绝」（403），而不是「整个服务 500」。
 *    两者都不可用，但前者的爆炸半径是**单请求**，且健康探针不受影响。
 *    这条取舍必须与「Redis 是会话的必需品」一起读——Redis 挂了本来就没有任何会话可用。
 *    **降级不等于静音**（修复轮 2）：异常必须变成**可观测的日志**，见 `describeVerificationFailure`
 *    与 `use()` 里的处置——否则一个 `TypeError`（依赖写坏、Redis 字段改名）会伪装成
 *    「所有用户都是匿名」这种与 Redis 宕机**外部表现完全相同**的形态，而日志里一行都没有。
 *    这正是 Step 0 要消灭的那类静默失败。
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
  private readonly logger = new Logger(SessionMiddleware.name);

  constructor(private readonly sessions: SessionService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const raw: unknown = req.cookies?.[SESSION_COOKIE];
    // **真实检查，不是断言**（修复轮 2）。`cookie-parser` 支持 `j:` 前缀的 JSON cookie，
    // 那种 cookie 会被解析成对象/数组；写成 `as string | undefined` 只是让 tsc 闭嘴，
    // 运行期仍会把一个对象交给 `verify`——键变成 `vca:sess:[object Object]`，
    // 更糟的是它可能与另一个请求**共享同一个键**（表现为随机的身份串线）。
    const sessionId = typeof raw === 'string' ? raw : undefined;
    if (!sessionId) {
      next();
      return;
    }

    let session: Awaited<ReturnType<SessionService['verify']>> = null;
    try {
      session = await this.sessions.verify(sessionId);
    } catch (err) {
      // Redis 不可达/超时：降级为「无身份」，让守卫按匿名处理（见约束 2）。
      // 但**降级必须可观测**：把所有异常都无声吞掉，会让「依赖写坏 / Redis 字段改名 /
      // `verify` 内部出 bug」与「Redis 宕机」在外部表现上完全相同（所有用户 403），
      // 而日志里没有任何一行指向真正的原因。这正是 Step 0 要消灭的静默失败形态。
      this.logVerificationFailure(err);
      session = null;
    }

    const userId = session?.userId;
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

  /**
   * 把一次 `verify` 失败写进日志，**且保证日志行里没有凭证**（C11）。
   *
   * 三处刻意的取舍：
   *
   * 1. **不记录 `sessionId`。** 它就是完整的 bearer 凭证（见 `session.service.ts`），
   *    日志是「谁都能看」的存储。排查不靠它：`req` 序列化器已经带上 `method` + `url`，
   *    同一请求的其余日志由 pino `mixin` 带上 `traceId`/`userId`，足够定位到具体请求，
   *    不需要把凭证抄进日志。
   *
   *    **这条日志是否带 `traceId`（最终评审的 Minor 更正）**：带。上一版注释写的是
   *    「本行走的是 Nest `Logger`，不经 pino `mixin`，因此**不**自带 traceId」——那句话在
   *    Task 7 之前是对的（当时全仓没有 `app.useLogger`），接线之后**已经过时**：
   *    `configureApp` 第一条就是 `app.useLogger(app.get(PinoLogger))`（`bootstrap.ts`），
   *    而本中间件跑在 `TraceMiddleware` 建立的 ALS 作用域内（顺序由 `AppModule.configure` 定，
   *    见约束 3），因此 pino 的 `mixin` 在写入这一刻读得到上下文，
   *    这一行与业务日志一样带 `traceId`/`userId`。
   *    代价如实记录：`logger.warn` 只收到一个**已经拼好的字符串**，不带结构化字段，
   *    所以键名是 `msg` 而不是自定义字段——可读性上仍是「点名的一行」。
   * 2. **只记 `name` + `message`（截断）+ 错误码**，并且 `describeVerificationFailure`
   *    对任何异常形状都安全（属性 getter 抛错也只回 `[unavailable]`）：日志路径上的
   *    代码自己炸掉，会把一次「可观测的降级」变成一次 500。
   * 3. **测试环境下不发日志**（`NODE_ENV === 'test'`）：套件里「Redis 挂了会降级」
   *    这条路径是被**故意**触发的（容器停掉之后仍在收尾），把它打成告警会让真正的
   *    失败淹在预期噪音里。与 pino 在测试下静音（`logger.module.ts`）是同一个理由、
   *    两个不同的落点。
   *
   *    **为什么不能只靠 pino 静音**（最终评审的 Minor 更正）：pino 的静音只作用于
   *    **那个 pino 实例**，而本行走的是 Nest 的 `Logger`——生产里它确实接到了 pino 上
   *    （`configureApp` 的 `app.useLogger`，Task 7 接线），但测试的引导路径
   *    （`tests/helpers/app.ts` 的 `createTestApp`）**不调** `configureApp`，
   *    因此那时 Nest 用的是自己的输出通道（`@nestjs/testing` 的 `TestingLogger` 恰好把
   *    warn 置空，但那是**偶然**，见 `policy-default-deny.test.ts` 的实测记载）。
   *    这里显式判断 `NODE_ENV`，输出的有无就不依赖这些偶然。
   */
  private logVerificationFailure(err: unknown): void {
    if (process.env.NODE_ENV === 'test') return;
    const { errorName, errorMessage, errorCode } = describeVerificationFailure(err);
    const detail = [errorName, errorCode ? `code=${errorCode}` : undefined, errorMessage ? `message=${errorMessage}` : undefined]
      .filter((part): part is string => part !== undefined)
      .join(' ');
    this.logger.warn(`会话校验失败，按匿名降级（本行不含 sessionId）：${detail}`);
  }
}

/**
 * 把 `verify` 抛出的任意值收敛成**日志安全**的三个字段。
 *
 * 为什么导出：它是「降级必须可观测」这条修复的承重点，单测直接调它可以把每一种异常形状
 * （原始值、`null`、getter 抛错、超长消息）都覆盖到，而不必为了观察一个 `TypeError`
 * 去造一个会抛错的 Redis 客户端。
 *
 * 用**白名单取字段**而不是把异常对象整个交给 logger：异常消息可能带着被 `verify` 夹带进来的
 * 输入，而输入里最敏感的就是那个会话 id。只取 `name` / `message` / `code`，
 * 且 `message` 截断到 200 字符——注意截断**不是**保密手段（43 字符的 id 装得下），
 * 真正的保证是调用方不把 id 传进来；截断只是防止日志行被一条超长消息撑爆。
 *
 * 任何取值失败（getter 抛错、`err` 是 `null`/原始值）都退化成可读的常量，绝不抛出：
 * 这个函数跑在 catch 块里，它抛出就会把一个降级变成一次未捕获异常。
 */
export function describeVerificationFailure(err: unknown): {
  errorName: string;
  errorMessage: string | undefined;
  errorCode: string | undefined;
} {
  const MAX = 200;
  const type = typeof err;
  // `typeof null === 'object'`：不先摘掉它，下面读 `.name` 会抛 `TypeError`，
  // 于是 `null` 会被归到「属性读取失败」那一类——分类因此变得不准确（实测踩到过）。
  if (err === null) return { errorName: 'NonError(null)', errorMessage: undefined, errorCode: undefined };
  if (type !== 'object' && type !== 'function') {
    // `throw 'boom'` / `throw 42`：原始值本身可能是凭证，**不回显它的值**，只回类型。
    return { errorName: `NonError(${type})`, errorMessage: undefined, errorCode: undefined };
  }
  try {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
    const message = typeof e.message === 'string' && e.message ? e.message.slice(0, MAX) : undefined;
    const code = typeof e.code === 'string' && e.code ? e.code : undefined;
    return { errorName: name, errorMessage: message, errorCode: code };
  } catch {
    return { errorName: 'Unavailable', errorMessage: undefined, errorCode: undefined };
  }
}
