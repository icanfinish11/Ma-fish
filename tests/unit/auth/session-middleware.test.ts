import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  SessionMiddleware,
  describeVerificationFailure,
} from '@vca/api/modules/auth/session.middleware.js';
import type { SessionService } from '@vca/api/modules/auth/session.service.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { currentContext } from '@vca/api/common/context/request-context.js';
import { type ExpressNext, type ExpressRequest, type ExpressResponse } from '../../helpers/app.js';

/**
 * 会话中间件的**失败面**（修复轮 2）。
 *
 * ## 为什么这些断言必须存在
 *
 * `SessionMiddleware` 刻意「绝不自己拒绝请求」：`verify` 抛错时降级为「无身份」，
 * 由守卫按匿名处理（见该文件的四条硬约束）。这个降级本身是对的，但**分寸**在过去搞错了：
 * 一个 `catch {}` 把**所有**异常当成「Redis 不可达」，于是
 *
 * - `TypeError`（依赖被写坏、`verify` 里改名、注入了一个坏实例）；
 * - Redis 字段改名导致的结构性 bug；
 * - `verify` 内部的任何编程错误
 *
 * 与「Redis 真的宕机了」在外部表现上**完全一致**：每个用户都是 403，日志里一行都没有。
 * 那正是 Step 0 要消灭的静默失败形态，而且它还会让「伪造 cookie → 403」这条端到端证据
 * 变得不可判别（坏依赖同样给 403，见任务报告 §修复轮 2 对 §14.3.1 的更正）。
 *
 * 这里用**直接构造中间件 + 假 `SessionService`** 来覆盖这条路径，而不是走完整 HTTP 应用：
 * 要触发它必须让 `SessionService.verify` 抛出，而真实应用里那条依赖是接到 Redis 的
 * ——在集成层「制造一次 TypeError」只能靠替换 provider 或停掉容器，两者都又慢又不确定
 * （后者表现为连接错误，走的正是**另一个**分支）。直接构造让这条路径变成确定性的单测。
 *
 * ## 日志断言的边界（诚实记录）
 *
 * 中间件在 `NODE_ENV === 'test'` 时**不发**日志（理由见 `logVerificationFailure`：
 * 套件里「容器停掉后仍在收尾」是**故意**触发的降级，把它打成告警会让真正的失败淹在
 * 预期噪音里）。因此下面用 `vi.stubEnv('NODE_ENV', 'production')` 打开日志，
 * 让断言落在真实的那条分支上，而不是在测试里另走一条。
 */
