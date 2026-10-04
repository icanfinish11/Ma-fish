import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { scrubEmails } from '../../common/logging/redact.js';
import { TRANSACTION_MAX_WAIT_MS, TRANSACTION_TIMEOUT_MS } from '../../common/timeouts.js';
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

/**
 * `last_error` 落库文本的长度上界（修复轮 2 的 Minor）。
 *
 * 为什么 `TEXT` 列也要有预算：那一条写的是列**能装**多少，不是这个字段**该装**多少。
 * 两个真实的来源会把这一列撑大——Prisma 的校验错误会内嵌**渲染后的查询文本**
 * （`Invalid \`prisma.outboxEvent.findMany()\` invocation: …` 里带着整条语句），
 * 而 MTA 的拒绝消息可以回显一整段内容片段。这一列是运维要读的失败记录，不是取证档案。
 *
 * 取 2000 的依据：真实 SMTP 拒绝消息在几百字符量级，2000 留了一个很大的余量，
 * 同时把「一次查询全文」这类几 KB 的错误挡在外面。与 worker 失败行的 300 字符
 * （`apps/worker/src/worker.ts` 的 `describeError`）不同，这是**落库**的字段，
 * 要求比一行日志更完整，因此刻意不共用同一个数字。
 */
export const MAX_LAST_ERROR_LENGTH = 2_000;

