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
 * 两份实现就是漂移的开始——掩码规则、边界字符迟早会分叉，而它们本该永远一致。
 *
 * ## 为什么是**扫描器**而不是一条正则
 *
 * 第一版写成了一条「两个候选」的正则
 * （``/"[^"]*"@[^…]+|[^…]+@[^…]+/g``）。它**本身是对的**，但修复轮 2 的实现过程暴露了
 * 一个真实的坑：判断「匹配到的是不是带引号的形式」必须写 `charCodeAt(0) === 34`，
 * **不能写引号字面量 `'"'`**——引号字面量在本仓库的编辑流程里极易被替换成排版引号
 * （U+201C/U+201D），而那种替换**肉眼看不出来**，只会让判断恒为假、掩码静默失效
 * （实测：`endsWith('"')` 对 ASCII 引号返回 false，输出里 `quoted` 原样留下）。
 * 追查这条的过程中还出现过一个**假线索**（误判为「同一份正则源码在 vitest 与 node 里
 * 行为不一致」），根因是我自己的调试语句先调了一次 `str.match(全局正则)`，见下。
 *
 * 现在的实现是一段确定性扫描：先找 `@`，再向两侧按「地址字符」扩展，引号只作为
 * **定界符**参与判断（用码点，不用字面量）。保留它的理由有两条，都不依赖上面那条假线索：
 * ① 引号这东西要同时处理「包住整个地址」与「只包住 local-part」两种形态，正则的字符类
 * 表达不了，只能靠分支 + 前后瞻，可读性反而更差；② 扫描的每一步都能逐行读出来。
 *
 * **给后人的一条实测教训**（这也是那条假线索的成因）：`String.replace` 与 `String.matchAll`
 * 在传入**带 `g` 的同一个正则对象**时会**共享并推进 `lastIndex`**。因此
 * 「先用 `match`/`matchAll` 打印一遍、再 `replace`」的调试写法本身就会改变被观察的行为
 * ——要么把正则的 `lastIndex` 归零，要么用不含 `g` 的副本去观察。
 * 本轮为此白花了不少时间，写在这里免得下一个人重踩。
 *
 * ## 分隔符集合
 *
 * `\s < > ( ) [ ] { } , ; : ' "` 都是**边界**，不是地址字符：
 * - `RCPT TO:<user@example.com>`、`a@x.com,b@y.com`、`"user@example.com"` 都能正确掩码；
 * - `mailto:victim@example.com` 只会掩掉 `victim@example.com`（`:` 是边界，前缀原样保留）。
 *   若把 `:` 当成地址字符，被掩码的会是 `mailto:victim@example.com`，输出
 *   `m***@example.com`——`victim` 会原样留在文本里（实测过的形态）；
 * - **带引号的 local-part**（RFC 5321 quoted-string）：引号是定界符、不参与掩码，
 *   于是 `"quoted local"@example.com` 得到 `"q***@example.com"`。修复轮 1 的实现在这种情况下
 *   **原样返回、一个字符都没掩**（实测：`550 "quoted local"@example.com rejected` 的输出与输入
 *   逐字相同）——一个**完整**的地址穿过了 C11 那道过滤。而当时的注释把这件事写成
 *   「部分残留 / 地址被截断」，两条都不对（修复轮 2 的复审指出，实测如上）。
 *
 * **代价如实记录**：带端口的地址（`user@host:25`）会在 `:` 处截断；带字面量 IP 的地址
 * （`user@[192.168.0.1]`）因括号是边界、只会掩到 `user@` 之后。两者在本项目里都不存在
 * （地址来自用户注册，形状是 `local@domain`），而「前缀被当成 local-part」是真实发生过的泄露。
 *
 * ## 仍然漏掉的（如实记录，不是「已解决」）
 *
 * **MIME 编码字完全漏掉**：`=?utf-8?Q?victim=40example.com?=` 里根本没有字面量 `@`，
 * 扫描器无从发现（`=40` 是 `@` 的 quoted-printable 编码）。要盖住它必须解 MIME 编码，
 * 那是另一个量级的实现，且照样盖不住任意编码——本阶段刻意不做（C16）。
 *
 * 结论：这是**缓解**，不是保证。主防线仍然是「不要把地址写进日志消息/错误文本」。
 * 上列边界在 `tests/unit/logging/redact.test.ts` 里被钉住（改这段扫描就要同时改那里的期望）。
 */

