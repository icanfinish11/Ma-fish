import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { runInContext } from '@vca/api/common/context/request-context.js';
import { buildLoggerOptions, type LoggerEnv } from '@vca/api/common/logging/logger.module.js';

/**
 * 验收 13.4（trace id 贯穿同一请求的所有日志）的**可观测**证明（修复轮 1）。
 *
 * ## 为什么不能用「跑一遍应用再看日志」
 *
 * 测试期是静音的（Ruling 3），而 pino 的 `silent` 会把六个 level 方法整体换成 `noop`
 * （`lib/levels.js`），`mixin` 只在写入路径里求值（`lib/proto.js`）——所以静音下
 * **根本不会构造任何日志记录**，`mixin` 一次也不跑。在静音期断言「日志里有 traceId」，
 * 断言对象是一个空集合，`logs.every(...)` 之类的写法必然通过：这就是假绿。
 *
 * ## 这里的做法
 *
 * 用 `buildLoggerOptions` 这**同一份**生产配置，在内存 destination 上造一个真实 pino 实例，
 * 把日志调用放在 `runInContext()` 的 ALS 作用域里，然后断言**实际写出的那一行**。
 * 关键顺序：先断言捕获非空，再断言内容——空捕获会先在这里失败，而不是让下面的断言空转。
 */
function capture(env: LoggerEnv) {
  const lines: string[] = [];
  const logger = pino(buildLoggerOptions(env), {
    write: (line: string) => {
      lines.push(line);
    },
  });
  return { logger, lines };
}

function onlyRecord(lines: string[]): Record<string, unknown> {
  // 非空（且恰好一行）断言必须排在解析之前：否则整个用例可以对着空数组「通过」
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('trace id 贯穿（§3.5 / 验收 13.4）—— 真实 pino 实例上可观测', () => {
  it('ALS 上下文内产生的日志，写出的记录带同一个 traceId', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });

    runInContext({ traceId: 'trace-thread-1' }, () => {
      logger.info('handler log');
    });

    const record = onlyRecord(lines);
    expect(record.traceId).toBe('trace-thread-1');
    expect(record.msg).toBe('handler log');
  });

  it('上下文里设了 userId 时一并带上（审计需要「谁做的」）', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });

    runInContext({ traceId: 'trace-thread-2', userId: 'user-42' }, () => {
      logger.info('audited action');
    });

    const record = onlyRecord(lines);
    expect(record.traceId).toBe('trace-thread-2');
    expect(record.userId).toBe('user-42');
  });

  it('上下文之外不写 traceId（证明该字段真的来自 ALS，而不是写死的常量）', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });

    logger.info('bootstrap log');

    const record = onlyRecord(lines);
    expect(record.traceId).toBeUndefined();
    expect(record.userId).toBeUndefined();
  });

  it('NODE_ENV=test 时同一构造器仍然静音——静音是默认，不得为了测试方便被关掉', () => {
    const { logger, lines } = capture({ NODE_ENV: 'test' });

    runInContext({ traceId: 'trace-thread-3' }, () => {
      logger.info('dropped');
    });

    // 与上面三条相反方向的断言：这里**要求**捕获为空。
    // 它把 Ruling 3 的静音默认钉在同一处，防止「把 level 改成 info 让断言好写」这种漂移。
    expect(lines).toEqual([]);
  });
});

/**
 * `formatters.log: redact` 的接线（Task 8 / C11）。
 *
 * ## 为什么这条用例必须存在
 *
 * Task 4 的复审指出：`maskEmail` 与 `REDACT_KEYS` 此前**没有任何生产调用方**——
 * 「键名含 email 的字符串值走掩码」这条 C11 子句只被单元测试逐字钉住，却不在任何一条
 * 真实链路上。Task 4 把「接进 `formatters.log`」转派给 Task 8，并写明**顺序依赖**：
 * 必须先有保形（`Date` 不变 `{}`）且防环/防深的 `redact`，否则接线的同时就引入两个新故障。
 *
 * 因此下面的断言分两层：
 * - 「脱敏真的生效」（密码/令牌/邮箱）——没有接线时必红；
 * - 「`Date`/环/超深负载活着」——它证明的正是上面那条顺序依赖：把实现换回旧版
 *   （对所有 `typeof === 'object'` 一律重建）时，`createdAt` 会变成 `{}`（已实测，见报告探针）。
 */
