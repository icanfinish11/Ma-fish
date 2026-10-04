/**
 * 跨模块的**超时预算**（修复轮 2 / Fix 2）。
 *
 * ## 为什么超时必须集中在一处、且带一条启动期硬断言
 *
 * 消费一条事件的事务形状是：**占位 → 投递（SMTP）→ 标记已处理**，三件事在同一个
 * `$transaction` 里（§8.5 的 exactly-once 效果）。而 Prisma 的**交互式事务默认超时是 5 秒**，
 * nodemailer 的默认超时是 **2 分钟连接 + 30 秒问候 + 10 分钟 socket 空闲**——两者相差两个数量级。
 *
 * 那个组合的失败形态很坏：一次**成功**的 SMTP 投递（邮件的的确确发出去了）在 5 秒处被事务超时打断
 * ⇒ 事务回滚 ⇒ `processed_jobs` 的占位与 `processed_at` 一起回滚 ⇒ 事件回到待处理集合 ⇒
 * 下一轮**再发一次**。配合 `MAX_DELIVERY_ATTEMPTS = 5`，收件人会收到**最多 5 封重复邮件**，
 * 而数据库最后把这行标成「已放弃（没发出去）」——两个字段都在说谎。
 *
 * 因此这里把两个数字放在同一个文件里，并**在模块求值期断言它们的顺序**：
 * 事务超时必须**严格大于**邮件投递的最坏耗时。数值可以调，顺序不能被调错——
 * 调错了进程直接起不来（`assertTimeoutOrdering()`），而不是等到线上某天 SMTP 慢下来才发作。
 *
 * ## 这里的边界（不遮）
 *
 * 这条断言保证的是「**事务超时**不会先于**传输层自身的超时**触发」。它**不能**保证
 * 「投递一定在事务超时内完成」：`SmtpMailer` 只在我们**自己的**实现里被绑定到这些值，
 * 任何人换一个慢适配器（或直接把 `Mailer` 换成别的实现）都能打破这个上界。
 * 与 Fix 2 的代码注释一起读：真正的语义仍然是 **at-least-once**。
 */

/**
 * 邮件传输层自己的超时（毫秒）。**显式配置**，不再继承 nodemailer 的默认值。
 *
 * 为什么必须显式：默认值（连接 2 分钟、问候 30 秒、socket 空闲 10 分钟）不是「宽松」，
 * 而是**未知**——一个没有边界的依赖无法被排进任何预算，也就无法判断事务超时该设多大。
 * 三个值都收窄到 20 秒以内：真实 SMTP 会话的每一步都在秒级完成，
 * 20 秒无响应基本等同于「这台服务器已经坏了」。
 *
 * `socketTimeout` 是**空闲**超时（每收到一段服务器响应就重置一次），因此它界定的不是
 * 「整个会话」而是「会话卡住」。{@link MAILER_WORST_CASE_MS} 的估算据此保守取三者之和。
 */
export const MAILER_TIMEOUTS = {
  /** 建立 TCP/TLS 连接的上限。 */
  connectionMs: 15_000,
  /** 连接建立后等 SMTP 问候（`220 …`）的上限。 */
  greetingMs: 15_000,
  /** socket 空闲上限：这么久没有任何服务器响应就判失败。 */
  socketMs: 20_000,
} as const;

/**
 * 一次投递的**最坏耗时估算**（毫秒）。
 *
 * 取三者之和是一个**刻意的保守**估算：连接超时与问候超时各只会触发一次，
 * 而 socket 空闲超时在每一段响应之间都可能重新计时（真实会话有十几段，理论上界因此更高）。
 * 这个数字不是「投递最多花这么久」的证明，而是两条超时之间的**比较基准**——
 * 用它推出的事务超时留了 {@link TRANSACTION_TIMEOUT_MS} 注释里写明的倍数余量。
 */
export const MAILER_WORST_CASE_MS =
  MAILER_TIMEOUTS.connectionMs + MAILER_TIMEOUTS.greetingMs + MAILER_TIMEOUTS.socketMs;

/** 事务超时的下限：再短的 SMTP 预算也不该让一次正常投递撞上它。 */
const MIN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * 交互式事务的超时（毫秒），**必须**大于 {@link MAILER_WORST_CASE_MS}。
 *
 * `120_000`（2 分钟）的依据：约等于邮件最坏耗时估算的 **2.4 倍**，且远高于
 * `MIN_TRANSACTION_TIMEOUT_MS`——留出的余量覆盖的是「投递之外」的那部分工作
 * （占位 INSERT、标记 UPDATE、连接池取连接），这些在库健康时是毫秒级。
 *
 * 为什么不设得更大（比如 10 分钟）：事务在超时前一直持有 `outbox_events` 那一行的锁，
 * 而超时本身**不会**取消已经发出去的 SMTP 会话。把超时调到比传输层还长，
 * 换来的是「一直等一个已经坏掉的连接」，那不是安全，是把故障时间拉长。
 */
export const TRANSACTION_TIMEOUT_MS = Math.max(4 * MAILER_WORST_CASE_MS, MIN_TRANSACTION_TIMEOUT_MS);

/**
 * 从连接池取连接的上限（Prisma `maxWait`）。
 *
 * Prisma 的默认是 2 秒（远小于事务超时），因此这里显式写出来：一个被慢投递占满的连接池
 * 会让后续事件在 `maxWait` 处失败，而**那个失败发生在投递之前**，不产生重复邮件——
 * 与事务超时的后果完全不同，值得单独有名字。10 秒是「池子还有救」的量级。
 */
export const TRANSACTION_MAX_WAIT_MS = 10_000;

/**
 * 顺序断言：事务超时必须严格大于邮件投递的最坏估算。
 *
 * 在模块求值期调用一次（见文件末尾）——把一条**可以调错的常量关系**变成一条启动即生效的断言。
 * 这与 `env.schema.ts` 用 `validate` 在启动期拒绝坏配置是同一条既有标准：
 * 能在启动期发现的事实，不要留到运行期靠运气。
 */
export function assertTimeoutOrdering(): void {
  if (TRANSACTION_TIMEOUT_MS <= MAILER_WORST_CASE_MS) {
    throw new Error(
      `超时预算被调反了：事务超时 ${TRANSACTION_TIMEOUT_MS}ms 必须严格大于邮件最坏耗时 ` +
        `${MAILER_WORST_CASE_MS}ms（${MAILER_TIMEOUTS.connectionMs}+${MAILER_TIMEOUTS.greetingMs}+` +
        `${MAILER_TIMEOUTS.socketMs}）。否则一次**成功**的 SMTP 投递会在事务超时处被回滚，` +
        '事件回到待处理集合、下一轮重发，直到 attempts 用尽——收件人会收到重复邮件。',
    );
  }
}

assertTimeoutOrdering();