/** `runOnce` 的选项。 */
export interface RunOnceOptions {
  /** 单批处理条数。默认 50（`worker` 显式传同一个值以固定契约）。 */
  batchSize?: number;
  /** 覆盖 {@link MAX_DELIVERY_ATTEMPTS}：用例用它把上限压到几轮内可跑完。 */
  maxAttempts?: number;
  /**
   * 覆盖 {@link TRANSACTION_TIMEOUT_MS}。
   *
   * **存在的唯一理由是取证**（Fix 2）：事务超时与邮件超时是两个可以调错的常数，
   * 而它们的关系只有在「投递比事务超时更慢」时才会显形——那需要把事务超时压到毫秒级
   * 才能在一个用例里观察到（用例见 `outbox.test.ts` 的「慢投递」两条）。
   * 生产路径**不传**它：默认值由 `common/timeouts.ts` 的启动期断言守着。
   */
  transactionTimeoutMs?: number;
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
 * 2. 截断到 {@link MAX_LAST_ERROR_LENGTH} 而不是 300——该列类型是 `TEXT`，
 *    「坏在哪」的信息越完整越有用，但**有界**（理由见那个常量）。
 */
function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // 压成单行：Prisma 的错误自带换行，多行会破坏「一行一条失败」的可读性
  return scrubEmails(message).replace(/\s+/g, ' ').trim().slice(0, MAX_LAST_ERROR_LENGTH);
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
 * ### 「提交失败」最现实的触发形态是**事务超时**（修复轮 2 / Fix 2）
 *
 * 上面那句话此前只说了「存在一个窗口」，没有指名它有多宽。实测的默认值组合是：
 * Prisma 交互式事务 **5 秒**、nodemailer **连接 2 分钟 / 问候 30 秒 / socket 空闲 10 分钟**。
 * 于是「一台慢但正常的 SMTP」就足以让一次**成功**的投递在 5 秒处被回滚 ⇒ 事件回到待处理集合
 * ⇒ 下一轮重发。配合 {@link MAX_DELIVERY_ATTEMPTS}，收件人会收到最多 5 封重复通知，
 * 而数据库最后把这行标成 `abandoned_at`（「没发出去」）——两个字段同时在说谎。
 *
 * 现在两个超时都显式配置，且集中在 `common/timeouts.ts`：文件里有一条**模块求值期断言**
 * 「事务超时 > 邮件最坏耗时」，调反了进程直接起不来。
 *
 * ### 这道修法**没有**消除 at-least-once，别读错
 *
 * 它消除的是「投递本身成功、却因为超时被回滚并重发」这条**自己制造**的重复路径。
 * 仍然会重复的是：进程在「SMTP 已接受」与「事务已提交」之间崩掉（kill -9、容器重启、断电）。
 * 那一小段窗口无法用超时关掉——它是外部副作用的固有性质。因此：
 * - **投递保证**始终是 at-least-once；
 * - 运维看到的 `attempts` 记的是**尝试次数**，不是「发出去几封」。一次被超时打断的尝试
 *   会让这个数字 +1，而邮件可能已经发出——**不要**把 `attempts` 读成「实际投递封数」；
 * - `abandoned_at` 非空只说明「这条事件被放弃了」，它**不**证明「一封都没发出去」。
 *   要看真的发没发，得去 SMTP 侧的日志或收件箱。
 *
 * ## 失败分类决定了「会不会重试」
 *
 * - **投递失败**（SMTP 拒绝、负载形状不对）：事务整体回滚（`processed_jobs` 的占位也回滚），
 *   只递增 `attempts` 并记 `lastError` ⇒ 事件**保持未处理**，下一轮重试。运维靠 `last_error`
 *   判断是哪条事件坏了。
 * - **唯一冲突**（已被别的消费者处理过）：这是**终止态**，必须标记 `processed_at`，
 *   否则这条事件每一轮都会重试、每轮都报同一个错（`attempts` 无限增长，日志被刷满）。
 *   **它 `abandoned_at` 保持 NULL**（修复轮 2 / Fix 1）：这一列的含义是「试了 N 次后放弃」，
 *   而「别人已经发过了」既没失败也没被放弃。把两者写成同一行，正是这一列存在的理由被反转。
 * - **投递失败到达 {@link MAX_DELIVERY_ATTEMPTS}**（修复轮 1 / Fix 1）：也是终止态，
 *   标记 `processed_at` **并**标记 `abandoned_at`，于是它离开待处理集合、不再对外部 SMTP
 *   产生尝试。失败记录（`attempts` / `last_error`）**保留**，运维仍然看得到坏在哪。
 *
 * ## 失败回写自己坏掉时，能保证什么（修复轮 2 / Fix 4）
 *
 * `recordFailure` 是**另一次**数据库写。它自己也可能持续失败（这一行的锁超时、P2028、
 * 甚至是 `describeFailure` 里的 `String(err)` 抛错）。不守的话：异常会冒出 `runOnce`，
 * 于是**同一批里排在后面的事件一个都不处理**（worker 只看到「这一轮失败」），
 * 而这条事件永远停在 `attempts = 0`、永远留在待处理集合里。
 *
 * 守法是「记一行、继续下一个事件」（`recordFailure` 的调用点有 try/catch）。
 * **这个守护能给的保证，与不能给的保证要分清楚**：
 * - **能**：失败回写炸掉**不会**变成「重试风暴」。一轮里每条事件最多被尝试一次
 *   （投递在该事件的 try 块里只出现一次，且异常后立即转出），所以坏掉的回写
 *   不会让同一轮反复调外部服务；两次尝试之间至少有 worker 的轮询间隔。
 * - **不能**：事件**不会**因此进入终止态。`attempts` 没写进去，上限就判不出来，
 *   这条事件会**每一轮**再投一次——`last_error` 为空、`attempts` 为 0 的事件
 *   正是「失败回写坏了」的现场特征。这是持久故障，只能靠修库解决；
 *   本阶段**不**为它造机制（不加退避/死信/熔断，C16），只保证它有界可观测。
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
  private readonly logger = new Logger(OutboxConsumer.name);

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
   * “Argument `take`: Invalid value provided. Expected Int, provided Object.”）。
   * 具名对象让调用点无法把「上限」误写成「批次大小」。
   */
  async runOnce(options: RunOnceOptions = {}): Promise<number> {
    const maxAttempts = options.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    /**
     * 事务选项**显式**传入（修复轮 2 / Fix 2），不再吃 Prisma 的默认值。
     *
     * 两个数字都与邮件传输层的超时成对定义（`common/timeouts.ts`），
     * 并由那里的启动期断言保证「事务超时 > 邮件最坏耗时」：
     * - `timeout` 太短 ⇒ 一次**成功**的投递被回滚并重发（重复邮件，直到上限用尽）；
     * - `maxWait` 与 `timeout` 是两件事：前者是**从连接池取连接**的上限，
     *   它先于投递发生，因此失败时不会产生重复邮件。
     */
    const transactionOptions = {
      timeout: options.transactionTimeoutMs ?? TRANSACTION_TIMEOUT_MS,
      maxWait: TRANSACTION_MAX_WAIT_MS,
    };

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
        }, transactionOptions);
        handled++;
      } catch (err) {
        /**
         * 失败回写被**单独**守住（修复轮 2 / Fix 4）。
         *
         * 没有这个 try/catch 时：回写抛错会冲出 `runOnce` ⇒ 同一批里**后面的事件全部被跳过**
         * （worker 只看到「这一轮消费失败」），而这条事件的 `attempts` 永远是 0。
         * 后果是 `attempts` 到顶这条唯一的界**永远不生效**，外部 SMTP 被无界地调用——
         * 正是 Fix 1 存在的理由被反转。
         *
         * 守住之后能保证什么、不能保证什么，**写在类注释里**（不在失败位置重复一遍）：
         * 一轮里每条事件最多被尝试一次（投递只在这个 try 块里出现一次，异常后立即转出），
         * 但回写若**永久**坏掉，事件会一直留在待处理集合里、每轮重试一次——那是持久故障，
         * 只能修库，本阶段不造退避/死信（C16）。
         */
        try {
          await this.recordFailure(e.id, err, maxAttempts, transactionOptions);
        } catch (writeErr) {
          this.logger.error(
            `[outbox] 事件 ${e.id} 的失败回写也失败了：这一轮不再重试它，` +
              `但它会留在待处理集合里（attempts 未递增，上限判不出来）。` +
              `投递错误：${describeFailure(err)}；回写错误：${describeFailure(writeErr)}`,
          );
        }
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
  private async recordFailure(
    eventId: string,
    err: unknown,
    maxAttempts: number,
    transactionOptions: { timeout: number; maxWait: number },
  ): Promise<void> {
    const message = describeFailure(err);
    // 已处理过（唯一冲突）也是终止态，避免每轮重试
    const alreadyHandled = isUniqueViolation(err);

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.outboxEvent.update({
        where: { id: eventId },
        data: { attempts: { increment: 1 }, lastError: message },
        select: { attempts: true },
      });
      if (!alreadyHandled && updated.attempts < maxAttempts) return;

      /**
       * 终止态：让它退出待处理集合（轮询循环不再选它）。
       *
       * `abandonedAt` **只**在「投递失败到达上限」时写（修复轮 2 / Fix 1）。
       * 它此前与唯一冲突共用同一次写入，于是「别人已经发过了」被记成
       * 「试了 N 次后放弃、一封没发」——恰好是这一列要防的那种误读，方向还反了。
       * 列语义（`schema.prisma`）：`processed_at` 非空 + `abandoned_at` 空 = 已投递/已被处理；
       * 两者都非空 = 真的放弃了。
       */
      await tx.outboxEvent.update({
        where: { id: eventId },
        data: alreadyHandled
          ? { processedAt: new Date() }
          : { processedAt: new Date(), abandonedAt: new Date() },
      });
    }, transactionOptions);
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
