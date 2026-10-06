import { describe, expect, it } from 'vitest';
import { test as fcTest } from '@fast-check/vitest';
import fc from 'fast-check';
import {
  formatMinorUnits,
  isCanonicalMinorUnits,
  parseMinorUnits,
} from '@vca/api/common/money/minor-units.js';
import { DESIGN_MIN_NUM_RUNS, PROPERTY_NUM_RUNS, WIRING_NUM_RUNS } from './property-config.js';

/** 生成「规范形式的十进制整数字符串」（含 0、含负数、含 >2^53 的量级）。 */
const canonicalArb = fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n }).map((v) => v.toString());

describe('金额的十进制字符串契约（C22 / D5）', () => {
  it('预算不得低于设计下限（把 10 万改小会让这条红）', () => {
    expect(PROPERTY_NUM_RUNS).toBeGreaterThanOrEqual(DESIGN_MIN_NUM_RUNS);
  });

  it('解析→格式化 往返恒等（任意规范串）', () => {
    fc.assert(
      fc.property(canonicalArb, (text) => {
        expect(formatMinorUnits(parseMinorUnits(text))).toBe(text);
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('格式化→解析 往返恒等（任意 bigint，含 >2^53 与负数）', () => {
    fc.assert(
      fc.property(fc.bigInt(), (value) => {
        expect(parseMinorUnits(formatMinorUnits(value))).toBe(value);
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('格式化器的输出恒为规范形式', () => {
    fc.assert(
      fc.property(fc.bigInt(), (value) => {
        expect(isCanonicalMinorUnits(formatMinorUnits(value))).toBe(true);
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('任何 `number` 输入都必须被拒（实测：>2^53 的 number 会静默少 1 分且无异常）', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.double({ noNaN: true }), fc.constant(0)), (value) => {
        expect(() => parseMinorUnits(value)).toThrow();
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('非规范字符串一律被拒（前导零 / 正号 / 小数点 / 空白 / -0 / 空串）', () => {
    const nonCanonical = fc
      .string({ minLength: 0, maxLength: 12 })
      .filter((s) => !isCanonicalMinorUnits(s));
    fc.assert(
      fc.property(nonCanonical, (text) => {
        expect(() => parseMinorUnits(text)).toThrow();
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('2^53 之上：字符串契约无损，而 number 会静默少 1 分（预检 A.2 的实测值，逐字）', () => {
    const exact = 9007199254740993n;
    expect(parseMinorUnits('9007199254740993')).toBe(exact);
    expect(formatMinorUnits(exact)).toBe('9007199254740993');
    // ↓ 这一行就是「为什么契约是字符串而不是数字」：两个不同的整数在 IEEE754 下是同一个数。
    expect(Number(9007199254740993n)).toBe(9007199254740992);
  });

  /**
   * 接线复验（先验再做 第 1 条 / 预检 §G.5）。
   *
   * 预检的 `@fast-check/vitest` 探针跑在一个**仓库之外的最小 vitest 配置**里，因此
   * 「包能 import」与「它在**本仓库**的 `vitest.config.ts`（`globalSetup` + `--project`
   * 选择）下真的会执行」是两件事——P1 §8 的教训正是探针环境与仓库环境的差异本身是坑。
   *
   * 这条用例同时钉住三件事，缺一条它就不成立：
   *   1. `@fast-check/vitest` 的 `test.prop` **注册出来的用例真的会跑**（不是被 project 的
   *      include 漏掉、也不是注册到了另一个 vitest 实例上——那会静默不执行）；
   *   2. 适配器内部的 `fast-check` 与仓库直接依赖的是**同一个版本**：`@fast-check/vitest`
   *      把 `fast-check` 声明成普通依赖（`^3.0.0 || ^4.0.0`），不钉的话 pnpm 会复用
   *      store 里 `effect@3.20.0` 带来的 3.23.2，于是一份测试文件里有两个 fast-check
   *      （`pnpm-workspace.yaml` 的 override 与它的注释记了这条实测）；
   *   3. 它跑的是**金额契约本身**，不是一句 `expect(true)`——接线用例也不许是空转的。
   *
   * `numRuns` 取小：它证明的是接线，10 万次的覆盖预算由上面五条承担（不重复付费）。
   */
  fcTest.prop([canonicalArb], { numRuns: WIRING_NUM_RUNS })(
    '接线复验：@fast-check/vitest 的 test.prop 在仓库 property project 下真的执行（预检 §G.5）',
    (text) => {
      expect(formatMinorUnits(parseMinorUnits(text))).toBe(text);
    },
  );
});
