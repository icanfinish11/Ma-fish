import { describe, it, expect } from 'vitest';
import { maskEmail, redact } from '@vca/api/common/logging/redact.js';

/**
 * C11（日志绝不记录令牌/密码/完整邮箱）与威胁 #6（密封出价上限）的**常驻回归**。
 *
 * 为什么 brief 没写这个文件我仍然要加：`REDACT_KEYS` 目前只是一份常量清单，
 * 没有任何测试指向它——删掉任意一行都不会变红。而它守护的东西（令牌、密码、
 * 密封出价上限）恰好是「泄露一次就无法挽回」的那一类。按本项目既有标准
 * （安全控制必须被测试强制，而不是靠注释与自觉），这里把它钉住。
 */
describe('日志脱敏（C11 / 威胁 #15）', () => {
  it('maskEmail 只保留首字符与域名', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    // 域名部分与 `+` 别名原样保留：定位问题靠它，泄露身份不靠它
    expect(maskEmail('bob.smith+tag@mail.example.co')).toBe('b***@mail.example.co');
  });

  it('maskEmail 对无法解析的输入退化为 ***', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
  });

  it('黑名单键名整值替换，且大小写不敏感', () => {
    expect(
      redact({
        password: 'p@ssw0rd',
        passwordHash: '$2b$12$abcdef',
        accessToken: 'gho_xxx',
        Authorization: 'Bearer abc',
        cookie: 'sid=1',
        clientSecret: 'shhh',
        apiKey: 'k-1',
      }),
    ).toEqual({
      password: '[REDACTED]',
      passwordHash: '[REDACTED]',
      accessToken: '[REDACTED]',
      Authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      clientSecret: '[REDACTED]',
      apiKey: '[REDACTED]',
    });
  });

  it('proxyCeiling / proxy_ceiling 在黑名单内（威胁 #6：密封出价上限永不入日志）', () => {
    expect(redact({ proxyCeiling: 12_345 })).toEqual({ proxyCeiling: '[REDACTED]' });
    expect(redact({ proxy_ceiling: 12_345 })).toEqual({ proxy_ceiling: '[REDACTED]' });
  });

  it('键名含 email 的字符串值走掩码，非字符串值不误伤', () => {
    expect(redact({ email: 'alice@example.com' })).toEqual({ email: 'a***@example.com' });
    expect(redact({ contactEmail: 'bob@example.com' })).toEqual({ contactEmail: 'b***@example.com' });
    expect(redact({ emailVerified: true })).toEqual({ emailVerified: true });
  });

  it('嵌套对象与数组递归生效（漏一层就等于没脱敏）', () => {
    expect(
      redact({ user: { email: 'alice@example.com', password: 'x' }, sessions: [{ token: 't' }, 'plain'] }),
    ).toEqual({
      user: { email: 'a***@example.com', password: '[REDACTED]' },
      sessions: [{ token: '[REDACTED]' }, 'plain'],
    });
  });

  it('无敏感键时原样返回（不因脱敏改变普通值的形状）', () => {
    expect(redact({ id: 'x', n: 1, ok: true, nil: null })).toEqual({ id: 'x', n: 1, ok: true, nil: null });
  });

  /**
   * 下面五条是修复轮 1 补的。理由：上面那条「形状不变」只用了原始值（字符串/数字/布尔/null），
   * 因此它证明不了它声称的东西——旧实现把所有 `typeof === 'object'` 的值都重建一遍，
   * 这条断言照样全绿，而 `Date` 会变成 `{}`、`Error` 会丢掉 message、环引用会抛 `RangeError`。
   * 断言形状保持**必须拿非纯对象来断**。
   */
  it('Date 原样保留：Prisma 的 createdAt/updatedAt 不会被吃成 {}', () => {
    const createdAt = new Date('2026-10-04T00:00:00.000Z');

    const out = redact({ id: 'x', createdAt, nested: { updatedAt: createdAt } });

    expect(out.createdAt).toBeInstanceOf(Date);
    expect(out.createdAt).toBe(createdAt); // 连引用都不变，更别说值
    expect(out.createdAt.toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(out.nested.updatedAt).toBe(createdAt);
  });

  it('Error 原样保留：message 与 stack 不丢', () => {
    const err = new Error('boom');

    const out = redact({ err });

    expect(out.err).toBe(err);
    expect(out.err.message).toBe('boom');
    expect(out.err.stack).toBeTruthy();
  });

  it('Buffer / Map / Set 等非纯对象原样返回（不重建、不掏空）', () => {
    const buf = Buffer.from('abc');
    const map = new Map([['k', 'v']]);
    const set = new Set([1]);

    const out = redact({ buf, map, set });

    expect(out.buf).toBe(buf);
    expect(out.buf.toString()).toBe('abc');
    expect(out.map).toBe(map);
    expect(out.map.get('k')).toBe('v');
    expect(out.set).toBe(set);
  });

  it('环引用不抛 RangeError，命中处替成 [Circular]（脱敏自己不能把日志变成 500）', () => {
    const node: Record<string, unknown> = { id: 'n1', password: 'x' };
    node.self = node;

    const out = redact(node) as Record<string, unknown>;

    expect(out.id).toBe('n1');
    expect(out.password).toBe('[REDACTED]'); // 有环也照常脱敏
    expect(out.self).toBe('[Circular]');
  });

  it('同一对象出现在兄弟分支（DAG）不算环，两处都被完整脱敏', () => {
    const shared = { token: 't', email: 'alice@example.com' };

    const out = redact({ a: shared, b: shared });

    expect(out.a).toEqual({ token: '[REDACTED]', email: 'a***@example.com' });
    expect(out.b).toEqual({ token: '[REDACTED]', email: 'a***@example.com' });
  });

  it('数组自身的环同样降级为 [Circular]', () => {
    const arr: unknown[] = [1];
    arr.push(arr);

    const out = redact({ arr });

    expect(out.arr[0]).toBe(1);
    expect(out.arr[1]).toBe('[Circular]');
  });
});
