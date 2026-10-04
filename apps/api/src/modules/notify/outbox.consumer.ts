import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { scrubEmails } from '../../common/logging/redact.js';
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
 * 单条事件的投递尝试上限（修复轮 1 / Fix 1）。
 *
 * ## 为什么必须有上限（这不是「提前造死信队列」）
 *
 * `attempts` 字段与它的递增**本来就存在**，只是此前没有任何东西读它。而 worker 的轮询循环
 * **每秒重新选取**未处理事件：一个永久失败的事件（SMTP 拒收、收件人不存在、无法解析的负载）
 * 会对**外部 SMTP 服务**产生无界的投递尝试。那正是会把发信域名限流或拉黑的形态——
 * 比丢一条通知严重得多，而且是运维在事后才会发现的。因此这里只是把已有机制**补完**：
 * 一个具名常量、一次判定，没有退避、没有队列、没有新表。
 *
 * ## 为什么是 5
 *
 * 投递失败的两大类是「暂时」（SMTP 抖动、连接被拒）与「永久」（收件人被拒、负载坏掉），
 * 而**事件本身不带这两类的区分信息**（这是一个刻意不做类型化错误分类的 P0 边界）。
 * 取 5 是在两者间的一个折中：以 1 秒的轮询间隔计，暂时性故障有约 4 秒的恢复窗口，
 * 而一条毒事件最多只对外部服务产生 5 次尝试。调大它只是改这一行。
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** `runOnce` 的选项。 */
export interface RunOnceOptions {
  /** 单批处理条数。默认 50（`worker` 显式传同一个值以固定契约）。 */
  batchSize?: number;
  /** 覆盖 {@link MAX_DELIVERY_ATTEMPTS}：用例用它把上限压到几轮内可跑完。 */
  maxAttempts?: number;
}

/** 单批条数的默认值。 */
const DEFAULT_BATCH_SIZE = 50;

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
 * 落进 `last_error` 的错误文本（修复轮 1 / Fix 2）。
 *
 * **必须过 `scrubEmails`**：SMTP 的拒绝消息经常原样回显收件人
 * （`550 5.1.1 <user@example.com>: Recipient address rejected`），而 `last_error`
 * 是一行**无限期保留**的失败记录。C11 字面上说的是日志，但 Task 6 已经为持久化存储定过
 * 同一把尺子（复审发现会话 id 被写进 append-only 的 `audit_log` 时把它去掉了：
 * 「只在数据库里」并不比「在日志里」弱）。这里用的是 worker 那条失败行**同一段**代码。
 *
 * 与 worker 的 `describeError` 的差别只有两点，都是刻意的：
 * 1. 不加 `名称(码): ` 前缀——`last_error` 列里需要的是**原因**，事件的身份在别的列上；
 * 2. 不截断到 300 字符——该列类型是 `TEXT`，而「坏在哪」的信息越完整越有用。
 */
function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // 压成单行：Prisma 的错误自带换行，多行会破坏「一行一条失败」的可读性
  return scrubEmails(message).replace(/\s+/g, ' ').trim();
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
 * - **投递失败到达 {@link MAX_DELIVERY_ATTEMPTS}**（修复轮 1 / Fix 1）：也是终止态，
 *   标记 `processed_at` **并**标记 `abandoned_at`，于是它离开待处理集合、不再对外部 SMTP
 *   产生尝试。失败记录（`attempts` / `last_error`）**保留**，运维仍然看得到坏在哪。
 *
 * ## 上限的判定为什么必须在事务里（一次实测教训）
 *
 * 「自增 + 读回 + 判定」如果拆成「先读行、再判断、最后 `increment`」，两个并发消费者会读到
 * **同一个旧值**，`attempts` 因此被少算——上限就成了摆设。所以失败路径用**交互式事务**
 * 把三件事放在一起：`update` 拿行锁 → 读回自增后的值 → 超过上限则同时写 `abandoned_at`。
 * 并发的丢失更新于是不再能绕过上限（`tests/integration/notify/outbox.test.ts` 有专门的判别用例）。
 *
 * ## 仍然**没有**的东西（C16）
 *
 * 没有退避、没有死信表、没有重试队列、没有告警钩子。上限是**一个界**，不是一个子系统；
 * 需要退避与人工重放时那是后续阶段（P8/P9）的设计，届时 `abandoned_at` 就是它的输入。
 */
@Injectable()
export class OutboxConsumer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
  ) {}

  /**
   * 处理一批未处理事件，返回**成功处理**的条数（唯一冲突、投递失败、被放弃都不计入）。
   *
   * 调用方（worker）用返回值判断「还有没有活」：`0` 表示可以睡一个轮询间隔。
   *
   * 两个参数走**一个具名对象**而不是位置参数：`runOnce(n, { maxAttempts })` 这种形状下
   * `runOnce({ maxAttempts: 3 })` 会被静默当成 `batchSize`（实测：Prisma 报
   * `Argument \`take\`: Invalid value provided. Expected Int, provided Object.`）。
   * 具名对象让调用点无法把「上限」误写成「批次大小」。
   */
  async runOnce(options: RunOnceOptions = {}): Promise<number> {
    const maxAttempts = options.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

    const events = await this.prisma.outboxEvent.findMany({
      // 待处理集合的定义：`processed_at` 为空。到达上限的事件由下面写入 `processed_at`
      // 主动**退出**这个集合，因此不需要额外的 `attempts` 过滤条件。
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
        await this.recordFailure(e.id, err, maxAttempts);
      }
    }
    return handled;
  }

  /**
   * 失败回写：自增 `attempts`、**脱敏后**记 `lastError`，到达上限则一并标为放弃。
   *
   * 三件事必须在**同一个事务**里（见类注释）：`update` 拿到行锁后自增并读回新值，
   * 判定用的就是那个新值，因此并发消费者不可能都基于同一个旧值做决定。
   *
   * 另一个必须点明的取舍：唯一冲突也走这里，它会**保留** `last_error`。这与成功路径
   * 清空 `last_error` 是有区别的（成功即无事可报），而冲突本身是运维要知道的事实。
   */
  private async recordFailure(eventId: string, err: unknown, maxAttempts: number): Promise<void> {
    const message = describeFailure(err);
    // 已处理过（唯一冲突）也是终止态，避免每轮重试
    const alreadyHandled = isUniqueViolation(err);

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.outboxEvent.update({
        where: { id: eventId },
        data: { attempts: { increment: 1 }, lastError: message },
        select: { attempts: true },
      });
      const abandon = alreadyHandled || updated.attempts >= maxAttempts;
      if (!abandon) return;
      // `processedAt` 让它退出待处理集合（轮询循环不再选它）；`abandonedAt` 是**区分性**的标记：
      // 只有它非空才代表「试了 N 次后放弃」，而不是「投递成功」。
      await tx.outboxEvent.update({
        where: { id: eventId },
        data: { processedAt: new Date(), abandonedAt: new Date() },
      });
    });
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
