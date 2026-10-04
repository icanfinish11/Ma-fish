import { randomBytes } from 'node:crypto';
import helmet, { type HelmetOptions } from 'helmet';
import type { NextFunction, Request, Response } from 'express';

/**
 * CSP nonce 与安全响应头（威胁 #9）。
 *
 * ## Ruling 1：`randomBytes` 必须**顶层**导入，不能动态 `require`
 *
 * brief 的版本把取值包在一个 `randomBytes(n) { return require('node:crypto').randomBytes(n) }`
 * 里（注释说「单独包裹以便测试替换」）。本仓库是 **ESM**（三个包的 `"type": "module"`），
 * `require` 在 ESM 里根本不存在——那个 helper 会在**第一个请求**上抛
 * `ReferenceError: require is not defined`，而它包着的正是每个响应都要走的那条路径。
 * 实测探针（报告 §探针 P0）：
 *
 * ```
 * node --input-type=module -e "function r(n){return require('node:crypto').randomBytes(n)}; r(16)"
 * → ReferenceError: require is not defined in ES module scope
 * ```
 *
 * 「便于测试替换」这个理由也不成立：nonce 的随机性由 `node:crypto` 保证，
 * 测试要断言的是「每次不同」（本文件被 headers.test.ts 直接断言），而不是「调用了哪个函数」。
 * 动态 `require` 换来的唯一东西是一个可以被打桩的接缝，而那个接缝在 ESM 下是**抛错**。
 */

/** nonce 的字节数：128 位随机。base64 后 24 字符，远超 CSP 对不可预测性的要求。 */
const NONCE_BYTES = 16;

/**
 * `res.locals` 上 nonce 的键名。
 *
 * 目前**只有本文件**写它（将来模板层 P5 会读它）。刻意不导出：在出现真正的第二个
 * 使用点之前，导出一个没人 import 的常量只是让「键名可以有两份」这件事看起来合法；
 * 真到了 P5，再把 `res.locals` 的读取与这个常量一起抽出去。
 */
const CSP_NONCE_LOCALS = 'cspNonce';

/** 生成每请求唯一的 CSP nonce（威胁 #9：禁 inline 脚本）。 */
export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64');
}

/**
 * helmet 选项的纯构造器：`nonce` 与是否生产**全部**由入参决定。
 *
 * 为什么抽成纯函数：测试可以拿同一个函数断言两个方向（HSTS 只在生产打开），
 * 而不必为了看生产那一支去改 `NODE_ENV`——那种测试要么靠进程级探针，要么靠顺序耦合，
 * 两者在本仓库都已吃过亏（见 task-4/task-6 报告）。
 *
 * `useDefaults: false` 是刻意的：helmet 的默认 CSP 里带着 `'unsafe-inline'`（对 style）
 * 与 `upgrade-insecure-requests`，前者与「禁 inline」直接冲突。这里逐条列出指令，
 * 使「CSP 允许什么」成为本文件里可读的一行行字，而不是某个库版本的默认值。
 */
export function buildHelmetOptions(nonce: string, isProduction: boolean): HelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        // `'strict-dynamic'` 让「由受信脚本动态插入的脚本」也放行，同时使 `'self'` 在
        // 支持 CSP3 的浏览器里被忽略——这正是我们要的：唯一入口是 nonce。
        'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"],
        'style-src': ["'self'", `'nonce-${nonce}'`],
        'img-src': ["'self'", 'data:', 'https:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // 上传文件绝不从同源路径回源（威胁 #9 的最后一句）：`same-site` 让跨站嵌入被拒。
    // P0 还没有上传路径，因此这是**提前到位**的那一层；真正的
    // 「独立域 / Content-Disposition: attachment」由 P1 的下载路由承担（见报告 §concerns）。
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    noSniff: true,
    hidePoweredBy: true,
    // HSTS 只在生产下发：本地是 http，浏览器一旦记住 `max-age=31536000` 的 HSTS，
    // 之后所有 `http://localhost` 都会被强制升级到 https——开发环境直接不可用
    // （这不是理论风险，是 HSTS 的定义行为）。测试断言了「非生产不下发」这**一侧**。
    hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  };
}

/**
 * 每请求中间件：先造 nonce 放进 `res.locals`，再把它交给 helmet 下发响应头。
 *
 * 顺序不能反，也不可拆成两个中间件：`buildHelmetOptions` 需要 nonce 做入参，
 * 而 `res.locals` 必须在**同一请求**里拿到**同一个**值。
 * 写成「两个中间件各自 `newNonce()`」时 CSP 头看着完全正常，而模板拿到的 nonce
 * 永远对不上——页面白屏，控制台全是 CSP 违规。headers.test.ts 用探针把这条钉住。
 */
export function nonceHelmetMiddleware(isProduction: boolean): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const nonce = newNonce();
    res.locals[CSP_NONCE_LOCALS] = nonce;
    helmet(buildHelmetOptions(nonce, isProduction))(req, res, next);
  };
}
