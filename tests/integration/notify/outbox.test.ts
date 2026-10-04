import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { OutboxService } from '@vca/api/modules/notify/outbox.service.js';
import { OutboxConsumer } from '@vca/api/modules/notify/outbox.consumer.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';

/**
 * transactional outbox（§3.3 / §8.5 / C15）。
 *
 * ## 为什么每条断言都要真库
 *
 * 本文件断言的四件事**全都是数据库语义**，mock 一律证明不了：
 * 1. 事件与业务写入共用事务——回滚必须让事件消失（这是 outbox 存在的**全部理由**：
 *    结构上排除「业务成功但事件丢失」）；
 * 2. `idempotency_key` 的唯一约束；
 * 3. 唯一约束在**事务内**被检查 ⇒ 并发消费者只有一个能投递（§8.5 的 exactly-once 效果）；
 * 4. 消费者对 `processed_at` / `attempts` / `last_error` 的回写。
 *
 * ## 与 brief 版本的差异（Ruling 2，三处缺陷已修）
 *
 * - 后续步骤用**新**幂等键（`k-commit-2`）：原版重复发布 `k-commit` 会撞唯一约束，
 *   用例变成「抛错」而不是「断言」。重复键被拒这件事另有一条**专门**的用例（第 3 条）；
 * - 邮件负载一律是真实的 `{ to, subject, text }` 形状：原版发 `{ a: 3 }`，
 *   消费者的 `p.subject` 是 `undefined`，`s.includes(...)` 直接抛——那不是在测契约，
 *   是在测一个崩溃；
 * - 断言的是**实际投递内容**（`delivered` 数组里是 `subject`）而不只是计数，
 *   于是「投给了谁/投了几次」都有据可查。
 *
 * ## 用例之间的顺序依赖（有意为之，写在明处）
 *
 * 它们共用同一个 container 与同一个库，事件因此是**累积**的：每条消费者用例先 `drain()`
 * 把前面用例留下的事件排空，再只对本用例发布的事件断言。最后一条（畸形负载）刻意放在
 * 末尾：它留下一个**永远处理不掉**的事件（这正是要断言的行为），排在前面会干扰其它用例。
 */
