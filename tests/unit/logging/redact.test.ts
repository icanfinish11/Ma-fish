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

  /**
   * 下面四条是 **Task 8 的 Ruling 3 前置加固**（修复轮 2 复审留下的两条 deferred minor）。
   *
   * 上一条「非纯对象原样返回」的边界救回了 `Date`/`Error` 的值，代价是**缩小了键访问面**：
   * `err.token = 'x'` 或类实例的 `password` 字段**不再被访问**。今日无生产调用方故不泄漏，
   * 但 Task 8 一旦把 `redact` 接进 `formatters.log`，缺口立即生效——所以接线**之前**
   * 必须先补上，而不允许「先接线、以后再修」（那会让「已修」与「已生效」之间出现空窗）。
   *
   * 另两条：深度上界（非环的极深嵌套仍会爆栈）与会话 id 的 deny-list 常驻断言
   * （`sessionId` 是完整 bearer 凭证，此前只在代码里、没有测试钉住）。
   */
  it('sessionId / session_id 在黑名单内（会话 id 即 bearer 凭证，C11）', () => {
    expect(redact({ sessionId: 'sess-1' })).toEqual({ sessionId: '[REDACTED]' });
    expect(redact({ session_id: 'sess-1' })).toEqual({ session_id: '[REDACTED]' });
  });

  it('Error 的**自有可枚举**属性同样被脱敏，且 message/stack 不丢', () => {
    const err = new Error('认证失败') as Error & Record<string, unknown>;
    err.token = 'gho_secret';
    err.actorEmail = 'alice@example.com';

    const out = redact({ err });

    // 仍是 Error（原型保留 ⇒ pino 的 err 序列化器仍认它），message/stack 一个字不少
    expect(out.err).toBeInstanceOf(Error);
    expect(out.err.message).toBe('认证失败');
    expect(out.err.stack).toBeTruthy();
    // 挂在 Error 上的敏感字段不能再直通
    const seen = out.err as unknown as Record<string, unknown>;
    expect(seen.token).toBe('[REDACTED]');
    expect(seen.actorEmail).toBe('a***@example.com');
  });

  it('类实例的自有可枚举敏感字段被脱敏，且仍是该类实例（原型方法可用）', () => {
    class Session {
      constructor(
        public readonly id: string,
        public token: string,
      ) {}
      describe(): string {
        return `session:${this.id}`;
      }
    }
    const session = new Session('s-1', 'secret-token');

    const out = redact({ session });

    expect(out.session).toBeInstanceOf(Session);
    expect(out.session.describe(), '原型被丢掉：类实例被压成了普通对象').toBe('session:s-1');
    expect(out.session.token).toBe('[REDACTED]');
  });

  it('挂了自定义属性的 Date 不被重建（假 Date 会让 pino 序列化时抛错）', () => {
    const createdAt = new Date('2026-10-04T00:00:00.000Z');
    (createdAt as unknown as Record<string, unknown>).note = 'x';

    const out = redact({ createdAt });

    // 内部槽位类型整体透传：宁可漏掉挂上去的自定义字段，也不能造出一个 `getTime()` 会抛的
    // 假 Date —— `JSON.stringify` 正是走 `toJSON` → `getTime()`，那会把脱敏变成一次日志失败。
    expect(out.createdAt).toBe(createdAt);
    expect(out.createdAt.getTime()).toBe(createdAt.getTime());
    expect(JSON.stringify(out.createdAt)).toBe('"2026-10-04T00:00:00.000Z"');
  });

  it('非环的极深嵌套不爆栈：超过上界处降级为 [MaxDepth]', () => {
    // 20 万层**互不相同**的嵌套对象（没有任何环，环守卫看不见它）。
    const DEPTH = 200_000;
    let deep: Record<string, unknown> = { token: 'x' };
    for (let i = 0; i < DEPTH; i++) deep = { next: deep };

    const out = redact(deep);

    let cursor: unknown = out;
    let levels = 0;
    while (cursor !== null && typeof cursor === 'object' && 'next' in cursor) {
      cursor = (cursor as { next: unknown }).next;
      levels++;
    }
    expect(cursor, '没有深度上界：要么爆栈抛出 RangeError，要么一路递归下去').toBe('[MaxDepth]');
    expect(levels, '深度上界应当是个小常数，而不是 20 万').toBeLessThan(200);
  });
});
