import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { LoggerOptions } from 'pino';
import { currentContext } from '../context/request-context.js';
import { redact } from './redact.js';

/** 本模块读取的环境变量面（目前只用到 `NODE_ENV`）。 */
export interface LoggerEnv {
  NODE_ENV?: string | undefined;
}

/**
 * 脱敏失败时的降级（Task 8 接线后发现的边界）。
 *
 * ## 为什么必须有它
 *
 * `redact` 要**读**每个属性才能脱敏它，而「读」这一步本身就可能抛：带 getter 的对象、
 * 被代理过的对象、第三方库的实例。`formatters.log` 位于 pino 的写入路径中间，
 * 异常会一路冒到 `logger.info(...)` 的调用点——在请求里就是一次 500。
 * 这与 `redact.ts` 自己写明的原则直接冲突：脱敏是日志路径上的最后一道工序，
 * **它自己炸掉等于把一条本该记下来的日志变成一次请求失败**。
 * 已实测：一个会抛的 getter 就能让 `logger.info()` 抛出（见报告探针 R1）。
 *
 * ## 降级方向是刻意选的
 *
 * - **负载整体丢弃**（fail-closed）：异常发生时不知道脱敏进行到哪一步，宁可少记一条，
 *   也不能把未脱敏的数据写出去；
 * - **保留 `traceId`/`userId`**（fail-open）：它们来自 `mixin` 的 ALS 上下文，不是负载数据，
 *   丢掉它们会让这条日志无法与请求关联；
 * - **标记 `redactFailed`**：让「负载为什么没了」这件事在日志里可解释，而不是静默丢数据。
 */
function failureName(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return name.slice(0, 60);
}

function contextFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['traceId', 'userId'] as const) {
    try {
      const value = obj[key];
      if (typeof value === 'string') out[key] = value;
    } catch {
      // 连这两个键都读不出来：那就只留 redactFailed（同样是 fail-open，不抛）
    }
  }
  return out;
}

/**
 * pino 选项的纯构造器：给定 env，返回**唯一一份**生产/测试共用的 logger 配置。
 *
 * 为什么抽成纯函数（修复轮 1）：静音会把 `mixin` 一并关掉（见下），所以「trace 贯穿」
 * 无法从应用里那个真正装好的 logger 上观察。把它做成 `env → options` 的纯构造器后，
 * 测试可以拿**同一份** options 在内存 destination 上造一个真实 pino 实例，
 * 直接断言「ALS 上下文 → 日志记录」这条链路（`tests/unit/logging/logger-options.test.ts`）。
 * 配置只有一处定义，测试与生产不会各写一份然后悄悄漂移。
 */