/** 分隔符（不是地址字符）。与旧正则的字符类逐字对应。 */
const ADDRESS_DELIMITERS = new Set([' ', '\t', '\n', '\r', '\f', '\v', '<', '>', '(', ')', '[', ']', '{', '}', ',', ';', ':', "'", '"']);

/** ASCII 双引号（用码点而不是字面量：字面量极易被排版引号替换而看不出来）。 */
const DOUBLE_QUOTE = 34;

/** 从 `from` 起沿 `step` 方向吃掉连续的地址字符，返回**停下来的下标**（该处是边界或越界）。 */
function scanAddressChars(text: string, from: number, step: 1 | -1): number {
  let i = from;
  while (i >= 0 && i < text.length && !ADDRESS_DELIMITERS.has(text[i]!)) i += step;
  return i;
}

/**
 * 向左吃完连续的地址字符，返回 local-part 的**起始下标**。
 *
 * `scanAddressChars` 返回的是「停在边界上的那个下标」，因此起点要再往右挪一格
 * （实测过一次差一：把停在引号上的下标直接当起点，会让 local-part 少一格）。
 */
function climbLeft(text: string, from: number): number {
  return scanAddressChars(text, from, -1) + 1;
}

/** 向右吃完连续的地址字符，返回**独占**的结束下标（即 `slice(start, end)` 的 `end`）。 */
function climbRight(text: string, from: number): number {
  return scanAddressChars(text, from, 1);
}

/**
 * 把文本里出现的邮箱换成掩码形式（见 {@link ADDRESS_DELIMITERS} 上方的边界说明）。
 *
 * 掩码采用「首个字符 + `***` + 域名」的 `maskEmail` 规则：
 * - 裸地址（含被 `<>`/`,`/`"` 包住、含 `mailto:` 前缀）直接交给 `maskEmail`；
 * - 带引号的 local-part（`"quoted local"@example.com`）**不能**直接交给 `maskEmail`——
 *   它会拿 `email[0]`（也就是那个引号）当「首字符」保留，于是得到 `"***@example.com`：
 *   引号后的第一个字符被当成首字符消耗掉、收尾的引号也丢了，输出既不是原串也不是合法掩码。
 *   这里把引号当**定界符**留在原位，只掩码里面的地址部分：
 *   `"quoted local"@example.com` ⇒ `"q***@example.com"`。
 */
