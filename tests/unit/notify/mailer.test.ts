import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConsoleMailer } from '@vca/api/modules/notify/console-mailer.js';
import { SmtpMailer } from '@vca/api/modules/notify/smtp-mailer.js';
import { MAILER } from '@vca/api/modules/notify/mailer.port.js';
import { NotifyModule } from '@vca/api/modules/notify/notify.module.js';
import { ConfigModule } from '@vca/api/config/config.module.js';
import { maskEmail } from '@vca/api/common/logging/redact.js';
import { testEnv } from '../../helpers/env.js';

/**
 * 邮件适配器（C11 / C15）与 `MAILER` 的接线。
 *
 * ## 1. `ConsoleMailer` 必须掩码收件人
 *
 * C11 的字面要求是「绝不记录完整邮箱地址」，而开发/测试适配器的**唯一输出**就是一行日志。
 * 因此「掩码」这件事必须被断言，而不是靠注释。
 *
 * ## 2. `SmtpMailer` 为什么可以注入传输层
 *
 * 生产适配器只在 `NODE_ENV === 'production'` 下被构造，而单测**不做网络请求**
 * （本仓库的既有标准：Task 6 给 `GithubOauthService.exchange` 注入 `fetch`，
 * 只断言请求构造与失败路径）。因此这里注入一个 `MailTransportFactory`：
 * 断言 `sendMail` 收到的**恰好**是 `{ from, to, subject, text }`，以及传输层的失败
 * **不被吞掉**（消费者要靠它决定「不标记已处理、下轮重试」）。
 *
 * ## 3. 为什么还要测 `MAILER` 的工厂
 *
 * 这是本模块唯一「看起来对、坏起来静默」的地方：如果工厂在生产也返回 `ConsoleMailer`，
 * 线上邮件会**一封都不发**，而所有测试照旧全绿（没人会红）。这类「接线断言」在
 * Task 4/Task 7 的复审里被反复要求补上，所以这里直接对两个分支各断言一次。
 */
describe('邮件适配器与脱敏（C11）', () => {
  it('ConsoleMailer 记录而不抛错', async () => {
    const sent: string[] = [];
    const m = new ConsoleMailer((s) => sent.push(s));
    await m.send({ to: 'user@example.com', subject: '收到交换要约', text: '正文' });
    expect(sent).toHaveLength(1);
  });

  it('日志中的邮箱被掩码，不出现完整地址', async () => {
    const sent: string[] = [];
    const m = new ConsoleMailer((s) => sent.push(s));
    await m.send({ to: 'user@example.com', subject: 's', text: 't' });
    expect(sent[0]).not.toContain('user@example.com');
    expect(sent[0]).toContain('u***@example.com');
  });

  it('maskEmail 处理异常输入', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
  });

  it('SmtpMailer 把 from/to/subject/text 原样交给传输层，且用传入的 URL 建传输层', async () => {
    const urls: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const mailer = new SmtpMailer('smtp://mail.internal:587', 'no-reply@example.com', (url) => {
      urls.push(url);
      return {
        sendMail: async (options) => {
          sent.push(options);
          return { accepted: [options.to] };
        },
      };
    });

    await mailer.send({ to: 'user@example.com', subject: '收到交换要约', text: '正文' });

    expect(urls, '传输层不是用配置里的 SMTP_URL 建的').toEqual(['smtp://mail.internal:587']);
    expect(sent, 'sendMail 的参数形状变了（收件人/发件人/主题/正文必须逐字对应）').toEqual([
      { from: 'no-reply@example.com', to: 'user@example.com', subject: '收到交换要约', text: '正文' },
    ]);
  });

  it('SmtpMailer 不吞传输层失败（消费者要靠它决定重试，而不是标记已处理）', async () => {
    const mailer = new SmtpMailer('smtp://mail.internal:587', 'no-reply@example.com', () => ({
      sendMail: async () => {
        throw new Error('smtp 连接被拒绝');
      },
    }));

    await expect(mailer.send({ to: 'user@example.com', subject: 's', text: 't' })).rejects.toThrow(
      'smtp 连接被拒绝',
    );
  });

  describe('MAILER 的工厂接线（生产 SMTP / 其余 Console）', () => {
    /**
     * 用夹具环境造一个只覆盖 `NODE_ENV` 的 ConfigService——其余键仍取夹具值。
     *
     * `ConfigModule` 必须显式 import：`DbModule` 的 `PrismaService` 工厂依赖**全局**的
     * `ConfigService`（生产里由 `AppModule` 注册）。只 import `NotifyModule` 时它不是全局的，
     * Nest 会报 `Nest can't resolve dependencies of the PrismaService (?)`——实测踩到过。
     * 这也让本用例的模块图与生产一致（ConfigModule + DbModule + NotifyModule）。
     */
    async function mailerUnder(nodeEnv: string): Promise<unknown> {
      const env: Record<string, string | undefined> = { ...testEnv };
      const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, NotifyModule] })
        .overrideProvider(ConfigService)
        .useValue({ get: (key: string) => (key === 'NODE_ENV' ? nodeEnv : env[key]) })
        .compile();
      try {
        return moduleRef.get(MAILER);
      } finally {
        await moduleRef.close();
      }
    }

    it('生产环境必须用 SmtpMailer（否则线上邮件一封都不发，且没有任何测试会红）', async () => {
      expect(await mailerUnder('production')).toBeInstanceOf(SmtpMailer);
    });

    it('开发/测试环境用 ConsoleMailer（不真投递）', async () => {
      expect(await mailerUnder('test')).toBeInstanceOf(ConsoleMailer);
      expect(await mailerUnder('development')).toBeInstanceOf(ConsoleMailer);
    });
  });
});
