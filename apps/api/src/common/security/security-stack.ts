import cookieParser from 'cookie-parser';
import type { INestApplication } from '@nestjs/common';
import { nonceHelmetMiddleware } from './headers.js';

/**
 * 浏览器侧安全中间件栈的**唯一安装点**（生产与测试共用同一个函数）。
 *
 * ## 为什么要有这个文件（Ruling 4）
 *
 * brief 的 Step 5 让 `tests/helpers/app.ts` 新增一个 `createSecureTestApp()`，
 * 里面**再抄一遍** `helmet(...) + cookieParser()` 的安装顺序。那是本仓库已经被
 * 评审点名过的形态（另一处测试文件里出现过第二套引导）：抄件与真件迟早漂移，
 * 而漂移的方向总是「测试里装了、生产里没装」，于是安全断言全绿而线上什么都没有。
 *
 * 所以这里只留**一个**函数：`main.ts` 的引导与 `tests/helpers/app.ts` 都调它。
 * 两处唯一的差别是 `isProduction` 的取值（生产读 `NODE_ENV`，测试恒为 `false`），
 * 而这个差别是**显式入参**，不是抄件的自由发挥。
 * 测试助手侧**没有开关**：`createTestApp` 无条件装这条栈（修复轮 3 删掉了那个
 * 「关掉就什么都不装」的 `withSecurity` 选项——它的失效形态是静默地没有 cookie-parser）。
 *
 * ## 顺序是承重的
 *
 * 1. **nonce + helmet**：每个响应都要带 CSP，因此它必须排在所有可能写响应的地方之前
 *    （包括错误响应——Nest 的异常过滤器之后才写 body，头已经设好了）；
 * 2. **cookie-parser**：`/auth/**` 的处理器与 `SessionMiddleware`（Task 6）、
 *    `CsrfMiddleware`（Task 7）都读 `req.cookies`，而它由这一步填充。
 *
 * 两条都通过 `app.use()` 注册在 express 实例上，因此它们先于 `app.init()` 建立的
 * Nest 中间件链执行（这条性质已被 Task 6 的用例实测钉住，见 `helpers/app.ts` 的说明）。
 * 顺序**不能**反：反了的话 `CsrfMiddleware` 读到的 `req.cookies` 是 `undefined`，
 * 表现为「每个写操作都被拒」——一个看起来像 CSRF 配置问题、实为中间件顺序的故障。
 */
export interface SecurityStackOptions {
  /**
   * 是否按生产下发 HSTS 等「只在 https 下有意义」的头。
   *
   * 测试恒传 `false`：`app.set('trust proxy', 1)` 与 https 终止都在 Nginx，
   * 测试进程里没有 https，下发 HSTS 只会让本地浏览器记住升级规则（见 `headers.ts`）。
   */
  isProduction: boolean;
}

/** 安装 nonce/helmet 与 cookie-parser（生产与测试共用；见文件头）。 */
export function applySecurityMiddleware(app: INestApplication, options: SecurityStackOptions): void {
  app.use(nonceHelmetMiddleware(options.isProduction));
  app.use(cookieParser());
}
