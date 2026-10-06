import { z } from 'zod';

/**
 * `parseOrBadRequest` / `FieldIssue` **已经搬到平台层**
 * （`apps/api/src/common/http/parse-or-bad-request.ts`，P2 / Task 10 的 Step 1）。
 *
 * ## 为什么搬
 * `ledger` 模块的 DTO 也要用它，而「跨模块只走 `modules/<other>/index.ts`」
 * （设计 §3.3 第 2 条 / `no-cross-module-internals`）意味着不能深引本文件；
 * 从 `auth/index.ts` 导出它又不对——它是平台层的 HTTP 校验工具，不是 auth 的能力。
 *
 * ## 为什么这里保留一行 re-export，而不是让既有调用点逐个改 import
 * `auth.controller.ts`（register / login 两处）与几个用例引的都是这个路径。
 * 一次与行为无关的搬迁不该制造 5 处 diff 噪声；而 re-export 是**零行为变化**的
 * （`export { … } from` 不新建任何绑定）。实现只有一处，这里只是别名。
 */
export { parseOrBadRequest, type FieldIssue } from '../../common/http/parse-or-bad-request.js';

export const registerSchema = z.object({
  email: z.string().email().max(254),
  // 长度下限 12，避免弱口令；上限防 DoS（Argon2 成本随输入增长）
  password: z.string().min(12).max(200),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = registerSchema;
export type LoginDto = z.infer<typeof loginSchema>;
