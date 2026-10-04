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
 * （`x-session-id`）、URL 查询串或调试负载里。真正的运行期防线是「不要把它写进日志」
 * 与 pino 的 `req` 序列化器（只输出 `method`/`url`）——**本函数今天没有运行时调用方**，
 * 所以这两条不是「已经生效的过滤」，只是把 C11 的意图写进 deny-list：
 * 将来 `redact()` 被接进日志路径时，它们立刻生效。
 * 注意 `cookie` 已在列表中，因此 `req.headers.cookie` 这一类早已被挡。
 */
const REDACT_KEYS = [
  'password', 'passwordHash', 'password_hash', 'token', 'accessToken', 'refreshToken',
  'authorization', 'cookie', 'set-cookie', 'secret', 'clientSecret', 'apiKey',
  'sessionId', 'session_id',
  'proxyCeiling', 'proxy_ceiling',
];

/** 邮箱只保留首字符与域名，如 `a***@example.com`。无 `@` 或 `@` 在首位时退化为 `***`。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** 环引用替身（见下方「环」一节）：降级成可读的值，而不是抛出 `RangeError`。 */
const CIRCULAR = '[Circular]';

/** 只把**纯对象**（`Object.prototype` 或 `null` 原型）当作可以下钻的记录，见「边界」。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 递归脱敏。三类处理：
 * 1. 键名命中 `REDACT_KEYS` → `[REDACTED]`；
 * 2. 键名含 `email` 且值是字符串 → `maskEmail`（这是「完整邮箱不入日志」的落点）；
 * 3. 纯对象与数组 → 递归下钻。
 *
 * ## 边界：只下钻纯对象与数组，其余值**原样返回**（修复轮 1 更正）
 *
 * 上一版对所有「`typeof === 'object'`」的值一律 `Object.entries()` 重建，结果是把
 * **非纯对象压成 `{}`**——实测（见报告 §11 探针 B）：
 *
 * - `redact({ createdAt: new Date() })` → `{"createdAt":{}}`：`Date` 的数据在内部槽位，
 *   不是自有可枚举属性，于是时间戳被静默吃掉。**Prisma 返回的正是 `Date`**
 *   （`createdAt` / `updatedAt`），Task 8 的审计负载一旦过上一步就永久丢失时间；
 * - `redact({ err: new Error('boom') })` → `{"err":{}}`：`message` / `stack` 同理丢失；
 * - 环引用直接 `RangeError: Maximum call stack size exceeded`。
 *
 * 这与「脱敏不该改变普通值的形状」这条承诺直接冲突，所以现在只递归**纯对象**与数组：
 * `Date`、`Error`、`Buffer`/TypedArray、`Map`/`Set`、`RegExp`、类实例等一律原样返回
 * （引用不变，调用方拿到的是同一个对象）。这条边界的**代价据实写在下面**，不靠注释免责。
 *
 * ## 环：沿当前路径去重，命中即替成 `[Circular]`
 *
 * `seen` 集合在**进入**节点时加入、**离开**时移除，因此它检测的是「当前路径上的环」，
 * 而不是「见过的所有对象」——同一个对象出现在两个兄弟分支（DAG，很常见）仍会被完整脱敏，
 * 只有真正的环才降级。降级而不是抛错：脱敏是日志路径上的最后一道工序，
 * 它自己炸掉等于把一条本该记下来的日志变成一次 500。
 *
 * ## 两处诚实的局限
 *
 * 1. 它**只认键名**，值里的敏感信息（如 URL query 上的 token）不会被它发现——
 *    所以脱敏不是唯一防线，另一道是「不要把这些东西放进日志」。
 * 2. 非纯对象是**整体透传**的：若某个类实例自己带 `password` 字段，这里不会屏蔽它。
 *    传进来的应当是日志安全的**纯数据**（Prisma 的结果就是纯对象 + `Date`）。
 *    若将来确实要脱敏类实例，正确做法是在调用方把它摊平，而不是让本函数去猜
 *    任意对象的可枚举属性（那正是上面三个缺陷的来源）。
 */
export function redact<T>(value: T): T {
  return redactValue(value, new Set<object>()) as T;
}

function redactValue(value: unknown, seen: Set<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    const out = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return out;
  }

  if (!isPlainObject(value)) return value;

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEYS.some((rk) => k.toLowerCase() === rk.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (k.toLowerCase().includes('email') && typeof v === 'string') {
      out[k] = maskEmail(v);
    } else {
      out[k] = redactValue(v, seen);
    }
  }

  seen.delete(value);
  return out;
}
