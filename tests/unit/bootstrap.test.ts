import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Logger as NestLogger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { bootstrap, runBootstrap, type BootstrapLogger } from '@vca/api/bootstrap.js';

/**
 * 引导期的三件事（Ruling 3；第三条是**修复轮 2** 补的）。
 *
 * ## 1. 失败必须「可见且非零退出」，而不是静默成功
 *
 * Task 6 之前 `main.ts` 的最后一行是 `void bootstrap();`——没有 `.catch`。
 * 配置校验失败、端口被占、依赖连不上时，进程会打出一条**未经 pino 的**未处理拒绝，
 * 而 `process.exitCode` 仍是 0：容器编排、CI、`pnpm start && ...` 都会把它当成**成功**。
 *
 * 第一条用例钉住「错误经应用 logger 记录（原始对象，不是 `String(e)`）+
 * 请求以码 1 退出 + 关停钩子跑过」。注意它**不能**用真 `process.exit`：那会杀掉
 * vitest 的 worker，「失败路径」就再也没法在单测里断言了。因此退出函数是注入的
 * （`runBootstrap({ exit })`），断言的是「确实请求了以 1 退出」。
 *
 * ## 2. Nest 的框架 logger 必须接进 pino（否则 `app.module.ts` 里那句话是假的）
 *
 * `app.module.ts` 声称「业务代码（含 Nest logger）在请求内打的日志全部带 traceId」。
 * 那句话在 Task 7 之前**不成立**：全仓没有任何地方调用 `app.useLogger`，
 * Nest 的 `ConsoleLogger` 直接写 stdout，压根不经过 pino——`PolicyGuard` 的
 * `logger.warn(...)`（默认拒绝那条告警）就是这种「有输出、但不结构化、也没有 traceId」的行。
 *
 * 第二条用例**跑真实引导**（`NestFactory.create` → `configureApp` → `listen(0)`，
 * 与 `main.ts` 同一条路径），因此它同时关掉一个否则会漏掉的洞：
 * 生产接线若哪天不再装安全中间件栈（`configureApp` 里删掉那一行），
 * 别的测试全都照绿——因为它们各自调 helper 装栈，而**没有**任何用例走生产这条路径。
 *
 * ## 3.（修复轮 2）失败路径必须**真的让进程结束**，而不是只设一个标志位
 *
 * 前两条都看不见这个缺陷：第一条注入的工厂 `() => Promise.reject(boom)` 从来
 * 没有建过应用，因此**没有任何活跃句柄**；第二条走的是成功路径。而真实的主失效模式是
 * **端口被占**：`NestFactory.create` 成功了（`RedisModule` 的 `new Redis(url)` 已经建连、
 * 持有活跃 socket），只有 `listen()` reject——旧实现写下 `process.exitCode = 1` 就返回，
 * 进程于是**永远活着**，编排系统看到的是一个健康容器。
 *
 * 第三条用例因此是**子进程 + 真端口占用 + 观测退出**：spawn 生产入口
 * （`apps/api/dist/main.js`，与 `pnpm start` 同一个文件），让它的 `listen()` 必然失败，
 * 然后只断言一件事——**它自己在限时内退出，且退出码非零**。
 * 只断言 `process.exitCode` 会把这个盲点原样复制一遍，因此这里一个字都不提那个标志。
 */

/**
 * 生产入口（`pnpm start` 跑的就是它）。
 *
 * 为什么是**构建产物**而不是源码入口：本用例要的正是生产那一条进程形态。
 * 源码入口在子进程里跑不起来——应用的相对 import 是 `.js` 后缀而实体是 `.ts`
 * （NodeNext 的要求），只有 vitest/vite 的解析管线能处理。构建由本文件的
 * `beforeAll` 现跑一次（约 4 秒），因此产物**不可能**与源码不同步。
 */
const ENTRY = path.resolve(import.meta.dirname, '../../apps/api/dist/main.js');
const APP_DIR = path.dirname(ENTRY);

/**
 * 子进程的时限。
 *
 * 真实观测（修复轮 2，见报告）：正常路径 ≤1.5 秒退出；旧实现在 15 秒后仍然活着。
 * 30 秒因此离两边都足够远——慢 CI 不会假红，而「没退出」也绝不会被等成「退出」。
 */
const CHILD_EXIT_TIMEOUT_MS = 30_000;

