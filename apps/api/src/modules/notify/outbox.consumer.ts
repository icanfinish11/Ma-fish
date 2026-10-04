import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import type { Mailer } from './mailer.port.js';

/** `email.*` 主题的负载形状：`Mailer.send` 的入参。 */
interface EmailPayload {
  to: string;
  subject: string;
  text: string;
}

/** 需要投递邮件的主题前缀。目前只有一个通道，故意不做主题路由表（C16）。 */
const EMAIL_TOPIC_PREFIX = 'email.';

/**
 * 是否是 Prisma 的**唯一约束冲突**（`P2002`）。
 *
 * 按 `code` 判而不是 `instanceof PrismaClientKnownRequestError`：跨 Prisma 版本的类身份与
 * 打包边界都是额外假设，而 `code` 是 Prisma 对外文档化的稳定契约。这与
 * `modules/auth/auth.service.ts` 里那个同名判据是**同一条**理由。
 *
 * 为什么是两份而不是抽成共享工具：它是一行鸭子类型判断，两处的**用途**不同
 * （那里把注册竞态映射成 409，这里判断「事件是否已被处理过」），抽取它要改动
 * 已审阅的 Task 6 代码而不改变任何语义；本仓库的既有标准是「只有承重的重复才抽取」。
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** 负载形状校验：`payload` 来自数据库（JSON 列），是**外部输入**，不能只靠类型断言。 */
function isEmailPayload(value: unknown): value is EmailPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<EmailPayload>;
  return typeof p.to === 'string' && typeof p.subject === 'string' && typeof p.text === 'string';
}

/**
 * Outbox 消费者：exactly-once **效果**（§8.5）。
 *
 * ## 机制：唯一约束在**事务内**先占位
 *
 * 每条事件先以 `idempotencyKey` 往 `processed_jobs` 插一行（该列是主键），**然后**才投递，
 * 最后把 `outbox_event` 标记为已处理——三件事在同一个事务里。并发消费者因此被数据库
 * **串行化**：后到的那一个会阻塞在唯一索引上，等前一个提交后拿到 `P2002`，于是它**不会**
 * 投递。这正是设计 §8.5 要的「唯一约束在事务内被检查，所以并发消费者不可能都投递」。
 *
 * ## 诚实记录：这是「exactly-once 效果」，不是分布式事务
 *
 * 投递是**外部副作用**（SMTP），它无法与数据库提交原子化。真实边界是：
 * 若「邮件已发出、但事务提交失败」，重试会**再发一次**（at-least-once）。
 * 反过来绝不会发生（不会出现「标记了已处理但没发」）——所以这条通道的错误方向是
 * 「宁可重复，不可静默丢失」。真要彻底去重需要收件方幂等（邮件做不到），
 * 或引入两阶段确认（本阶段**刻意不做**，C16 不为假设中的重复投递造机制）。
 *
 * ## 失败分类决定了「会不会重试」
 *
 * - **投递失败**（SMTP 拒绝、负载形状不对）：事务整体回滚（`processed_jobs` 的占位也回滚），
 *   只递增 `attempts` 并记 `lastError` ⇒ 事件**保持未处理**，下一轮重试。运维靠 `last_error`
 *   判断是哪条事件坏了。
 * - **唯一冲突**（已被别的消费者处理过）：这是**终止态**，必须标记 `processed_at`，
 *   否则这条事件每一轮都会重试、每轮都报同一个错（`attempts` 无限增长，日志被刷满）。
 *
 * 重试没有退避与上限：本阶段只有一个消费者、间隔 1 秒（见 `apps/worker`），
 * 永久失败的事件会一直重试——**这是已知的 P0 边界**，死信队列属于后续阶段。
 */
@Injectable()
export class OutboxConsumer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
  ) {}

  /**
   * 处理一批未处理事件，返回**成功处理**的条数（唯一冲突与投递失败都不计入）。
   *
   * 调用方（worker）用返回值判断「还有没有活」：`0` 表示可以睡一个轮询间隔。
   */
  async runOnce(batchSize = 50): Promise<number> {
    const events = await this.prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    let handled = 0;
    for (const e of events) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // 唯一约束在并发下保证只有一个消费者能插入成功（§8.5）
          await tx.processedJob.create({ data: { idempotencyKey: e.idempotencyKey } });
          await this.deliver(e.topic, e.payload);
          await tx.outboxEvent.update({
            where: { id: e.id },
            data: { processedAt: new Date(), attempts: { increment: 1 }, lastError: null },
          });
        });
        handled++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 已处理过（唯一冲突）也要标记，避免无限重试；投递失败则保持未处理以便重试
        const alreadyHandled = isUniqueViolation(err);
        await this.prisma.outboxEvent.update({
          where: { id: e.id },
          data: {
            attempts: { increment: 1 },
            lastError: message,
            ...(alreadyHandled ? { processedAt: new Date() } : {}),
          },
        });
      }
    }
    return handled;
  }

  private async deliver(topic: string, payload: unknown): Promise<void> {
    if (!topic.startsWith(EMAIL_TOPIC_PREFIX)) return;
    if (!isEmailPayload(payload)) {
      // 不投递半成品：`to` 为 undefined 的邮件会把「一条坏事件」变成一个 SMTP 侧的怪错误，
      // 错误信息里也没有主题，运维根本不知道坏的是哪条。
      throw new Error(`outbox 事件 ${topic} 的 payload 不是邮件负载（需要 to/subject/text 三个字符串字段）`);
    }
    await this.mailer.send({ to: payload.to, subject: payload.subject, text: payload.text });
  }
}
