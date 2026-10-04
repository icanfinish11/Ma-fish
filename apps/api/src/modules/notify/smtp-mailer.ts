import nodemailer from 'nodemailer';
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

const defaultTransportFactory: MailTransportFactory = (smtpUrl) => nodemailer.createTransport(smtpUrl);

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
