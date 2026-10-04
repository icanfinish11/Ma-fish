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
