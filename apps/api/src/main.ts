import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  /**
   * 必须在 Nest 的中间件链**之前**挂上（`app.use` 注册于 express 实例，
   * 先于 `app.init()` 时注册的 Nest 中间件执行）。
   *
   * 为什么必需：`/auth/**` 的处理器与 `SessionMiddleware` 都读 `req.cookies`。
   * 没有它时 `req.cookies` 恒为 `undefined` ⇒ 会话永远「不存在」⇒
   * `/auth/me` 与 `/auth/logout` 对任何人都 403。这与 Task 6 的会话中间件
   * 是**两件**缺一不可的事：cookieParser 把 cookie 变成可读数据，
   * 会话中间件把数据变成身份。
   *
   * `cookieParser()` 不带 secret：**不以签名 cookie 作凭证**。
   * 签名只防「客户端改 cookie」，而本方案的 cookie 里只有会话 id；
   * 改一个 id 只会得到一个不存在的会话（服务端 `verify` 返回 null）。
   * 引入 secret 反而会让人误以为「cookie 不可改」是安全边界，真正的边界是
   * 「服务端没有这个 id 就不认」。
   */
  app.use(cookieParser());

  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
