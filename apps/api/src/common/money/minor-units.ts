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

/**
 * 账本里每一个金额列的**存储上界**：int8（`BIGINT`）——`migration.sql` 的
 * `accounts.balance` 与 `entries.amount` 都是它。
 *
 * ## ★ 为什么它与 `MINOR_UNITS_MAX_DIGITS` 是**两条不同的界**（P2 最终审查 I3）
 *
 * `MINOR_UNITS_MAX_DIGITS` 是**字符串长度**的防 DoS 上限，远大于 int8 的 19 位。把**它**
 * 当成金额契约的上界，会让「合同说可以、库说不行」的那一段（19 位里大于 int8 上界的值，
 * 以及 20–100 位）一路进到服务层，由 PostgreSQL 以 **22003** 拒绝——而
 * `ledger-error-map.ts` 没有那一档 ⇒ **唯一一条造钱路由上，一个调用方的输入错误变成 500**。
 * 上界必须与**存储**同源，因此它写在这里、由 DTO 引用，并有两条会红的用例看着它
 * （`tests/unit/ledger/dto.test.ts` 的边界对；`tests/integration/ledger/topup-route.test.ts`
 * 的「合同之内但超出 int8 ⇒ 400」）。**它的另一个方向同样承重**：上界比库更紧会让一个
 * 合法金额被无理由拒绝，因此「恰好等于它 ⇒ 接受」也有一条断言。
 */
export const MINOR_UNITS_MAX_INT8 = 9223372036854775807n;

/**
 * 十进制的**位数**上限，使任何 ≥ 20 位的字符串都不可能落在 int8 之内。
 *
 * ## ★ 据实记载：这一条**单独存在时是冗余的**（探针实测，不是推断）
 * `.max(MINOR_UNITS_MAX_INT8_DIGITS)` 只用在 DTO 上，而它与下面那条 int8 比较**覆盖同一批
 * 输入**：任何 ≥ 20 位的字符串必然大于 `9223372036854775808`。三条探针逐条量过：
 *   * 只删 int8 比较 ⇒ `dto.test.ts` 红 **2** 条（19 位里超出上界那条 + 边界对），
 *     **「20 位」那条照样绿**——它是被本条位数上限拒的；
 *   * 只删本条位数上限 ⇒ **一条都不红**（20 位改由 int8 比较拒）；
 *   * 两条一起删 ⇒ 「20 位」那条**才**红。
 * ⇒ 它不是一条守卫，而是**契约可读性**：19 位这个数与存储同源，写在边界上比藏在注释里
 * 更难漂移。与 `readBalances` 里那句 `toLowerCase()` 同一处置：据实记载，不包装成守卫。
 * （第一轮探针装置把「20 位」算成 int8 比较的见证，实测不符 ⇒ 矩阵 exit 2 作废，判据按实测改。）
 */
export const MINOR_UNITS_MAX_INT8_DIGITS = 19;

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
