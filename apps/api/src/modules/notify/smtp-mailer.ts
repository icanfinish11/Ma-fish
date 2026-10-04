import nodemailer from 'nodemailer';
import { MAILER_TIMEOUTS } from '../../common/timeouts.js';
import type { Mailer, MailMessage } from './mailer.port.js';

/**
 * 传输层的**最小**面：本适配器只用到 `sendMail`。
 *
 * 为什么不直接依赖 nodemailer 的 `Transporter` 类型：这一层要能被**假传输**替换，
 * 单测才能在不联网的前提下断言「交给 SMTP 的参数形状」。这与
 * `GithubOauthService` 注入 `fetch` 是同一条既有标准（Task 6 的裁定：
 * 外部适配器要测请求构造与失败路径，但不做依赖网络的测试）。
 */
export interface MailTransport {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** 从 `SMTP_URL` 造传输层。生产路径上唯一一行与 nodemailer 真正耦合的代码。 */
export type MailTransportFactory = (smtpUrl: string) => MailTransport;

/**
 * 默认工厂要交给 nodemailer 的选项（**纯函数、可直接断言**）。
 *
 * 为什么单独抽出来：三个超时是「事务超时预算」的**依据**，因此「参数名有没有写对」
 * 必须能被测到——写成 `socket_timeout` 这种拼错的名字时，nodemailer 会静默用它自己的
 * 10 分钟默认值，预算就变成一纸空文。抽成纯函数后，`tests/unit/notify/delivery-timeouts.test.ts`
 * 可以对着**同一个对象**断言键名与取值，不需要在测试侧引入 `nodemailer` 依赖（K6）。
 */
export function buildSmtpTransportOptions(smtpUrl: string): {
  url: string;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
} {
  return {
    url: smtpUrl,
    connectionTimeout: MAILER_TIMEOUTS.connectionMs,
    greetingTimeout: MAILER_TIMEOUTS.greetingMs,
    socketTimeout: MAILER_TIMEOUTS.socketMs,
  };
}

/**
 * 默认工厂：**显式**配置三个超时（修复轮 2 / Fix 2）。
 *
 * 为什么不能只写 `createTransport(smtpUrl)`：那样三个超时全部继承 nodemailer 的默认值
 * （连接 2 分钟 / 问候 30 秒 / socket 空闲 10 分钟），而它们**没有被记在任何地方**，
 * 于是「消费者的事务超时该设多大」这个问题就没有答案——这正是 Fix 2 的原始缺陷：
 * 事务用 Prisma 的 5 秒默认，投递继承 nodemailer 的分钟级默认，两者相差两个数量级，
 * 一次成功的投递会在 5 秒处被回滚并重发。
 *
 * 现在超时值集中在 `common/timeouts.ts`，并在**模块求值期**断言
 * 「事务超时 > 邮件最坏耗时」。这行工厂是把那份预算真正交给传输层的那一步：
 * 参数写错了，预算就只是一份文档（因此选项形状由 {@link buildSmtpTransportOptions} 固定）。
 */
const defaultTransportFactory: MailTransportFactory = (smtpUrl) =>
  nodemailer.createTransport(buildSmtpTransportOptions(smtpUrl));

/**
 * 生产适配器（`NODE_ENV=production` 时由 `NotifyModule` 装配）。
 *
 * 「不吞异常」是它的契约：传输层失败必须冒泡回 `OutboxConsumer`，消费者据此
 * **不**把事件标记为已处理（§8.5），下一轮才可能重投。这里若 catch 掉，事件会被
 * 永久标记成「已处理」，那是一封静默丢失的邮件。
 */
export class SmtpMailer implements Mailer {
  private readonly transporter: MailTransport;

  constructor(
    smtpUrl: string,
    private readonly from: string,
    createTransport: MailTransportFactory = defaultTransportFactory,
  ) {
    this.transporter = createTransport(smtpUrl);
  }

  async send(m: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}
