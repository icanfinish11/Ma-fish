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
 * 4. 消费者对 `processed_at` / `attempts` / `last_error` / `abandoned_at` 的回写。
 *
 * ## 修复轮 1 新增的两组用例（Fix 1 / Fix 2）
 *
 * - **重试上限**：`attempts` 到顶后事件必须**离开待处理集合**（否则轮询循环会对外部 SMTP
 *   产生无界投递尝试），且「放弃」与「投递成功」在行上可区分。判定与自增必须在**同一事务**里，
 *   故有一条并发判别用例；
 * - **`last_error` 脱敏**：SMTP 的拒绝消息常回显收件人，落库前必须过 scrubber。
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
 *
 * 修复轮 1（Fix 1）改变了「永远处理不掉」的终局：畸形负载的事件**在到达上限后会被放弃**，
 * 于是它不再永远占着批次名额。上限用例仍然各自 `drain()` 一次，并且都用**自己**的事件键做断言，
 * 因此不依赖「谁先被选到」。
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

  /**
   * 修复轮 1 / Fix 1：重试上限（`attempts` 到顶就退出待处理集合）。
   *
   * ## 为什么这不是「提前造机制」（C16）
   *
   * `attempts` 字段与它的递增**本来就存在**，只是没有任何东西读它。而轮询循环每秒
   * **重新选取**未处理事件：一个永久失败的事件（SMTP 拒收、无法解析的负载）会对外部
   * SMTP 服务产生**无界**投递尝试——那是会把发信域名打上黑名单的那类运维事故，
   * 比丢一条通知更糟。所以这是「把已有机制补完」，不是新增子系统。
   *
   * ## 用例形状的两个要点
   *
   * 1. `maxAttempts` 传 **3** 而**不是**用默认值：用例必须能在几轮里跑完，而默认值
   *    （{@link MAX_DELIVERY_ATTEMPTS}）是产品参数，两者不该被混为一谈——用例断言的是
   *    「到顶就停」，与具体数字无关；
   * 2. 断言的是**「离开待处理集合」**（`processedAt: null` 的集合里不再有它），而不是
   *    某个内部字段：轮询循环看到的正是这个集合，所以这才是「不再重试」的真实含义。
   */
  it('永久失败的事件到达重试上限后退出待处理集合，且与「投递成功」可区分（Fix 1）', async () => {
    const cap = 3;
    // 恒定失败的适配器：每次调用都抛（模拟 SMTP 永久拒收）
    let sendCalls = 0;
    const alwaysFail = {
      send: async (): Promise<void> => {
        sendCalls++;
        throw new Error('550 收件人被拒');
      },
    };
    const consumer = new OutboxConsumer(prisma, alwaysFail);
    await drain(consumer);
    const baseline = sendCalls;

    await publishEmail('k-poison-cap', 'subject-k-poison-cap');

    for (let i = 1; i <= cap; i++) {
      expect(await consumer.runOnce({ maxAttempts: cap }), `第 ${i} 次尝试不该算作处理成功`).toBe(0);
    }

    const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-poison-cap' } });
    expect(row?.attempts, '尝试次数没有被如实记下').toBe(cap);
    expect(row?.lastError, '失败原因没有被保留：运维无从判断坏在哪').toBeTruthy();
    expect(
      await prisma.outboxEvent.count({ where: { idempotencyKey: 'k-poison-cap', processedAt: null } }),
      '到达上限后它仍在待处理集合里：轮询循环会永远对外部 SMTP 重试',
    ).toBe(0);

    // 区分「投递成功」与「尝试 N 次后放弃」：靠**终止标记**，而不是靠读 attempts 猜
    const deliveredRow = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-commit-2' } });
    expect(deliveredRow?.abandonedAt, '成功投递的事件被标成了「已放弃」').toBeNull();
    expect(deliveredRow?.processedAt, '前置用例的前提变了：k-commit-2 本应已成功投递').not.toBeNull();
    expect(row?.abandonedAt, '无法区分「投递成功」与「尝试 N 次后放弃」：两者都只是 processedAt 非空').not.toBeNull();
    expect(row?.processedAt, '放弃后仍留在待处理集合里').not.toBeNull();

    const before = sendCalls;
    await consumer.runOnce({ maxAttempts: cap });
    expect(sendCalls, '已放弃的事件被再次投递：上限没有真的拦住重试').toBe(before);
    expect(sendCalls - baseline, '投递次数超过了上限').toBeLessThanOrEqual(cap);
  });

  it('达到上限的事件不阻塞后续事件的投递（坏事件不该拖垮整条通道）', async () => {
    const cap = 2;
    const sentTitles: string[] = [];
    /** 只拒收 A 的主题（永久失败），B 的主题正常投递。 */
    const rejectsOnlyA = {
      send: async (m: { subject: string }): Promise<void> => {
        if (m.subject === 'subject-poison-a') throw new Error('550 收件人被拒');
        sentTitles.push(m.subject);
      },
    };
    const consumer = new OutboxConsumer(prisma, rejectsOnlyA);
    await drain(consumer);

    await publishEmail('k-poison-a', 'subject-poison-a');
    await publishEmail('k-after-poison', 'subject-after-poison');

    // 第一轮：A 失败（attempts=1），**同轮的 B 必须照常投递**
    await consumer.runOnce({ maxAttempts: cap });
    expect(sentTitles, '一条失败事件把同一批里后续事件的投递挡住了').toContain('subject-after-poison');

    // 再跑到 A 被放弃（多给几轮：其它用例可能留下事件占用批次名额）
    for (let round = 0; round < 4; round++) {
      await consumer.runOnce({ maxAttempts: cap });
      if ((await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-poison-a' } }))?.abandonedAt) break;
    }

    const abandoned = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-poison-a' } });
    expect(abandoned?.abandonedAt, '事件 A 到达上限后没有被标为放弃').not.toBeNull();
    expect(abandoned?.attempts, '放弃前的尝试次数超过上限').toBeLessThanOrEqual(cap);
    expect(sentTitles, 'A 到达上限后，B 的投递记录不该消失或重复').toContain('subject-after-poison');
  });

  /**
   * 并发消费者下上限**仍然有效**。
   *
   * 这一条是「按行上的 attempts 判定」这个实现的判别用例：如果失败路径先读行、再决定、
   * 最后 `increment`（read-modify-write），两个并发消费者读到的是**同一个旧值**，
   * 于是 `attempts` 会被**少算**——上限就成了摆设，外部 SMTP 依旧收到无界的尝试。
   * 把「自增 + 读回 + 判定 + 标放弃」放进**一个事务**后，并发的丢失更新不再能绕过上限。
   */
  it('并发消费者不会绕过重试上限（判定必须与自增在同一事务里，不能 read-modify-write）', async () => {
    const cap = 3;
    const failures = {
      send: async (): Promise<void> => {
        throw new Error('550 收件人被拒');
      },
    };
    const first = new OutboxConsumer(prisma, failures);
    const second = new OutboxConsumer(prisma, failures);
    const third = new OutboxConsumer(prisma, failures);
    const consumers = [first, second, third];

    await drain(first);

    await publishEmail('k-poison-parallel', 'subject-poison-parallel');

    for (let round = 0; round < cap; round++) {
      await Promise.all(consumers.map((c) => c.runOnce({ maxAttempts: cap })));
    }

    expect(
      await prisma.outboxEvent.count({ where: { idempotencyKey: 'k-poison-parallel', processedAt: null } }),
      '并发消费者下事件没有离开待处理集合：上限被 read-modify-write 的丢失更新绕过了',
    ).toBe(0);
    const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-poison-parallel' } });
    expect(row?.abandonedAt, '并发下没有落放弃标记').not.toBeNull();
  });

  /**
   * 修复轮 1 / Fix 2：`last_error` 落库前也要脱敏。
   *
   * ## 为什么「只在库里」不是一条更弱的暴露（Task 6 的同一把尺子）
   *
   * C11 字面上说的是日志，但 Task 6 已经为**持久化存储**定过先例：复审发现会话 id
   * （本身就是完整的 bearer 凭证）被写进 append-only 的 `audit_log` 时把它去掉了，
   * 理由是「只在数据库里」并不比「在日志里」弱。`last_error` 是同一种东西：
   * 一行**无限期保留**的错误文本，而 SMTP 的错误消息经常直接回显收件人地址。
   *
   * ## 复用的是 worker 里那一份 scrubber
   *
   * 第二份实现就是漂移的开始：两处的正则、掩码规则、括号边界迟早会分叉。
   * 因此 `scrubEmails` 被搬到 `common/logging/redact.ts`（与 `maskEmail` 同一处），
   * worker 的失败行与这里的 `last_error` 走**同一段代码**。
   */
  it('last_error 落库前脱敏：SMTP 拒绝消息里的完整地址不得进入数据库（Fix 2 / C11）', async () => {
    const smtpRejection = {
      send: async (): Promise<void> => {
        // 真实形态：nodemailer 把服务器响应原样抛出，里面带着收件人
        throw new Error(
          'Mail command failed: 550 5.1.1 <victim@example.com>: Recipient address rejected: User unknown in local recipient table',
        );
      },
    };
    const consumer = new OutboxConsumer(prisma, smtpRejection);
    await drain(consumer);

    await publish('k-scrub-address', 'email.welcome', {
      to: 'victim@example.com',
      subject: 'subject-scrub-address',
      text: '正文',
    });

    expect(await consumer.runOnce()).toBe(0);

    const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-scrub-address' } });
    expect(row?.lastError, 'SMTP 的失败消息没有被记下来（运维看不到坏在哪）').toContain('550 5.1.1');
    expect(
      row?.lastError,
      '完整收件人地址被持久化进 last_error：这一行会无限期保留，"只在数据库里" 不比 "在日志里" 弱（Task 6 的同一裁定）',
    ).not.toContain('victim@example.com');
    expect(row?.lastError, '掩码形式应当仍然可读（域名保留，运维能看出是哪个域被拒）').toContain(
      'v***@example.com',
    );
  });
});
