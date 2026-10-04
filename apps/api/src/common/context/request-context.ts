import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 一次请求的身份上下文。
 *
 * 字段是**接口**，不是实现细节：Task 5 的授权守卫读 `userId`/`sessionId`，
 * Task 8 的审计日志把 `traceId` 落库，因此不要随手改名或删字段。
 */
export interface RequestContext {
  traceId: string;
  userId?: string;
  sessionId?: string;
}

/**
 * 用 `AsyncLocalStorage` 承载上下文，而不是把它当参数一路透传：
 * 参数透传要求每一层（controller → service → repository）都记得接一个 ctx 并原样往下递，
 * 漏一层就断链；ALS 由 Node 在**异步边界**上自动继承，中间层无需知情。
 * 这正是「trace id 贯穿一次请求的全部日志」（验收 13.4）能以近乎零成本成立的原因。
 *
 * 代价（如实记录）：上下文的可见范围等于**一次 `run()` 作用域**，因此
 * `TraceMiddleware` 必须把 `next()` 包在 `run()` 里；在 `run()` 之外（启动期、
 * 定时任务、worker）`currentContext()` 返回 `undefined`，调用方必须容忍这一点
 * ——按计划，Task 5 的守卫与 Task 8 的审计都用 `?.` 取值，不会因此抛错。
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** 当前异步上下文；不在任何请求作用域内时为 `undefined`（不是抛错）。 */
export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/** 在既定的上下文里执行 `fn`（事件回调、队列消费等需要手动接续的场景）。 */
export function runInContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}
