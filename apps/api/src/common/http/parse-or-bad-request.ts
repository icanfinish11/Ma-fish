import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * 入参校验的平台层工具：**校验失败一定是 400，且只回路径与消息**。
 *
 * ## 为什么它在 `common/http/` 而不是某个模块的 `dto.ts`（P2 / Task 10 的搬迁）
 *
 * 它原先住在 `apps/api/src/modules/auth/dto.ts`。P2 的额度发放路由（`ledger` 模块）
 * 也要用它，而「跨模块只走 `modules/<other>/index.ts`」（设计 §3.3 第 2 条，
 * 由 `.dependency-cruiser.cjs` 的 `no-cross-module-internals` 静态强制）意味着
 * **不能**深引 `../auth/dto.js`；把它从 `auth/index.ts` 导出又不对——它是平台层的
 * HTTP 校验工具，不是 auth 的能力，那样只会让 auth 的对外接口变成杂物袋。
 *
 * 因此搬到平台层：函数体**一字未改**，`modules/auth/dto.ts` 保留一行 re-export
 * （既有调用点与用例不必为一次无关紧要的搬迁付 5 处 diff 的噪声）。
 * 这也正是这个文件存在的唯一理由：**同一种「校验失败」语义只允许有一处实现**。
 */

/** 单条校验问题的对外形状。**只暴露路径与消息**，不含内部堆栈或值。 */
export interface FieldIssue {
  path: string;
  message: string;
}

/**
 * 校验入参，失败时抛 **400**（而不是让 `ZodError` 冒到默认异常过滤器变成 500）。
 *
 * ## 为什么必须显式转换（实测缺陷，不是理论担忧）
 *
 * 直觉写法是 `registerSchema.parse(body)`。实测：`ZodError` 不是 `HttpException`，
 * Nest 的默认异常过滤器因此把它当作**未预期错误**，返回
 * `500 {"statusCode":500,"message":"Internal server error"}`——三种非法输入
 * （口令过短、邮箱格式错、请求体为空）全都是 500，实测见任务报告 §变异探针。
 *
 * 后果不是「状态码不好看」，而是三件具体的事：
 * 1. **把客户端错误报成服务端故障**：监控/告警会对 500 告警，一个脚本刷弱口令就能
 *    持续制造 500 告警；而限流（Task 7）按路由维度统计时，这些请求会被算成「服务异常」；
 * 2. **客户端无法自助纠正**：调用方拿到 `Internal server error`，无从知道是哪个字段错了；
 * 3. **与「长度下限 12，避免弱口令」这条约束直接矛盾**：写了约束却让它以 500 表现，
 *    等于这条约束在对外契约上不存在。
 *
 * ## 为什么放在平台层而不是控制器或全局过滤器
 *
 * 放在这里，schema 与它的失败语义**只有一处**，各入口（register/login、额度发放……）
 * 不可能漂移。全局 `ZodExceptionFilter` 是另一种可行做法，但那会引入 app 级的新接线面
 * （Task 7 还要往 main.ts 加 helmet/CSRF，改动越集中越好）。
 * 将来控制器多了，再把这里提升成全局过滤器是一步机械的搬迁——届时本函数就是它的实现。
 *
 * 只回 `path` + `message`：zod 的 `issues` 里还带 `code`、`received`（可能是口令本身）等
 * 字段，把整个 `issues` 原样返回会把**用户提交的口令**回显到响应体与日志里（C11 的边界）。
 */
export function parseOrBadRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const errors: FieldIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  throw new BadRequestException({ message: '请求参数校验失败', errors });
}
