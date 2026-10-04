import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { currentContext } from '../context/request-context.js';

/**
 * 测试期静音（Ruling 3）。
 *
 * 本模块一旦接进 `AppModule`，**每个**会引导应用的测试都会走 pino：单测的
 * `createTestApp()` 与集成套件的每个 HTTP 请求都会打印请求行。这些行不是失败信息，
 * 却会把真正的失败挤出视野，也让「输出全绿」这种一眼判据失效。
 *
 * 所以 `NODE_ENV === 'test'` 时把 level 设成 `'silent'`（pino 的合法 level，
 * 使日志在**进入**任何 destination 之前就被丢弃），其余环境保持 pino 默认的 `info`。
 * 该判断在模块求值期求值一次，与 `config.module.ts` 的 `ignoreEnvFile` 同一时机、
 * 同一数据来源（`tests/helpers/env.ts` → `vitest.config.ts` 的 `test.env`）。
 *
 * 静音**只影响输出去向**：`mixin` 仍会被求值，测试因此仍可断言 trace 贯穿逻辑，
 * 不会出现「测试通过是因为日志没跑」这种假绿。
 */
const LOG_LEVEL = process.env.NODE_ENV === 'test' ? 'silent' : 'info';

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: LOG_LEVEL,
        // trace id 全链路贯穿（§3.5）：每条日志自动带上当前请求的 traceId
        mixin: () => {
          const ctx = currentContext();
          return ctx ? { traceId: ctx.traceId, userId: ctx.userId } : {};
        },
        // 第二层防线（C11）：即使序列化器将来被写宽，这几个键也不会原样落盘。
        // `req.body.*` 两条是**纵深防御**——默认序列化器并不输出 body
        // （`pino-std-serializers/lib/req.js` 只取 id/method/url/headers/remoteAddress），
        // 但将来若有人加自定义序列化器把 body 带上，这两条仍然挡得住。
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.body.password',
            'req.body.token',
          ],
          censor: '[REDACTED]',
        },
        // 第一层防线：请求/响应只留方法、路径、状态码。
        // 默认 req 序列化器会输出**完整 headers**——`cookie` 与 `authorization` 就在里面
        // （`pino-std-serializers/lib/req.js` 的 `_req.headers = req.headers`），
        // 那正是 C11 禁止的内容，因此这里刻意**不**沿用默认。
        serializers: {
          req: (r: { method: string; url: string }) => ({ method: r.method, url: r.url }),
          res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
        },
        formatters: { level: (label: string) => ({ level: label }) },
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class AppLoggerModule {}
