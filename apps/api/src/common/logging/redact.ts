/** 日志脱敏（C11 / 威胁 #15）：绝不记录令牌、密码、完整邮箱。 */

/**
 * 键名**黑名单**（大小写不敏感）。命中即整值替换为 `[REDACTED]`，不做部分保留。
 *
 * `proxyCeiling` / `proxy_ceiling` 目前**还没有对应字段**（代理出价的密封上限，
 * 威胁 #6：「任何界面，含管理端，都不得暴露」）。这里是**提前放进黑名单**，
 * 而不是提前造抽象：黑名单条目是 deny-list 的一项，成本为零；
 * 将来漏了它的代价却是一封密封标价被打进日志。故保留。
 *
 * `sessionId` / `session_id` 是**修复轮 2 新增的纵深防御**：会话 id 本身就是完整的
 * bearer 凭证（见 `modules/auth/session.service.ts`），而它天然会出现在请求头
 * （`x-session-id`）、URL 查询串或调试负载里。注意 `cookie` 已在列表中，
 * 因此 `req.headers.cookie` 这一类早已被挡。
 *
 * **Task 8 起它们不再是「意图」而是生效的过滤**：`redact()` 已接进 pino 的
 * `formatters.log`（见 `logger.module.ts` 的 Ruling 3 记载），因此这几条 deny-list
 * 现在真的会拦住应用写出的每一条日志记录。常驻断言在 `tests/unit/logging/redact.test.ts`。
 */
const REDACT_KEYS = [
  'password', 'passwordHash', 'password_hash', 'token', 'accessToken', 'refreshToken',
  'authorization', 'cookie', 'set-cookie', 'secret', 'clientSecret', 'apiKey',
  'sessionId', 'session_id',
  'proxyCeiling', 'proxy_ceiling',
];

/**
 * 黑名单的小写集合（求值期算一次）。
 *
 * 为什么不再逐键 `REDACT_KEYS.some(...)`：Task 8 把 `redact` 接进了 `formatters.log`，
 * 于是这段代码从「无人调用的工具函数」变成**每条日志记录**都要跑一遍的热路径，
 * 逐键线性扫 16 条字符串是白给的常数开销。语义与原来逐字一致（大小写不敏感的全等）。
 */
const SENSITIVE_KEYS = new Set(REDACT_KEYS.map((key) => key.toLowerCase()));

const REDACTED = '[REDACTED]';

/** 邮箱只保留首字符与域名，如 `a***@example.com`。无 `@` 或 `@` 在首位时退化为 `***`。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * 文本里出现的邮箱（C11 的**字符串**那一层）。
 *
 * `redact()` 只按键名脱敏——值里的邮箱它看不见，那是它自己写明的边界。而两类**落库/落日志的
 * 文本**经常自带收件人：
 * - SMTP 的错误消息（`550 5.1.1 <user@example.com>: Recipient address rejected`）；
 * - 消费者写进 `outbox_events.last_error` 的任何异常文本。
 *
 * 因此这一层必须存在，而且**只能存在一份**：worker 的失败行与消费者的 `last_error`
 * 共用本函数（修复轮 1 / Fix 2 把原先写在 `apps/worker/src/worker.ts` 里的那份搬到这里）。
 * 两份实现就是漂移的开始——正则、掩码规则、边界字符迟早会分叉，而它们本该永远一致。
 *
 * 边界如实记录（三条都是实测，不是推测）：
 * - **MIME 编码字完全漏掉**：`=?utf-8?Q?victim=40example.com?=` 里根本没有字面量 `@`，无从匹配；
 * - **带引号的 local-part 会部分残留**：`"quoted local"@example.com` 里引号不在「地址字符」集合内，
 *   匹配因此从引号之后开始，`quoted`（不含 `@` 那一段）原样留下；
 * - 反过来，**被 `<`/`>`/`,`/`;`/`"` 包起来的普通地址是安全的**：分隔符只是边界，
 *   `RCPT TO:<user@example.com>`、`"user@example.com"`、`a@x.com,b@y.com` 都能正确掩码。
 *
 * 结论：这是**缓解**，不是保证。主防线仍然是「不要把地址写进日志消息/错误文本」。
 * 上列边界在 `tests/unit/logging/redact.test.ts` 里被钉住（改正则就必须同时改那里的期望）。
 */
const EMAIL_IN_TEXT = /[^\s<>()[\]{},;:'"]+@[^\s<>()[\]{},;:'"]+/g;

/** 把文本里出现的邮箱换成掩码形式（见 {@link EMAIL_IN_TEXT} 的边界说明）。 */
export function scrubEmails(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (match) => maskEmail(match));
}

