/**
 * worker **子进程**用例的共用装置（起进程 / 等输出 / 等退出）。
 *
 * ## 为什么抽出来（而不是各文件写一份）
 *
 * 这套 spawn + 轮询等待 + 有界退出的代码此前只存在于
 * `tests/integration/worker/process.test.ts`。P2 / Task 3 新增
 * `tests/integration/worker/runtime-role.test.ts` 后，同一段装置有了**第二个**消费者；
 * 计划评审把 Task 3 Step 1 标成「重写了一遍已有的 spawn/wait 助手」，这份文件就是那个
 * 结论的落点：**复制两份测试装置的下场与复制两份生产代码一样**——`process.test.ts` 里
 * 那几条用实测换来的注释（构建产物、超时即失败证据）只会留在其中一份里，另一份悄悄漂移。
 *
 * 抽取是**纯搬运**：`process.test.ts` 的断言与用例行为逐字未改，它的绿灯就是这次搬运的
 * 安全网（不需要新写测试来证明「搬运没有改变行为」，因为既有用例正是那个证明）。
 *
 * ## 生产入口是**构建产物**
 *
 * `apps/worker/dist/main.js` 就是 `pnpm --filter @vca/worker start` 跑的那个文件。
 * 源码入口在子进程里跑不起来（相对 import 是 `.js` 而实体是 `.ts`，只有 vitest 的解析
 * 管线能处理），因此每个用例文件在自己的 `beforeAll` 里跑一次 {@link buildWorker}——
 * 产物不可能与源码不同步。
 *
 * ## 环境：夹具 + 调用方指定的库
 *
 * `DATABASE_URL` 由调用方**显式**给出，本文件不设默认值。理由是用例想说的那句话不同：
 * `process.test.ts` 要一个**连不上**的库（消费必然失败，是它要观测的行为），
 * `runtime-role.test.ts` 要一个**真的**库（角色权限是 PostgreSQL 的语义，只有真库能回答）。
 * 给一个默认值会让其中一个用例变成「碰巧指到了对的库」。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { testEnv } from './env.js';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
export const WORKER_ENTRY = path.resolve(REPO_ROOT, 'apps/worker/dist/main.js');
export const WORKER_DIR = path.dirname(WORKER_ENTRY);

/** 启动标记（`runWorker` 的第一行日志）。 */
export const WORKER_STARTED = /outbox 消费者已启动/;

export interface WorkerRun {
  child: ChildProcess;
  /** 到目前为止累积的 stdout + stderr（断言用；失败时贴末段做诊断）。 */
  output: () => string;
}

/**
 * 构建 worker（同时构建它依赖的 `@vca/api`——后者是它运行期解析 `@vca/api/*` 的前提，
 * 见 `apps/api/package.json` 的 `node` 条件指向 `dist/*`）。
 */
export function buildWorker(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const build = spawn('pnpm', ['--filter', '@vca/worker', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      // Windows 上 `pnpm` 是 `.cmd`，不套 shell 会 ENOENT（与仓库其他子进程调用一致）。
      shell: process.platform === 'win32',
    });
    build.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`worker 构建失败，退出码 ${String(code)}`)),
    );
    build.once('error', reject);
  });
}

/**
 * 起一个 worker 子进程，`DATABASE_URL` 指向 `databaseUrl`。
 *
 * `stdio` 手写三项：`'ignore'` 掉 stdin（无人喂它，也不该继承父进程的），两个输出流都
 * 捕获成字符串——用例的断言就建立在这段累积输出上。
 */
export function startWorker(databaseUrl: string): WorkerRun {
  const child = spawn(process.execPath, [WORKER_ENTRY], {
    cwd: WORKER_DIR,
    env: { ...process.env, ...testEnv, DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += String(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    out += String(chunk);
  });
  return { child, output: () => out };
}

/** 轮询等待某段输出出现（子进程的日志是异步流，断言不能只看某一瞬）。 */
export async function waitForOutput(
  run: Pick<WorkerRun, 'output'>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pattern.test(run.output())) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 等子进程自己退出。
 *
 * 超时**本身就是失败证据**（「它没退出」正是缺陷形态），因此先 SIGKILL 收掉它，
 * 再让断言去读 `signal === 'SIGKILL'` 说话——而不是让整个用例挂到 vitest 超时上，
 * 那样失败信息里就没有输出末段可看（与 `tests/unit/bootstrap.test.ts` 的子进程用例同一形状）。
 */
export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, signal: 'SIGKILL' });
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
