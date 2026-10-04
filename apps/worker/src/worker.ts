import { scrubEmails } from '@vca/api/common/logging/redact.js';

/**
 * worker 的**进程内逻辑**：轮询、停机顺序、有界关停。
 *
 * ## 为什么它不在 `main.ts` 里
 *
 * `main.ts` 是带副作用的入口——求值即建应用、即注册信号处理器，import 它就会真的去连库。
 * 把循环与关停顺序放进本文件、依赖全部可注入之后，失败路径变成**可重复的单元**
 * （`tests/unit/worker/loop.test.ts`），而不是一次性进程探针。这与 `apps/api` 的
 * `main.ts` / `bootstrap.ts` 拆分是同一条标准（Task 7 的 Ruling 3）。
 *
 * ## 依赖形状为什么是 `{ consumer, close }` 而不是整个 Nest 应用
 *
 * 循环只用得到两件东西。传整个应用上下文会带来两处代价：类型上要和
 * `NestApplicationContext.get` 的重载签名对齐，可测性上单测必须造一个假装有 DI 容器的对象。
 * 少传一点，「本进程到底依赖什么」也就在签名里看得见。
 */

/** 空闲时的轮询间隔。1 秒是 P0 的粒度：通知够快，空转打库的频率也可忽略。 */
export const DEFAULT_POLL_MS = 1_000;

/**
 * 关停等待上限。
 *
 * 为什么必须有上限（Task 7 修复轮 2 的实测教训）：停机路径上任何一处挂住——连接池收尾、
 * 某个模块的关停钩子——都会让进程**永远活着**，而编排系统看到的是一个健康容器。
 * 超过上限就记一行然后退出；把「一次失败的关停」变得可见，比让它静默僵住好。
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** 单批处理条数（与 `OutboxConsumer.runOnce` 的默认值一致，显式写出以固定契约）。 */
const BATCH_SIZE = 50;

/** 循环真正用到的那一面（结构化类型：单测不必造一个真 Nest 应用）。 */
export interface WorkerDependencies {
  consumer: { runOnce(options?: { batchSize?: number }): Promise<number> };
  close(): Promise<void>;
}

export interface RunWorkerOptions {
  /**
   * 停机信号。收到（`aborted`）后：不再开始新一轮，关掉依赖，然后 `exit(0)`。
   *
   * 用标准的 `AbortSignal` 而不是自定义的 `stop()` 回调：它是平台原语，
   * 单测可以 `new AbortController().abort()` 直接驱动，没有为本项目发明的概念。
   */
  signal?: AbortSignal;
  pollMs?: number;
  shutdownTimeoutMs?: number;
  /** 等待函数（可注入以便单测不真的睡）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 进程退出函数（可注入：单测里真调 `process.exit` 会杀掉 vitest 的 worker）。 */
  exit?: (code: number) => void;
  /** 日志出口。默认 stderr：worker 的正常输出里不该混进「消费失败」这类运维信息。 */
  log?: (line: string) => void;
}

/**
 * 把一段文本压成**单行**。
 *
 * 为什么必须有这一步（实测）：Prisma 的错误消息自带换行
 * （`Invalid \`prisma.outboxEvent.findMany()\` invocation:\n\nCan't reach database server …`），
 * 直接写进 stderr 会让「一条失败」变成五行输出，把行数与事件数的一一对应关系破坏掉
 * （本仓库的日志约定是每条记录一行，pino 那边是 newline-delimited JSON）。
 *
 * 邮箱脱敏走 `scrubEmails`（`common/logging/redact.ts`，**与消费者写 `last_error` 的那一份是同一段代码**）：
 * 这里曾经是本文件的私有实现，修复轮 1 / Fix 2 把它搬到了共享位置——任务要求
 * 「复用你已有的 scrubber，而不是写第二个」，理由就是两份实现必然会漂移。
 */
function oneLine(text: string): string {
  return scrubEmails(text).replace(/\s+/g, ' ').trim();
}

/** 一行可诊断、且不含凭据的失败摘要（C11；与 Task 6 会话中间件的标准一致）。 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return oneLine(String(err)).slice(0, 300);
  const code = (err as { code?: unknown }).code;
  const suffix = typeof code === 'string' && code !== '' ? `(${code})` : '';
  return `${err.name}${suffix}: ${oneLine(err.message).slice(0, 300)}`;
}

/**
 * 可中断的等待。
 *
 * 两个细节都是实测得来的：
 * 1. **停机信号到达时要立刻醒**：否则关停最多白等一个轮询间隔；
 * 2. **监听器必须摘掉**：每轮挂一个 `abort` 监听器而不摘，十轮之后 Node 就会打印
 *    `MaxListenersExceededWarning`——本仓库要求测试输出 pristine，这条噪声会直接违规。
 */
function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * 有界关停：先关依赖（连接池、Nest 的关停钩子），再让调用方退出。
 *
 * 三种情况都不改变方向（吞掉异常、超时也继续），并把后两种各记一行——它们是
 * **独立于停机请求**的另一个事实，混在一起会让运维少看到一件事。
 */
async function closeBounded(
  deps: WorkerDependencies,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const outcome = await Promise.race([deps.close().then(() => 'closed' as const), timedOut]);
    if (outcome === 'timeout') log(`[worker] 关停超过 ${timeoutMs}ms，不再等待，直接退出`);
  } catch (err) {
    log(`[worker] 关停失败（进程仍会以码 0 退出）：${describeError(err)}`);
  } finally {
    // 不清掉的话这个定时器会在退出路径上多活 `timeoutMs` 毫秒
    if (timer) clearTimeout(timer);
  }
}

/**
 * 轮询循环：消费一批 → 有活就继续、没活就等一个间隔 → 收到停机信号则关停退出。
 *
 * 失败语义（两条都是刻意的）：
 * - **消费抛错不退出**：数据库/SMTP 抖动是暂时的，退出会把「异步投递」变成需要人工介入的
 *   故障；但必须等一个间隔再试，否则失败会变成每秒上千次的空转（热循环）。
 * - **关停后仍然 `exit(0)`**：即使 `close()` 挂住或抛错（见 {@link closeBounded}）。
 *   不调用 `exit` 的话，进程能否结束就取决于事件循环里还剩什么句柄——
 *   正是 Task 7 实测过的「容器看起来永远健康」那个形态。
 */
export async function runWorker(
  deps: WorkerDependencies,
  options: RunWorkerOptions = {},
): Promise<void> {
  const {
    signal,
    pollMs = DEFAULT_POLL_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    sleep = sleepMs,
    exit = process.exit,
    log = (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  } = options;

  log(`[worker] outbox 消费者已启动（每 ${pollMs}ms 轮询一次，单批 ${BATCH_SIZE} 条）`);

  while (!signal?.aborted) {
    let handled: number;
    try {
      handled = await deps.consumer.runOnce({ batchSize: BATCH_SIZE });
    } catch (err) {
      log(`[worker] 消费失败，${pollMs}ms 后重试：${describeError(err)}`);
      await sleep(pollMs, signal);
      continue;
    }
    // 有活干就立刻再来一轮（把积压排空），没活才等
    if (handled === 0) await sleep(pollMs, signal);
  }

  await closeBounded(deps, shutdownTimeoutMs, log);
  exit(0);
}