/** 环引用替身：降级成可读的值，而不是抛出 `RangeError`。 */
const CIRCULAR = '[Circular]';

/**
 * 深度上界替身（Ruling 3 的前置加固）。
 *
 * 为什么需要它：环守卫只挡**同一条路径上重复出现**的对象，而一条 20 万层**互不相同**的
 * 嵌套链（`{next:{next:…}}`）每个节点都是新对象，环守卫完全看不见——实测直接
 * `RangeError: Maximum call stack size exceeded`（见报告 §REDACT）。
 */
const MAX_DEPTH_MARKER = '[MaxDepth]';

/**
 * 递归深度上界。
 *
 * 取 32 的依据：本项目最深的**真实**负载是「审计 metadata 里套一层业务对象」（1–2 层），
 * 32 远高于它；而 32 个递归帧离真实栈上限极远（实测只有 20 万层那种量级的非环链才会溢出）。
 * 上界处**降级**而不是抛错：脱敏是日志路径上的最后一道工序，
 * 它自己炸掉等于把一条本该记下来的日志变成一次请求失败。
 *
 * 代价如实记录：超过 32 层的负载会被截断成 `[MaxDepth]`（信息丢失，但方向安全）。
 */
const MAX_DEPTH = 32;

/** 只把**纯对象**（`Object.prototype` 或 `null` 原型）当作可以下钻重建的记录。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 数据放在**内部槽位**而不是自有属性里的内建类型。
 *
 * 为什么必须显式列出来（这不是分类癖，是一个真实的坏对象制造机）：
 * `Object.create(Date.prototype)` 造出来的「Date」上调用 `getTime()` 会抛
 * `TypeError: this is not a Date object`——而 `JSON.stringify` **正是**这样序列化 Date 的
 * （走 `toJSON` → `this.getTime()`）。也就是说，给一个挂了自定义属性的 `Date` 做重建，
 * 会把「脱敏」变成「pino 序列化时抛错」，比漏掉那个自定义属性严重得多。
 * `Map`/`Set`/`RegExp`/Promise 同理（数据都在内部槽位里）。
 *
 * 代价如实记录：这些类型**内部**若被挂了敏感字段，本函数不会屏蔽它（整体透传）。
 * 这个取舍与「不能造坏对象」相比是划算的一侧，且它需要有人往 `Date` 上挂 `token` 才会发生。
 */
const OPAQUE_BUILTINS: ReadonlyArray<new (...args: never[]) => object> = [
  Date, RegExp, Map, Set, WeakMap, WeakSet, Promise, ArrayBuffer, DataView, URL, URLSearchParams,
];

function isOpaqueBuiltin(value: object): boolean {
  // Buffer / TypedArray / DataView 都是 view，`instanceof` 对它们不可靠（跨 realm/Buffer 特例），
  // 用 `ArrayBuffer.isView` 一次覆盖。
  if (ArrayBuffer.isView(value)) return true;
  return OPAQUE_BUILTINS.some((Ctor) => value instanceof Ctor);
}

/**
 * 递归脱敏。五类处理：
 * 1. 键名命中 `REDACT_KEYS` → `[REDACTED]`；
 * 2. 键名含 `email` 且值是字符串 → `maskEmail`（这是「完整邮箱不入日志」的落点）；
 * 3. **纯对象**与数组 → 重建后递归下钻；
 * 4. **非纯对象**（`Error`、类实例）→ 保留原型重建，只访问其**自有可枚举**属性；
 * 5. 其余（`Date`/`Buffer`/`Map`/`Set`/`RegExp`/函数……）→ 原样返回。
 *
 * ## 边界（Task 8 / Ruling 3 更新）
 *
 * 修复轮 1 的边界是「只下钻纯对象与数组，其余一律原样返回」，它救回了被压成 `{}` 的
 * `Date`/`Error`，但**缩小了键访问面**：`err.token = 'x'`、类实例的 `password` 字段
 * 从此不再被访问。修复轮 2 的复审把这一条列为「接进 `formatters.log` 之前的硬前置」。
 *
 * 现在第 4 类补上了这个缺口，做法是**保留原型地重建**：
 * - `message`/`stack`/`name` 是 `Error` 的自有**非枚举**属性，逐个用属性描述符搬过去，
 *   因此 `err instanceof Error` 成立、pino 的 `err` 序列化器照旧认它，栈一个字不丢；
 * - 自有**可枚举**属性走与普通对象完全相同的键级规则（黑名单 / 邮箱掩码 / 递归）；
 * - 用 `Object.defineProperty` 写入而不是赋值，避免撞上原型上的 setter。
 *
 * 为什么不是「就地改写原对象」：那会让 `logger.info({ user })` 把调用方手里那个对象的
 * `password` 字段真的替换掉（日志是只读观察，不该有这种副作用）。
 * 为什么没有自有可枚举属性时**返回原引用**：`Date`/`Buffer`/`Map`/没有自定义字段的类实例
 * 都属于这一类，零拷贝、零风险，也让「不改变普通值的形状」这条承诺继续成立。
 *
 * ## 深度上界（Ruling 3）
 *
 * 超过 {@link MAX_DEPTH} 层降级为 `[MaxDepth]`，见该常量的说明。
 *
 * ## 三处诚实的局限
 *
 * 1. 它**只认键名**，值里的敏感信息（如 URL query 上的 token、错误消息里夹的邮箱）
 *    不会被它发现——所以脱敏不是唯一防线，另一道是「不要把这些东西放进日志」。
 * 2. 不透明内建类型（`Date`/`Map`/…）是整体透传的，见 {@link OPAQUE_BUILTINS}。
 * 3. 自有可枚举属性若由 **getter** 提供，读取时必然触发它（脱敏值之后以数据属性写入）。
 *    这与「只认键名」同源：本函数没有能力在不求值的前提下知道它是什么。
 */
