import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  EmptyPostingError,
  IdempotencyKeyReusedError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidFeeRateError,
  MissingAccountError,
  NetZeroLegError,
  SelfMoveError,
  SystemAccountMissingError,
  UnbalancedPostingError,
  UnknownAccountKindError,
  UnknownTransactionKindError,
  UnknownUserError,
  ZeroAmountLegError,
} from './core/errors.js';

/**
 * 领域错误 → HTTP 的**唯一**翻译表（与 `assetErrorToHttp` 同一形状与同一理由：
 * 同一种错误只有一处出口，否则两个出口迟早给出不同的状态码）。
 *
 * | 错误 | 状态码 | 责任方 |
 * |---|---|---|
 * | `InsufficientFundsError` | **409** | 资源**当前状态**不允许这次过账（与 P1 的 `SelfTransferRejectedError` 同档） |
 * | `IdempotencyKeyReusedError` | **409** | 同一个键被用在**不同**的请求上（客户端的键管理错了） |
 * | `InvalidAmountError` / `InvalidFeeRateError` | **400** | 调用方给的数不对（正常路径上被 DTO 挡在前面） |
 * | `UnknownUserError` | **404** | 这次请求引用的用户**不存在**（C1：额度不能发给一个没人能登录的账户） |
 * | `MissingAccountError` / `SystemAccountMissingError` | 500 | 服务端数据缺失（迁移没跑 / 账户该在而不在） |
 * | `UnbalancedPostingError` / `EmptyPostingError` / `ZeroAmountLegError` / `NetZeroLegError` / `SelfMoveError` | **500** | 服务端**自己的** bug（C28：这些断言的存在就是为了在这里响亮） |
 * | `UnknownAccountKindError` | 422 | 数据里出现了 §8.1 之外的 kind（C30：五个之外一律不认） |
 * | `UnknownTransactionKindError` | 422 | §8.2 之外的**交易** kind（P3/Task 4 的 D5：六行之外一律不认；`kind` 不是 HTTP 入参 ⇒ 只可能是我们自己传错了值） |
 * | **`P2028`（Prisma 交互式事务超时）** | **503** | 争用 / 锁等待超出事务预算。**不是**领域错误，但同样只有一个出口：500 会让调用方看不出**重试是安全的**（同一个幂等键会重放） |
 *
 * ## 为什么 409 而不是 400 / 422（与 P1 那次裁定同源）
 *
 * 余额不足**不是**参数错误：请求的内容完全合法，冲突在于**资源的当前状态**。
 * 409 还带着「先裁决、再重试」的意思——客户端唯一正确的下一步是重新读一次余额。
 * 而 422 在本仓库的既定含义是「**制品 / 数据本身**不可接受」：`UnknownAccountKindError`
 * 指的正是「库里的数据出现了 §8.1 之外的取值」，与「你这次请求不成立」是两件事。
 *
 * ## 为什么 500 与 409 之间不能含糊
 *
 * 上面 5 个 500 全是**我们自己的不变量被破坏了**（借贷不平、0 金额的腿、
 * 把同一个账户的两条腿并成一条……）。把它们回成 4xx 会把一次服务端 bug 说成
 * 一次调用方错误，而那是本项目在 P1 就明确拒绝过的形状
 * （`asset.controller.ts` 的 `AssetPersistFailedError` 那一段）。
 *
 * ## 为什么响应体**只有** `code` 一个键
 *
 * 500 的响应体里不得出现内部诊断信息（账户 id、余额、分录）——那些进日志与审计，
 * 不进对外契约（C11 的边界）。4xx 同样只给一个可检索的代号：
 * 把余额/金额回显出去会让「客户端按它做算术」成为事实上的契约，
 * 而金额的**唯一**合法载体是账本（C22/C27）。
 * 这条性质由 `tests/unit/ledger/error-map.test.ts` 逐档断言（`Object.keys(body)` 恰好是 `['code']`）。
 */
/**
 * Prisma 的**交互式事务超时**（`P2028`）—— 基础设施层的形状，不是账本的语义。
 *
 * ## 为什么它要在这里翻译（P2 最终审查 M3）
 * 请求路径的事务用 Prisma 的**默认**预算（`maxWait` 2 s / `timeout` 5 s），而测试里那些持锁的
 * 用例显式放宽到 20 s。争用超过 5 s 时抛这个错误，而它此前落到 `null` ⇒ **500**：
 * 调用方无法区分「别重试」与「重试是安全的」，而这里的事实恰好是**重试是安全的**
 * （同一个幂等键会走重放路径 ⇒ `created:false`，不会记第二笔）。⇒ **503**。
 *
 * ## 为什么判别式必须窄到**恰好一个 code**
 * 放宽成「任何 Prisma 错误都回 503」会把一次真正的不变量破坏说成一次可重试的争用——
 * 那正是本文件开头那条「500 与 4xx 之间不能含糊」的反面。反例由
 * `tests/unit/ledger/error-map.test.ts` 的「别的 Prisma 错误码仍然 ⇒ null」那条守着。
 *
 * ## 见证（端到端，实测）
 * `tests/integration/ledger/topup-route.test.ts` 的「锁争用超出事务预算 ⇒ 503」：用一条独立
 * 连接把目标用户的账户行 `FOR UPDATE` 锁住、持锁 6 s（让 5 s 预算在锁还被持有时过期）、
 * 放锁 ⇒ 请求以 **503 `LEDGER_TX_TIMEOUT`** 返回（实测耗时 **6196 ms**），库里一行未留，
 * 然后**同一个幂等键**重试 ⇒ 200（证明「重试安全」那句话）。
 *
 * ## ★ 顺带被量出来的一件事（审查那句话的机制与它说的不同，据实记载）
 * 审查的原话是「争用下生产预算会产出 P2028」。**第一版按那句话写（持锁不放、等 5 s 看它
 * 变红）实测：请求在 5 s 时根本不会返回——它一直卡在行锁上，60 s 撞测试超时**
 * （证据 `evidence/fix-m3-step3-route-measure.txt`）。原因是 Prisma 的定时器起爆之后要向
 * **同一条连接**发 ROLLBACK，而那条连接正被阻塞的语句占着。
 * ⇒ **事务预算不是锁等待的 deadline**：延迟由争用方决定，`P2028` 在阻塞语句结束之后才到手。
 * 这是一条**可用性**事实，本任务**没有**改它（改它要先在一个没有测量的数字上做决定）；
 * 修的是「拿到 P2028 时回什么」。两者的分工写在这里，免得下一个人把 503 当成延迟兜底。
 */
function isTransactionTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2028';
}

export function ledgerErrorToHttp(error: unknown): HttpException | null {
  if (error instanceof InsufficientFundsError) {
    return new ConflictException({ code: 'LEDGER_INSUFFICIENT_FUNDS' });
  }
  if (error instanceof IdempotencyKeyReusedError) {
    return new ConflictException({ code: 'LEDGER_IDEMPOTENCY_KEY_REUSED' });
  }
  if (error instanceof InvalidAmountError) {
    return new BadRequestException({ code: 'LEDGER_INVALID_AMOUNT' });
  }
  if (error instanceof InvalidFeeRateError) {
    return new BadRequestException({ code: 'LEDGER_INVALID_FEE_RATE' });
  }
  if (error instanceof UnknownUserError) {
    // 404：**这次引用**指向的用户不存在（C1）。刻意不是 400 —— `userId` 的**格式**是对的
    // （DTO 的 `z.uuid()` 已经放行），缺的是那一行；也不是 422 —— 那在本仓库的既定含义是
    // 「**库里的数据**本身不可接受」（`UnknownAccountKindError`）。
    // 响应体同样只有 `code`：不回显 uuid、不吐内部 id（C11 的边界）。
    return new NotFoundException({ code: 'LEDGER_UNKNOWN_USER' });
  }
  if (error instanceof UnknownAccountKindError) {
    // 422：**数据里**出现了 §8.1 之外的 kind（C30）。刻意不是 400——调用方交给我们的
    // 参数是合法的（金额字符串、UUID 都对），不可接受的是那批数据本身。
    return new UnprocessableEntityException({ code: 'LEDGER_UNKNOWN_ACCOUNT_KIND' });
  }
  if (error instanceof UnknownTransactionKindError) {
    // 422（P3 / Task 4；D5）：与上一档**同档**，理由逐字写在 `core/errors.ts` 那个类上——
    // `kind` 不是 HTTP 入参（六个原语各自硬编码自己的 kind），因此走到这里的只可能是
    // **我们自己的**代码传错了一个值。响应体同样只有 `code`（不回显那个取值：它是内部契约）。
    return new UnprocessableEntityException({ code: 'LEDGER_UNKNOWN_TRANSACTION_KIND' });
  }
  if (error instanceof MissingAccountError) {
    return new InternalServerErrorException({ code: 'LEDGER_ACCOUNT_MISSING' });
  }
  if (error instanceof SystemAccountMissingError) {
    return new InternalServerErrorException({ code: 'LEDGER_SYSTEM_ACCOUNT_MISSING' });
  }
  if (error instanceof UnbalancedPostingError) {
    return new InternalServerErrorException({ code: 'LEDGER_UNBALANCED_POSTING' });
  }
  if (error instanceof EmptyPostingError) {
    return new InternalServerErrorException({ code: 'LEDGER_EMPTY_POSTING' });
  }
  if (error instanceof ZeroAmountLegError) {
    return new InternalServerErrorException({ code: 'LEDGER_ZERO_AMOUNT_LEG' });
  }
  if (error instanceof NetZeroLegError) {
    return new InternalServerErrorException({ code: 'LEDGER_NET_ZERO_LEG' });
  }
  if (error instanceof SelfMoveError) {
    return new InternalServerErrorException({ code: 'LEDGER_SELF_MOVE' });
  }
  // 基础设施层的那一档（**不是**领域错误：它判的是 Prisma 的 code，不是 `instanceof`）。
  // 放在领域错误之后：两者对象形状不同，顺序不影响结果，但「先语义、后基础设施」更好读。
  if (isTransactionTimeout(error)) {
    return new ServiceUnavailableException({ code: 'LEDGER_TX_TIMEOUT' });
  }
  // 未登记的错误 ⇒ null：交给 Nest 的默认过滤器，**不**伪装成一个已知错误。
  // 它自己**绝不抛**（输入可能是 null / 字符串 / 任意对象）——翻译表在 catch 里被调用，
  // 这里再抛一次会让调用方拿到一个与根因无关的 500。
  return null;
}
