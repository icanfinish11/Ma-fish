import { z } from 'zod';
import {
  MINOR_UNITS_MAX_INT8, MINOR_UNITS_MAX_INT8_DIGITS,
  isCanonicalMinorUnits, parseMinorUnits,
} from '../../common/money/minor-units.js';

/**
 * 额度发放的入参（C22 / D5）。
 *
 * ## `z.string()` 就是「`number` 一律拒绝」的执行点
 *
 * 不用 `z.number()`、不用 `z.coerce.number()`、不用 `z.union([z.string(), z.number()])`：
 * 预检实测 `JSON.parse('{"amount":9007199254740993}')` → `…992`，写库**成功、少 1 分、无异常**。
 * 任何「宽容一点」的写法都会把这条静默路径搬进来。`z.string()` 对 `number` 给出的
 * issue 是 `Expected string, received number`，`parseOrBadRequest` 把它翻成 400。
 *
 * `.refine(...).transform(...)` 的顺序是承重的：**先**校验规范形式、**再**转 bigint。
 * 反过来会让 `parseMinorUnits` 的领域错误绕过 zod 的 400（变成 500）。
 *
 * ## 为什么 `userId` 用 `z.uuid()`
 *
 * zod 4 把 `z.string().uuid()` 标成 deprecated（改用 `z.uuid()`），两者底层是**同一个**
 * 判据（`core/regexes.js` 的 `uuid()`，接受 RFC 9562 的 1–8 版，因此 UUIDv7 通过）。
 * 这里用非弃用的那个拼写：契约不变，而下一个读它的人不会看到一条弃用告警。
 *
 * ## 为什么 `amount` 的正数判据是第二条 `refine` 而不是 `.positive()`
 *
 * 经过 `transform` 之后类型已经是 `bigint`，而 zod 的 `.positive()` 只存在于数字/大整数
 * schema 上（`ZodString` 没有它）。`(v) => v > 0n` 是同一个判据的显式写法——
 * **0 分的发放**是一次没有任何资金变动的过账，纯核心会以 `InvalidAmountError` 拒绝它，
 * 而那会变成 500；在 DTO 这一层拒绝才是正确的责任方（调用方的数不对）。
 */
export interface GrantCreditsInput {
  readonly userId: string;
  readonly amount: bigint;
  readonly idempotencyKey: string;
}

export const grantCreditsSchema: z.ZodType<GrantCreditsInput> = z.object({
  userId: z.uuid(),
  amount: z
    .string()
    // ★ I3：第一条界是**位数**（便宜的前置筛），第二条界是**与 int8 上界比较**
    //   （真正的契约上界）。此前这里是 `MINOR_UNITS_MAX_DIGITS = 100`——那是一个防 DoS 的
    //   长度上限，而不是存储的上界，于是 19 位里大于 int8 的值会打到 Postgres 变成 500。
    .max(MINOR_UNITS_MAX_INT8_DIGITS)
    .refine(isCanonicalMinorUnits, { message: '金额必须是规范的小单位十进制字符串（分）' })
    .transform(parseMinorUnits)
    .refine((v) => v <= MINOR_UNITS_MAX_INT8, { message: '金额超出账本的存储上界（int8 / BIGINT）' })
    .refine((v) => v > 0n, { message: '发放额度必须为正' }),
  idempotencyKey: z.string().min(1).max(200),
});

/**
 * 额度发放的响应（`POST /ledger/credits`）。
 *
 * 三个字段各自回答一个调用方真正要问的问题：
 * - `transactionId`：这次发放**在账本上的那一笔**（审计与对账都按它追溯）；
 * - `created`：同键重放 ⇒ `false`。**不是**被静默吞掉的重复——D9 明写这是调用方
 *   需要知道的事实（否则它无法区分「我的重试生效了」与「我发了两笔」）；
 * - `balance`：该用户**可用**余额，**小单位十进制字符串**——绝不是 JSON number（C22）。
 *   它是**这个事务里**读出来的（与过账同一个事务），因此回答的是
 *   「这次发放之后他的余额是多少」，而不是一个可能已经变了的值。
 *
 * **刻意没有** `frozen` / `userId` / 金额回显：这条路由的调用方（管理员）问的是
 * 「这次发放成了没有、他现在多少」，多给的字段只会变成下一个人的兼容负担（C16）。
 */
export interface GrantCreditResponse {
  transactionId: string;
  /** 同键重放 ⇒ false（D9：调用方需要知道的事实，不是被静默吞掉的重复）。 */
  created: boolean;
  /** 该用户**可用**余额（小单位十进制字符串）——绝不是 JSON number（C22）。 */
  balance: string;
}
