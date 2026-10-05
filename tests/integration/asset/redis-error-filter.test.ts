import { describe, expect, it } from 'vitest';
import { isTeardownError } from '../../helpers/redis.js';

/**
 * `TestRedis` 的收尾噪音过滤器（修复轮 1 / Fix 2）。
 *
 * ## 为什么这条用例必须存在
 *
 * `tests/helpers/redis.ts` 的 `error` 处理器是为了**让输出 pristine**：它靠一张
 * 「哪些错误算收尾噪音」的清单决定「打不打 stderr」。那张清单过窄，噪音就漏出来——
 * 实测 `[test-redis] write ECONNABORTED` 出现在全量运行的 stderr 里
 * （`evidence/t1-final-test.txt` 第 56 行）。**过宽更贵**：真实故障会被静音，
 * 于是「会话/限流断言以一堆 403/500 失败」而 stderr 里一句解释都没有，
 * 而且没有任何别的东西会红。因此两侧都要钉住。
 *
 * ## 为什么直接测纯函数而不是造一个真 socket 故障
 *
 * 判据本身（`isTeardownError`）是纯函数，直接测它既确定（不依赖容器与竞态时机）
 * 又省掉一个 testcontainer。接线（处理器真的调用它）由 `startTestRedis()` 的存在本身
 * 保证——本文件不重复装配一份处理器，那样测的会是副本而不是被使用的那个。
 */
describe('TestRedis 的收尾噪音过滤器（修复轮 1 / Fix 2）', () => {
  it('容器收尾会产生的错误一律被吞掉（含实测漏出来的 ECONNABORTED）', () => {
    // 每一条都在**消息**与**code**两个位置各测一次：socket 错误两个位置都有，
    // 而 ioredis 自己的错误只有消息（如 `Connection is closed.`）。
    const cases: ReadonlyArray<{ message: string; code?: string }> = [
      { message: 'write EPIPE', code: 'EPIPE' },
      { message: 'write ECONNABORTED', code: 'ECONNABORTED' }, // ← 本轮实测漏出来的那个
      { message: 'read ECONNRESET', code: 'ECONNRESET' },
      { message: 'write ESHUTDOWN', code: 'ESHUTDOWN' },
      { message: 'Cannot call write after a stream was destroyed', code: 'ERR_STREAM_DESTROYED' },
      { message: "Stream isn't writeable and enableOfflineQueue options is false" },
      { message: 'Connection is closed.' },
    ];

    for (const one of cases) {
      expect(isTeardownError(Object.assign(new Error(one.message), { code: one.code })), one.message).toBe(true);
      // 只带 code（消息被包装过）也要认：判据不能只挂在文本上。
      if (one.code) {
        expect(isTeardownError(Object.assign(new Error('被包装过的消息'), { code: one.code })), one.code).toBe(true);
      }
    }
  });

  it('真实故障（连不上 / 超时 / 解析失败）照旧上报，这个过滤器不是静音开关', () => {
    const mustReport: ReadonlyArray<{ message: string; code?: string }> = [
      { message: 'connect ECONNREFUSED 127.0.0.1:6379', code: 'ECONNREFUSED' },
      { message: 'connect ETIMEDOUT 127.0.0.1:6379', code: 'ETIMEDOUT' },
      { message: 'getaddrinfo ENOTFOUND redis', code: 'ENOTFOUND' },
      { message: 'ERR invalid password' },
      { message: '未知错误：这一条谁也不认识' },
    ];

    for (const one of mustReport) {
      expect(isTeardownError(Object.assign(new Error(one.message), { code: one.code })), one.message).toBe(false);
    }
  });
});