export function redact<T>(value: T): T {
  return redactValue(value, new Set<object>(), 0) as T;
}

function redactValue(value: unknown, seen: Set<object>, depth: number): unknown {
  // 原始值与函数（`typeof 'function'`）不参与递归，也与深度无关
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return MAX_DEPTH_MARKER;

  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    const out = value.map((item) => redactValue(item, seen, depth + 1));
    seen.delete(value);
    return out;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactEntry(k, v, seen, depth);

    seen.delete(value);
    return out;
  }

  return redactObject(value, seen, depth);
}

/** 键级规则：黑名单 → 邮箱掩码 → 递归。普通对象与非普通对象共用同一条规则。 */
function redactEntry(key: string, value: unknown, seen: Set<object>, depth: number): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return REDACTED;
  if (key.toLowerCase().includes('email') && typeof value === 'string') return maskEmail(value);
  return redactValue(value, seen, depth + 1);
}

/**
 * 非纯对象（`Error`、类实例）的脱敏：**保留原型**重建，只碰自有属性。
 *
 * `seen` 的语义与纯对象分支一致：进入时加入、离开时移除，因此只检测**当前路径上的环**，
 * 同一个对象出现在两个兄弟分支仍会被完整脱敏。
 */
function redactObject(value: object, seen: Set<object>, depth: number): unknown {
  const enumerableKeys = Object.keys(value);
  // 没有自有可枚举属性 ⇒ 没有任何「挂在对象上的自定义字段」可脱敏 ⇒ 原样返回（保持引用）。
  // Date / Buffer / Map / Set / RegExp / 没有自定义字段的类实例都落在这里。
  if (enumerableKeys.length === 0 || isOpaqueBuiltin(value)) return value;

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  const out = Object.create(Object.getPrototypeOf(value) as object | null) as Record<string, unknown>;

  // 先搬自有**非枚举**属性（`Error` 的 `message`/`stack`/`name` 就在这里）：丢掉它们
  // 等于把修复轮 1 救回来的东西又丢一次。用描述符搬运，保持「非枚举」这一性质，
  // 于是 `JSON.stringify(err)` 的行为与原生一致（`err` 交给 pino 的 err 序列化器）。
  for (const key of Object.getOwnPropertyNames(value)) {
    if (enumerableKeys.includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (descriptor.get) {
      // **访问器不能照搬描述符**：V8 的 `err.stack` 是一个惰性 getter，真正的数据在
      // `[[ErrorData]]` 内部槽位里，而 `Object.create(Error.prototype)` 造出来的副本
      // 没有那个槽位——实测照搬描述符后 `out.err.stack === undefined`，栈又丢了。
      // 因此这里在原对象上求值一次，落成一个普通数据属性（值就是那一刻的栈字符串）。
      Object.defineProperty(out, key, {
        value: (value as Record<string, unknown>)[key],
        writable: true,
        enumerable: descriptor.enumerable,
        configurable: true,
      });
    } else {
      Object.defineProperty(out, key, descriptor);
    }
  }

  // 可枚举属性：与普通对象同一套键级规则
  for (const key of enumerableKeys) {
    Object.defineProperty(out, key, {
      value: redactEntry(key, (value as Record<string, unknown>)[key], seen, depth),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  seen.delete(value);
  return out;
}
