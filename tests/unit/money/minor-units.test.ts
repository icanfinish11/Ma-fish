import { describe, expect, it } from 'vitest';
import {
  MINOR_UNITS_MAX_DIGITS,
  formatMinorUnits,
  isCanonicalMinorUnits,
  parseMinorUnits,
} from '@vca/api/common/money/minor-units.js';

describe('金额字符串契约的边界（C22）', () => {
  it.each(['01', '+1', '1.0', ' 1', '1 ', '-0', '', '1e3', '0x10', '--1', '１２３'])(
    '非规范形式被拒：%j',
    (bad) => {
      expect(() => parseMinorUnits(bad)).toThrow();
      expect(isCanonicalMinorUnits(bad)).toBe(false);
    },
  );

  it.each([['0', 0n], ['1', 1n], ['-1', -1n], ['9007199254740993', 9007199254740993n]])(
    '规范形式被接受：%s',
    (text, value) => {
      expect(parseMinorUnits(text)).toBe(value);
      expect(formatMinorUnits(value)).toBe(text);
    },
  );

  // 标题用 `%s` 而**不是** `%j`：vitest 的 `%j` 走 `JSON.stringify`，而参数里有一个 `1n`
  // ⇒ 整个文件在**收集期**就炸掉（实测第一版：
  //    `TypeError: Do not know how to serialize a BigInt`，0 test）。
  // 这正是预检 A.2「`JSON.stringify(bigint)` 直接抛 TypeError」那条事实，只是它出现在
  // 一个没人会预期的地方——用例**标题的格式化器**。契约用字符串的第二个理由就在这里。
  it.each([[1], [1.5], [null], [undefined], [{}], [[1]], [true], [1n]])(
    '非字符串一律被拒：%s',
    (bad) => {
      expect(() => parseMinorUnits(bad)).toThrow(/十进制字符串/);
    },
  );

  it('`JSON.stringify(bigint)` 抛 TypeError —— 契约必须是字符串的另一半（预检 A.2）', () => {
    // 上面那条用例的 `%j` 版就是这么炸的；而 HTTP 响应体走的正是 JSON.stringify。
    // 所以「余额不能直接放进响应体」不是风格问题，它会以 500 的形式出现。
    expect(() => JSON.stringify(1n)).toThrow(TypeError);
  });

  it(`超过 ${MINOR_UNITS_MAX_DIGITS} 位的字符串被拒（防 DoS）`, () => {
    expect(() => parseMinorUnits('9'.repeat(MINOR_UNITS_MAX_DIGITS + 1))).toThrow();
  });

  it('0 与 -0 的边界：`0` 规范、`-0` 被拒（否则同一个 0 有两种写法）', () => {
    expect(parseMinorUnits('0')).toBe(0n);
    expect(() => parseMinorUnits('-0')).toThrow();
  });
});
