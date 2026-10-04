import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** 单条校验问题的对外形状。**只暴露路径与消息**，不含内部堆栈或值。 */
export interface FieldIssue {
  path: string;
  message: string;
}

export const registerSchema = z.object({
  email: z.string().email().max(254),
  // 长度下限 12，避免弱口令；上限防 DoS（Argon2 成本随输入增长）
  password: z.string().min(12).max(200),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = registerSchema;
export type LoginDto = z.infer<typeof loginSchema>;

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
 * ## 为什么放在 DTO 层而不是控制器或全局过滤器
 *
 * 放在这里，schema 与它的失败语义**只有一处**，两个入口（register/login）不可能漂移。
 * 全局 `ZodExceptionFilter` 是另一种可行做法，但那会引入 app 级的新接线面
 * （Task 7 还要往 main.ts 加 helmet/CSRF，改动越集中越好），而本任务只有这两个入口。
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