export function scrubEmails(text: string): string {
  const quote = String.fromCharCode(DOUBLE_QUOTE);
  let out = '';
  let cursor = 0;

  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    /**
     * 起点。向左吃完地址字符；引号是边界，因此**带引号的 local-part 会停在收尾引号上**
     * （`"quoted local"@example.com` 停在 `local` 之后那个引号），这种情况再往前找配对的
     * 起始引号。引号本身不参与掩码，只被原样保留（见下面的 `leading`/`trailing`）。
     */
    let start = climbLeft(text, at - 1);
    if (text.charCodeAt(start - 1) === DOUBLE_QUOTE) {
      const openAt = text.lastIndexOf(quote, start - 2);
      if (openAt >= 0) start = openAt;
    }

    /**
     * 结束位置。**收尾引号可能出现在 `@` 的右边**（引号只包住 local-part 的形态），
     * 所以向右扫要看一眼引号后面还有没有地址字符：有就继续吃，没有就停在引号处。
     */
    let end = climbRight(text, at + 1);
    if (text.charCodeAt(end) === DOUBLE_QUOTE) {
      const afterQuote = climbRight(text, end + 1);
      // 引号后还有地址字符（形态 2：引号只包住 local-part）：继续吃，收尾引号留在中间；
      // 否则（形态 1：引号包住整个地址）把收尾引号也纳入区间，好让下面把它识别为 trailing。
      end = afterQuote > end + 1 ? afterQuote : end + 1;
    }

    // 空 local-part（`@example.com`）或空域名（`a@`）：不是地址，跳过。
    // `at + 1` 保证循环继续向前，不会停在同一处。
    if (start >= at || end <= at + 1 || start < cursor) continue;

    /**
     * 掩码的输入**不含首尾引号**，引号原样保留在输出里。
     *
     * `maskEmail` 对两种引号形态都会出错：
     * 1. **包住整个地址**：`"victim@example.com"` —— 若把引号一起交给它，它会把起始引号
     *    当成「首字符」保留，得到 `""***@example.com""`；
     * 2. **包住 local-part**（RFC 5321 quoted-string）：`"quoted local"@example.com` ——
     *    若直接交给它，`quoted` 会原样留在输出里（`"quoted local"***@example.com`）。
     *
     * 两种形态被同一条规则盖住：去掉**首尾**那对引号 ⇒ 掩码 ⇒ 把引号放回去。
     * 形态 2 中间的那个引号（收尾引号）留在输入里不用管——`maskEmail` 只看首字符与 `@` 的位置。
     */
    const span = text.slice(start, end);
    const leading = span.charCodeAt(0) === DOUBLE_QUOTE ? 1 : 0;
    const trailing = span.length > leading && span.charCodeAt(span.length - 1) === DOUBLE_QUOTE ? 1 : 0;
    const masked =
      (leading ? quote : '') +
      maskEmail(span.slice(leading, span.length - trailing)) +
      (trailing ? quote : '');

    out += text.slice(cursor, start) + masked;
    cursor = end;
  }

  return out + text.slice(cursor);
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
 * （走 `toJSON` → `this.getTime()`）。重建一个挂了自定义属性的 `Date`，产出的就是这样一个
 * 「原型对、槽位空」的对象。
 *
 * 修复轮 2 的复审指出：这里原先把这层后果写成「会让 pino 序列化时抛错」是**说过头了**——
 * pino 对坏对象的实际行为是 catch 住并降级成 `"[unable to serialize…]"` 字符串，
 * 不会把一条日志变成一次异常（已实测）。所以真正的代价是**可读性**而不是可用性：
 * 一个 `createdAt` 会从时间戳变成一行序列化失败标记。方向不变（整体透传、不重建），
 * 但别把它当成「不这么做就会 500」。
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
 * 4. **私有槽位（`#private` 字段）不在重建范围内**：`Object.create(proto)` 造出的副本没有
 *    那些槽位，因此副本上一个「读 `#x` 的 getter」会抛 `TypeError`。实测的后果**不是** 500——
 *    pino 会 catch 住并把它降级成 `"[unable to serialize…]"` 字符串（与 {@link OPAQUE_BUILTINS}
 *    那条同一机制）。代价是那一个字段变成不可读的标记，而不是日志失败。本阶段不解决它：
 *    要解决就得放弃「不修改调用方对象」这条承诺（改为就地求值），而那条承诺更重要。
 */
export function redact<T>(value: T): T {
  return redactWithContext(value, () => undefined) as T;
}

/**
 * 脱敏失败时抛出的错误：**带上出错的键名**（修复轮 2 的 Minor）。
 *
 * 为什么要专门有这么一个类型：`redact` 必须**读**每个属性才能脱敏它，因此「读」这一步
 * 抛出的异常（getter / Proxy）会带着**没有上下文**的原始消息冒到 `formatters.log`。
 * 而 `formatters.log` 的降级路径要把「什么坏了」写进 `redactFailed`——只知道
 * 「`Error: getter 爆炸`」还不够，得知道是**哪个键**（`hostile`）才能去修。
 *
 * 因此 `redactValue` / `redactObject` 里每一次属性访问都包在 try/catch 里，
 * 把原始异常挂在这上面（`cause`）并补上键名。**它仍然会抛**——reporter 的责任是记录，
 * 不是吞掉（吞掉就会在「不知道脱敏到哪一步」的情况下继续，那正是 fail-closed 要避免的）。
 */
export class RedactionError extends Error {
  constructor(
    /** 触发异常的键名（顶层或嵌套路径上的那一层）。 */
    readonly key: string,
    /** 键名不可知时（例如数组元素）传 `undefined`。 */
    override readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`脱敏时读取键「${key}」失败：${reason}`, { cause });
    this.name = 'RedactionError';
  }
}

function isRedactionError(err: unknown): err is RedactionError {
  return err instanceof RedactionError || (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'RedactionError' &&
    typeof (err as { key?: unknown }).key === 'string'
  );
}

