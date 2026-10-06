import { describe, expect, it } from 'vitest';
import { runWorker, type WorkerTask } from '@vca/worker/worker.js';

/**
 * worker 的**周期任务**（P3 / Task 5；控制器裁定 ⑩ / D13）。
 *
 * ## 为什么用 `runWorker` 而不是一个真的 worker 进程
 *
 * 这一条问的是「可注入 tick 的 runner 到底会不会 tick、间隔尊不尊重、抛错会不会把循环带走」
 * ——那是**循环**的性质，与数据库无关。真进程那一条（`process.test.ts`）证明的是
 * 「启动行会出现」与「SIGTERM 会关停」，两者互补：这一条**不**起容器、**不**连库。
 *
 * ## 它守的三条（每条都对应一种「静默失效」）
 *
 * 1. **真的会 tick**（≥ 2 次）：少了它，一个「注册了但从不调用 `runOnce`」的实现照样绿
 *    ——而那种实现下**周期对账等于没有**（P2 的 D11 警告的正是「把同一个盲区跑得更勤」）。
 * 2. **间隔被尊重**：一个每轮都 tick 的实现会把「每分钟对账一次」变成「每秒一次」（空转打库）。
 *    判据用注入的 `log` 读**服务端事实上收到了什么毫秒数**，而不是数 tick 次数——
 *    因为 tick 次数由「跑到第几轮」这个外部决定，而「上一轮到现在够不够 `intervalMs`」
 *    是循环自己算的。
 * 3. **抛错不让循环退出，但必须记一行**：与「消费抛错不退出」同一条纪律（数据库抖动是暂时的，
 *    退出会把周期对账变成需要人工介入的故障）；而「记一行」是因为**一次静默失败的周期对账
 *    等于没有对账**。反空转：同一个用例里同一个任务的**成功**那一轮**不得**留下这一行。
 *
 * ## 空 `tasks` 时行为逐字不变
 *
 * 那一条的常驻见证是 `tests/unit/worker/loop.test.ts` 的既有四条（它们都不传 `tasks`），
 * 而本文件末尾另加一条**显式**的对照：`tasks` 省略时既不多 tick、也不改变消费节奏。
 */
