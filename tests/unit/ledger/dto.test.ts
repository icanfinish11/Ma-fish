import { describe, expect, it } from 'vitest';
import { grantCreditsSchema } from '@vca/api/modules/ledger/dto.js';
import { MINOR_UNITS_MAX_INT8 } from '@vca/api/common/money/minor-units.js';

/**
 * 额度发放的**入参契约**：金额的上界就是账本的存储上界（P2 最终全分支审查 I3）。
 *
 * ## 这个文件问的是哪一件事
 *
 * `grantCreditsSchema` 此前用 `MINOR_UNITS_MAX_DIGITS = 100` 当金额字符串的长度上限——
 * 那是一个**防 DoS** 的位数上限，而账本每一个金额列都是 `BIGINT`（`migration.sql` 的
 * `accounts.balance` / `entries.amount` / 都是 int8，上界 `9223372036854775807`）。
 * 于是「合同说可以、库说不行」的那一段（19 位里大于 int8 的那一小段，以及 20–100 位）
 * 会被放进服务层，由 PostgreSQL 以 **22003（numeric_value_out_of_range）** 拒绝——
 * 而 `ledger-error-map.ts` **没有**这一档 ⇒ 唯一一条造钱路由上，一个**调用方的输入错误**
 * 变成 500。这是 I3 的原文：**「声明的上界不是库的上界」**。
 *
 * ## 为什么上界的两个方向落在**单元**层，而不是路由层
 *
 * 因为「恰好等于 int8 上界 ⇒ 接受」这条断言在真库路由上有**破坏性副作用**：
 * `EXTERNAL_TOPUP` 是全局共享账户，一次 int8 上界的发放会把它的余额推到 int8 下界，
 * 于是**同一个文件里后续每一条**发放都会以 22003 溢出——那会让这条断言的代价落到别人头上。
 * 存储上界本身是契约的一部分（它由列类型决定，与库里的余额无关），因此边界对在这里量，
 * 而「越界 ⇒ 400 而不是 500」那条端到端判据在 `topup-route.test.ts` 里（它带库侧断言）。
 */
const USER = '01920000-0000-7000-8000-0000000000aa';

function parse(amount: string) {
  return grantCreditsSchema.safeParse({ userId: USER, amount, idempotencyKey: 'k' });
}

describe('额度发放入参契约：金额的上界 = int8（I3）', () => {
  it('恰好 int8 上界 ⇒ **接受**（否则上界会比库本身更紧，一个合法的金额会被无理由拒绝）', () => {
    const max = MINOR_UNITS_MAX_INT8.toString();
    // 非空转前提：这条断言只有在 `max` 真的是 19 位时才有意义（位数与列类型同源）。
    expect(max).toHaveLength(19);
    const r = parse(max);
    expect(r.success, `int8 上界 ${max} 被拒了：上界被收得比库更紧`).toBe(true);
    if (r.success) expect(r.data.amount).toBe(MINOR_UNITS_MAX_INT8);
  });

  it('int8 上界 + 1 ⇒ **拒绝**（同一形状、只差一分 —— 这是那个静默 500 的最小反例）', () => {
    const tooBig = (MINOR_UNITS_MAX_INT8 + 1n).toString();
    expect(tooBig).toHaveLength(19); // 19 位，因此「位数上限」这条**挡不住它**——必须比大小
    const r = parse(tooBig);
    expect(r.success, `${tooBig} 被放行了：它会以 22003 打到 Postgres，而那条错误没人翻译 ⇒ 500`).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['amount']);
  });

  it('20 位（远超 int8，但仍在旧的 100 位 DoS 上限之内）⇒ 拒绝', () => {
    const r = parse('12345678901234567890');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['amount']);
  });

  it('101 位 ⇒ 拒绝（防 DoS 的位数上限仍然在，两条上界各管一段）', () => {
    const r = parse('1' + '0'.repeat(100));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['amount']);
  });

  it('合同边界的**两个方向**在同一份 schema 上：19 位里 int8 之内接受、之外拒绝', () => {
    // 逐位走一遍 19 位区间的两端，证明拒/收的分界线**恰好**落在 int8 上界上，
    // 而不是某个看起来差不多的数（例如 10^18 或 2^63）。
    for (const [value, ok] of [
      ['999999999999999999', true],      // 10^18 − 1：int8 之内
      ['1000000000000000000', true],     // 10^18
      ['9223372036854775807', true],     // int8 上界
      ['9223372036854775808', false],    // 上界 + 1
      ['9999999999999999999', false],    // 19 位全 9
    ] as const) {
      expect(parse(value).success, `${value} 的接受/拒绝判据错了`).toBe(ok);
    }
  });
});
