import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { OutboxService } from '@vca/api/modules/notify/outbox.service.js';
import { MAX_LAST_ERROR_LENGTH, OutboxConsumer } from '@vca/api/modules/notify/outbox.consumer.js';
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
 *   产生无界投递尝试），且「放弃」与「投递成功」在行上可区分。判定与自增在**同一事务**里；
 *   并发那条用例是**放弃分支**的判别式，**不**判别 read-modify-write（该说法已撤回，
 *   理由写在用例的注释里）；
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
 * 把前面用例留下的事件排空，再只对本用例发布的事件断言。
 *
 * 两条用例会留下**未处理**事件（畸形负载 `k-bad-payload`、恒定失败的那几条毒事件），
 * 它们因此会占着后续批次的名额——所以：
 * - 每条用例的断言都只针对**自己**的幂等键，不依赖「谁先被选到」；
 * - **基线必须在 `drain()` **之前**取、且在本用例发布之前**（最终评审的 Minor 改正了
 *   这处**写反了**的规则）：`delivered.slice(base)` 要覆盖的正是「排空这些非邮件 topic 的
 *   全过程」。取在 `drain()` **之后**的话，那句 `toEqual([])` 比较的是一个**按构造为空**的
 *   切片（排空之后、发布之前没有任何投递），于是它在任何实现上都绿——同义反复。
 *   逐条用例里的写法与理由见下面「基线在 `drain()` **之前**取」那一段注释。
 *
 * 「畸形负载」用例此前刻意排在末尾（理由：它留下一个永远处理不掉的事件）。修复轮 1 的
 * Fix 1 **改掉了那个前提**：那条事件到达上限后会被放弃、离开待处理集合，因此它不再
 * 永远占名额——排在前面也无害。它现在仍留在原位置（后面跟着上限那几条用例），
 * 因为它依赖 `attempts === 1` 这个**首轮**状态，而 `drain()` 只跑一轮失败就返回 0。
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
  /**
   * Fix 4 的用例会触发实现里的 `Logger.error`（那是**被断言的场景**，不是噪声）。
   * 把整个文件里的 Nest 日志挡在测试输出之外，本仓库要求输出 pristine。
   */
  const logSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  beforeAll(async () => {
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    outbox = new OutboxService();
  }, 180_000);

  afterAll(async () => {
    logSpy.mockRestore();
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
    /**
     * 基线在 `drain()` **之前**取（修复轮 2 的 Minor）。
     *
     * 此前这句在 `drain()` 之后，于是 `delivered.slice(base)` 因为排空本身没投递过任何东西
     * 而**必然**是空数组——「非邮件 topic 不该调用邮件适配器」那条断言就变成了同义反复
     * （它在任何实现上都绿）。基线取在排空之前，那句断言才真的覆盖了「排空这些非邮件事件
     * 的全过程里，适配器一次都没被调过」。
     */
    const base = delivered.length;
    // 排空前面用例留下的事件（k-commit / k-dup / 已放弃的毒事件都是非邮件 topic ⇒ 不产生投递）
    await drain(consumer);
    expect(delivered.slice(base), '非邮件 topic 不该调用邮件适配器').toEqual([]);

    await publishEmail('k-commit-2', 'subject-k-commit-2');

    expect(await consumer.runOnce(), '新发布的邮件事件必须被处理').toBe(1);

    const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-commit-2' } });
    expect(row?.processedAt, '处理过的事件没有被标记').not.toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBeNull();
    expect(delivered.slice(base), '投递内容与 payload 不符').toEqual(['subject-k-commit-2']);

    expect(await consumer.runOnce(), '已处理的事件不该再被处理').toBe(0);
    // `toEqual` 是**逐元素**比较：多投一次、少投一次、投错内容都会红。
    // （此前这里用的是 `toContain`，而它的消息写着「不得重复投递」——`toContain` 检测不了重复，
    //   断言与消息不符。修复轮 2 的 Minor 把它改成 `toEqual`。）
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
    /**
     * **唯一冲突不是「放弃」**（修复轮 2 / Fix 1 补的断言）。
     *
     * 列语义（`schema.prisma`）：`processed_at` 非空 + `abandoned_at` 空 = 已投递/已被处理；
     * 两者都非空 = 试了 N 次后放弃、邮件**没发出去**。
     *
     * 修 Fix 1 之前，这条路径与「到达上限」共用同一次写入，于是**唯一一个**含义是
     * 「别的消费者已经把这封发出去了」的状态，被存成了「试了 N 次、一封没发」——
     * 恰好是这一列要防的那种误读，方向还反了。这条断言就是钉住那个区分：
     * 把 `abandonedAt` 删掉，运维会把「别人已投递」读成「投递失败」。
     */
    expect(row?.abandonedAt, '唯一冲突被当成了「尝试 N 次后放弃」：这一列的语义被反转了').toBeNull();
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
   * ## 这条用例**不是** read-modify-write 的判别式（最终评审的 Minor 收窄了标题与说明）
   *
   * 它此前被标成「抓 RMW」，而那个说法已经在下面对并发度的那段注释里被**撤回**了
   * （实测：真正的 RMW 变异在 3 路与 12 路下都不红）。因此这里的口径改成它**实际**证明的：
   * 「`attempts` 到顶后事件离开待处理集合 + 落了 `abandoned_at`」，
   * 把「放弃」分支关掉（探针 `fix1-abandon-disabled`）时必红。
   * RMW 那条不变式由 `tests/unit/notify/outbox-attempts.test.ts` 的**确定性**用例承担。
   */
  it('并发消费者下事件仍会离开待处理集合并落放弃标记（放弃分支的判别式；不判别 RMW）', async () => {
    const cap = 3;
    const failures = {
      send: async (): Promise<void> => {
        throw new Error('550 收件人被拒');
      },
    };
    /**
     * 并发度刻意取 12 而不是 3（修复轮 2 的实测教训）。
     *
     * **本用例能证明什么、不能证明什么**（据实记录，因为它此前被标成了「抓 read-modify-write」）：
     * - **能**：`attempts` 到顶后事件确实离开待处理集合、并且落了 `abandoned_at`；
     *   把「放弃」分支关掉（探针 `fix1-abandon-disabled`）时它必红；
     * - **不能**：它抓不住真正的 read-modify-write。丢失更新需要「B 的 SELECT 落在 A 的
     *   SELECT 与 UPDATE 之间」，而每次失败只有两条语句、都是毫秒级：用真正的 RMW 变异
     *   （先 `SELECT` 旧值、再写「旧值 + 1」）实测，**3 路不红、12 路也不红**
     *   （探针 `t8-fix2-probe-fix2-rmw` / `…-rmw-12way`）。
     *
     * 所以「判定必须来自 `UPDATE … RETURNING`」这条不变式改由**确定性**用例承担：
     * `tests/unit/notify/outbox-attempts.test.ts` 直接断言失败回写不发起任何独立 SELECT，
     * 真 RMW 变异下必红（探针 `t8-fix2-probe-rmw-shape`，2/2 红）。那条与并发无关、
     * 不随机器快慢漂移——这里保留 12 路只是为了把「并发下也不会卡在待处理集合里」测宽一点。
     */
    const consumers = Array.from({ length: 12 }, () => new OutboxConsumer(prisma, failures));

    await drain(consumers[0]!);

    await publishEmail('k-poison-parallel', 'subject-poison-parallel');

    for (let round = 0; round < cap; round++) {
      await Promise.all(consumers.map((c) => c.runOnce({ maxAttempts: cap })));
    }

    expect(
      await prisma.outboxEvent.count({ where: { idempotencyKey: 'k-poison-parallel', processedAt: null } }),
      '并发消费者下事件没有离开待处理集合（放弃分支没生效）——注意这条**不**判别 read-modify-write，' +
        '见本用例上方与并发度那段注释',
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

  /**
   * 修复轮 2 / Fix 2：**慢投递不能变成重复邮件**。
   *
   * ## 被修的那个形态
   *
   * 事务形状是「占位 → 投递 → 标记」，而**默认**的两个超时相差两个数量级：
   * Prisma 交互式事务 **5 秒**，nodemailer **连接 2 分钟 / 问候 30 秒 / socket 空闲 10 分钟**。
   * 于是一台慢但正常的 SMTP 就能让一次**成功**的投递在 5 秒处被事务超时打断 ⇒ 回滚 ⇒
   * 事件回到待处理集合 ⇒ 下一轮重发。配合 `MAX_DELIVERY_ATTEMPTS = 5`，收件人最多收到
   * **5 封重复通知**，而数据库最后把这行标成 `abandoned_at`（「没发出去」）。
   *
   * ## 这两条用例怎么把它们的关系钉住
   *
   * 时间数字被**同比例缩小**（真实数字是分钟级，用例不能真等）：投递 250ms、
   * 事务超时 750ms（3 倍余量，与生产默认的 2.4 倍同向）。两条用例的**投递完全相同**，
   * 只有事务超时不同：
   * - 有足够余量（第 1 条）⇒ 事件被标记为已处理，**恰好投递一次**；
   * - 事务超时被压到 100ms（第 2 条）⇒ 事务先超时、投递照样发生 ⇒ **投递两次**。
   *
   * 第 2 条是这一对里承重的那条：它证明第 1 条**不是因为巧合才绿**——
   * 把「事务超时 > 投递耗时」这条关系调反，重复就会立刻出现（探针 `fix2-timeout-inverted`）。
   */
  describe('Fix 2：事务超时与邮件超时的关系（慢投递不得产生重复）', () => {
    /** 一次「慢」投递的耗时。真实 SMTP 的慢是秒/分钟级，这里同比例缩小。 */
    const SLOW_DELIVERY_MS = 250;
    /** 有余量的事务超时（投递耗时的 3 倍）。 */
    const HEADROOM_TIMEOUT_MS = 750;
    /** 被压到**低于**投递耗时的事务超时：模拟「5 秒事务 / 2 分钟 SMTP」那对默认值。 */
    const INVERTED_TIMEOUT_MS = 100;

    /** 投递耗时可控的假适配器（`slowMs` 传 0 时就是普通投递）。 */
    function slowMailer(subjects: string[], slowMs: number) {
      return {
        send: async (m: { subject: string }): Promise<void> => {
          await new Promise((r) => setTimeout(r, slowMs));
          subjects.push(m.subject);
        },
      };
    }

    it('投递比「5 秒默认事务」慢得多，但在事务超时之内：只投一次，且被标记为已处理', async () => {
      const subjects: string[] = [];
      const consumer = new OutboxConsumer(prisma, slowMailer(subjects, SLOW_DELIVERY_MS));
      await drain(consumer);
      /** 只统计本用例的投递：库里还有前面用例留下的**未处理**事件，`drain()` 会把它们也投掉。 */
      const mine = (): string[] => subjects.filter((s) => s.startsWith('subject-slow-ok'));

      await publishEmail('k-slow-ok', 'subject-slow-ok');

      expect(
        await consumer.runOnce({ transactionTimeoutMs: HEADROOM_TIMEOUT_MS }),
        '慢投递在事务超时之内完成，这一轮必须算作处理成功',
      ).toBe(1);

      const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-slow-ok' } });
      expect(row?.processedAt, '慢投递之后事件没有被标记为已处理：它还会被再投一次').not.toBeNull();
      expect(row?.abandonedAt, '一次成功的慢投递被标成了放弃').toBeNull();
      expect(row?.attempts, '一次成功的慢投递被记了不止一次尝试').toBe(1);
      expect(mine(), '慢投递一次都没发生（用例的前提不成立）').toEqual(['subject-slow-ok']);

      // 已处理 ⇒ 下一轮无活可干 ⇒ 不会有第二次投递（重复邮件的形态）
      expect(await consumer.runOnce({ transactionTimeoutMs: HEADROOM_TIMEOUT_MS })).toBe(0);
      expect(mine(), '事务与投递的关系写反了：一次成功的投递被回滚并重发').toEqual(['subject-slow-ok']);
    });

    it('**不覆盖**事务超时（即生产配置）时，慢投递同样只投一次', async () => {
      const subjects: string[] = [];
      const consumer = new OutboxConsumer(prisma, slowMailer(subjects, SLOW_DELIVERY_MS));
      await drain(consumer);
      const mine = (): string[] => subjects.filter((s) => s.startsWith('subject-slow-default'));

      await publishEmail('k-slow-default', 'subject-slow-default');

      // 这一条**不传** transactionTimeoutMs：走的就是 `common/timeouts.ts` 的默认值，
      // 也就是生产路径真正用的那个数（120000ms），在真库 + 真事务上跑通。
      expect(await consumer.runOnce()).toBe(1);

      const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-slow-default' } });
      expect(row?.processedAt, '默认事务超时下，慢投递没有完成').not.toBeNull();
      expect(row?.attempts, '默认事务超时下，慢投递被记了多次尝试').toBe(1);
      expect(mine(), '默认事务超时下出现了重复投递').toEqual(['subject-slow-default']);

      /**
       * **它能证明什么、不能证明什么（如实记录，别把它读强了）**。
       *
       * 能：默认路径（不传覆盖）在真库上是通的，且 250ms 的投递在里面**没有**被回滚重发。
       *
       * **不能**：它抓不住「默认值被调小」的变异。探针 `fix2-default-lost-defaults` 把默认
       * 从 120000 改成 **5000**（Prisma 的原始默认）后，本用例**照样全绿**——250ms 的投递
       * 在 5 秒里当然跑得完。要让它有判别力就得把投递拖到 5 秒以上，那会让每次跑测试都等
       * 那么久（不值得）。
       *
       * 因此「默认值必须比邮件最坏耗时大」这件事由**常量级**的单测承担
       * （`tests/unit/notify/delivery-timeouts.test.ts`：断言默认值 ≥ 2 × 邮件最坏耗时、
       * 且三项邮件超时都是秒级）。两条一起读才是完整的证据链：常量对（单测）+ 默认路径
       * 在真库上跑得通（本条）+ 关系调反就会重复（上一条）。
       */
    });

    it('把事务超时压到投递耗时之下：重复**必然**出现（证明上一条有判别力）', async () => {
      const subjects: string[] = [];
      const consumer = new OutboxConsumer(prisma, slowMailer(subjects, SLOW_DELIVERY_MS));
      await drain(consumer);
      const mine = (): string[] => subjects.filter((s) => s.startsWith('subject-slow-timeout'));

      await publishEmail('k-slow-timeout', 'subject-slow-timeout');

      // 第一轮：事务在 100ms 处超时，而投递在 250ms 处完成 —— 邮件出去了，事务没了
      expect(await consumer.runOnce({ transactionTimeoutMs: INVERTED_TIMEOUT_MS })).toBe(0);

      const afterFirst = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-slow-timeout' } });
      expect(afterFirst?.processedAt, '事务超时了，事件却已被标记为处理完成（前提不成立）').toBeNull();
      expect(mine(), '超时的那一次投递本身没有发生（前提不成立）').toEqual(['subject-slow-timeout']);

      // 第二轮：事件仍在待处理集合里 ⇒ 再投一次 ⇒ 收件人收到重复通知
      await consumer.runOnce({ transactionTimeoutMs: INVERTED_TIMEOUT_MS });

      expect(
        mine(),
        '超时没有造成重复：这说明本用例没有测到「事务超时 ⇒ 回滚 ⇒ 重发」这条路径',
      ).toEqual(['subject-slow-timeout', 'subject-slow-timeout']);
    });
  });

  /**
   * 修复轮 2 的 Minor：`last_error` 必须有长度上界。
   *
   * `TEXT` 是列**能装**多少，不是这个字段**该装**多少：Prisma 的校验错误会内嵌渲染后的
   * 查询文本，而 MTA 的拒绝消息可以回显一整段内容片段。这一列是运维要读的失败记录。
   */
  it('超长的错误文本在落库前被截断到上界（last_error 不是取证档案）', async () => {
    const long = new Error(`SMTP 拒绝：${'x'.repeat(4_000)}`);
    const consumer = new OutboxConsumer(prisma, {
      send: async (): Promise<void> => {
        throw long;
      },
    });
    await drain(consumer);

    await publishEmail('k-long-error', 'subject-long-error');
    expect(await consumer.runOnce({ maxAttempts: 3 })).toBe(0);

    const row = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-long-error' } });
    expect(row?.lastError, '超长错误没有被截断：整条查询文本都会留在这张表里').toHaveLength(
      MAX_LAST_ERROR_LENGTH,
    );
    expect(row?.lastError, '截断把可诊断的部分也吃掉了（开头应当保留）').toContain('SMTP 拒绝：');
  });

  /**
   * 修复轮 2 / Fix 4：失败回写自己坏掉时，`runOnce` 不得因此崩掉、更不得把一批事件整体丢掉。
   *
   * ## 这条用例钉住的一件事（以及为什么只要一件）
   *
   * **一批不会被一次坏回写整批丢掉**：事件 A 的失败回写抛错，同一批里的事件 B 必须照常走完
   * （投递成功 + 回写成功）。没有守护时，A 的回写异常会冲出 `runOnce`，B 连试都不会试
   * （探针 `t8-fix2-probe-fix4-no-guard` 实测：整条用例在 `runOnce` 里抛错而红）。
   *
   * 它同时如实记录**给不了的**保证：A 的 `processed_at` 仍是 NULL、`attempts` 仍是 0、
   * `last_error` 仍为空——回写失败意味着那条记录本来就写不进去。于是 A 会**一直留在待处理
   * 集合里、每轮再投一次**，`attempts` 到顶这条唯一的界对它**不生效**（判不出来）。
   * `attempts = 0` 且 `last_error` 为空正是这种「回写坏了」的现场特征。
   * 那是持久故障（修库才能解决），本阶段不造退避/死信（C16）。
   *
   * ## 为什么注入一个代理而不是用纯真库
   *
   * 要造出「**回写**这一条 UPDATE 失败、投递那条成功」的状态，在真库上得撤表权限之类的
   * 破坏性操作（会污染同一个 container 里其它用例）。被测对象是**循环的控制流**，不是数据库
   * 语义，因此这里只替换事务客户端的 `outboxEvent.update` 视图，其余（`findMany`、投递事务、
   * 事件 B 的回写）全部走真库——断言也就打在**真库的行**上。
   */
  it('失败回写本身抛错时：这一批不被整体丢掉，且同一批里后续事件照常完成（Fix 4）', async () => {
    const deliveredSubjects: string[] = [];

    /**
     * 让**目标事件 A** 的 `outboxEvent.update` 抛错（投递那条与回写那条都抛），其余一切不变：
     * A 的投递事务里的 update 抛错 ⇒ 整个投递事务回滚 ⇒ A 保持未处理（`deliver` 已经真的
     * 调用过适配器，所以「尝试过投递」这件事仍然发生过）；紧接着 `recordFailure` 的 UPDATE
     * 也抛错 ⇒ **这就是 Fix 4 的守护要接住的那一下**。事件 B 完全不受影响。
     *
     * 判据是**行的 id**（`args.where.id === A 的 id`），不是调用次序：批次里还有前面用例留下的
     * 未处理事件，次序无法保证（实测踩到过——计数版把错误抛在了别的行上，A 反而成功了）。
     *
     * 四个踩出来的细节：
     * - **不能只传 `{ $transaction }`**：`runOnce` 先要 `prisma.outboxEvent.findMany`，
     *   否则用例在 `Cannot read properties of undefined (reading 'findMany')` 处崩掉；
     * - **不能一律抛**：投递也在事务里，一律抛会让 `deliver` 一次都走不到，
     *   那测到的是「什么都坏掉」而不是「回写坏掉」；
     * - **不能给 `prisma.outboxEvent.update` 打补丁**：实测 `updateCalls === 0`——
     *   Prisma 在 `$transaction` 内部用的是**克隆过的** tx 客户端，补丁挂在原对象上，
     *   事务里那次调用根本不经过它。只能在回调拿到 `tx` 之后替换它的 `outboxEvent` 视图；
     * - **抛错必须发生在事务回调内部**：实测「等回调返回后再抛」时事务已经提交、
     *   行已经变成已处理，用例的第一条断言就失去意义。
     */
    const keys = ['k-write-broken-a', 'k-write-broken-b'] as const;
    const subjects = ['subject-write-broken-a', 'subject-write-broken-b'] as const;
    /** 事件 A 的行 id：代理用它来判定「该不该让这次 update 失败」；发布之后才取得到。 */
    let targetA: { id: string } | null = null;
    const realTransaction = prisma.$transaction.bind(prisma);
    const failingWriteBack = new Proxy(prisma, {
      get(real, key) {
        if (key === '$transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>, options?: unknown): Promise<unknown> =>
            realTransaction(
              // 断言用 `never`：`$transaction` 的参数类型是那串内部泛型，这里只需要
              // 「转发并替换其中一层视图」，不必复现它的全部形状。
              ((tx: unknown) => {
                const markedTx = new Proxy(tx as object, {
                  get(delegate, prop) {
                    const value = Reflect.get(delegate, prop) as unknown;
                    if (prop !== 'outboxEvent') return value;
                    return new Proxy(value as object, {
                      get(model, method) {
                        const call = Reflect.get(model, method) as unknown;
                        if (method !== 'update' || typeof call !== 'function') return call;
                        return async (args: { where?: { id?: string } }): Promise<unknown> => {
                          if (args?.where?.id === targetA?.id) {
                            throw new Error('模拟持续写库失败：这一行的锁超时 / P2028');
                          }
                          return (call as (a: unknown) => Promise<unknown>).call(model, args);
                        };
                      },
                    });
                  },
                });
                // 把打了标记的视图交给回调：消费者的闭包用的就是传进去的 `tx`
                return fn(markedTx);
              }) as never,
              options as never,
            );
        }
        const value = Reflect.get(real, key) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
      },
    }) as PrismaService;

    const consumer = new OutboxConsumer(failingWriteBack, {
      send: async (m: { subject: string }): Promise<void> => {
        deliveredSubjects.push(m.subject);
      },
    });

    /** 只统计本用例投递：批次里还有前面用例留下的未处理事件，它们也会（正常）被投递。 */
    const mine = (): string[] => deliveredSubjects.filter((s) => s.startsWith('subject-write-broken-'));

    try {
      await publishEmail(keys[0], subjects[0]);
      await publishEmail(keys[1], subjects[1]);
      // 目标行的 id 必须在发布之后取（`targetA` 是上面代理的判据，取值时它已经存在）
      targetA = await prisma.outboxEvent.findUnique({
        where: { idempotencyKey: keys[0] },
        select: { id: true },
      });

      await consumer.runOnce();

      /**
       * 承重断言：**两条**事件都被尝试投递过（`deliver` 真的调用了适配器）。
       *
       * 注意措辞：A 的投递事务**回滚了**，所以它没有「成功投递」，但它**被尝试过**。
       * 没有 Fix 4 的守护时，A 的失败回写异常会冲出 `runOnce`，B 连适配器都走不到
       * （探针 `t8-fix2-probe-fix4-no-guard` 实测：整条用例在 `runOnce` 里抛错）。
       */
      expect(
        mine(),
        '一条事件的失败回写把同一批里后面的事件整体丢掉了（异常冲出了 runOnce）',
      ).toEqual(['subject-write-broken-a', 'subject-write-broken-b']);

      const rows = await prisma.outboxEvent.findMany({ where: { idempotencyKey: { in: [...keys] } } });
      expect(rows, '两条事件都应当还在').toHaveLength(2);
      const rowA = rows.find((r) => r.idempotencyKey === keys[0]);
      const rowB = rows.find((r) => r.idempotencyKey === keys[1]);

      /**
       * 事件 A：适配器被调用过（上层已断言），但投递事务回滚了 ⇒ 行仍是未处理；
       * 失败回写也抛错并被守护吞下 ⇒ 回写完全没有落库。
       *
       * **这就是 Fix 4 给不了的保证**，如实钉在这里：`attempts` 没有增长，上限就永远判不出来，
       * 这条事件会**每一轮**再投一次（`last_error` 也是空的——那条记录本身就写不进去）。
       * `attempts = 0` 且 `last_error` 为空就是这种「回写坏了」的现场特征。
       */
      expect(rowA?.processedAt, '回写失败了，事件却进了终止态：回滚没有发生').toBeNull();
      expect(rowA?.attempts, '回写失败了，attempts 却变了').toBe(0);
      expect(rowA?.lastError, '回写失败了，last_error 却是空的——这条记录本身就写不进去').toBeNull();

      // 事件 B 与 A 在同一批里，回写正常 ⇒ 它是终止态的对照组：
      // 「守护只影响坏掉的那一条，不影响同一批里其它事件」。
      expect(rowB?.processedAt, '同一批里后续事件的回写也失败了：守护放行了不该放行的异常').not.toBeNull();
      expect(rowB?.attempts, '后续事件的 attempts 没有被记下').toBe(1);
      expect(rowB?.lastError, '成功路径必须清空 last_error').toBeNull();
    } finally {
      // 不留脏数据给后面的用例：A 会永远停在未处理状态，占批次名额
      await prisma.processedJob.deleteMany({ where: { idempotencyKey: { in: [...keys] } } });
      await prisma.outboxEvent.deleteMany({ where: { idempotencyKey: { in: [...keys] } } });
    }
  });
});
