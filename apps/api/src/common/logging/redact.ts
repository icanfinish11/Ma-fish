/** 日志脱敏（C11 / 威胁 #15）：绝不记录令牌、密码、完整邮箱。 */

/**
 * 键名**黑名单**（大小写不敏感）。命中即整值替换为 `[REDACTED]`，不做部分保留。
 *
 * `proxyCeiling` / `proxy_ceiling` 目前**还没有对应字段**（代理出价的密封上限，
 * 威胁 #6：「任何界面，含管理端，都不得暴露」）。这里是**提前放进黑名单**，
 * 而不是提前造抽象：黑名单条目是 deny-list 的一项，成本为零；
 * 将来漏了它的代价却是一封密封标价被打进日志。故保留。
 */
const REDACT_KEYS = [
  'password', 'passwordHash', 'password_hash', 'token', 'accessToken', 'refreshToken',
  'authorization', 'cookie', 'set-cookie', 'secret', 'clientSecret', 'apiKey',
  'proxyCeiling', 'proxy_ceiling',
];

/** 邮箱只保留首字符与域名，如 `a***@example.com`。无 `@` 或 `@` 在首位时退化为 `***`。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * 递归脱敏。三类处理：
 * 1. 键名命中 `REDACT_KEYS` → `[REDACTED]`；
 * 2. 键名含 `email` 且值是字符串 → `maskEmail`（这是「完整邮箱不入日志」的落点）；
 * 3. 其余递归下钻（数组与对象）。
 *
 * 注意：它**只认键名**，值里的敏感信息（如 URL query 上的 token）不会被它发现——
 * 所以脱敏不是唯一防线，另一道是「不要把这些东西放进日志」。
 */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.some((rk) => k.toLowerCase() === rk.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else if (k.toLowerCase().includes('email') && typeof v === 'string') {
        out[k] = maskEmail(v);
      } else {
        out[k] = redact(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}
