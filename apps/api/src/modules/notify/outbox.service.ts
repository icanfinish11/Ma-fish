import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

export interface OutboxMessage {
  topic: string;
  payload: unknown;
  /** 幂等键（§8.5）：同一业务动作重复发布只会产生一条事件。 */
  idempotencyKey: string;
}

/**
 * Outbox 的写入侧（§3.3）。
 *
 * ## 为什么 `publish` **必须**收一个事务客户端
 *
 * 这是 transactional outbox 的全部要点：事件与业务写入要么一起提交、要么一起回滚。
 * 如果这里改用 `this.prisma`（自己的连接、自己的事务），那么「业务提交成功但进程在
 * 两件事之间崩溃」就会表现为**业务成功而事件永久丢失**——通知静默不发，且没有任何
 * 地方会报错。所以签名刻意要求调用方传入 `tx`，让「共用事务」成为**类型上的**事实：
 * 传 `PrismaService` 本身是编译不过的（它没有 `outboxEvent`？——它有，但调用点必须
 * 显式地走到 `$transaction` 里，见 `tests/integration/notify/outbox.test.ts` 的回滚用例）。
 *
 * 本类**没有** `PrismaService` 依赖，因此它不需要 Nest 的 DI 也能被直接构造（测试里就是
 * 这么用的）。这也是刻意的：一个只有一种写法的写入器，越少依赖越不容易被绕过。
 *
 * ## 唯一约束在写入侧的表现
 *
 * `idempotency_key` 上有唯一约束（`schema.prisma`），重复发布会被数据库拒绝并抛错；
 * 本类**不**吞掉这个错误，也不做 `upsert`。「重复发布」是调用方需要知道的事实
 * （通常意味着某个业务动作被触发了两次），静默去重会把它藏起来。
 */
@Injectable()
export class OutboxService {
  /**
   * 与业务写入共用同一事务（§3.3）：调用方必须传入事务客户端。
   * 这样「业务成功但事件丢失」在结构上不可能发生。
   */
  async publish(tx: Prisma.TransactionClient, msg: OutboxMessage): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        topic: msg.topic,
        payload: msg.payload as Prisma.InputJsonValue,
        idempotencyKey: msg.idempotencyKey,
      },
    });
  }
}
