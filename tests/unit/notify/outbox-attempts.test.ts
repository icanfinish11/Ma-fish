import { describe, it, expect } from 'vitest';
import { OutboxConsumer } from '@vca/api/modules/notify/outbox.consumer.js';
import type { PrismaService } from '@vca/api/db/prisma.service.js';

/**
 * 修复轮 2 / Fix 3：**用确定性证据替代「靠并发撞出来」的证据**。
 *
 * ## 为什么需要这个文件
 *
 * 集成用例里那条「并发消费者不会绕过重试上限」声称能抓住 read-modify-write 的丢失更新。
 * 修复轮 2 用**真正的** RMW 变异（先 `SELECT` 旧值、再写成「旧值 + 1」）实测：**3 路不红，
 * 12 路也不红**（探针 `t8-fix2-probe-fix2-rmw` 与 `…-rmw-12way`）。原因是丢失更新需要
 * 「B 的 SELECT 落在 A 的 SELECT 与 UPDATE 之间」，而每次失败只有两条语句、都是毫秒级——
 * 靠加并发把窗口撞开的做法既不稳定、又会随机器负载漂移。**结论如实记录**：
 * 那条集成用例**没有**判别 RMW 的能力，它判别的是「到顶即放弃」这条更粗的逻辑。
 *
 * ## 这里怎么做到确定性
 *
 * 不撞时序，直接检查**代码形状**：把 `outboxEvent.update` 换成一个可观测的替身，记录
 * 每一次读/写。判据只有一条，而且它在读代码时就能一眼验证：
 *
 * > 判定所用的 `attempts` **必须**来自 `UPDATE … RETURNING` 的返回，
 * > 而**不能**来自任何一次独立的 `SELECT`。
 *
 * 正确实现完全不需要读 `attempts`；真正的 RMW 则必须先 `findUnique` 拿到旧值。
 * 因此「有没有那次独立的读」就是「是不是 RMW」的**充分判据**，与并发无关、与机器快慢无关。
 *
 * 这个替身不碰数据库（`$transaction` 直接执行回调），所以它是**单元**测试：
 * 真库语义（行锁、唯一约束）由集成套件负责，这里负责的是控制流。
 */

/** 记录替身收到过哪些操作，供断言直接读。 */
interface SpyLog {
  /** `outboxEvent.update` 的 data（每次一条）。 */
  updateData: Array<Record<string, unknown>>;
  /** 事务客户端上发生过几次独立的 SELECT（`findUnique` / `findUniqueOrThrow` / `findFirst`）。 */
  standaloneReads: number;
}

/**
 * 造一个只实现 `runOnce` 失败路径所需面的假 prisma。
 *
 * 关键设计：**事务客户端的 `findUnique` 会被计数**，而 `update` 返回「自增后的」值——
 * 模拟 `UPDATE … RETURNING` 的效果，也就是正确实现真正依赖的那件事。
 */
function makeSpyPrisma(eventId: string, pendingEvents: number, log: SpyLog): PrismaService {
  const row = { id: eventId, idempotencyKey: 'k-spy', topic: 'email.welcome', payload: {}, attempts: 0 };

  const txClient = {
    processedJob: { create: async (): Promise<unknown> => ({}) },
    outboxEvent: {
      update: async (args: { data: Record<string, unknown> }): Promise<{ attempts: number }> => {
        log.updateData.push(args.data);
        row.attempts += 1; // 自增语义：读回的一定是**新**值
        return { attempts: row.attempts };
      },
    },
  };

  const client = {
    /** 独立的读：RMW 必须先走这里拿旧值。正确实现不该调用它。 */
    findUnique: async (): Promise<unknown> => {
      log.standaloneReads += 1;
      return { attempts: row.attempts };
    },
    findUniqueOrThrow: async (): Promise<unknown> => {
      log.standaloneReads += 1;
      return { attempts: row.attempts };
    },
    findFirst: async (): Promise<unknown> => {
      log.standaloneReads += 1;
      return { attempts: row.attempts };
    },
  };

  const prismaLike = {
    outboxEvent: {
      findMany: async (): Promise<unknown[]> => Array.from({ length: pendingEvents }, () => row),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
      fn({
        ...txClient,
        outboxEvent: { ...txClient.outboxEvent, ...client },
        processedJob: txClient.processedJob,
      }),
  };

  return prismaLike as unknown as PrismaService;
}

const failingMailer = {
  send: async (): Promise<void> => {
    throw new Error('550 收件人被拒');
  },
};

describe('重试上限的判定形状（Fix 3：判定必须来自 UPDATE … RETURNING，不能来自独立 SELECT）', () => {
  it('失败回写不发起任何独立的 SELECT：attempts 只从 update 的返回值里拿', async () => {
    const log: SpyLog = { updateData: [], standaloneReads: 0 };
    const consumer = new OutboxConsumer(makeSpyPrisma('e-1', 1, log), failingMailer);

    await consumer.runOnce({ maxAttempts: 3 });

    /**
     * 承重断言。把实现改成「先 `findUnique` 拿旧值、再写 `attempts: 旧值 + 1`」
     * （真正的 read-modify-write）时，`standaloneReads` 会变成 1，这条立刻红——
     * 与并发无关、与机器快慢无关。这正是集成用例给不了的判别力。
     */
    expect(
      log.standaloneReads,
      '判定用的是独立 SELECT 读回来的旧值：并发下会丢失更新，上限就成了摆设（RMW）',
    ).toBe(0);

    // 失败路径必须真的走到（否则上面那条断言会对着「什么都没发生」通过）
    expect(log.updateData, '失败回写没有发生：上面那条断言是空转的').toHaveLength(1);
    expect(log.updateData[0], '失败回写不再使用数据库侧的自增').toHaveProperty('attempts', { increment: 1 });
  });

  it('到达上限时，判定用的是**自增后**的值（maxAttempts=1 时第一次失败就放弃）', async () => {
    const log: SpyLog = { updateData: [], standaloneReads: 0 };
    const consumer = new OutboxConsumer(makeSpyPrisma('e-2', 1, log), failingMailer);

    // maxAttempts = 1 ⇒ 第一次失败就该标为放弃。替身的 update 返回**自增后**的 1；
    // 实现若拿自增前的值（0）去比，就永远不会放弃——这条会把那种实现钉住。
    await consumer.runOnce({ maxAttempts: 1 });

    expect(log.standaloneReads, '判定用的是独立 SELECT（RMW）').toBe(0);
    // 一次失败在到达上限时写两次：先自增 + 记 lastError，再标 processedAt/abandonedAt
    expect(log.updateData, '第一次失败没有走到「自增 + 标放弃」两步').toHaveLength(2);
    expect(log.updateData[0], '第一步不再是数据库侧自增').toHaveProperty('attempts', { increment: 1 });
    expect(log.updateData[1], '到达上限后没有标记终止态').toHaveProperty('abandonedAt');
    expect(log.updateData[1], '到达上限后没有让它退出待处理集合').toHaveProperty('processedAt');
  });
});
