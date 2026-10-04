import 'reflect-metadata';
import { runBootstrap } from './bootstrap.js';

/**
 * 进程入口。
 *
 * ## 全部引导逻辑在 `bootstrap.ts`（Ruling 3）
 *
 * 本文件此前是 `void bootstrap();`——**没有 `.catch`**：配置校验失败、端口被占、
 * 依赖连不上时，进程打印一条未经 pino 的未处理拒绝，而 `process.exitCode` 仍是 **0**，
 * 容器编排与 CI 都会把它当成一次成功的启动。现在：
 *
 * - 失败经**应用 logger**（同一份 `buildLoggerOptions`）记录，且保留原始错误对象（含栈）；
 * - 退出码由 `runBootstrap` 设成 **1**；
 * - 中间件栈（每请求 CSP nonce + helmet + cookie-parser）与 `trust proxy = 1`
 *   在 `configureApp` 里安装——那是与测试 `helpers/app.ts` **共用**的同一个函数，
 *   两边的安装顺序不会漂移。
 *
 * ## 为什么这里仍然是 `void` 而不是 `.catch(...)`
 *
 * `runBootstrap` **内部**已经处理了全部失败（它不 rethrow，见其注释），
 * 因此这里没有可 catch 的东西；`void` 只是表明「有意不 await 顶层 promise」。
 * 写成 `void runBootstrap()` 与旧的 `void bootstrap()` 形状相同、含义完全不同：
 * 区别在于被调用的那个函数有没有兜住自己的失败。
 */
void runBootstrap();
