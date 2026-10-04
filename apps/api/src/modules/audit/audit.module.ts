import { Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/**
 * 审计模块（Ruling 1）。
 *
 * ## `@Global()` 已移除：它**不承重**（修复轮 2，与 `AuthModule` 同一标准）
 *
 * 曾经的理由是「审计是横切关注点，逐模块 `imports` 只会制造样板」。但那是对未来调用方的
 * **猜测**，不是当下的依赖事实：今天唯一的使用者 `AuthModule` 已经在自己的 `imports` 里
 * 显式写了本模块。既然显式 import 已经工作，全局可见性就没有任何东西在依赖它——
 * 与 `AuthModule` 那次一样，**用实测代替推断**（移除后全量套件与 `tsc` 全绿）。
 * 全局 provider 命名空间是真实成本（C16：平铺的令牌空间、看不出来的覆盖）。
 *
 * ## 将来要写审计的模块（Task 9 等）
 *
 * 在自己的 `imports` 里写上 `AuditModule` 即可，**不要**为了让少写一行而把本模块重新标成
 * `@Global()`。**不得**重建 `AuditService`（它已完整，见 `audit.service.ts` 的边界说明）。
 *
 * 一处已经**过时并被改正**的说法（修复轮 2 的 Minor）：本注释曾经写「Task 8 在本模块内
 * **新增** outbox/通知相关提供者」。Task 8 的实际交付**没有**这么做——outbox/邮件是**另一张表**、
 * 另一套失败语义（可重试、可放弃），放进本模块会让「审计写入路径有且只有一条」这条边界变模糊。
 * 它们住在 `modules/notify/`（`NotifyModule`），两个模块只用注释互相指路。
 * 这是对那句注释的**有意偏离**，理由已交回裁定（任务报告 §2）。
 */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
