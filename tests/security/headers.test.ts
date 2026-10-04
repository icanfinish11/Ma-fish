import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Controller, Get, Module, Res, type INestApplication } from '@nestjs/common';
import { Public } from '@vca/api/common/policy/policy.decorator.js';
import { buildHelmetOptions } from '@vca/api/common/security/headers.js';
import { createTestApp } from '../helpers/app.js';

/** nonce 探针的响应体（断言用，字段是 `unknown`：回显的就是响应对象上的原始值）。 */
interface NonceProbeBody {
  nonce?: unknown;
}

/**
 * 安全响应头与 CSP（威胁 #9 / 验收 13.2）。
 *
 * ## 这个文件为什么跑**真实** `AppModule`
 *
 * 头是**中间件栈**的产物，而中间件栈的接线在 `main.ts` / `tests/helpers/app.ts`
 * 共用的那个安装点里。照抄一份 `helmet(...)` 到测试里，测的就只是「helmet 这个库
 * 会不会设头」，与「我们的应用有没有装它、装在哪一步」完全无关——那正是 Task 7
 * 要防的假绿（brief 的 `createSecureTestApp` 若与生产接线漂移，本文件会全绿而线上裸奔）。
 * 因此这里只调 `createTestApp({ withSecurity: true })`，它内部调的是**生产那个**
 * `applySecurityMiddleware`。
 *
 * ## nonce 的**两处**落点都要断言
 *
 * 1. 响应头 `Content-Security-Policy` 里的 `'nonce-…'`（浏览器实际执行的那一份）；
 * 2. `res.locals.cspNonce`（将来模板渲染 `<script nonce>` 时取用的那一份）。
 *
 * 只断言 1 是不够的：两处可以由**两个不同的 nonce** 分别填上（例如中间件里生成两次），
 * 那时 CSP 头看起来完全正常，而页面里注入的 nonce 永远不匹配——CSP 会静默地把
 * **自己的**脚本全挡掉（表现为「页面白屏，控制台一堆 CSP 报错」）。
 * 所以第 2 条断言的是「探针回显的 nonce 与它自己那次响应的 CSP 头里的 nonce **逐字相同**」。
 */

/** 从 CSP 头里取出 nonce（`'nonce-…'`）。 */
function cspOf(res: request.Response): string {
  return String(res.headers['content-security-policy'] ?? '');
}

function nonceOf(res: request.Response): string | undefined {
  return /'nonce-([A-Za-z0-9+/=]+)'/.exec(cspOf(res))?.[1];
}

/**
 * nonce 探针控制器（`extraModules` 注入，不是生产代码）。
 *
 * `@Public()` 必需：Task 5 起全局 `PolicyGuard` 默认拒绝一切未声明的路由。
 * `@Res({ passthrough: true })` 让我们拿到响应对象读 `res.locals`——`res.locals.cspNonce`
 * 按定义只存在于响应对象上，处理器是唯一能观察它的位置。
 * 参数类型用结构化写法而不是 `import type { Response } from 'express'`：
 * `tests` 包没有声明 `@types/express`（见 `helpers/app.ts` 的说明），
 * 为一行类型断言新增一条依赖不值得。
 */
@Controller('__nonce-probe')
class NonceProbeController {
  @Public()
  @Get()
  probe(@Res({ passthrough: true }) res: { locals: Record<string, unknown> }): NonceProbeBody {
    return { nonce: res.locals['cspNonce'] };
  }
}

@Module({ controllers: [NonceProbeController] })
class NonceProbeModule {}

describe('安全响应头与 CSP（威胁 #9 / 验收 13.2）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ withSecurity: true, extraModules: [NonceProbeModule] });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('设置 nosniff / frame-deny / referrer-policy', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    // `hidePoweredBy`：指纹类头不该出现（威胁 #9 的旁支，但同属「响应头最小面」）。
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CSP 基于 nonce 且禁止 inline 脚本', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    const csp = cspOf(res);
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // 上传文件绝不从同源路径回源（威胁 #9 的最后一句）：CORP 是这一条在 P0 就有的**可见**抓手。
    // 真正的「独立域 / Content-Disposition: attachment」属 P1（此刻还没有上传路径），
    // 由 P1 的下载路由承担；这条头至少保证跨站嵌入被拒。
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  it('每次响应的 nonce 不同', async () => {
    const a = await request(app.getHttpServer()).get('/health');
    const b = await request(app.getHttpServer()).get('/health');
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(b)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });

  it('nonce 同时写进 res.locals.cspNonce，且与同一次响应的 CSP 头逐字一致', async () => {
    const res = await request(app.getHttpServer()).get('/__nonce-probe');
    expect(res.status).toBe(200);
    const body = res.body as NonceProbeBody;
    expect(typeof body.nonce).toBe('string');
    expect(body.nonce).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
    expect(body.nonce).toBe(nonceOf(res));
  });

  it('HSTS 在非生产环境不下发（否则会污染本地 http 开发）', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('错误响应同样带头（403 / 404 也要有 CSP）', async () => {
    // 安全头只在 200 上生效是最常见的假绿：`app.use(helmet)` 若挂到了路由**之后**
    // （或只挂在某个路由上），正常响应对应不上差别，而**错误页**才是反射型 XSS
    // 最容易落地的地方（Nest 的默认错误体里带着请求路径）。
    const forbidden = await request(app.getHttpServer()).post('/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(12) });
    expect(forbidden.status).toBe(403); // CSRF 缺失（Task 7 的另一半在 csrf.test.ts）
    expect(nonceOf(forbidden)).toBeTruthy();
    expect(forbidden.headers['x-content-type-options']).toBe('nosniff');

    const notFound = await request(app.getHttpServer()).get('/no-such-route');
    expect(notFound.status).toBe(404);
    expect(nonceOf(notFound)).toBeTruthy();
  });

  it('buildHelmetOptions：HSTS 只在生产打开（两个方向都断言，免得「永远不下发」也算通过）', () => {
    expect(buildHelmetOptions('probe-nonce', false).hsts).toBe(false);
    expect(buildHelmetOptions('probe-nonce', true).hsts).toMatchObject({
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: true,
    });
  });
});
