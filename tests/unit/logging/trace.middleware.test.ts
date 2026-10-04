import { describe, it, expect } from 'vitest';
import { TRACE_HEADER, TraceMiddleware } from '@vca/api/common/logging/trace.middleware.js';
import { currentContext } from '@vca/api/common/context/request-context.js';

/**
 * `TraceMiddleware` 的入参校验（修复轮 1）。
 *
 * 这里不引导 Nest：中间件本身没有依赖，行为全部在 `use()` 里，直接给一对假 req/res
 * 就能把「沿用 / 丢弃并重新生成」的边界钉住——包括真实 HTTP 请求**到不了**的输入
 * （Node 的头部解析器自己就会拒掉 CRLF，但中间件的契约不该依赖上游解析器）。
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UseArgs = Parameters<TraceMiddleware['use']>;

function runMiddleware(incoming: string | string[] | undefined) {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string): void => {
      headers[name] = value;
    },
  };
  const req = { headers: incoming === undefined ? {} : { [TRACE_HEADER]: incoming } };

  // handler 里读到的值 = 后面所有日志会带上的值（`mixin` 读的正是这个 ALS 存储）
  let seenInHandler: string | undefined;
  new TraceMiddleware().use(
    req as unknown as UseArgs[0],
    res as unknown as UseArgs[1],
    (() => {
      seenInHandler = currentContext()?.traceId;
    }) as UseArgs[2],
  );

  return { echoed: headers[TRACE_HEADER], seenInHandler };
}

describe('TraceMiddleware 的入参处理（§3.5）', () => {
  it('合法入参 id 原样沿用，且 handler 内读到同一个值', () => {
    const { echoed, seenInHandler } = runMiddleware('trace-abc-123');

    expect(echoed).toBe('trace-abc-123');
    expect(seenInHandler).toBe('trace-abc-123');
  });

  it('恰好 128 字符（长度上限）仍然接受', () => {
    const id = 'a'.repeat(128);

    const { echoed } = runMiddleware(id);

    expect(echoed).toBe(id);
  });

  it('未传 x-trace-id 时生成一个 UUID', () => {
    const { echoed, seenInHandler } = runMiddleware(undefined);

    expect(echoed).toMatch(UUID_V4);
    expect(seenInHandler).toBe(echoed);
  });

  it('超长（129 字符）丢弃并重新生成，不截断也不沿用', () => {
    const tooLong = 'a'.repeat(129);

    const { echoed, seenInHandler } = runMiddleware(tooLong);

    expect(echoed).not.toBe(tooLong);
    expect(echoed).toMatch(UUID_V4);
    expect(seenInHandler).toBe(echoed);
  });

  it('字符集不合法（空白/引号/花括号/换行/非 ASCII/空串）一律丢弃并重新生成', () => {
    const rejected = [
      'trace id', // 空白
      'trace"id', // 引号
      '{"traceId":"x"}', // 花括号
      'trace\nid', // 控制字符（真实请求到不了，契约仍不收）
      '追踪-id', // 非 ASCII
      '', // 空串
    ];

    for (const bad of rejected) {
      const { echoed, seenInHandler } = runMiddleware(bad);
      expect(echoed, `入参 ${JSON.stringify(bad)} 不应被沿用`).toMatch(UUID_V4);
      expect(echoed).not.toBe(bad);
      expect(seenInHandler).toBe(echoed);
    }
  });

  it('重复头（数组）不被沿用（沿用会让「哪一个是本次请求的 id」失去定义）', () => {
    const { echoed } = runMiddleware(['trace-a', 'trace-b']);

    expect(echoed).toMatch(UUID_V4);
  });
});
