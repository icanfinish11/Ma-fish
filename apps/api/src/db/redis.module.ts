import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { REDIS } from '../modules/auth/session.service.js';
import type { Env } from '../config/env.schema.js';

/**
 * ioredis 连接的生命周期管理。
 *
 * ## 为什么这个钩子是必需的而不是「多余抽象」
 *
 * ioredis 在构造时就建连，并保持一个**活跃的 socket 句柄**。Node 的事件循环只要还有
 * 活跃句柄就不会自己退出，因此没有 `quit()` 时，`app.close()`（测试）与收到 SIGTERM 后的
 * 进程退出（生产）都会被这个连接**挂住**——表现为「测试跑完不退出」「滚动发布卡在 terminating」。
 * 这正是 `prisma.service.ts` 里 `onModuleDestroy` 已经在做的同一件事，不是新抽象。
 *
 * 用 `quit()` 而非 `disconnect()`：前者发送 `QUIT` 让服务端正常关闭连接（并冲刷已排队的
 * 命令），后者直接掐断。关停路径上多一次往返是划算的。
 *
 * ## 为什么关停用 `disconnect()` 而**不是** `quit()`（实测改正）
 *
 * 直觉上应该用 `quit()`（发 `QUIT` 让服务端正常收尾）。实测**不行**，两个独立的原因：
 *
 * 1. **`quit()` 在连接已关闭时会同步抛** `Error: Connection is closed.`
 *    （ioredis 6 的 `closeHandler` → `flushQueue`）。关停时 Redis 可能从未连上
 *    （启动即失败、或已经掉线），这条路径很容易走到；而 `onApplicationShutdown` 抛出
 *    会让 Nest 的关停流程半途而废——**其余模块的钩子不再执行**，一个 Redis 的收尾失败
 *    会连带让数据库连接不被断开。
 * 2. **`quit()` 要写 socket，而那个 socket 随时可能在半途消失**。实测报
 *    `[ioredis] Unhandled error event: Error: write EPIPE`（容器先停、或对端已关），
 *    以及 ready-check 的 `INFO` 命令在关停中撞上断连。这些都是**噪音**：
 *    它们出现在每一个 app.close() 的路径上，把真正的失败挤出视野。
 *
 * `disconnect()` 是同步的、不写任何字节、不产生以上任何一种错误。代价（据实记录）：
 * 已排队但未发出的命令会被丢弃（默认 `reconnect = false`，即不再尝试重连）。
 * 这个代价在**进程即将退出**的语境下是可以接受的：调用方（HTTP 请求）此刻要么已经
 * 完成，要么本来就随进程一起结束；而「关停干净、不留噪音、不阻断其他模块」更重要。
 */
@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onApplicationShutdown(): void {
    // 'end' / 'close' 表示连接已经终止；'wait' 表示从未成功建连。都没有可断的连接。
    if (this.redis.status === 'end' || this.redis.status === 'close' || this.redis.status === 'wait') {
      return;
    }
    this.redis.disconnect();
  }
}

/**
 * Redis 模块（Ruling 2：brief 的 Files 列表漏了本文件，其代码块又要求它存在）。
 *
 * `@Global()` 的理由与 `DbModule` 相同：会话、限流（Task 7）、幂等键（Task 8）
 * 都要用同一个连接池，逐模块 `imports` 只会制造样板，还会**多开连接**。
 *
 * 连接串来自 `ConfigService`（`REDIS_URL`），与 `DbModule` 的 `DATABASE_URL` 同一形状：
 * 密钥/端点只从环境变量来（C10），不在这里回退到任何默认值。
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      // ioredis 6 是 CJS 且必须用具名导出 Redis（实测见验证报告 §2.6）
      useFactory: (cfg: ConfigService<Env, true>) => new Redis(cfg.get('REDIS_URL', { infer: true })),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
