import type { Mailer, MailMessage } from './mailer.port.js';
import { maskEmail } from '../../common/logging/redact.js';

/**
 * 开发与测试用适配器：不真实投递，且日志中邮箱已脱敏（C11）。
 *
 * `sink` 可注入的唯一理由是**可测**：真实默认值是 `console.log`，而单测需要捕获那一行
 * 才能断言「完整邮箱没有出现」。这与 `bootstrap.ts` 注入 `exit`、`GithubOauthService`
 * 注入 `fetch` 是同一条既有标准（不做依赖网络的测试）。
 *
 * 注意：**只有收件人被掩码**（`maskEmail`）。主题与正文由调用方决定，C15 的边界是
 * 「通知内容里不放凭证」——本适配器不是内容审计器，它做的是 C11 明确要求的那一条：
 * 日志里不出现完整邮箱地址。
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly sink: (line: string) => void = (l) => console.log(l)) {}

  async send(m: MailMessage): Promise<void> {
    this.sink(`[mail] to=${maskEmail(m.to)} subject=${m.subject}`);
  }
}
