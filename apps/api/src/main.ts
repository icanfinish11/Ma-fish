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
 * - 进程**真的以码 1 退出**（修复轮 2：从「只设 `process.exitCode`」改成
 *   有界关停 + `process.exit(1)`，理由见 `runBootstrap` 的注释——
 *   旧的写法在「端口被占」这条路径上会因 ioredis 的活跃 socket 把进程永远挂住）；
 * - 中间件栈（每请求 CSP nonce + helmet + cookie-parser）与 `trust proxy = 1`
 *   在 `configureApp` 里安装——那是与测试 `helpers/app.ts` **共用**的同一个函数，
 *   两边的安装顺序不会漂移。
 *
 * ## `runBootstrap` 覆盖到哪里，**不**覆盖到哪里（修复轮 2 收窄了措辞）
 *
 * 覆盖：`configureApp` 与 `listen()` 抛出的失败（端口被占、地址不可用、接线抛错）。
 * **不覆盖**：环境变量校验失败。`ConfigModule.forRoot({ validate })` 在
 * **模块求值期**执行，而那时本文件顶部的 `import { runBootstrap } from './bootstrap.js'`
 * 已经先把 `./app.module.js` 拉起来了——也就是说告警发生在 `runBootstrap` 的 `try`
 * **存在之前**，那条路径仍然是「一条未经 pino 的未处理拒绝 + 非零退出码」
 * （实测：`node apps/api/dist/main.js` 在缺 env 时打出 Zod 聚合错误后以码 1 结束，
 * 因为**未处理的拒绝**本身就带非零退出码）。
 *
 * 上一版注释声称「现在失败经应用 logger 记录」，那句话对 env 校验这条路径**是假的**，
 * 已收窄。要真正覆盖它只能把 `app.module.js` 的 import 改成 `try` 内的
 * 动态 `await import(...)`——那会让「模块图加载」这件事变成运行期行为，
 * 属于另一个取舍，本任务不做；这里如实写明边界。
 *
 * ## 为什么这里仍然是 `void` 而不是 `.catch(...)`
 *
 * `runBootstrap` **内部**已经处理了全部失败（它不 rethrow，见其注释），
 * 因此这里没有可 catch 的东西；`void` 只是表明「有意不 await 顶层 promise」。
 * 写成 `void runBootstrap()` 与旧的 `void bootstrap()` 形状相同、含义完全不同：
 * 区别在于被调用的那个函数有没有兜住自己的失败。
 */
void runBootstrap();
