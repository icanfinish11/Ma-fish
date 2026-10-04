import { Module } from '@nestjs/common';
import { ConfigModule } from '@vca/api/config/config.module.js';
import { DbModule } from '@vca/api/db/db.module.js';
import { NotifyModule } from '@vca/api/modules/notify/notify.module.js';

/**
 * worker 的模块图：配置 + 数据库 + 通知（outbox 消费者与邮件端口）。
 *
 * ## 刻意**不**包含什么
 *
 * - **没有 HTTP 层**（`main.ts` 用 `createApplicationContext`）：worker 不服务请求；
 * - **没有 `RedisModule`**：会话与限流是 API 进程的事。少一个 ioredis 连接就少一个
 *   活跃句柄与一条网络依赖——worker 只需要数据库；
 * - **没有 `AppLoggerModule`**：worker 的日志量级只有「启动/停机/消费失败」三类，
 *    走 Nest 默认 logger + stderr 即可；引入 pino 会带来一套与 API 不同（无请求上下文）
 *    的配置面。这是**当下的取舍**，不是「以后也不加」：一旦 worker 需要结构化日志
 *    （例如接指标），第一件事就是把 `AppLoggerModule` 加进来，而不是另造一套。
 *
 * `ConfigModule` / `DbModule` 自己标了 `@Global()`，所以只写 `NotifyModule` 也能跑；
 * 三个都显式列出是为了让依赖方向可读（与 `NotifyModule` 里 `imports: [DbModule]` 同一理由）。
 */
@Module({ imports: [ConfigModule, DbModule, NotifyModule] })
export class WorkerModule {}