describe('引导期（Ruling 3）', () => {
  const savedPort = process.env.PORT;
  const savedExitCode = process.exitCode;

  afterEach(() => {
    // K10/K6：进程级状态必须在 finally 之外也还原，断言失败不能把 PORT 留给后续用例。
    // （`process.exitCode` 的保存/还原留着：真引导用例里 `enableShutdownHooks` 那类路径
    // 仍可能碰它，污染整个 vitest 进程的退出码。）
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
  });

  it('引导失败：经应用 logger 记录**原始错误对象**、请求以退出码 1 退出，并先关掉应用', async () => {
    const boom = new Error('端口被占用');
    const logged: Array<{ obj: unknown; msg: unknown }> = [];
    const flushed: number[] = [];
    const logger: BootstrapLogger = {
      error: (obj: unknown, msg?: string) => {
        logged.push({ obj, msg });
      },
      flush: () => {
        flushed.push(1);
      },
    };

    // 一个**真的建起来了**的应用替身：真实的主失效模式里 `listen()` 失败发生在应用
    // 建好**之后**（`RedisModule` 的 `new Redis(url)` 早就建了连），因此
    // 「有没有把已经建好的应用关掉」正是修复的一半。
    //
    // 顺序断言是刻意的：`close()` 必须在 `exit()` **之前**——反过来的话连接会被直接
    // 晾掉，而「进程确实退出了」这条观测看不出这个差别（子进程用例也看不出）。
    const order: string[] = [];
    const app = {
      // `configureApp` 的接线：`app.get(PinoLogger)` → `useLogger` → 安全栈的两次
      // `app.use()`（nonce+helmet、cookie-parser）→ `set('trust proxy')` →
      // `enableShutdownHooks`。这里全部记账，这样「接线在 listen 之前」这件事也被钉住
      // （反了的话 `useLogger` 就来不及接住 `init()` 冲出来的缓冲日志，
      // 见 `configureApp` 里更正后的那条说明）。
      get: () => ({ log: () => undefined }),
      useLogger: () => order.push('useLogger'),
      use: () => order.push('use'),
      set: () => order.push('set'),
      enableShutdownHooks: () => order.push('enableShutdownHooks'),
      listen: () => {
        order.push('listen');
        return Promise.reject(boom);
      },
      close: () => {
        order.push('close');
        return Promise.resolve();
      },
    };
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
    });

    await runBootstrap({
      createApp: () => Promise.resolve(app as never),
      logger,
      exit,
    });

    expect(order, '失败路径的顺序必须是 接线 → listen → close → exit').toEqual([
      'useLogger',
      // 安全栈的两条中间件：nonce+helmet 与 cookie-parser。
      'use',
      'use',
      'set',
      'enableShutdownHooks',
      'listen',
      'close',
      'exit:1',
    ]);
    expect(logged, '引导失败没有写任何日志').toHaveLength(1);
    // **原始错误对象**（同一个引用）必须被带进日志：pino 的 `err` 序列化器会输出
    // name/message/stack。若实现写成 `String(error)` 或只记一句「引导失败」，
    // 栈就丢了——那正是「吞掉原始错误」的形态。
    expect((logged[0]?.obj as { err?: unknown } | undefined)?.err).toBe(boom);
    expect(String(logged[0]?.msg)).toContain('引导失败');
    // 退出前必须刷日志：`exit()` 不等未完成的写入（修复轮 2）。
    expect(flushed.length, '退出前没有刷日志：那一行可能只留在缓冲区里').toBeGreaterThan(0);
    expect(exit, '引导失败后没有请求以非零码退出：编排/CI 会把它当成功').toHaveBeenCalledWith(1);
  });

  it('关停挂住时也必须退出（关停超时有界，不能把失败引导变回「永远活着」）', async () => {
    const logged: string[] = [];
    const logger: BootstrapLogger = {
      error: (_obj: unknown, msg?: string) => {
        logged.push(String(msg));
      },
      flush: () => undefined,
    };
    const exit = vi.fn();
    const neverClosing = {
      get: () => ({ assigned: true }),
      useLogger: () => undefined,
      use: () => undefined,
      set: () => undefined,
      enableShutdownHooks: () => undefined,
      listen: () => Promise.reject(new Error('端口被占用')),
      // 一个**永远不 resolve** 的 `close()`：正是「关停流程自己挂住」的形态。
      close: () => new Promise(() => undefined),
    };

    await runBootstrap({
      createApp: () => Promise.resolve(neverClosing as never),
      logger,
      exit,
      shutdownTimeoutMs: 50,
    });

    expect(logged.some((m) => m.includes('关停超过')), `关停超时没有被记下来：${logged.join(' | ')}`).toBe(true);
    expect(exit, '关停挂住时没有退出：这正是修复要消灭的「永远活着」').toHaveBeenCalledWith(1);
  });

  it('真实引导路径：安全头到位、trust proxy 就位、Nest 框架 logger 接进 pino', async () => {
    process.env.PORT = '0'; // 随机端口：不占用固定端口，也不与开发者本机的服务抢
    const app = await bootstrap();
    try {
      const url = await app.getUrl();
      const res = await request(url).get('/health');
      expect(res.status).toBe(200);
      // `configureApp` 必须装上安全栈：这条断言是「生产引导路径」上唯一的守护者。
      expect(res.headers['content-security-policy']).toContain("'nonce-");
      expect(res.headers['x-content-type-options']).toBe('nosniff');

      // `trust proxy = 1`：Nginx 反代后 `req.ip` 才是**真实客户端 IP**。
      // 不设它时 express 会把 Nginx 的地址当客户端——所有用户共用一个限流桶
      // （登录 5 次/15 分钟会变成全站共享，属自伤级故障），因此这里直接断言接线。
      const express = app.getHttpAdapter().getInstance() as { get(setting: string): unknown };
      expect(express.get('trust proxy')).toBe(1);

      // Nest 的**静态** logger（框架自己用的那条路径）必须把消息交给 nestjs-pino 的 Logger。
      // 少了 `app.useLogger` 时，消息会走 ConsoleLogger 直接写 stdout——下面的 spy 就不会被调用，
      // 而 stdout 上会多出一行（本用例因此同时是「输出 pristine」的守护者）。
      const pino = app.get(PinoLogger);
      const spy = vi.spyOn(pino, 'log').mockImplementation(() => undefined);
      new NestLogger('BootstrapProbe').log('RULING-3-PROBE');
      expect(spy, 'Nest framework logger 没有接进 pino（app.useLogger 缺失？）').toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain('RULING-3-PROBE');
    } finally {
      await app.close();
    }
  });
});

