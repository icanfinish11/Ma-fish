import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Controller, Get, Module, type INestApplication, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createTestApp } from '../../helpers/app.js';
import { currentContext } from '@vca/api/common/context/request-context.js';
import { AppLoggerModule } from '@vca/api/common/logging/logger.module.js';
import { TraceMiddleware } from '@vca/api/common/logging/trace.middleware.js';

/**
 * 探针捕获的 traceId。用模块级变量而不是往 service 里塞状态：
 * 断言要证明的正是「**处理器内部**读到的上下文」与响应头一致。
 */
let seen: string | undefined;

/**
 * 测试专用探针路由。
 *
 * 为什么不用 `app.getHttpAdapter().getInstance().get('/__trace-probe', ...)`：
 * 那是在 `app.init()` **之后**往 express 实例上挂路由，而此时 Nest 的路由表与
 * 中间件链都已建好——后挂的路由不保证经过中间件（甚至不保证可达）。
 * 把探针做成真正的 controller 放进 Nest 模块，它才走**同一条真实管线**：
 * 下面 `TraceProbeModule` 引入的 `AppLoggerModule` 与 `TraceMiddleware`
 * 就是生产 `AppModule` 里那两个，`configure()` 的写法也逐字一致。
 */
@Controller()
class TraceProbeController {
  @Get('__trace-probe')
  probe(): { ok: boolean } {
    seen = currentContext()?.traceId;
    return { ok: true };
  }
}

@Module({
  imports: [AppLoggerModule],
  controllers: [TraceProbeController],
})
class TraceProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}

async function createProbeApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [TraceProbeModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('trace id 贯穿（§3.5 / 验收 13.4）', () => {
  it('响应回显 x-trace-id，且 handler 内可读同一 traceId', async () => {
    seen = undefined;
    const app = await createProbeApp();

    const res = await request(app.getHttpServer()).get('/__trace-probe');
    expect(res.status).toBe(200);
    expect(res.headers['x-trace-id']).toBeTruthy();
    expect(seen).toBe(res.headers['x-trace-id']);
    await app.close();
  });

  it('尊重调用方传入的 trace id', async () => {
    // 这条走**真实 AppModule**（不是上面的探针模块）：它同时证明
    // `AppModule.configure` 里的 `forRoutes('*')` 在生产接线下真的生效——
    // 若中间件没被应用，这个响应头只会是 undefined，断言必红。
    const app = await createTestApp();
    const res = await request(app.getHttpServer()).get('/health').set('x-trace-id', 'trace-abc-123');
    expect(res.headers['x-trace-id']).toBe('trace-abc-123');
    await app.close();
  });
});