describe('transactional outbox（§3.3 / C15）', () => {
  /**
   * 并发用例里屏障的等待上限。
   *
   * 正确实现下它必然被走满（第二个消费者阻塞在唯一索引上，永远到不了 `send`），
   * 因此这个数字就是该用例的固定耗时：400ms 足够让第二个消费者读到事件并走到插入，
   * 又远小于 Prisma 交互式事务的 5 秒上限（否则赢家会先被事务超时打断）。
   */
  const BARRIER_TIMEOUT_MS = 400;

  let pg: TestPg;
  let prisma: PrismaService;
  let outbox: OutboxService;
  /** 假邮件适配器：只记录 subject（真实形状，见 Ruling 2），不做任何投递。 */
  const delivered: string[] = [];

  beforeAll(async () => {
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    outbox = new OutboxService();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  /** 在一个事务里发布一条事件（与业务写入共用事务的调用形态）。 */
  async function publish(idempotencyKey: string, topic = 'test.event', payload: unknown = { a: 1 }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await outbox.publish(tx, { topic, payload, idempotencyKey });
    });
  }

  /** 发布一条**真实形状**的邮件事件（`OutboxConsumer.deliver` 的契约）。 */
  async function publishEmail(idempotencyKey: string, subject: string): Promise<void> {
    await publish(idempotencyKey, 'email.welcome', { to: 'user@example.com', subject, text: '正文' });
  }

  function makeConsumer(): OutboxConsumer {
    return new OutboxConsumer(prisma, {
      send: async (m) => {
        delivered.push(m.subject);
      },
    });
  }

  /**
   * 反复跑到没有可处理事件为止（上限轮数防止未来某个缺陷把用例变成死循环）。
   * 只统计**处理成功**的事件：处理失败的事件返回 0，因此它是终止条件的一部分。
   */
  async function drain(consumer: OutboxConsumer, maxRounds = 5): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await consumer.runOnce();
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  it('事件与业务写入同一事务：事务回滚则事件不落库', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.publish(tx, { topic: 'test.rollback', payload: { a: 1 }, idempotencyKey: 'k-rollback' });
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');

    const found = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-rollback' } });
    expect(found, '业务回滚了但事件留下了：outbox 的全部意义就是排除这种状态').toBeNull();
  });

  it('事务提交则事件落库且未被处理', async () => {
    await publish('k-commit', 'test.commit', { a: 2 });

    const found = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-commit' } });
    expect(found?.processedAt).toBeNull();
    expect(found?.attempts).toBe(0);
  });

  it('幂等键唯一：重复发布被拒绝，且库里只有一条事件', async () => {
    await publish('k-dup', 't', {});

    await expect(publish('k-dup', 't', {}), '同一个幂等键被接受了第二次').rejects.toThrow();
    expect(await prisma.outboxEvent.count({ where: { idempotencyKey: 'k-dup' } })).toBe(1);
  });

  it('消费者处理后标记 processedAt；重复运行不会重复投递（exactly-once 效果）', async () => {
    const consumer = makeConsumer();
    // 先排空前面用例留下的事件（k-commit / k-dup 都是非邮件 topic ⇒ 不产生投递）
    await drain(consumer);
    const base = delivered.length;
    expect(delivered.slice(base), '非邮件 topic 不该调用邮件适配器').toEqual([]);

    await publishEmail('k-commit-2', 'subject-k-commit-2');

    expect(await consumer.runOnce(), '新发布的邮件事件必须被处理').toBe(1);

    const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-commit-2' } });
    expect(row?.processedAt, '处理过的事件没有被标记').not.toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBeNull();
    expect(delivered.slice(base), '投递内容与 payload 不符').toEqual(['subject-k-commit-2']);

    expect(await consumer.runOnce(), '已处理的事件不该再被处理').toBe(0);
    expect(delivered.slice(base), 'exactly-once：重复运行不得重复投递').toEqual(['subject-k-commit-2']);
  });

  it('幂等键已被别的消费者占位时不再投递，并把事件标记为已处理（避免无限重试）', async () => {
    const consumer = makeConsumer();
    await drain(consumer);
    const base = delivered.length;

    await publishEmail('k-preempted', 'subject-k-preempted');
    // 模拟「另一个消费者先赢了这把锁」：processed_jobs 里已经有这个键
    await prisma.processedJob.create({ data: { idempotencyKey: 'k-preempted' } });

    expect(await consumer.runOnce(), '唯一约束冲突不该被算成处理成功').toBe(0);
    expect(delivered.slice(base), '已经被别的消费者处理过，不得重复投递').toEqual([]);

    const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-preempted' } });
    expect(row?.processedAt, '已处理过的事件必须标记，否则每轮都会重试并反复报同一个错').not.toBeNull();
    expect(row?.lastError, '失败原因没有被记下来，运维无从判断').toBeTruthy();
  });

  it('两个并发消费者处理同一事件时只投递一次（§8.5）', async () => {
    const a = makeConsumer();
    await drain(a);
    const base = delivered.length;

    await publishEmail('k-concurrent', 'subject-k-concurrent');

    /**
     * 屏障式假适配器：**强制**两个消费者都走到「投递」这一步，本用例才真的判别。
     *
     * 为什么必须有它（实测，见报告探针 O1）：单纯的
     * `Promise.all([a.runOnce(), b.runOnce()])` **抓不住**「先投递、后占位」这种错误实现——
     * 后到的消费者往往在读到事件时对方已经提交，它看到 `processed_at` 已标记就直接返回，
     * 于是断言在错误实现上照样全绿（这就是「测试没有牙齿」的形态）。
     *
     * 加上屏障之后：
     * - **正确实现**：只有一个消费者能走到 `send`（另一个阻塞在 `processed_jobs` 的唯一索引上），
     *   屏障靠超时放行，`arrivals === 1`；
     * - **错误实现**（先投递后占位）：两个都走到 `send`，屏障立刻放行、两封都发出去
     *   ⇒ `arrivals === 2`、`delivered` 两条 ⇒ 断言必红。
     */
    let arrivals = 0;
    let release: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrierMailer = {
      send: async (m: { subject: string }): Promise<void> => {
        arrivals++;
        if (arrivals === 2) release();
        // 等另一个消费者也到（或超时）：超时那条路径就是「正确实现」必然走的那条
        await Promise.race([bothArrived, new Promise((r) => setTimeout(r, BARRIER_TIMEOUT_MS))]);
        delivered.push(m.subject);
      },
    };
    const first = new OutboxConsumer(prisma, barrierMailer);
    const second = new OutboxConsumer(prisma, barrierMailer);

    const [n1, n2] = await Promise.all([first.runOnce(), second.runOnce()]);

    expect(n1 + n2, '恰好应该有一个消费者处理成功').toBe(1);
    expect(arrivals, '两个消费者都走到了投递：唯一约束没有在事务内挡住第二个').toBe(1);
    expect(delivered.slice(base), '两个消费者都投递了同一封邮件').toHaveLength(1);
  });

  it('邮件负载形状不对：不投递、记 lastError、事件保持未处理（可诊断、可重试）', async () => {
    const consumer = makeConsumer();
    await drain(consumer);
    const base = delivered.length;

    // 刻意给一个**错**的形状（brief 原版就是这样，见 Ruling 2）：真实契约是 { to, subject, text }
    await publish('k-bad-payload', 'email.welcome', { a: 3 });

    expect(await consumer.runOnce()).toBe(0);
    expect(delivered.slice(base), '形状不对的负载被投给了适配器（会发出 to=undefined 的邮件）').toEqual([]);

    const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-bad-payload' } });
    expect(row?.processedAt, '失败的事件不能被标记为已处理').toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError, '错误信息里没有主题，运维不知道是哪条事件坏了').toContain('email.welcome');
  });
});
