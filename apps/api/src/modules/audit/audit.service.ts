import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { currentContext } from '../../common/context/request-context.js';

/** 一条审计记录的入参。`traceId` **不**在此：它来自请求上下文，由本服务统一盖戳。 */
export interface AuditRecordInput {
  /** 当事人。匿名/系统行为（登录失败、定时任务）为 `null`。 */
  actorId?: string | null;
  /** 稳定的动作名，`<域>.<动作>`，如 `auth.login` / `auth.login_failed`。 */
  action: string;
  resource: string;
  resourceId?: string | null;
  /** 结构化补充。**不得**放口令、令牌、完整邮箱（C11）。 */
  metadata?: Record<string, unknown> | null;
}

/**
 * 审计落库（C7 / §9；Ruling 1：本任务交付**最小**实现，Task 8 只消费不重建）。
 *
 * ## 边界：这里只做「写一行」，不做别的
 *
 * 刻意**不**包含：outbox 事件、邮件/通知、读取接口、批量写入、日志复制。
 * 审计的**写入路径**必须有且只有一条，否则「审计是否可靠」就要按最弱的那条来判断。
 * Task 8 会加 outbox 与 mailer，但那是**别的**表、别的模块；它消费本服务，
 * 不得再实现一份写审计的代码。
 *
 * ## 为什么表在 `audit` schema 且本服务不做 append-only 检查
 *
 * append-only 是**数据库角色**的权限事实（`audit` schema 只有 SELECT + INSERT，
 * UPDATE/DELETE 被显式撤销，见 `infra/db/apply-grants.sql`），由
 * `tests/integration/db/append-only.test.ts` 守着。在应用层再写一遍「不许 UPDATE」
 * 只是把同一个不变式表达两次，且应用层那份是**可被绕过的**——真正的防线必须在库里。
 *
 * ## `traceId` 为什么在这里取而不是让调用方传
 *
 * 调用方（`AuthService`）在多处写审计，每处都记得传 traceId 是一次「漏一层就断链」的
 * 参数透传。`currentContext()` 由 ALS 在异步边界上自动继承，取到的一定是**本次请求**的 id。
 * 上下文之外（启动期、定时任务、队列消费）取不到，此时落 `null` 而**不是**抛错——
 * 审计的可用性不该被「有没有请求上下文」绑架。
 *
 * ## 错误处理：**不吞**
 *
 * 写审计失败会让整个操作失败。理由是审计的用途是事后追责与合规：如果「写不进去也能继续」，
 * 那么一个被静默破坏的审计表在需要它之前不会有人发现。这与「日志」（写不进去就算了）
 * 是两类东西，别看错。
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    const traceId = currentContext()?.traceId ?? null;
    await this.prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId ?? null,
        traceId,
        metadata: (input.metadata ?? null) as never,
      },
    });
  }
}
