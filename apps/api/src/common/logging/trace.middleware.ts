import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { requestContext, type RequestContext } from '../context/request-context.js';

/** 全链路贯穿用的请求/响应头名。 */
export const TRACE_HEADER = 'x-trace-id';

/** 入参 trace id 的长度上限（含），超出即视为不可信。 */
const MAX_TRACE_ID_LENGTH = 128;

/**
 * 入参 trace id 的唯一合法形状：`[A-Za-z0-9._:-]`，长度 1–128（修复轮 1）。
 *
 * 为什么必须校验：调用方传入的 id 会被**原样复制**到响应头，并且（经 `mixin`）进入
 * 该请求的**每一条**日志。不设限时，一个客户端可以用一个几 MB 的 `x-trace-id`
 * 把属于它自己的每一行日志都撑大——这是日志污染/放大，不是注入
 * （CRLF 已被 Node 的头部解析器拒绝，pino 也会把值 JSON 转义），但代价由服务端承担。
 *
 * 字符集刻意保守：足以覆盖 W3C `traceparent`（32 位十六进制）、UUID、以及网关/前端常见的
 * `<service>-<opaque id>` 形式；排除空白、引号、花括号与控制字符——凡是能改变一行日志
 * 形状或长度语义的字符都不收。
 *
 * 不匹配时的处置是**丢弃并重新生成**，不是截断：一个被截断的 id 会与调用方手里的
 * id 不一致，比换一个新 id 更难排查（新 id 至少还回写在响应头里）。
 */
const TRACE_ID_PATTERN = new RegExp(`^[A-Za-z0-9._:-]{1,${MAX_TRACE_ID_LENGTH}}$`);

/**
 * 给每个请求建立 trace 上下文，并把同一个 id 回写到响应头。
 *
 * 三条行为，都是契约：
 * 1. **调用方传了合法 `x-trace-id` 就沿用它**——网关/前端/上一个服务已经把一次业务操作
 *    串起来了，这里重新生成会把链路切断；
 * 2. 没传、或传了不合法的（见 `TRACE_ID_PATTERN`）则生成一个；
 * 3. 用 `randomUUID()`（v4）而不是本任务同时产出的 `uuidv7()`：trace id **不是主键**、
 *    不入库、不需要时间序，只需不可猜；而 UUIDv7 的单调计数器是**进程内全局状态**，
 *    给每个请求都消耗一个计数器槽位没有收益。
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
    const traceId =
      typeof incoming === 'string' && TRACE_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    const ctx: RequestContext = { traceId };
    res.setHeader(TRACE_HEADER, traceId);
    requestContext.run(ctx, () => next());
  }
}
