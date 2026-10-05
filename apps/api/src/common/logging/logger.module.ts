import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { LoggerOptions } from 'pino';
import { currentContext } from '../context/request-context.js';
import { redactWithContext, RedactionError, scrubEmails } from './redact.js';

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
 *
 * ## `redactFailed` 里放什么（修复轮 2 的 Minor）
 *
 * 此前它只放错误的**类名**，而对一个普通 `Error` 那就是字面量 `"Error"`：运维看到的是
 * 「脱敏失败了」，但不知道**什么**抛的、也看不出是**哪个键**触发的——一条无法据以行动的标记。
 * 现在放三段：`名称(截断后的消息)` + `@` + 出错的键名。键名重要是因为脱敏按**键**推进，
 * 触发异常的那个键直接指向有问题的字段（例如某个带 getter 的 `hostile`）。
 *
 * 消息**过 `scrubEmails` 并截断到 120 字符**（两个都是刻意的）：异常消息是最容易
 * 夹带地址的文本（`550 5.1.1 <user@example.com> rejected`），而降级路径**恰恰是**
 * 我们没能完成脱敏的那条路——它更没有资格把未脱敏的文本写出去。截断则是因为这个字段
 * 是给运维看的线索，不是错误档案（与 `last_error` 的 2000 字符是两把尺子）。
 */

/** 降级标记里消息部分的长度上界。 */
const FAILURE_MESSAGE_LIMIT = 120;

/**
 * 把降级标记拼成 `名称: 截断消息 @键名`。
 *
 * 键名从哪里来：`redact` 必须**读**每个属性，而读就可能抛；`redactWithContext` 的钩子
 * 把那次异常换成 `RedactionError`（带着键名），因此这里能取到它。取不到（异常发生在
 * 递归之外，例如 `Object.getPrototypeOf` 抛）时退化成不带键名的形态——仍然比只有类名有用。
 *
 * ## 这个函数**自己绝不能抛**（最终评审 I-7）
 *
 * 它跑在 `formatters.log` 的 catch 里，而它面对的正是**不可信**的抛出值：
 * - `err instanceof Error` 会触发 `getPrototypeOf`——一个 `Proxy` 让这个陷阱抛，`instanceof` 就抛；
 * - `String(err)` 会调用 `toString`——一个「`toString` 会抛」的对象就让这一步抛。
 *
 * 任一情况都会让**报告失败的代码**变成失败本身：`logger.info(...)` 的调用点收到异常，
 * 在请求里就是一次 500，而排查线索是零。这正是 `redact.ts` 写明的原则
 * （「脱敏是日志路径上的最后一道工序，它自己炸掉等于把一条本该记下来的日志变成一次请求失败」）
 * 在**降级路径**上的同一个要求。因此整个函数体包在一个兜底 try 里，
 * 连兜底自己都再兜一层（返回一个常量字符串）。
 *
 * `key` 曾经是一个从未被传入的参数（`failureReason(err, key?)` 只有一个调用点传了 `err`），
 * 最终评审的 Minor 把它删掉了：键名只从 `RedactionError` 上取，参数是死代码。
 */
function failureReason(err: unknown): string {
  // 每一步都单独兜住：只让**那一步**退化成常量，其余信息仍然写进标记。
  // 若整体共用一个 try，「读 message 抛了」会把已经拿到的键名一起丢掉。
  const isError = attempt(() => err instanceof Error, false);
  const name = attempt(() => (isError ? (err as Error).name : typeof err), 'unknown');
  const message = attempt(() => (isError ? (err as Error).message : String(err)), '');
  const key = attempt(() => (err instanceof RedactionError ? err.key : undefined), undefined);
  const detail = attempt(
    () => scrubEmails(message).replace(/\s+/g, ' ').trim().slice(0, FAILURE_MESSAGE_LIMIT),
    '',
  );
  const at = typeof key === 'string' && key ? ` @${key}` : '';
  return attempt(() => `${String(name).slice(0, 60)}: ${detail}${at}`, '[unavailable]');
}

/** 求值一段「可能抛」的报告逻辑；抛出时返回兜底值（见 `failureReason` 的说明）。 */
function attempt<T>(compute: () => T, fallback: T): T {
  try {
    return compute();
  } catch {
    return fallback;
  }
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
     * **记录级脱敏**（C11）：每条记录在交给 serializers 与 JSON 序列化**之前**先过一遍
     * `redact`（Task 8 接线；Task 4 的复审把这一步转派给本任务，并写明顺序依赖）。
     *
     * 它与上面两层的关系：`serializers` 管「请求/响应对象怎么压缩」、`redact.paths`
     * 管「几个已知路径不落盘」，而这一层管**任意业务负载**（键名黑名单、邮箱掩码、
     * 环与深度的降级）——三者是互补的，不是同一件事的三份。
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
          // 钩子：把「读某个键时抛出的异常」换成带键名的 `RedactionError`，
          // 于是下面那行降级能把「是哪个键坏了」写进 `redactFailed`（修复轮 2 的 Minor）。
          const out = redactWithContext(rest, (err, key) =>
            key === undefined ? err : new RedactionError(key, err),
          );
          if (req !== undefined) out.req = req;
          if (res !== undefined) out.res = res;
          return out;
        } catch (err) {
          return { ...contextFields(obj), redactFailed: failureReason(err) };
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
