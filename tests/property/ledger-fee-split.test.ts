import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PLATFORM_FEE_BPS, computeFeeSplit } from '@vca/api/modules/ledger/core/fee-split.js';
import { PROPERTY_NUM_RUNS } from './property-config.js';

/**
 * 手续费拆分的**全称命题**（控制器裁定 4 / C23 / 预检 §F.3）。
 *
 * ## 为什么这条属性必须存在，而且必须住在 `tests/property/`
 *
 * 裁定 4 的原文是「必须是**一个共享函数 + 一条属性测试**（对所有输入断言
 * `fee + net === gross`），而不是两处各自向下取整」；预检 §F.3 把它列成 P2 的硬要求；
 * 设计 §8.3 的那句「≥10 万次随机交易序列」要成立，先得有这样一个**可以在内存里跑 10 万次**
 * 的被测对象（预检 §D.7 划的边界：属性测试覆盖纯逻辑，并发与 DB 强制点各有真库用例）。
 *
 * `tests/unit/ledger/core.test.ts` 的六行 `it.each` 钉的是**具体反例**
 * （999 / 1 / 7 / 100 分——不能整除才是判据，整除的 1000 分什么也证明不了，见预检 A.4 的
 * 诚实边界），它们证明的是「这些点是对的」；这一条证明的是**对所有输入**都对。
 * 两者形状不同、都要在。
 *
 * ## 生成器的两个上界都不是随手取的
 *
 * * `gross` 取到 `10^20` 分（远超 2^53）⇒ 顺带钉住「不能走浮点」：`Number` 在这条路径上
 *   会静默丢分（预检 §A.3）。
 * * `feeBps` 取到 `100_000`（**大于** 10000）⇒ 把 `computeFeeSplit` 的**上限钳制**那条
 *   分支也行使到（`bps > 10000` 时 `ceil` 可能超过 gross，净额会变负——那会把卖家从
 *   「收钱」变成「付钱」，并撞上不变式 #3）。
 *   负 `gross` 不在全域里：它被 `InvalidAmountError` 显式拒绝（`tests/unit/ledger/core.test.ts`
 *   的拒绝面用例负责那一半）。
 */
const grossArb = fc.bigInt({ min: 0n, max: 10n ** 20n });
const feeBpsArb = fc.nat({ max: 100_000 });

describe('手续费拆分的守恒（裁定 4 / C23 / 预检 F.3）', () => {
  it('★ 裁定 4 的属性：任意 `(gross, bps)` 下 `fee + net === gross`（且 `0 ≤ fee ≤ gross`、`net ≥ 0`）', () => {
    fc.assert(
      fc.property(grossArb, feeBpsArb, (gross, feeBps) => {
        const { fee, net } = computeFeeSplit(gross, feeBps);
        expect(fee + net).toBe(gross);
        expect(fee).toBeGreaterThanOrEqual(0n);
        expect(fee).toBeLessThanOrEqual(gross);
        expect(net).toBeGreaterThanOrEqual(0n);
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
    // §8.4 的默认费率在这里被真的用上（否则 `PLATFORM_FEE_BPS` 是个未使用的 import，lint 会红）：
    // 10000 分按 5% ⇒ 平台 500、卖家 9500（与 Task 7 的真库用例同一条算式）。
    // 它同时是这条属性的**反 vacuity 锚点**：一个具体的、非平凡的结果。
    expect(computeFeeSplit(10_000n, PLATFORM_FEE_BPS)).toEqual({ fee: 500n, net: 9_500n });
  });

  it('★ 向上取整的**全域**命题：`fee` 是「不小于精确值」的**最小**整数（bps ≤ 10000 时）', () => {
    // ## 为什么守恒属性之外还要这一条
    //
    // `fee + net === gross` 只钉住「净额是减出来的」，它**钉不住取整方向**：把
    // `computeFeeSplit` 换成「费用向下取整、净额 = gross − fee」，守恒照样成立
    // （少收平台 1 分），而守恒属性会**全绿**。C23 要求的规则有**两半**——「费用向上取整」
    // 与「净额减出来」——这一条把前一半变成全称命题：
    //   `fee · 10⁴ ≥ gross · bps`（够多）且 `(fee − 1) · 10⁴ < gross · bps`（再少一分就不够）
    // 两条合起来就是 `fee = ceil(gross · bps / 10⁴)` 的定义，与实现无关。
    // 向下取整的实现在第二条上必红（`tests/unit/ledger/core.test.ts` 的六行是它的具体形态）。
    //
    // 上界取 10000（不含钳制区）：钳制之后 `fee = gross` 而精确值更大，最小性那条
    // 按设计不成立（`computeFeeSplit` 的文档注释里写了这件事）。
    fc.assert(
      fc.property(grossArb, fc.nat({ max: 10_000 }), (gross, feeBps) => {
        const { fee } = computeFeeSplit(gross, feeBps);
        expect(fee * 10_000n).toBeGreaterThanOrEqual(gross * BigInt(feeBps));
        if (fee > 0n) expect((fee - 1n) * 10_000n).toBeLessThan(gross * BigInt(feeBps));
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('生成器覆盖率（反 vacuity）：非零 fee、钳制分支、**向上取整真的起作用**的情形都被走到过', () => {
    // 一条「不可能失败的属性」比没有属性更坏：若生成器退化成只产出 `feeBps = 0` 或
    // `gross = 0`，上面两条属性会在「什么都没发生」的输入上恒成立，而 CI 照样绿。
    // 这一条用同一个生成器抽样，数出三类输入各自出现过多少次。
    const samples = fc.sample(fc.tuple(grossArb, feeBpsArb), { numRuns: 2_000 });
    let nonzeroFee = 0;
    let clamped = 0;
    // 「向上取整真的起作用」= 费用**严格大于**精确值（`fee · 10⁴ > gross · bps`）。
    // 这一格才是 SPLIT_CASES 那六行（999 / 1 / 7 / 100 分）在**全量**上的对应物：
    // 恰好整除的输入（1000 分 5%）在这一格上是 0，什么也证明不了（预检 A.4）。
    let roundedUp = 0;
    for (const [gross, feeBps] of samples) {
      const { fee } = computeFeeSplit(gross, feeBps);
      if (fee > 0n) nonzeroFee += 1;
      if (fee * 10_000n > gross * BigInt(feeBps)) roundedUp += 1;
      if (fee === gross && gross > 0n && BigInt(feeBps) > 10_000n) clamped += 1;
    }
    expect(nonzeroFee, '生成器退化了：2000 次抽样里一次非零手续费都没有').toBeGreaterThan(0);
    expect(roundedUp, '抽样里没有一次「向上取整真的起作用」——换成向下取整也照样绿，这条属性就空了').toBeGreaterThan(0);
    expect(clamped, '上限钳制那条分支一次都没被行使过：bps 的上界是不是被改小了？').toBeGreaterThan(0);
  });
});
