/**
 * 金额的 JSON 契约：**小单位的十进制字符串**（C3 + C22 / 控制器裁定 5）。
 *
 * ## 为什么不是 `number`
 *
 * 预检 A.2/A.6 实测（不是推理）：`JSON.parse('{"amount":9007199254740993}').amount`
 * 得到 `9007199254740992`，把它写进 `bigint` 列**成功、库里少 1 分、全程无异常**。
 * 也就是说「一律 bigint，禁浮点」（C3）在 TypeScript 类型层成立，而**请求体不经过
 * TypeScript**。同时 `JSON.stringify(bigint)` 直接抛
 * `TypeError: Do not know how to serialize a BigInt`——所以 bigint 也不能原样出响应。
 * 两个方向都坏，唯一同时成立的两端表示就是字符串。
 *
 * ## 为什么必须是**规范形式**
 *
 * 接受 `"01"` / `"+1"` / `" 1"` / `"-0"` 会让同一个金额有多种表示，于是「幂等键 + 请求体
 * 相同」的比较、审计里的金额、以及将来任何按金额做索引/统计的地方都要先做归一化。
 * 规范形式是 `0` 或 `-?[1-9][0-9]*`——一个金额一个字符串。
 */

/** 上限（防 DoS）。100 位十进制远大于任何真实金额，也远大于 int8 的 19 位。 */
export const MINOR_UNITS_MAX_DIGITS = 100;

const CANONICAL = /^(?:0|-?[1-9][0-9]*)$/;

/** 金额的 JSON 形状不合法。**只在校验器内部使用**：HTTP 层由 zod 翻成 400。 */
export class InvalidMinorUnitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMinorUnitsError';
  }
}

/** 规范形式判定（同一个判据既用于 zod 的 `.refine`，也用于属性测试，只有一处定义）。 */
export function isCanonicalMinorUnits(value: string): boolean {
  return value.length <= MINOR_UNITS_MAX_DIGITS && CANONICAL.test(value);
}

/**
 * 解析。**只接受字符串**：`number` / `bigint` / `null` / 对象一律抛错。
 *
 * 刻意**不**做「宽容转换」（`String(input)` 或 `BigInt(Number(input))`）：那会把
 * 预检实测的那条静默路径（少 1 分、无异常）原样搬进来，只是搬到了一个更容易被
 * 忽略的位置。拒绝一个静默错误的输入，比猜它的意图便宜。
 */
export function parseMinorUnits(input: unknown): bigint {
  if (typeof input !== 'string') {
    throw new InvalidMinorUnitsError(
      `金额必须是十进制字符串（收到 ${input === null ? 'null' : typeof input}）——` +
        'JSON 的 number 在 2^53 之上会静默丢精度（实测少 1 分且不报错）。',
    );
  }
  if (input.length > MINOR_UNITS_MAX_DIGITS) {
    throw new InvalidMinorUnitsError(`金额字符串过长（${input.length} > ${MINOR_UNITS_MAX_DIGITS}）`);
  }
  if (!CANONICAL.test(input)) {
    throw new InvalidMinorUnitsError(
      `金额不是规范形式（"0" 或 "-?[1-9][0-9]*"）：${JSON.stringify(input)}`,
    );
  }
  return BigInt(input);
}

/** 反向：任何出 JSON 的金额都必须经这里（`JSON.stringify(bigint)` 会抛）。 */
export function formatMinorUnits(value: bigint): string {
  return value.toString();
}
