import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Logger as NestLogger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { bootstrap, runBootstrap, type BootstrapLogger } from '@vca/api/bootstrap.js';

/**
 * 引导期的两件事（Ruling 3）。
 *
 * ## 1. 失败必须「可见且非零退出」，而不是静默成功
 *
 * Task 6 之前 `main.ts` 的最后一行是 `void bootstrap();`——没有 `.catch`。
 * 配置校验失败、端口被占、依赖连不上时，进程会打出一条**未经 pino 的**未处理拒绝，
 * 而 `process.exitCode` 仍是 0：容器编排、CI、`pnpm start && ...` 都会把它当成**成功**。
 * 本文件第一条用例把「错误经应用 logger 记录 + 退出码 1 + 原始错误对象未被吞」钉住，
 * 三条缺一不可（只记日志不改退出码 ⇒ 编排系统看不见；只改退出码不记日志 ⇒ 运维看不见）。
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
 */
describe('引导期（Ruling 3）', () => {
  const savedPort = process.env.PORT;
  const savedExitCode = process.exitCode;

  afterEach(() => {
    // K10/K6：进程级状态必须在 finally 之外也还原，断言失败不能把 PORT 与退出码留给后续用例。
    // （`process.exitCode` 被污染尤其危险：它会让整个 vitest 进程以非零码退出。）
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
  });

  it('引导失败：经应用 logger 记录**原始错误对象**，并以退出码 1 结束（不是静默成功）', async () => {
    const boom = new Error('端口被占用');
    const logged: Array<{ obj: unknown; msg: unknown }> = [];
    const logger: BootstrapLogger = {
      error: (obj: unknown, msg?: string) => {
        logged.push({ obj, msg });
      },
    };

    process.exitCode = 0;
    // 不传工厂就是真引导（会去连库并监听端口）；这里注入一个必然失败的工厂，
    // 让「失败路径」成为可重复的单元，而不是一次性的进程探针。
    await runBootstrap(() => Promise.reject(boom), logger);

    expect(logged, '引导失败没有写任何日志').toHaveLength(1);
    // **原始错误对象**（同一个引用）必须被带进日志：pino 的 `err` 序列化器会输出
    // name/message/stack。若实现写成 `String(error)` 或只记一句「引导失败」，
    // 栈就丢了——那正是「吞掉原始错误」的形态。
    expect((logged[0]?.obj as { err?: unknown } | undefined)?.err).toBe(boom);
    expect(String(logged[0]?.msg)).toContain('引导失败');
    expect(process.exitCode, '引导失败后退出码仍是 0：编排/CI 会把它当成功').toBe(1);
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
      expect(spy, 'Nest 框架 logger 没有接进 pino（app.useLogger 缺失？）').toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain('RULING-3-PROBE');
    } finally {
      await app.close();
    }
  });
});