describe('SessionMiddleware 的失败面（降级必须可观测）', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  /** 与 `session.service.ts` 的真实 id 形状相同（43 字符 base64url），用于「日志里没有它」。 */
  const SESSION_ID = 'A'.repeat(43);

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** 构造一个只带 cookie 的最小请求（中间件只读 `req.cookies`）。 */
  function reqWith(cookies: unknown): ExpressRequest {
    return { cookies } as unknown as ExpressRequest;
  }

  function fakeNext(): { fn: ExpressNext; called: () => boolean } {
    let called = false;
    const fn = (() => {
      called = true;
    }) as ExpressNext;
    return { fn, called: () => called };
  }

  /**
   * 与上一条几乎相同，但**在 `next()` 被调用的那一刻**抓一次 `currentContext()`。
   *
   * 为什么不能在外面 `await mw.use(...)` 之后再读：中间件把 `next()` 包在
   * `requestContext.run()` 里（见它的约束 4），而 `run()` 的作用域在回调返回时就结束。
   * 在外面读必然是 `undefined`——这不是产品缺陷，而是「ALS 的可见范围等于一次 `run()`
   * 作用域」这条既有事实。第一版断言正是那样写的，实测变红（据实记录）。
   * 在回调内取样同时**顺带证明**了这一点：上下文确实只在 `next()` 的执行期间可见。
   */
  function fakeNextCapturing(): { fn: ExpressNext; contextAtNext: () => unknown } {
    let seen: unknown;
    const fn = (() => {
      seen = currentContext();
    }) as ExpressNext;
    return { fn, contextAtNext: () => seen };
  }

  function middlewareWith(verify: (sessionId: string) => Promise<unknown>): SessionMiddleware {
    return new SessionMiddleware({ verify } as unknown as SessionService);
  }

  /**
   * `cookie-parser` 会把 `j:` 前缀的 cookie 解析成**对象/数组**，而
   * `as string | undefined` 只是让 tsc 闭嘴的断言，运行期照样把对象传给 `verify`：
   * 键会变成 `vca:sess:[object Object]`——更糟的是**多个请求会共用同一个键**，
   * 表现为随机的身份串线。因此必须是真实的 `typeof` 检查。
   */
  it('cookie 值不是字符串（j: 前缀的 JSON cookie）时按匿名处理，且不调用 verify', async () => {
    const verify = vi.fn(async () => ({ userId: 'someone-else', authAt: Date.now(), ip: '', userAgent: '' }));
    const mw = middlewareWith(verify);
    const next = fakeNext();

    await mw.use(reqWith({ [SESSION_COOKIE]: { userId: 'attacker-chosen' } }), {} as ExpressResponse, next.fn);

    expect(next.called()).toBe(true);
    // 关键：坏形状的值**根本不该到达**存储层（否则会与别的请求撞键）
    expect(verify).not.toHaveBeenCalled();
    expect(currentContext()).toBeUndefined();
  });

  /** 形状合法的 cookie 仍然照常工作——上一条不是靠「一律忽略 cookie」通过的。 */
  it('字符串 cookie 正常走到 verify，并把身份写进上下文', async () => {
    const verify = vi.fn(async () => ({ userId: 'u-1', authAt: Date.now(), ip: '', userAgent: '' }));
    const mw = middlewareWith(verify);
    const next = fakeNextCapturing();

    await mw.use(reqWith({ [SESSION_COOKIE]: SESSION_ID }), {} as ExpressResponse, next.fn);

    expect(verify).toHaveBeenCalledWith(SESSION_ID);
    // 在 `next()` **内部**取样（理由见 `fakeNextCapturing`）：没有外层 TraceMiddleware 时
    // traceId 兜底为 '-'，身份字段被补上，且上下文是**继承**出来的新对象。
    expect(next.contextAtNext()).toMatchObject({ userId: 'u-1', sessionId: SESSION_ID, traceId: '-' });
    // 离开 `run()` 作用域后上下文消失——ALS 的既有语义，顺带钉住「上下文不是全局可变状态」
    expect(currentContext()).toBeUndefined();
  });

  /**
   * **本文件的核心断言**：一个非连接类异常（依赖写坏、改名、内部 bug）必须留下日志行，
   * 同时仍然降级（放行 + 无身份）。
   */
  it('verify 抛 TypeError 时留日志、仍然降级为匿名（不是静默 403）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const mw = middlewareWith(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'userId')");
    });
    const next = fakeNext();

    await mw.use(reqWith({ [SESSION_COOKIE]: SESSION_ID }), {} as ExpressResponse, next.fn);

    // 1) 可观测：一条 warn，且带上异常类型与消息，便于定位
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('TypeError');
    expect(line).toContain("reading 'userId'");

    // 2) C11：日志行里**不得**出现会话 id（它就是完整的 bearer 凭证）
    expect(line).not.toContain(SESSION_ID);
    // 整次调用的所有参数都不含它（防止有人把 req 或错误上下文塞进第二个参数）
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SESSION_ID);

    // 3) 仍然降级：放行，且没有把任何身份写进上下文（守卫据此判匿名）
    expect(next.called()).toBe(true);
    expect(currentContext()).toBeUndefined();
  });

  /**
   * 连接类错误走**同一个**降级路径，日志照旧——「可观测」不区分错误种类，
   * 因为区分种类的判据本身会漂移（`ECONNREFUSED` 今天不代表 Redis 宕机，
   * 明天也可能来自别的故障）。运维需要看到的是「会话校验在失败」这件事本身。
   */
  it('连接类错误（ECONNREFUSED）同样留日志并降级', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const mw = middlewareWith(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' });
    });
    const next = fakeNext();

    await mw.use(reqWith({ [SESSION_COOKIE]: SESSION_ID }), {} as ExpressResponse, next.fn);

    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('ECONNREFUSED');
    expect(line).not.toContain(SESSION_ID);
    expect(next.called()).toBe(true);
    expect(currentContext()).toBeUndefined();
  });

  /**
   * 测试环境**刻意静音**（见 `logVerificationFailure` 的理由）。
   * 这条断言把该行为钉住，免得将来有人「顺手」删掉那个早退导致套件输出变脏。
   */
  it('NODE_ENV=test 时静音（套件输出 pristine 的代价，是刻意的）', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const mw = middlewareWith(async () => {
      throw new TypeError('boom');
    });
    const next = fakeNext();

    await mw.use(reqWith({ [SESSION_COOKIE]: SESSION_ID }), {} as ExpressResponse, next.fn);

    expect(warn).not.toHaveBeenCalled();
    expect(next.called()).toBe(true);
  });

  /** 没有 cookie / 空 cookie 一律放行且**零** Redis 往返（中间件的既有契约）。 */
  it('没有 cookie 或值为空时不调用 verify，直接放行', async () => {
    const verify = vi.fn(async () => ({ userId: 'u', authAt: 0, ip: '', userAgent: '' }));
    const mw = middlewareWith(verify);

    const a = fakeNext();
    await mw.use(reqWith(undefined), {} as ExpressResponse, a.fn);
    const b = fakeNext();
    await mw.use(reqWith({ [SESSION_COOKIE]: '' }), {} as ExpressResponse, b.fn);

    expect(verify).not.toHaveBeenCalled();
    expect(a.called()).toBe(true);
    expect(b.called()).toBe(true);
  });
});

