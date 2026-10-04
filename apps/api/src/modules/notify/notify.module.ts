import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbModule } from '../../db/db.module.js';
import { PrismaService } from '../../db/prisma.service.js';
import { OutboxService } from './outbox.service.js';
import { OutboxConsumer } from './outbox.consumer.js';
import { ConsoleMailer } from './console-mailer.js';
import { SmtpMailer } from './smtp-mailer.js';
import { MAILER, type Mailer } from './mailer.port.js';
import type { Env } from '../../config/env.schema.js';

/**
 * 通知模块（C15）：outbox 的写入侧、消费侧与邮件端口。
 *
 * ## 为什么**没有** `@Global()`
 *
 * brief 给的模块带了 `@Global()`。它是**删掉**的，理由与 `AuditModule`/`AuthModule`
 * 那两处修复轮裁定完全一致：全局可见性必须是**当下被依赖的事实**，而不是对将来调用方的
 * 猜测。今天的使用者是 `apps/worker` 的 `WorkerModule`，它已经显式
 * `imports: [NotifyModule]`；显式导入一旦工作，全局标记就没有任何东西在依赖它。
 * 全局 provider 命名空间是真实成本（平铺的令牌空间、看不见的覆盖，C16）。
 *
 * ## `imports: [DbModule]` 是冗余但**承重**的一行
 *
 * `DbModule` 自己标了 `@Global()`，所以删掉这一行运行期不会报错——但这条边会从代码里
 * 消失：`PrismaService` 从哪来就只剩下「全局模块」这个隐含事实。显式写出来，
 * 依赖方向才是可读的（与 `AppModule` 里 `SessionMiddleware` 需要 `AuthModule` 的那条边同理）。
 *
 * ## `MAILER` 的工厂：为什么不 `useClass`
 *
 * 两个分支的构造参数不同（SMTP 需要 `SMTP_URL`/`MAIL_FROM`），且**生产与其余环境是不同的类**。
 * `useClass` 表达不了这个选择。这个选择本身只被一条用例钉住（`tests/unit/notify/mailer.test.ts`
 * 的两个分支断言）：工厂若在生产也返回 `ConsoleMailer`，线上邮件会一封都不发，
 * 而**所有其它测试照旧全绿**——那是必须被钉死的静默失败。
 *
 * ## `OutboxConsumer` 为什么用工厂而不是 `useClass`
 *
 * 它的第二个构造参数是 `MAILER` 这个 `Symbol` 令牌，类里若加 `@Inject(MAILER)` 就得把
 * Nest 的令牌概念带进一个纯逻辑类；而集成测试是 `new OutboxConsumer(prisma, fakeMailer)`
 * 直接构造的（见 `tests/integration/notify/outbox.test.ts`）。工厂把装配留在模块里，
 * 消费者保持「两个参数、可直接构造」。
 *
 * ## 今天的可达性：只有 worker 能走到本模块（已裁定接受，P0 边界）
 *
 * 唯一的使用者是 `apps/worker`。`apps/api` **没有** import 它——也就是说今天**没有生产者**：
 * 没有任何业务代码调用 `OutboxService.publish`，因此 outbox 表在正常运行下是空的
 * （集成测试直接构造消费者，不经过本模块）。这对 P0 是**正确**的：本任务交付的是通道本身
 * 与它的失败语义，不是某条具体通知。
 *
 * **交接备注（写给 Task 9+）**：第一个真实生产者落地时，要同时确认三件事——
 * ① 那个业务模块在自己的 `imports` 里写上 `NotifyModule`；
 * ② `publish` 必须传**业务事务的** `tx`（`PrismaService` 结构上也满足
 * `Prisma.TransactionClient`，类型挡不住误用，见 `outbox.service.ts`）；
 * ③ 主题名以 `email.` 开头才会被投递（`outbox.consumer.ts` 的 `EMAIL_TOPIC_PREFIX`）。
 */
@Module({
  imports: [DbModule],
  providers: [
    OutboxService,
    {
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<Env, true>): Mailer =>
        cfg.get('NODE_ENV', { infer: true }) === 'production'
          ? new SmtpMailer(cfg.get('SMTP_URL', { infer: true }), cfg.get('MAIL_FROM', { infer: true }))
          : new ConsoleMailer(),
    },
    {
      provide: OutboxConsumer,
      inject: [PrismaService, MAILER],
      useFactory: (prisma: PrismaService, mailer: Mailer) => new OutboxConsumer(prisma, mailer),
    },
  ],
  exports: [OutboxService, OutboxConsumer, MAILER],
})
export class NotifyModule {}
