/**
 * 邮件端口（依赖倒置的落点，§3.4 的接缝）。
 *
 * 业务代码只认 `Mailer` 与 `MAILER` 这个令牌，不认具体实现；`NotifyModule` 按
 * `NODE_ENV` 选择 `SmtpMailer`（生产）或 `ConsoleMailer`（其余）。
 * 于是「换供应商 / 加第二个通道」不需要改任何业务代码，而测试天然不联网。
 */

/** 注入令牌。用 `Symbol` 而不是字符串：字符串令牌会与别的模块撞名，且撞了不会报错。 */
export const MAILER = Symbol('VCA_MAILER');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(m: MailMessage): Promise<void>;
}