/**
 * 修复轮 2 / Fix 1：**端口被占时，进程真的会自己结束吗？**
 *
 * 这是本文件里唯一一条**观测进程终止**的用例，因为前面两条原理上就看不见这个缺陷：
 * 注入的工厂从不建应用（没有活跃句柄可挂），真实引导用例走的是成功路径。
 *
 * 形态刻意与生产一致：
 * 1. spawn `apps/api/dist/main.js`（`pnpm start` 的同一个文件）；
 * 2. 端口先被**本进程**占住，且占用面与 Node 默认的 `http.listen(port)` 一致；
 * 3. 只断言「子进程在限时内自己退出，且退出码非零」。
 *
 * ## 为什么占用面必须是 `::` 而不是 `0.0.0.0`（实测踩到过）
 *
 * `app.listen(port)` 不带 host ⇒ Node 绑 `::`（IPv6 any，且 `ipv6Only=false`）。
 * 父进程若只占 `0.0.0.0:port`，实测子进程**照样 listen 成功**
 * （`http.listening=true address={"address":"::","port":…}`）——于是用例会安静地
 * 测到成功路径上，变成一条恒真断言。占 `::` 才真正制造 EADDRINUSE
 * （实测 `code=EADDRINUSE message=listen EADDRINUSE: address already in use :::PORT`）。
 *
 * ## 为什么子进程的 `REDIS_URL` 指向一个**死端口**
 *
 * 这不是多余设置，而是复现缺陷的**必要条件**：ioredis 在构造时就建连并保持活跃 socket，
 * `db/redis.module.ts` 的文件头注释记载的正是「Node 的事件循环只要还有活跃句柄就不会
 * 自己退出」。指向一个连不上的端口时，重连定时器会一直把事件循环撑住——
 * 旧实现（只设 `process.exitCode = 1`）因此**永远不退出**，实测 15 秒后仍活着、只能 SIGKILL。
 * 若指向一个活的 Redis，socket 同样是活跃句柄，行为一致。
 */
describe('引导失败必须真的终止进程（修复轮 2 / Fix 1）', () => {
  beforeAll(async () => {
    // 生产入口是构建产物；这里现跑一次构建，产物因此不可能与源码不同步。
    // （比在源码树里再维护一份「给子进程用的 .mjs 入口」更安全：那会是第二份引导，
    // 正是 Ruling 4 禁止的形状。）
    await new Promise<void>((resolve, reject) => {
      const build = spawn('pnpm', ['--filter', '@vca/api', 'build'], {
        cwd: path.resolve(APP_DIR, '../..'),
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      build.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`构建失败，退出码 ${code}`))));
      build.once('error', reject);
    });
  }, 180_000);

  it('端口被占时，子进程自己在限时内以非零码退出（不是只设一个标志位）', async () => {
    // 占用面与 Node 的默认 `http.listen(port)` 一致（见本 describe 的注释）。
    const holder = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(0, '::', () => resolve());
      });
      const { port } = holder.address() as { port: number };

      const child = spawn(process.execPath, [ENTRY], {
        cwd: APP_DIR,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          // 死端口：让 ioredis 的重连定时器成为「把事件循环撑住」的那个句柄（见上）。
          REDIS_URL: 'redis://127.0.0.1:6399',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += String(chunk);
      });

      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const timer = setTimeout(() => {
          // 超时本身就是失败证据（旧实现的形态），先收掉子进程再让断言说话。
          child.kill('SIGKILL');
          resolve({ code: null, signal: 'SIGKILL' });
        }, CHILD_EXIT_TIMEOUT_MS);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });

      expect(
        outcome.signal,
        `子进程在 ${CHILD_EXIT_TIMEOUT_MS}ms 内没有退出（被父进程 SIGKILL）：` +
          '引导失败后进程仍然活着——编排系统会把它当成健康容器。stderr 末段：' +
          stderr.slice(-600),
      ).toBeNull();
      expect(outcome.code, `子进程退出码必须是 1（非零），实际 ${String(outcome.code)}`).toBe(1);
    } finally {
      holder.close();
    }
  }, 120_000);
});

afterAll(() => {
  // 本文件故意不留下任何句柄：占位 server 在用例的 finally 里关，
  // 子进程要么自己退出、要么被 SIGKILL。这条 afterAll 只是把「没有别的清理」写明。
});