export function buildLoggerOptions(env: LoggerEnv): LoggerOptions {
  return {
    /**
     * 测试期静音（Ruling 3）。
     *
     * 本模块一旦接进 `AppModule`，**每个**会引导应用的测试都会走 pino：单测的
     * `createTestApp()` 与集成套件的每个 HTTP 请求都会打印请求行。这些行不是失败信息，
     * 却会把真正的失败挤出视野，也让「输出全绿」这种一眼判据失效。
     *
     * 所以 `NODE_ENV === 'test'` 时把 level 设成 `'silent'`（pino 的合法 level），
     * 其余环境保持 pino 默认的 `info`。该判断与上一版一样在模块求值期求值一次，
     * 与 `config.module.ts` 的 `ignoreEnvFile` 同一时机、同一数据来源
     * （`tests/helpers/env.ts` → `vitest.config.ts` 的 `test.env`）。
     *
     * ## 静音的实测语义：它连 `mixin` 一起关掉（修复轮 1 更正，此前写反了）
     *
     * 上一版注释声称「静音只影响输出去向：`mixin` 仍会被求值，测试因此仍可断言 trace 贯穿」。
     * **这是错的**，读 pino 10.4.0 源码并实测（`node -e` 探针，见报告 §11）：
     *
     * - `lib/levels.js` 在建 logger 时对每个 level 做一次比较，
     *   `if (levelComparison(values[key], levelVal) === false) { this[key] = noop }`；
     *   而 `values.silent = Infinity`（`Object.create(Object.prototype, { silent: { value: Infinity } })`）
     *   让默认的升序比较对 trace/debug/info/warn/error/fatal **六次全部为 false**，
     *   于是六个方法**整体被替换成 `noop`**——实测 `info=noop … fatal=noop`；
     * - `mixin` 只在写入路径里被求值（`lib/proto.js` 的 `write()`：`obj = mixinMergeStrategy(obj, mixin(...))`），
     *   而 `noop` 根本不进入写入路径。实测同一份配置下：`level:'silent'` → `mixin` 调用 **0** 次、输出 0 行；
     *   `level:'info'` → 调用 1 次、输出 1 行。
     *
     * 结论：**静音下 `mixin` 不会被求值**，因此**不能**用「测试期跑了一遍应用、没报错」来证明
     * 验收 13.4（trace id 贯穿同一请求的所有日志）——那种断言只会落在空数组上，也就是假绿。
     * 静音的职责被收窄为「让测试输出 pristine（零 pino 行）」；
     * 13.4 的可观测证明改由 `buildLoggerOptions` + 真实 pino 实例 + 内存 destination 承担。
     */
    level: env.NODE_ENV === 'test' ? 'silent' : 'info',
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
    /**
     * **第一层防线**（C11）：每条记录在交给 serializers 与 JSON 序列化**之前**先过一遍
     * `redact`（Task 8 接线；Task 4 的复审把这一步转派给本任务，并写明顺序依赖）。
     *
     * ## 为什么必须排在 serializers 之前、为什么这不成问题
     *
     * 读 pino 10.4.0 的 `_asJson`：`if (formatters.log) obj = formatters.log(obj)` 就在
     * `for (const key in obj)` 那个循环**之前**，serializers 是在循环里逐键应用的。
     * 也就是说这里拿到的是**原始** merge 对象（`err` 还是 `Error` 实例、`req`/`res` 还是活对象）。
     * 前者正是我们要的：`redact` 保留原型的重建让 `err` 仍是 `Error`，
     * 于是 pino 默认的 `serializers.err`（`pino.js` 的 `defaultErrorSerializer`）照旧输出
     * name/message/stack。
     *
     * ## `req`/`res` 为什么**不**进脱敏遍历（实测得出，不是想当然）
     *
     * 它们是一整棵活对象图（socket、事件表、内部句柄），实测遍历一次约 **637 个节点 / 250µs**，
     * 而这次遍历的产物**立刻**被下面两个 serializer 的输出整个替换掉——纯浪费，
     * 且是每条请求日志的固定开销。所以这里把这两个键摘出来、原样交回给 serializer。
     *
     * **代价如实记录**：于是「请求头不会进日志」这件事有一半依赖那两个 serializer 继续存在
     * （pino 的 `redact.paths` 是另一半）。因此它被
     * `tests/unit/logging/logger-options.test.ts` 的第三条用例**钉住**——删掉 serializer、
     * 或把这两个键放回遍历，那条用例立刻变红，而不是变成一次静默泄露。
     *
     * ## 已知边界（不遮）
     *
     * `formatters.log` **不覆盖 child logger 的 bindings**：pino 的 `child()` 会把 bindings
     * 格式器重置成恒等函数（`proto.js` 的 `resetChildingsFormatter`），bindings 走的是
     * `asChindings`（只应用 serializers）。因此不要用 `logger.child({ token })` 携带敏感值——
     * pino-http 绑定的 `req` 恰好是安全的：它经过 `serializers.req` 压成 method/url。
     */
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (obj: Record<string, unknown>): Record<string, unknown> => {
        try {
          const { req, res, ...rest } = obj;
          const out = redact(rest);
          if (req !== undefined) out.req = req;
          if (res !== undefined) out.res = res;
          return out;
        } catch (err) {
          return { ...contextFields(obj), redactFailed: failureName(err) };
        }
      },
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };
}

@Module({
  imports: [PinoLoggerModule.forRoot({ pinoHttp: buildLoggerOptions(process.env) })],
  exports: [PinoLoggerModule],
})
export class AppLoggerModule {}
