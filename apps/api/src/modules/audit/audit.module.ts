import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/**
 * 审计模块（Ruling 1）。
 *
 * `@Global()`：审计是横切关注点，P2 起的账本、竞价、上传都会写它，逐模块 `imports`
 * 只会制造样板。Task 8 在此模块内**新增** outbox/通知相关提供者，
 * 但**不得**重建 `AuditService`（它已完整，见 `audit.service.ts` 的边界说明）。
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
