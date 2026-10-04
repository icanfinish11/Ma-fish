import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { requestContext, type RequestContext } from '../context/request-context.js';

/** 全链路贯穿用的请求/响应头名。 */
export const TRACE_HEADER = 'x-trace-id';

/**
 * 给每个请求建立 trace 上下文，并把同一个 id 回写到响应头。
 *
 * 两条行为，都是契约：
 * 1. **调用方传了 `x-trace-id` 就沿用它**——网关/前端/上一个服务已经把一次业务操作串起来了，
 *    这里重新生成会把链路切断；
 * 2. 没传则生成一个。用 `randomUUID()`（v4）而不是本任务同时产出的 `uuidv7()`：
 *    trace id **不是主键**、不入库、不需要时间序，只需不可猜；而 UUIDv7 的单调计数器
 *    是**进程内全局状态**，给每个请求都消耗一个计数器槽位没有收益。
 *
 * `requestContext.run(ctx, () => next())` 是「贯穿」的承重点：**`next()` 必须在 `run()`
 * 之内被调用**，此后整条异步链（含 Express 的处理器与其后的 `res` 事件）都继承该 ALS 上下文，
 * 因此请求处理期间产生的任何日志都能取到同一个 id。
 * 若把它写成「先 `next()` 再 `run()`」，处理器就已经在作用域之外跑完，trace id 只会存在于
 * 中间件自己那一层。
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[TRACE_HEADER];
    const traceId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    const ctx: RequestContext = { traceId };
    res.setHeader(TRACE_HEADER, traceId);
    requestContext.run(ctx, () => next());
  }
}