/**
 * `describeVerificationFailure` 是**日志路径上的最后一个函数**，因此它自己的失败模式
 * 与产品的失败模式是同一件事：它在 catch 块里被调用，一旦抛出就把一次「可观测的降级」
 * 变成一次未捕获异常。下面逐条覆盖它必须容忍的输入形状。
 */
describe('describeVerificationFailure：任何形状都不抛，且只回日志安全字段', () => {
  it('标准 Error 带 code（连接类错误）', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(describeVerificationFailure(err)).toEqual({
      errorName: 'Error',
      errorMessage: 'connect ECONNREFUSED',
      errorCode: 'ECONNREFUSED',
    });
  });

  it('超长消息被截断（消息可能夹带输入，截断防止日志被撑大）', () => {
    const { errorMessage } = describeVerificationFailure(new Error('x'.repeat(5000)));
    expect(errorMessage).toHaveLength(200);
  });

  /**
   * **原始值不回显**：`throw 'A'.repeat(43)` 这种形状下，「值」很可能就是凭证本身
   * （或它的片段），因此只记类型。这条是 `redact`/C11 在错误路径上的落点。
   */
  it('非 Error 值只回类型，不回显值本身（C11：原始值可能是凭证）', () => {
    const secret = 'B'.repeat(43);
    const out = describeVerificationFailure(secret);
    expect(out).toEqual({ errorName: 'NonError(string)', errorMessage: undefined, errorCode: undefined });
    expect(JSON.stringify(out)).not.toContain(secret);

    expect(describeVerificationFailure(42).errorName).toBe('NonError(number)');
    // `typeof null === 'object'`，但读它的属性会抛——因此先摘掉 `null`，
    // 否则它会落进「属性读取失败」那一类，分类失真（实测踩到过）。
    expect(describeVerificationFailure(null).errorName).toBe('NonError(null)');
    expect(describeVerificationFailure(undefined).errorName).toBe('NonError(undefined)');
  });

  it('属性 getter 抛错时退化，不把异常抛给日志路径', () => {
    const err = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('getter 炸了');
      },
    });
    expect(describeVerificationFailure(err)).toEqual({
      errorName: 'Unavailable',
      errorMessage: undefined,
      errorCode: undefined,
    });
  });

  it('缺字段 / 空字段的 Error 仍然给出可读的 name', () => {
    expect(describeVerificationFailure(new Error('')).errorName).toBe('Error');
    expect(describeVerificationFailure({ name: 'Weird' })).toEqual({
      errorName: 'Weird',
      errorMessage: undefined,
      errorCode: undefined,
    });
  });
});
