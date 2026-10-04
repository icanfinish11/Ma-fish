/**
 * `audit` 模块的**对外接口**（设计 §3.3 第 2 条：跨模块只走显式接口 + DTO）。
 *
 * ## 为什么需要这个文件（而不是让调用方直接 import 内部文件）
 *
 * 在它出现之前，`AuthModule` 直接 `import '../audit/audit.module.js'`、`AuthService` 直接
 * `import '../audit/audit.service.js'`——**深引到别人的内部实现**。那样 `audit` 模块内部
 * 怎么组织（拆成几个 service、加不加 repository、改不改文件名）都会顺着 import 图漏给
 * `auth`，两个模块之间就没有可拆的边界了。§3.3 的第 2 条说的正是这件事，本文件把它变成
 * 一条**可执行**的边界：`no-cross-module-internals`（`.dependency-cruiser.cjs`）只放行
 * `modules/<other>/index.ts`，其余深引一律报错。
 *
 * ## 这是**唯一**的出口，也是唯一的入口
 *
 * 只导出跨模块真正需要的三样东西：模块类（给 `imports` 用）、服务类（给 DI 用）、
 * 以及服务签名里的入参类型（DTO）。**不要**在这里 `export *`：那等于把内部实现换个地方
 * 继续暴露，规则就白设了。
 *
 * 将来要写审计的模块，做法是：`imports: [AuditModule]` + 构造函数注入 `AuditService`，
 * 并从这个文件取类型。**不得**重建 `AuditService`（见 `audit.module.ts` 的边界说明）。
 */
export { AuditModule } from './audit.module.js';
export { AuditService, type AuditRecordInput } from './audit.service.js';
