import { describe, it, expect } from 'vitest';
import { maskEmail, redact, scrubEmails } from '@vca/api/common/logging/redact.js';

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

  /**
   * `scrubEmails`：C11 的**字符串**那一层（修复轮 1 / Fix 2 把它搬到本模块）。
   *
   * 为什么它必须在这里有直接的用例：它此前是 `apps/worker/src/worker.ts` 的私有函数，
   * 现在有**两个**生产消费方——worker 的失败行与消费者写进 `outbox_events.last_error`
   * 的错误文本。搬到共享位置的全部理由就是「只存在一份」，因此这一份的行为必须被钉住：
   * 少了这些断言，将来任何一处「顺手改一下正则」都会静默地让另一边漏掉地址。
   */
  describe('scrubEmails（值里的邮箱）', () => {
    it('把文本里的地址换成掩码形式，域名保留', () => {
      expect(scrubEmails('550 5.1.1 <victim@example.com>: Recipient address rejected')).toBe(
        '550 5.1.1 <v***@example.com>: Recipient address rejected',
      );
      // 一条文本里出现多个地址：每一个都要被处理
      expect(scrubEmails('from a@x.com to b@y.com')).toBe('from a***@x.com to b***@y.com');
    });

    it('没有地址的文本原样返回（不得改动运维要看的内容）', () => {
      const plain = 'Mail command failed: 550 5.1.1 Recipient address rejected';
      expect(scrubEmails(plain)).toBe(plain);
      expect(scrubEmails('')).toBe('');
    });

    it('已知边界：MIME 编码字（=?utf-8?Q?...?=）完全漏掉，因为它里面没有字面量 @', () => {
      // 这条边界是**实测**的（不是猜的），钉在这里是为了让「缓解 vs 保证」的区别
      // 在代码里可见：改了正则就要同时改这里，而不是让保证悄悄变强。
      // 主防线始终是「不要把地址写进日志消息/错误文本」。
      expect(scrubEmails('=?utf-8?Q?victim=40example.com?=')).toBe('=?utf-8?Q?victim=40example.com?=');
    });

    /**
     * 修复轮 2 改正的那条：**带引号的 local-part 整段被掩码**。
     *
     * 此前这里钉的是「部分残留 / 地址被截断」，而**那个描述与实测都不符**（本轮逐字验过）：
     * 修复轮 1 的实现（`/[^\s<>()[\]{},;:'"]+@[^\s<>()[\]{},;:'"]+/g`）在
     * `550 "quoted local"@example.com rejected` 上**一个字符都没掩**，输出与输入逐字相同
     * ——**一个完整的地址穿过了 C11 那道过滤**。这比「部分残留」严重一档，
     * 也是本轮把它修掉的直接理由。
     *
     * 期望值一律用 `Q`（`String.fromCharCode(34)`）拼装，**不写字面量引号**：
     * 这个字符在本仓库的编辑流程里被替换成排版引号（U+201C/U+201D）过多次，而那种替换
     * **看不出来**却会让断言以「相差一个字符」的形式红掉（本轮实测踩到两次，
     * 其中一次还一度把我引向了「正则引擎行为不一致」的错误结论）。
     */
    const Q = String.fromCharCode(34);

    it('带引号的 local-part（RFC 5321 quoted-string）整段被掩码，不留残片', () => {
      const input = `550 ${Q}quoted local${Q}@example.com rejected`;
      // 引号是 RFC 的语法符号、不是地址的一部分。起始引号原样保留，`q` 是 `quoted` 的首字符。
      // 关键在于**完整地址不再出现**——旧实现只掩掉 `local"@example.com`，把 `quoted` 原样留下。
      expect(scrubEmails(input)).toBe(`550 ${Q}q***@example.com rejected`);
      expect(scrubEmails(`${Q}quoted local${Q}@example.com`)).toBe(`${Q}q***@example.com`);
      expect(scrubEmails(input)).not.toContain(`${Q}quoted local${Q}@example.com`);
      // 「域名前的部分被截断」那种描述是错的：真正的要求是 local-part 原样不再出现
      expect(scrubEmails(`${Q}quoted local${Q}@example.com`)).not.toContain('quoted local');
    });

    it('普通地址被引号/尖括号包起来时只脱敏地址本身，分隔符保留', () => {
      expect(scrubEmails(`${Q}victim@example.com${Q}`)).toBe(`${Q}v***@example.com${Q}`);
      expect(scrubEmails('RCPT TO:<user@example.com>')).toBe('RCPT TO:<u***@example.com>');
      expect(scrubEmails('a@x.com,b@y.com')).toBe('a***@x.com,b***@y.com');
    });

    it('mailto: 前缀不会被当成 local-part（`:` 是边界，前缀原样保留）', () => {
      // `:` 是分隔符 ⇒ 掩码只作用于 `victim@example.com`，前缀 `mailto:` 原样留下。
      // 若把 `:` 当成地址字符，被掩码的会是 `mailto:victim@example.com`，
      // 输出 `m***@example.com` 会把 `victim` 完整留在原处——同一个「掩码吃错了一段」的形态。
      const masked = scrubEmails('联系 mailto:victim@example.com 处理');
      expect(masked).toBe('联系 mailto:v***@example.com 处理');
      expect(masked, '完整地址仍然留在文本里（前缀保留是刻意的，地址必须被掩掉）').not.toContain(
        'victim@example.com',
      );
      expect(scrubEmails('MAILTO:Victim@Example.com')).toBe('MAILTO:V***@Example.com');
    });
  });
});
