import { InvalidAmountError, InvalidFeeRateError } from './errors.js';

/**
 * 手续费拆分（设计 §8.4「释放时扣平台手续费」；D4 / C23）。
 *
 * ## 规则：余数归**收取方**（平台）
 *
 * 费用**向上取整**，净额 `= gross − fee`——**减出来的，不是第二次取整算出来的**。
 * 于是 `fee + net === gross` **按构造成立**，不需要任何尾差分录、也不需要最大余数法。
 *
 * ## 为什么必须只有一个函数（预检 A.4 的实测）
 *
 * 「两侧各自向下取整」是最自然的写法，也是**唯一会把账做不平**的写法：
 * 999 分 5% → 49 + 949 = **998**；1 分 5% → 0 + 0 = **0**；7 分 3% → 0 + 6 = **6**。
 * 而复式记账的 `sum(entries) = 0` 这条不变式本身就规定了舍入规则——任何
 * 「各部分独立取整」的方案都必须再补一笔尾差腿，或者让一侧取整、另一侧取差额。
 * 后者简单、可预测，代价是把误差**固定**推给平台（这是产品决定，见 D4）。
 *
 * ## 上限钳制
 *
 * `bps > 10000` 时 `ceil` 可能超过 gross，于是净额变负——那会把卖家从「收钱」变成
 * 「付钱」，而且它会撞上不变式 #3（用户账户不得为负）。钳到 `gross` 之后
 * `fee + net === gross` 与 `0 ≤ fee ≤ gross` 同时成立。
 * 属性测试用**任意** bps 生成输入，因此这条钳制是必需的，不是防御性装饰。
 */
export const PLATFORM_FEE_BPS = 500;   // 5%（§8.4 的默认值；bps = 万分之一）

/**
 * 一次拆分的两半。**不变式按构造成立**：`fee + net === gross`（C23）——
 * 因此它没有第三个字段（「尾差」这种东西在本设计里不存在）。
 */
export interface FeeSplit {
  readonly fee: bigint;
  readonly net: bigint;
}

export function computeFeeSplit(gross: bigint, feeBps: number): FeeSplit {
  if (gross < 0n) throw new InvalidAmountError(`金额不得为负：${gross.toString()}`);
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new InvalidFeeRateError(`费率必须是非负整数（bps）：${String(feeBps)}`);
  }
  // 向上取整的整数写法（C3：绝不用浮点）：ceil(a/b) = (a + b - 1) / b
  const raw = (gross * BigInt(feeBps) + 9_999n) / 10_000n;
  const fee = raw > gross ? gross : raw;
  return { fee, net: gross - fee };
}
