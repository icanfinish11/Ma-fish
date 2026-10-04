import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '@vca/api';

/**
 * 与 `apps/api/src/main.ts` 保持一致的引导顺序。
 *
 * ## 为什么这里也要 `cookieParser()`
 *
 * `/auth/**` 的处理器与 `SessionMiddleware` 都读 `req.cookies`，而它由 cookie-parser
 * 填充。少了这一步，测试里「登录成功」后面的每一次请求都会被判成匿名——
 * 于是集成测试会**以通过的形式**骗人（403 断言全绿，200 断言全红），
 * 而生产是好的。测试助手必须复现真实的中间件栈，否则测的不是同一个应用。
 *
 * 顺序也与生产一致：`app.use` 注册在 express 实例上，先于 `app.init()` 建立的
 * Nest 中间件链执行，因此 cookie-parser 在 `TraceMiddleware`/`SessionMiddleware` 之前。
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  return app;
}
