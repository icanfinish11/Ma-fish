import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Logger as NestLogger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { bootstrap, runBootstrap, type BootstrapLogger } from '@vca/api/bootstrap.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { RuntimeDbRoleError } from '@vca/api/db/runtime-role.js';

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

/**
 * 一条**合格**的运行期角色行（C-2）。多个假应用都要用它：
 * 引导期现在会先跑角色检查，返回不合格的行会让引导在那里就断掉，
 * 于是那些「本该走到 listen 再失败」的用例会以另一种理由变红。
 */
const HEALTHY_ROLE_ROW = {
  role: 'app_user',
  role_is_superuser: false,
  role_bypasses_rls: false,
  audit_table_missing: false,
  can_update_audit: false,
  can_delete_audit: false,
  audit_table_owner: 'vca_owner',
} as const;

describe('引导期（Ruling 3）', () => {
  const savedPort = process.env.PORT;
  const savedTrustProxy = process.env.TRUST_PROXY;
  const savedExitCode = process.exitCode;

  afterEach(() => {
    // K10/K6：进程级状态必须在 finally 之外也还原，断言失败不能把 PORT 留给后续用例。
    // （`process.exitCode` 的保存/还原留着：真引导用例里 `enableShutdownHooks` 那类路径
    // 仍可能碰它，污染整个 vitest 进程的退出码。）
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    // `TRUST_PROXY` 同理：它是**引导期直读**的变量，用例改过就必须还原，
    // 否则同一个 worker 里后续的真实引导会拿到别的取值。
    if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTrustProxy;
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
      //
      // **`get(PrismaService)` 必须回一个健康的角色行**（C-2 起）：引导期会先跑运行期
      // 角色检查，回一个不合格的行会让引导**在这里**就断掉——那时本用例测的就不再是
      // 「listen 失败」这条路径了（实测踩到过：`listen` 一次都没被调用，断言直接红）。
      get: (token: unknown) =>
        token === PrismaService ? { $queryRaw: async () => [HEALTHY_ROLE_ROW] } : { log: () => undefined },
      useLogger: () => order.push('useLogger'),
      use: () => order.push('use'),
      set: () => order.push('set'),
      enableShutdownHooks: () => order.push('enableShutdownHooks'),
      listen: () => {
        order.push('listen');
        // **`listen` 自己把接线补上**（修复轮 3 补）：这样「接线排在 listen 之后」的
        // 实现也会把 `useLogger` / `use` / `set` 记进 `order`，下面那两条 `lessThan`
        // 才有东西可比、才真的会红。否则（不记账的话）接线落在 `listen` 之后时
        // `indexOf('useLogger')` 是 -1，而 `-1 < indexOf('listen')` 恰好为真——
        // 一条**恒真**的顺序断言（本仓库已经抓到过这种形状）。
        // 真实机制见 `configureApp`：缓冲的启动日志是在 `listen() → init()` 里被
        // **当时那个 logger** 冲出去的，因此接线晚于 `listen` 就是「那批日志由
        // 默认 ConsoleLogger 写出去、绕过 pino」。
        order.push('useLogger', 'use', 'set', 'enableShutdownHooks');
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

    // **顺序**断言（修复轮 3 改正）：原来这里把整个数组**逐字**钉死（`use, use, set, …`），
    // 于是任何一次无关的中间件增删都会让这条用例变红——那是**过度指定**，
    // 而它并不比下面两条关系断言多证明什么。真正承重的关系只有两条：
    //   1. 接线（`useLogger` / 安全栈 / `set` / `enableShutdownHooks`）都在 `listen` **之前**
    //      ——反了的话 `useLogger` 接不住 `init()` 冲出来的缓冲启动日志（见 `configureApp`）；
    //   2. `close` 在 `exit` **之前** ——反过来的话连接会被直接晾掉，而「进程确实退出了」
    //      这条观测看不出这个差别（子进程用例也看不出）。
    const idx = (label: string): number => order.indexOf(label);
    expect(idx('listen'), 'listen 没有被调用').toBeGreaterThanOrEqual(0);
    expect(idx('useLogger'), 'useLogger 必须排在 listen 之前').toBeLessThan(idx('listen'));
    expect(idx('use'), '安全中间件栈必须排在 listen 之前').toBeLessThan(idx('listen'));
    expect(idx('set'), 'trust proxy 必须排在 listen 之前').toBeLessThan(idx('listen'));
    expect(idx('enableShutdownHooks'), '关停钩子必须排在 listen 之前').toBeLessThan(idx('listen'));
    expect(idx('close'), 'close 必须排在 exit 之前').toBeLessThan(idx('exit:1'));
    expect(order.at(-1), '失败路径的最后一步必须是 exit').toBe('exit:1');
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
      // 同前：角色检查要拿到一条合格的行，否则引导会在到达 `listen()` 之前就结束。
      get: (token: unknown) =>
        token === PrismaService ? { $queryRaw: async () => [HEALTHY_ROLE_ROW] } : { assigned: true },
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

  it('接线自己抛错时，已建好的应用同样被关掉（句柄在接线**之前**就交出去了）', async () => {
    // 修复轮 3 补的缺口：修复轮 2 把 `onReady` 放在 `listen()` 之前，但仍在 `configureApp`
    // **之后**。于是「接线抛错」这条路径上 `bootstrap()` 的返回值同样不会产生，
    // `closeQuietly` 拿到 `undefined` 直接返回——**`close()` 一次都没跑**，
    // 而 `RedisModule` 的 ioredis socket 早就建好了。它与修复轮 2 修掉的那个
    // 「`listen()` 失败时拿不到句柄」是同一个形状，只是触发点更早、更不容易被注意到。
    //
    // 这里让 `app.get()` 抛：`configureApp` 的第一步就是 `app.get(PinoLogger)`，
    // 因此这正是「接线自己抛错」的最小形态。`set` / `enableShutdownHooks` / `listen`
    // 一次都不该被调用（接线在第一行就断了），而 `close` 必须被调用。
    const order: string[] = [];
    const boom = new Error('接线失败：取不到 PinoLogger');
    const app = {
      get: () => {
        order.push('get');
        throw boom;
      },
      useLogger: () => order.push('useLogger'),
      use: () => order.push('use'),
      set: () => order.push('set'),
      enableShutdownHooks: () => order.push('enableShutdownHooks'),
      listen: () => {
        order.push('listen');
        return Promise.resolve();
      },
      close: () => {
        order.push('close');
        return Promise.resolve();
      },
    };
    const logged: Array<{ obj: unknown; msg: unknown }> = [];
    const logger: BootstrapLogger = {
      error: (obj: unknown, msg?: string) => {
        logged.push({ obj, msg });
      },
      flush: () => undefined,
    };
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
    });

    await runBootstrap({
      createApp: () => Promise.resolve(app as never),
      logger,
      exit,
    });

    expect(order, '接线抛错时应用没有被关掉：连接会被直接晾在那里').toContain('close');
    expect(order.indexOf('close'), 'close 必须发生在 exit 之前').toBeLessThan(order.indexOf('exit:1'));
    expect(order, '接线已经抛错，listen 不该被调用').not.toContain('listen');
    expect((logged[0]?.obj as { err?: unknown } | undefined)?.err, '原始错误对象没有被记下来').toBe(boom);
    expect(exit, '接线抛错后必须请求以码 1 退出').toHaveBeenCalledWith(1);
  });

  it('真实的接线失败（无法解析的 TRUST_PROXY）拒绝启动：不 listen、以码 1 退出', async () => {
    // I-6：可接受取值的校验发生在**启动期**。交给 express 的话，
    // `proxyaddr.compile(['prox'])` 在**每个请求**上抛 ⇒ 全站 500 而不是一次起不来。
    // 这里用假应用（不真监听端口），因为要观察的正是「还没走到 listen」。
    process.env.TRUST_PROXY = 'prox';
    const order: string[] = [];
    const app = {
      get: () => ({ log: () => undefined }),
      useLogger: () => order.push('useLogger'),
      use: () => order.push('use'),
      set: () => order.push('set'),
      enableShutdownHooks: () => order.push('enableShutdownHooks'),
      listen: () => {
        order.push('listen');
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const logged: Array<{ obj: unknown; msg: unknown }> = [];
    const logger: BootstrapLogger = {
      error: (obj: unknown, msg?: string) => {
        logged.push({ obj, msg });
      },
      flush: () => undefined,
    };
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
    });

    await runBootstrap({
      createApp: () => Promise.resolve(app as never),
      logger,
      exit,
    });

    expect(order, 'listen 被调用了：坏配置应当在监听之前就把引导打断').not.toContain('listen');
    expect(order, '连 set 都不该跑到：取值解析在 configureApp 之前').not.toContain('set');
    expect(exit, '坏配置没有让进程以非零码退出：编排会把它当成一次成功的启动').toHaveBeenCalledWith(1);
    const err = (logged[0]?.obj as { err?: Error } | undefined)?.err;
    expect(String(err?.message), '失败原因里没有点名 TRUST_PROXY').toContain('TRUST_PROXY');
  });

  it('TRUST_PROXY=false 时真实引导把「谁都不信」应用到 express（配置是活的，不是装饰）', async () => {
    // 与上一条同一个真实引导路径，只改一个环境变量。判据落在**编译后的判据函数**上：
    // 直连部署要求任何来源的 XFF 都不影响 `req.ip`（包括回环——那种部署里没有反代）。
    process.env.PORT = '0';
    process.env.TRUST_PROXY = 'false';
    const app = await bootstrap();
    try {
      const express = app.getHttpAdapter().getInstance() as { get(setting: string): unknown };
      expect(express.get('trust proxy')).toBe(false);
      const trustFn = express.get('trust proxy fn') as (addr: string, i: number) => boolean;
      expect(trustFn('127.0.0.1', 0), 'false 之下仍信任了某个来源：配置没有生效').toBe(false);
      expect(trustFn('203.0.113.7', 0), 'false 之下仍信任了远端来源').toBe(false);
    } finally {
      await app.close();
    }
  });

  /**
   * **运行期数据库角色检查的接线**（最终评审 C-2）。
   *
   * 检查逻辑本身在真库上取证（`tests/integration/db/runtime-role.test.ts`：app_user 通过、
   * vca_owner 被拒）。这里要证明的是**另一件事**：`bootstrap()` 真的会调用它，
   * 而且失败时**不会走到 `listen()`**——否则那个检查就是一段没人执行的代码
   * （「声明了但没在执行」正是本仓库反复抓到的形态）。
   *
   * 替身返回的是**违规行**而不是抛一个现成的错：这样跑的仍是真实的判定逻辑
   * （`role_is_superuser` / `can_update_audit` 那两条判据）。
   */
  it('运行期角色不合格（DATABASE_URL 指向属主）时拒绝启动：不 listen、关掉应用、以码 1 退出', async () => {
    const order: string[] = [];
    const app = {
      get: (token: unknown) =>
        token === PrismaService
          ? {
              $queryRaw: async (): Promise<unknown[]> => [
                {
                  role: 'vca_owner',
                  role_is_superuser: true,
                  role_bypasses_rls: false,
                  audit_table_missing: false,
                  can_update_audit: true,
                  can_delete_audit: true,
                  audit_table_owner: 'vca_owner',
                },
              ],
            }
          : { log: () => undefined, warn: () => undefined },
      useLogger: () => order.push('useLogger'),
      use: () => order.push('use'),
      set: () => order.push('set'),
      enableShutdownHooks: () => order.push('enableShutdownHooks'),
      listen: () => {
        order.push('listen');
        return Promise.resolve();
      },
      close: () => {
        order.push('close');
        return Promise.resolve();
      },
    };
    const logged: Array<{ obj: unknown; msg: unknown }> = [];
    const logger: BootstrapLogger = {
      error: (obj: unknown, msg?: string) => logged.push({ obj, msg }),
      flush: () => undefined,
    };
    const exit = vi.fn((code: number) => order.push(`exit:${code}`));

    await runBootstrap({ createApp: () => Promise.resolve(app as never), logger, exit });

    expect(order, '角色检查不过关却仍然监听了端口：失误的部署会正常服务请求').not.toContain('listen');
    expect(order, '应用已经建好（连接池已创建），却被晾在那里').toContain('close');
    expect(order.indexOf('close'), 'close 必须在 exit 之前').toBeLessThan(order.indexOf('exit:1'));
    expect(exit, '角色检查不过关后没有以非零码退出').toHaveBeenCalledWith(1);

    const err = (logged[0]?.obj as { err?: unknown } | undefined)?.err;
    expect(err, '抛出的不是 RuntimeDbRoleError：调用方无法把「配置错误」与「连接故障」区分开').toBeInstanceOf(
      RuntimeDbRoleError,
    );
    expect(String((err as Error).message), '失败信息里没有点名 DATABASE_URL').toContain('DATABASE_URL');
  });

  /**
   * 边界的**正向**一面：**连不上库时不拒绝启动**（最终评审 C-2 的裁定，写进用例防止被「顺手改成 fail-closed」）。
   *
   * 理由（见 `db/runtime-role.ts` 文件头）：本应用按设计允许「先起来、库稍后可用」，
   * 而引导期的既有用例（端口被占的子进程用例、真实引导用例）都跑在**没有数据库**的环境里。
   * 把「连不上」变成拒绝启动会改掉那条语义，也会让那些用例红。
   * 方向仍然是安全的：库连不上时应用什么也做不了；**一旦连上就一定会被检查**。
   */
  it('角色检查无法完成（连不上库）时不拒绝启动，但要留下一条 warn', async () => {
    const order: string[] = [];
    const warned: Array<{ fields: unknown; message: string }> = [];
    const app = {
      get: (token: unknown) =>
        token === PrismaService
          ? {
              $queryRaw: async (): Promise<unknown[]> => {
                throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
              },
            }
          : {
              log: () => undefined,
              warn: (fields: unknown, message: string) => warned.push({ fields, message }),
            },
      useLogger: () => undefined,
      use: () => undefined,
      set: () => undefined,
      enableShutdownHooks: () => undefined,
      listen: () => {
        order.push('listen');
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const logger: BootstrapLogger = { error: () => undefined, flush: () => undefined };

    await runBootstrap({ createApp: () => Promise.resolve(app as never), logger, exit: vi.fn() });

    expect(order, '连不上库时拒绝启动了：这条边界是刻意选的，见用例说明').toContain('listen');
    expect(warned, '「检查没能完成」这件事没有留下任何记录：降级是静默的').toHaveLength(1);
    expect(warned[0]?.message).toContain('未能完成');
    expect(warned[0]?.message).toContain('ECONNREFUSED');
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

      // `trust proxy`：**配置驱动**（I-6），不再是硬编码的 `1`。
      // 夹具里 `TRUST_PROXY=loopback`（最窄的一档：只信任同机反代），因此这里断言的就是
      // 它被真的应用到了 express 上——「默认值最窄」这件事只有在引导路径上验证过才算数。
      // 各档取值的解析由 `tests/security/trust-proxy.test.ts` 覆盖；相邻那条
      // 「TRUST_PROXY=false」的用例会在**同一条真实引导路径**上再跑一遍，证明它是活的配置。
      const express = app.getHttpAdapter().getInstance() as { get(setting: string): unknown };
      expect(express.get('trust proxy')).toEqual(['loopback']);

      // `trust proxy fn` 是 express 在 `set('trust proxy', v)` 时**编译出来的那个函数**，
      // 即 `req.ip` 真正的判据（`application.js` 的 setter 里 `compileTrust(val)`）。
      // 断言它而不是只断言设置值：设置对了但没被编译/生效的情况在这里会红。
      const trustFn = express.get('trust proxy fn') as (addr: string, i: number) => boolean;
      expect(typeof trustFn, 'express 没有把 trust proxy 编译成判据函数').toBe('function');
      expect(trustFn('127.0.0.1', 0), '同机反代（回环）没有被信任：XFF 会被忽略，限流桶被合并').toBe(true);
      expect(
        trustFn('203.0.113.7', 0),
        '远端客户端被信任了：它可以用 X-Forwarded-For 换一个限流桶（I-6 要消灭的形态）',
      ).toBe(false);

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
 * 3. 断言「子进程在限时内自己退出，且退出码非零」，**并且**（修复轮 3 补）
 *    它的输出证明这次失败**确实是**那个端口冲突。
 *
 * ## 为什么 `NODE_ENV` 是 `production`（修复轮 3 改正）
 *
 * 原来是 `test`。而 `buildLoggerOptions` 在 `NODE_ENV === 'test'` 时把 pino 的 level 设为
 * `'silent'` —— pino 会把六个日志方法整体换成 noop，于是退出路径的
 * `logger.error({ err })` **一个字节都不写**（实测子进程 stdout / stderr 都是 0 字节）。
 * 那样「断言失败确为端口冲突」就没有任何材料可用，失败时也留不下诊断。
 * 换成 `production` 后实测子进程写出 5411 字节 JSON，其中原样带着
 * `"err":{"code":"EADDRINUSE","syscall":"listen","address":"::","port":<port>}`。
 * 这不改变要观测的东西：失败点是 `listen()`，进程从未服务过请求，`isProduction`
 * 带出的 HSTS / secure cookie 没有机会生效；env 校验是**同一份** schema，不按环境分叉。
 *
 * ## 为什么占用面必须是 `::` 而不是 `0.0.0.0`（实测踩到过）
 *
 * `app.listen(port)` 不带 host ⇒ Node 绑 `::`（IPv6 any，且 `ipv6Only=false`）。
 * 父进程若只占 `0.0.0.0:port`，实测子进程**照样 listen 成功**
 * （`http.listening=true address={"address":"::","port":…}`）——于是用例会安静地
 * 测到成功路径上，变成一条恒真断言。占 `::` 才真正制造 EADDRINUSE
 * （实测 `code=EADDRINUSE message=listen EADDRINUSE: address already in use :::PORT`）。
 * 这条实测同时是**归属断言**能成立的前提：没有真的 EADDRINUSE，输出里那句就无从谈起。
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
          // **生产**（修复轮 3 改正，此前是 `test`）：`buildLoggerOptions` 在 `NODE_ENV === 'test'`
          // 时把 pino 的 level 设为 `'silent'`（六个方法整体换成 noop），于是退出路径
          // `logger.error({ err })` **一个字节都不写**——实测子进程 stdout/stderr 均为 0 字节。
          // 那样「断言失败确为端口冲突」根本无从谈起（这正是评审说的「诊断为空」）。
          // 换到 `production` 后同一条路径实测写出 5411 字节 JSON，其中
          // `"err":{"code":"EADDRINUSE","syscall":"listen","address":"::","port":<port>}`
          // 原样可读（探针：evidence/t7-fix3-child-output-probe.mjs 与 t7-fix3-child-output.txt）。
          //
          // 这不改变用例要观测的东西：失败点仍是 `listen()`，进程**从未服务过任何请求**，
          // 因此 `isProduction` 带出的 HSTS / secure cookie 没有任何机会生效；
          // env 校验这套 schema 在生产与测试下是**同一份**（env.schema.ts 不按环境分叉），
          // 而这里照样显式给出 `REDIS_URL`（指向死端口）。
          NODE_ENV: 'production',
          PORT: String(port),
          // 死端口：让 ioredis 的重连定时器成为「把事件循环撑住」的那个句柄（见上）。
          REDIS_URL: 'redis://127.0.0.1:6399',
        },
        // stdout 也接管（修复轮 3）：pino 写 fd 1，原来那句 `'ignore'` 把唯一的诊断丢掉了。
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += String(chunk);
      });
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
          '引导失败后进程仍然活着——编排系统会把它当成健康容器。stdout 末段：' +
          stdout.slice(-600) +
          ' / stderr 末段：' +
          stderr.slice(-600),
      ).toBeNull();
      expect(outcome.code, `子进程退出码必须是 1（非零），实际 ${String(outcome.code)}`).toBe(1);

      // **归属断言**（修复轮 3 新增）：上面那条 `code === 1` 只说明「它退出了」，
      // 任何一个别的启动期失败（env 校验不过、模块加载失败、Redis 抛错…）都能让它以 1 退出。
      // 既然这条用例的**前提**是「端口被占」，就必须证明失败**确实是那个端口冲突**，
      // 否则它可能在一条与 Fix 1 无关的失败路径上保持常绿。
      const evidence = `${stdout}\n${stderr}`;
      expect(
        evidence,
        `子进程的输出里没有 EADDRINUSE（端口被占的失败形态）：退出码 1 可能来自别的启动期失败。` +
          `stdout=${JSON.stringify(stdout.slice(0, 400))} stderr=${JSON.stringify(stderr.slice(0, 400))}`,
      ).toContain('EADDRINUSE');
      expect(evidence, `子进程报的端口冲突不是我们占住的那个（${port}）`).toContain(String(port));
      expect(evidence).toContain('应用引导失败');
    } finally {
      holder.close();
    }
  }, 120_000);
});

afterAll(() => {
  // 本文件故意不留下任何句柄：占位 server 在用例的 finally 里关，
  // 子进程要么自己退出、要么被 SIGKILL。这条 afterAll 只是把「没有别的清理」写明。
});