describe('formatters.log 上的脱敏（C11 / Task 8 接线）', () => {
  it('审计形状的负载：Prisma 的 Date 活着，密码/令牌/邮箱被脱敏', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });
    const createdAt = new Date('2026-10-04T00:00:00.000Z');

    logger.info(
      {
        action: 'auth.login',
        resource: 'user',
        resourceId: 'u-1',
        createdAt, // Prisma 返回的就是 Date：旧实现把它压成 {}，时间戳静默消失
        metadata: { email: 'alice@example.com', password: 'p@ss', sessionId: 'sess-1', attempts: 3 },
      },
      'audit probe',
    );

    const record = onlyRecord(lines);
    expect(record.createdAt, 'Date 被脱敏吃掉了（旧实现在这里会变成 {}）').toBe(
      '2026-10-04T00:00:00.000Z',
    );
    expect(record.metadata).toEqual({
      email: 'a***@example.com',
      password: '[REDACTED]',
      sessionId: '[REDACTED]',
      attempts: 3,
    });
    // 整行里不得出现完整地址（这一条是 C11 的字面要求）
    expect(lines[0]).not.toContain('alice@example.com');
  });

  it('环与超深负载在**日志路径上**降级，而不是把一次日志变成一次异常', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });
    const cyclic: Record<string, unknown> = { id: 'n1', token: 'secret-token' };
    cyclic.self = cyclic;
    // 40 层互不相同的嵌套（环守卫看不见它，只有深度上界能挡住）
    let deep: Record<string, unknown> = { level: 40 };
    for (let i = 0; i < 40; i++) deep = { next: deep };

    logger.info({ cyclic, deep }, 'degradation probe');

    const record = onlyRecord(lines);
    const cyclicOut = record.cyclic as Record<string, unknown>;
    expect(cyclicOut.token, '环上的敏感字段没有脱敏').toBe('[REDACTED]');
    expect(cyclicOut.self, '环没有降级成 [Circular]').toBe('[Circular]');

    let cursor: unknown = record.deep;
    while (cursor !== null && typeof cursor === 'object' && 'next' in cursor) {
      cursor = (cursor as { next: unknown }).next;
    }
    expect(cursor, '超深负载没有降级成 [MaxDepth]（只有 redact 会产出这个标记）').toBe('[MaxDepth]');
  });

  it('req/res 不进脱敏遍历，但也不因此泄露请求头（序列化器是另一半）', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });
    let headerReads = 0;
    const req = {
      method: 'GET',
      url: '/probe',
      get headers(): Record<string, string> {
        headerReads++;
        return { cookie: 'sid=SUPER-SECRET', authorization: 'Bearer SUPER-SECRET' };
      },
    };
    const res = { statusCode: 200 };

    logger.info({ req, res, password: 'p' }, 'request probe');

    const record = onlyRecord(lines);
    // ① 序列化器把它们压成方法/路径/状态码——「不遍历也不泄露」的另一半，删掉序列化器这里就红
    expect(record.req).toEqual({ method: 'GET', url: '/probe' });
    expect(record.res).toEqual({ statusCode: 200 });
    expect(lines[0]).not.toContain('SUPER-SECRET');
    // ② 没有被拖进脱敏遍历：实测一棵真实 req/res 图约 637 个节点、每次 ~250µs，
    //    而结果会被序列化器的输出整个替换掉。`headers` 是自有可枚举的访问器，
    //    一旦遍历就会把它读出来（1 次），因此这个计数是判别性的。
    expect(headerReads, 'req 被拖进了脱敏遍历（每条请求日志约 250µs 的无效工作）').toBe(0);
  });

  it('脱敏自己失败时不让**日志调用**炸掉：丢弃负载、保留 traceId（降级而不是抛错）', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });
    // 一个会抛的 getter：`redact` 必须读它才能脱敏它，于是「读」这一步就会抛。
    // 这类负载不是假想——任何第三方对象、带 getter 的模型、被代理过的对象都可能这样。
    const hostile = {
      get boom(): string {
        throw new Error('getter 爆炸');
      },
    };

    runInContext({ traceId: 'trace-redact-degrade' }, () => {
      logger.info({ hostile, password: 'p@ss' }, 'hostile probe');
    });

    // 关键：上面这一行**没有抛**。redact 的设计原则是「它自己炸掉等于把一条本该记下来的日志
    // 变成一次请求失败」，因此这里必须降级：负载整体丢弃（fail-closed，不知道脱敏到哪一步了），
    // 但关联信息（traceId/userId，来自 mixin 的 ALS 上下文）保留（fail-open，可观测性优先）。
    const record = onlyRecord(lines);
    expect(record.traceId).toBe('trace-redact-degrade');
    expect(record.redactFailed, '降级这件事本身必须可见，否则「负载没了」无从解释').toBeTruthy();
    expect(record.password, '负载没有被丢弃：降级路径不得把未脱敏的数据写出去').toBeUndefined();
    expect(lines[0]).not.toContain('p@ss');
  });

  /**
   * **报告路径自己也不能炸**（最终评审 I-7）。
   *
   * 上面几条用的都是「正常的」抛出值（`Error`、带 getter 的对象），因此它们证明不了
   * 降级路径在**恶意形状**下的行为。而 `failureReason` 里每一句都在读那个抛出值：
   * `instanceof Error` 会触发 `getPrototypeOf`、`String(err)` 会调 `toString`、
   * `err instanceof RedactionError` 又会再来一次原型查找。任一处抛出，
   * 「报告失败」就变成新的失败：`logger.info(...)` 的调用点收到异常（请求里就是 500），
   * 而收到的诊断是零——比上面那条「丢掉负载」严重一档。
   *
   * 三种形态各一条：
   * 1. `getPrototypeOf` 陷阱抛出的**代理**（`instanceof` 与原型读取都会中招）；
   * 2. `toString` 会抛的**非 Error**（`String(err)` 中招）——这是评审点名的形态；
   * 3. 构造 `RedactionError` 时那个 `cause` 是敌意值（`new RedactionError(...)` 自己不能炸，
   *    否则 `readKey` 的 catch 会变成 re-throw）。
   *
   * 判据是「这一行没有抛」+「redactFailed 仍然写出来了」：只有前者时，
   * 一个「把 redactFailed 也一起丢掉」的实现会照样通过。
   */
  it('抛出值是敌意代理（getPrototypeOf 陷阱会抛）时，日志调用不抛且降级标记仍写出', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });
    // 陷阱抛出的**本身又是一个敌意值**：于是连 `instanceof`（它要读原型）都会抛，
    // 报告路径读不到 name/message，只能退化成类型名——但那仍然是「没有抛」。
    const hostileThrown = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error('不该被调用的原型陷阱');
        },
        get(): never {
          throw new Error('不该被调用的属性陷阱');
        },
      },
    );
    const hostile = new Proxy(
      { id: 'n1' },
      {
        getPrototypeOf(): never {
          throw hostileThrown;
        },
      },
    );

    expect(() => {
      runInContext({ traceId: 'trace-redact-hostile-proxy' }, () => {
        logger.info({ hostile }, 'hostile proxy probe');
      });
    }, '报告脱敏失败的那段代码自己抛了：一次日志调用变成一次请求失败').not.toThrow();

    const record = onlyRecord(lines);
    expect(record.traceId).toBe('trace-redact-hostile-proxy');
    expect(record.redactFailed, '降级标记没有写出来（负载已经丢了，连线索也丢了）').toBeTruthy();
  });

  it('抛出值的 toString 会抛（非 Error）时，日志调用同样不抛', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });
    const throwingToString = {
      toString(): never {
        throw new Error('toString 陷阱');
      },
    };
    const hostile = new Proxy(
      { id: 'n2' },
      {
        getPrototypeOf(): never {
          throw throwingToString;
        },
      },
    );

    expect(() => {
      runInContext({ traceId: 'trace-redact-hostile-tostring' }, () => {
        logger.info({ hostile }, 'hostile toString probe');
      });
    }, '`String(err)` 的抛出没有被兜住：报告路径自己变成了新的异常').not.toThrow();

    const record = onlyRecord(lines);
    expect(record.redactFailed).toBeTruthy();
    expect(record.password ?? 'absent', '降级路径把未脱敏的负载写了出来').toBe('absent');
  });

  it('RedactionError 的 cause 是敌意值时，构造它不抛且键名仍然保留', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });
    const hostileCause = {
      toString(): never {
        throw new Error('cause 的 toString 陷阱');
      },
    };
    // 这条走的是「readKey 捕获 → 钩子构造 RedactionError」那条真实路径：
    // `new RedactionError(key, cause)` 若去 `String(cause)` 就会在 catch 里再抛一次。
    const payload = {
      get boom(): string {
        throw hostileCause;
      },
    };

    expect(() => {
      logger.info({ payload }, 'hostile cause probe');
    }, 'RedactionError 的构造函数抛了：readKey 的 catch 变成了 re-throw').not.toThrow();

    const record = onlyRecord(lines);
    const marker = record.redactFailed as string;
    expect(marker, '键名丢了：运维无法定位是哪个字段坏了').toContain('@boom');
    expect(marker, 'cause 的描述崩了，标记里应当退化成类型名').toContain('RedactionError');
  });

  /**
   * 修复轮 2 的 Minor：降级标记必须**可据以行动**。
   *
   * 此前 `redactFailed` 只放错误的类名，而对一个普通 `Error` 那就是字面量 `"Error"`——
   * 运维看到「脱敏失败了」，却不知道**什么**抛的、也不知道是**哪个键**触发的。
   * 现在它有三段：名称、截断后的消息、`@键名`。
   *
   * 额外的两条要求都是**安全**要求，不是可读性偏好：
   * - 消息必须过 `scrubEmails`——降级路径恰恰是「没能完成脱敏」的那条路，它更没有资格
   *   把未脱敏文本写出去，而异常消息是最容易夹带地址的地方；
   * - 消息必须截断——这个字段是线索，不是错误档案。
   */
  it('降级标记带上出错的键名与消息，且消息本身也脱敏、有长度上界', () => {
    const { logger, lines } = capture({ NODE_ENV: 'development' });
    const hostile = {
      // 要害：异常消息里带着一个收件人地址（这是真实形态：SMTP 的拒绝消息就长这样）
      get hostileKey(): string {
        throw new Error(`550 5.1.1 <victim@example.com> rejected: ${'x'.repeat(500)}`);
      },
    };

    runInContext({ traceId: 'trace-redact-detail' }, () => {
      logger.info({ hostile }, 'detail probe');
    });

    const record = onlyRecord(lines);
    const marker = record.redactFailed as string;

    expect(marker, '标记里没有出错的消息（只写 "Error" 等于没写）').toContain('rejected');
    expect(marker, '标记里没有出错的键名，运维无法定位是哪个字段').toContain('@hostileKey');
    expect(marker, '标记里出现了完整地址：降级路径也没有资格写出未脱敏文本').not.toContain(
      'victim@example.com',
    );
    expect(marker, '标记里应当保留可读的掩码形式').toContain('v***@example.com');
    // 截断：500 个 x 不该原样进日志（120 字符的消息上界 + 名称/键名的固定前缀）
    expect(marker.length, '降级标记没有长度上界').toBeLessThan(300);
  });
});