/** 可选的「原始错误 → 脱敏错误」转换钩子（模块私有的扩展点，只有 logger 那一层用）。 */
type RedactErrorReporter = (err: unknown, key: string | undefined) => unknown;

/**
 * `redact` 的带钩子版本：`onKeyError` 决定「属性访问抛出的异常」变成什么再抛出。
 *
 * 唯一的生产调用方是 `logger.module.ts`（把原始错误换成 {@link RedactionError} 以便
 * `redactFailed` 里带上键名）。这个钩子是**模块私有**的扩展点，不进 `redact` 的公开签名——
 * 否则每个调用点都要考虑「我该传什么钩子」。
 */
export function redactWithContext<T>(value: T, onKeyError: RedactErrorReporter): T {
  const ctx: RedactContext = { seen: new Set<object>(), depth: 0, onKeyError };
  return redactValue(value, ctx) as T;
}

/** 递归上下文。把三个参数收成一个，是为了让「属性访问要包 try/catch」这条纪律只有一个落点。 */
interface RedactContext {
  seen: Set<object>;
  depth: number;
  onKeyError: RedactErrorReporter;
}

/**
 * 读取属性值，并把「读」这一步的异常转成**带键名**的错误。
 *
 * 为什么必须包住它：`redact` 的设计原则是「它自己炸掉等于把一条本该记下来的日志变成
 * 一次请求失败」，所以它的失败是**有意义的事件**——而一个不知道键名的失败几乎无法行动。
 */
function readKey(value: object, key: string, ctx: RedactContext): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch (err) {
    throw ctx.onKeyError(err, key);
  }
}

function redactValue(value: unknown, ctx: RedactContext): unknown {
  // 原始值与函数（`typeof 'function'`）不参与递归，也与深度无关
  if (value === null || typeof value !== 'object') return value;
  if (ctx.depth > MAX_DEPTH) return MAX_DEPTH_MARKER;

  if (Array.isArray(value)) {
    if (ctx.seen.has(value)) return CIRCULAR;
    ctx.seen.add(value);
    // 数组元素没有键名可言：位置索引不是「字段」，报出去只会误导（见 RedactionError 的说明）
    const out = value.map((item) => {
      try {
        return redactValue(item, { ...ctx, depth: ctx.depth + 1 });
      } catch (err) {
        if (isRedactionError(err)) throw err;
        throw ctx.onKeyError(err, undefined);
      }
    });
    ctx.seen.delete(value);
    return out;
  }

  if (isPlainObject(value)) {
    if (ctx.seen.has(value)) return CIRCULAR;
    ctx.seen.add(value);

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = redactEntry(key, readKey(value, key, ctx), ctx);
    }

    ctx.seen.delete(value);
    return out;
  }

  return redactObject(value, ctx);
}

/** 键级规则：黑名单 → 邮箱掩码 → 递归。普通对象与非普通对象共用同一条规则。 */
function redactEntry(key: string, value: unknown, ctx: RedactContext): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return REDACTED;
  if (key.toLowerCase().includes('email') && typeof value === 'string') return maskEmail(value);
  return redactValue(value, { ...ctx, depth: ctx.depth + 1 });
}

/**
 * 非纯对象（`Error`、类实例）的脱敏：**保留原型**重建，只碰自有属性。
 *
 * `seen` 的语义与纯对象分支一致：进入时加入、离开时移除，因此只检测**当前路径上的环**，
 * 同一个对象出现在两个兄弟分支仍会被完整脱敏。
 */
function redactObject(value: object, ctx: RedactContext): unknown {
  const enumerableKeys = Object.keys(value);
  // 没有自有可枚举属性 ⇒ 没有任何「挂在对象上的自定义字段」可脱敏 ⇒ 原样返回（保持引用）。
  // Date / Buffer / Map / Set / RegExp / 没有自定义字段的类实例都落在这里。
  if (enumerableKeys.length === 0 || isOpaqueBuiltin(value)) return value;

  if (ctx.seen.has(value)) return CIRCULAR;
  ctx.seen.add(value);

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
        value: readKey(value, key, ctx),
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
      value: redactEntry(key, readKey(value, key, ctx), ctx),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  ctx.seen.delete(value);
  return out;
}
