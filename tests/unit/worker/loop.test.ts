import { describe, it, expect, vi } from 'vitest';
import { runWorker, type WorkerDependencies } from '@vca/worker/worker.js';

/**
 * worker 的**进程内逻辑**：轮询、停机顺序、有界关停（Task 8 / C15）。
 *
 * ## 为什么逻辑不在 `main.ts` 里
 *
 * `main.ts` 是带副作用的入口（求值即建应用、即注册信号处理器），import 它就会真的去连库。
 * 因此循环与关停顺序住在 `worker.ts`，依赖全部可注入——这与 `apps/api` 的
 * `main.ts` / `bootstrap.ts` 拆分是同一条标准（Task 7 的 Ruling 3：失败路径必须是
 * **可重复的单元**，而不是一次性的进程探针）。
 *
 * ## 这些用例在守护什么（每一条都对应一种「静默失效」）
 *
 * 1. **空闲不热循环**：`runOnce()` 返回 0 时必须等一个间隔。少了这一步，worker 会以
 *    每秒上千次的频率空转打库；多了这一步（返回 >0 也睡）则积压排空变慢。
 * 2. **停机顺序**：先 `close()`（关连接池）再 `exit(0)`。反过来的话连接被直接晾掉，
 *    而「进程确实退出了」这条观测看不出差别。
 * 3. **关停有界**：`close()` 挂住时也必须退出——否则 ioredis/pg 这类活跃句柄会让
 *    编排系统看到「容器永远健康」（Task 7 修复轮 2 实测过的形态）。
 * 4. **失败可观测且不含凭据**（C11）：消费抛错时记一行、继续跑，且那一行里不出现完整邮箱。
 */
describe('worker 轮询循环（C15）', () => {
  /** 造一个最小依赖替身；`events` 记录顺序断言需要的事实。 */
  function makeApp(runOnce: () => Promise<number>, events: string[] = []): WorkerDependencies {
    return {
      consumer: { runOnce },
      close: async () => {
        events.push('close');
      },
    };
  }

  it('空闲时按配置的间隔轮询；收到停止信号后先关应用、再以码 0 退出', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const slept: number[] = [];
    let calls = 0;
    const events: string[] = [];
    const app = makeApp(async () => {
      calls++;
      if (calls === 2) controller.abort();
      return 0;
    }, events);

    await runWorker(app, {
      signal: controller.signal,
      pollMs: 250,
      sleep: async (ms) => {
        slept.push(ms);
        events.push('sleep');
      },
      exit: (code) => events.push(`exit:${code}`),
      log: (line) => lines.push(line),
    });

    expect(calls, '空闲时应持续轮询').toBe(2);
    expect(slept, '每次空闲都必须等一个轮询间隔（否则是热循环）').toEqual([250, 250]);
    expect(lines.some((l) => l.includes('已启动')), '缺少启动标记（进程级用例靠它判断已就绪）').toBe(true);
    expect(events.at(-2), '必须先关应用').toBe('close');
    expect(events.at(-1), '关停后必须以码 0 退出').toBe('exit:0');
  });

  it('有事件可处理时不等待，直接把积压排空', async () => {
    const controller = new AbortController();
    const slept: number[] = [];
    const results = [3, 2];
    const app = makeApp(async () => {
      const next = results.shift();
      if (next === undefined) {
        controller.abort();
        return 0;
      }
      return next;
    });

    await runWorker(app, {
      signal: controller.signal,
      pollMs: 100,
      sleep: async (ms) => {
        slept.push(ms);
      },
      exit: () => undefined,
      log: () => undefined,
    });

    expect(slept, '有活干的那两轮不该睡（睡了也只是拖慢排空）').toEqual([100]);
  });

  it('消费抛错时不退出：记一行、等一个间隔后继续，且那一行不含完整邮箱（C11）', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    let calls = 0;
    const app = makeApp(async () => {
      calls++;
      // 消息**带换行**：Prisma 的错误就是这样（实测 `Invalid \`prisma.…\` invocation:\n\n…`），
      // 因此下面那条「必须压成单行」的断言才有判别力
      if (calls === 1)
        throw new Error('Invalid `prisma.outboxEvent.findMany()` invocation:\n\nSMTP 拒绝收件人 user@example.com：550 unknown user');
      controller.abort();
      return 0;
    });

    await runWorker(app, {
      signal: controller.signal,
      sleep: async () => undefined,
      exit: () => undefined,
      log: (line) => lines.push(line),
    });

    const joined = lines.join('\n');
    expect(joined, '消费失败没有被记下来（运维看不到）').toContain('消费失败');
    expect(joined, '失败行里出现了完整邮箱地址（C11；SMTP 错误消息常带收件人）').not.toContain(
      'user@example.com',
    );
    expect(joined, '掩码形式应当仍然可读（域名保留）').toContain('u***@example.com');
    // Prisma/SMTP 的错误消息自带换行：不压成单行的话，「一条失败」会在 stderr 里变成好几行，
    // 行数与事件数的对应关系就断了（pino 那边是 newline-delimited JSON，这里是它的文本对应物）
    expect(
      lines.filter((l) => l.includes('消费失败')).every((l) => !l.includes('\n')),
      '失败行里带换行：一条失败被拆成了多行输出',
    ).toBe(true);
    expect(calls, '抛错后没有继续轮询').toBe(2);
  });

  it('应用关停挂住时也必须退出（有界关停，不能把进程永远挂住）', async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    controller.abort(); // 一开始就停：本用例只走关停路径
    const exit = vi.fn();

    await runWorker(
      { consumer: { runOnce: async () => 0 }, close: () => new Promise<void>(() => undefined) },
      {
        signal: controller.signal,
        shutdownTimeoutMs: 30,
        sleep: async () => undefined,
        exit,
        log: (line) => lines.push(line),
      },
    );

    expect(lines.join('\n'), '关停超时没有被记下来').toContain('关停超过');
    expect(exit, '关停挂住时没有退出：编排系统会把它当成健康容器').toHaveBeenCalledWith(0);
  });
});