describe('worker 的周期任务（Task 5 / D17）', () => {
  /**
   * 造一次运行：跑到 `rounds` 轮之后用 `controller.abort()` 收尾。
   *
   * `sleep` 是注入的，因此「跑到第几轮」由消费函数自己决定（返回 0 ⇒ 循环会 sleep ⇒
   * 注入的 sleep 里数数、数够了就 abort）。**不真的睡**，所以这些用例是毫秒级的。
   */
  async function runRounds(
    opts: {
      readonly rounds: number;
      readonly tasks?: readonly WorkerTask[];
      readonly runOnce?: () => Promise<number>;
      readonly pollMs?: number;
    },
  ): Promise<{ lines: string[]; handled: number }> {
    const controller = new AbortController();
    const lines: string[] = [];
    const slept: number[] = [];
    let handled = 0;
    await runWorker(
      {
        consumer: {
          runOnce: async () => {
            handled += 1;
            return opts.runOnce ? await opts.runOnce() : 0;
          },
        },
        ...(opts.tasks === undefined ? {} : { tasks: opts.tasks }),
        close: async () => undefined,
      },
      {
        signal: controller.signal,
        pollMs: opts.pollMs ?? 10,
        sleep: async (ms) => {
          slept.push(ms);
          if (slept.length >= opts.rounds) controller.abort();
        },
        exit: () => undefined,
        log: (line) => lines.push(line),
      },
    );
    return { lines, handled };
  }

  it('★ 注册的任务真的会被 tick（≥ 2 次），间隔到点之后**每一轮**都 tick', async () => {
    const ticks: string[] = [];
    const task: WorkerTask = {
      name: 'probe',
      intervalMs: 0, // 每一轮都该 tick
      runOnce: async () => {
        ticks.push('probe');
      },
    };

    const { handled } = await runRounds({ rounds: 3, tasks: [task] });

    expect(handled, '前置：消费真的跑了 3 轮（否则下面数的是别的东西）').toBe(3);
    expect(
      ticks.length,
      '注册的任务没有被 tick（或只 tick 了一次）——一个「注册了但从不调用 runOnce」的实现会让周期对账静默消失',
    ).toBeGreaterThanOrEqual(2);
    // `intervalMs: 0` ⇒ 每一轮都该 tick：这条把「只 tick 第一次」的实现也打红。
    expect(ticks.length, '`intervalMs: 0` 的任务必须在**每一轮**都 tick').toBe(3);
  });

  it('★ 间隔没到就不 tick（`intervalMs` 的判据：读**服务端事实**，不数 tick 次数）', async () => {
    // 一个每轮都 tick 的实现会让「每分钟对账一次」变成「每秒一次」——空转打库。
    // 判据取循环**真的传给了 `sleep` 的毫秒数**：它在第一轮 tick 之后必须改成
    // 「离 `intervalMs` 还差多少」，而不再是裸的 `pollMs`。
    const ticks: number[] = [];
    const task: WorkerTask = {
      name: 'ledger-reconcile',
      intervalMs: 60_000,
      runOnce: async () => {
        ticks.push(ticks.length);
      },
    };

    const { lines, handled } = await runRounds({ rounds: 3, tasks: [task], pollMs: 10 });

    expect(handled).toBe(3);
    expect(ticks.length, '第一轮必须 tick 一次（否则周期任务永远不会开始）').toBe(1);
    // ★ 核心判据：第 2 / 第 3 轮**不得**再 tick，而且循环必须为「还差多久」而睡。
    //   为什么不断言字面的 `60000ms`：那个数是「`intervalMs` − 刚刚过去的那几毫秒」，
    //   实测是 **59999**（两次读时钟之间真实时间必然走一点）——钉死它等于把「间隔被尊重」
    //   偷偷换成「某一次运行的调度抖动恰好为 0」。判据取「**接近** `intervalMs` 且
    //   **远大于** `pollMs`」：后者才是「一个每轮都 tick 的实现」会露出来的地方。
    const waits = [...lines.join('\n').matchAll(/等待周期任务：(\d+)ms/g)].map((m) => Number(m[1]));
    expect(waits.length, '循环没有为「距下次到期还差多少毫秒」而等待 ⇒ 它只是在按 pollMs 空转').toBeGreaterThan(0);
    for (const w of waits) {
      expect(w, `等待时长 ${w}ms 与 intervalMs（60000）不成比例 ⇒ 间隔没有被尊重`).toBeGreaterThan(59_000);
      expect(w, `等待时长 ${w}ms 超过了 intervalMs（60000）`).toBeLessThanOrEqual(60_000);
      expect(w, '等待时长与 pollMs 一样 ⇒ 循环忽略了 intervalMs').toBeGreaterThan(10 * 10);
    }
  });

  it('★ 任务抛错**不**让循环退出，但必须记一行（且成功的那一轮不留这一行）', async () => {
    // 与 `runWorker` 既有的「消费抛错不退出」逐字同源：数据库抖动是暂时的，退出会把
    // 「周期对账」变成需要人工介入的故障。而「记一行」是反静默：一次失败的周期对账
    // 若无痕迹，等于没有对账。
    let calls = 0;
    const task: WorkerTask = {
      name: 'ledger-reconcile',
      intervalMs: 0,
      runOnce: async () => {
        calls += 1;
        // 第 1 轮失败、第 2 轮成功 ⇒ 同一次运行里两个方向的见证都在
        // （「失败了会记一行」与「成功了不会记」）。
        if (calls === 1) throw new Error('账本对账失败:\n\n无法连接数据库');
      },
    };

    const { lines, handled } = await runRounds({ rounds: 3, tasks: [task] });

    expect(handled, '任务抛错把循环带走了（消费没有再跑）').toBe(3);
    expect(calls, '一次任务失败之后，后续轮次必须继续 tick').toBeGreaterThanOrEqual(2);
    const failureLines = lines.filter((l) => l.includes('周期任务'));
    expect(failureLines, '任务失败没有被记下来（运维看不到、也没人会对账）').toHaveLength(1);
    // 归属：那一行必须点名是**哪个**任务（多个周期任务时才能分辨）。
    expect(failureLines[0]).toContain('ledger-reconcile');
    // 失败消息自带换行（Prisma 的错误就是这样）⇒ 必须压成单行，否则一条失败变成多行输出。
    expect(failureLines.every((l) => !l.includes('\n')), '失败行里带换行：一条失败被拆成多行').toBe(true);
    // 反空转：成功的那两轮**不得**留下这一行（上面 `toHaveLength(1)` 已经钉住，
    // 这里再显式说一遍它数的不是空数组）。
    expect(calls, '前置：这个任务真的被 tick 了 3 次，其中 1 次失败').toBe(3);
  });

  it('★ 空 `tasks`（省略）时既不多 tick、也不改变消费节奏 —— 与改动前**逐字**相同的对照', async () => {
    // `tests/unit/worker/loop.test.ts` 的四条既有用例是这一条的常驻见证（它们不传 `tasks`）。
    // 这里把「省略」与「给一个空数组」两种写法**并排**量一次：两者的消费轮数、
    // 睡眠序列、以及产生的日志行必须完全一致——否则「省略 tasks 时行为不变」这句话
    // 就只是一句注释。
    const omitted = await runRounds({ rounds: 2, pollMs: 25 });
    const emptyArray = await runRounds({ rounds: 2, pollMs: 25, tasks: [] });

    expect(omitted.handled).toBe(2);
    expect(emptyArray.handled).toBe(2);
    expect(emptyArray.lines, '给了空 `tasks` 之后日志变了').toEqual(omitted.lines);
    // 反空转：这条对照必须建立在「真的跑了 2 轮」之上（否则两边都空、恒等）。
    expect(omitted.lines.length).toBeGreaterThan(0);
  });
});
