import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ledgerErrorToHttp } from '@vca/api/modules/ledger/ledger-error-map.js';
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
} from '@vca/api/modules/ledger/core/errors.js';

/**
 * 领域错误 → HTTP 的**唯一**翻译表（P2 / Task 10）。
 *
 * ## 这个文件问的是哪一件事
 *
 * 「同一种错误只有一处出口」。散在各处理器里的 `instanceof` 分支迟早给出不同的状态码，
 * 而那时「谁对」要靠读两处代码判断（`asset.controller.ts` 的 `assetErrorToHttp` 为此
 * 付过一次代价，P1 / Task 8）。因此本表的每一行都要有一个**可判定的**期望，
 * 而不是「大概会返回点什么」。
 *
 * ## 三个断言各自堵的洞（照 `asset-error-map.test.ts` 的形状）
 *
 * 1. 每一行：状态码 + `code` 字符串（**责任方**写在状态码上：409 = 资源当前状态不允许、
 *    400 = 调用方给的数不对、422 = 数据里出现了 §8.1 之外的 kind、500 = 服务端自己的 bug）；
 * 2. `code` **两两不同**：两种不同的领域错误共用一个 code 等于把它们合并了，
 *    调用方再也没法区分责任方（这条同时防「复制粘贴一行忘了改 code」）；
 * 3. 响应体**只有** `code` 一个键：500 的响应体里不得出现内部诊断信息（C11 的边界），
 *    409/400/422 也一样只给一个可检索的代号——金额与余额不进响应体。
 *
 * 外加两条**反例**（翻译表自己不能崩，也不能把陌生错误伪装成已知错误）。
 */
interface Row {
  label: string;
  error: () => Error;
  status: number;
  code: string;
}

const ROWS: Row[] = [
  {
    label: 'InsufficientFundsError（资源当前状态不允许这次过账）',
    error: () => new InsufficientFundsError('acct', 'USER_AVAILABLE', 10n, 20n, 'conditional-update'),
    status: 409,
    code: 'LEDGER_INSUFFICIENT_FUNDS',
  },
  {
    label: 'IdempotencyKeyReusedError（同一个键被用在不同的请求上）',
    error: () => new IdempotencyKeyReusedError('k'),
    status: 409,
    code: 'LEDGER_IDEMPOTENCY_KEY_REUSED',
  },
  {
    label: 'InvalidAmountError（调用方给的数不对）',
    error: () => new InvalidAmountError('金额必须为正'),
    status: 400,
    code: 'LEDGER_INVALID_AMOUNT',
  },
  {
    label: 'InvalidFeeRateError（调用方给的费率不对）',
    error: () => new InvalidFeeRateError('费率越界'),
    status: 400,
    code: 'LEDGER_INVALID_FEE_RATE',
  },
  {
    label: 'MissingAccountError（快照里少了这个账户：服务端数据缺失）',
    error: () => new MissingAccountError('acct'),
    status: 500,
    code: 'LEDGER_ACCOUNT_MISSING',
  },
  {
    label: 'SystemAccountMissingError（系统账户该在而不在：迁移没跑）',
    error: () => new SystemAccountMissingError('PLATFORM_ESCROW'),
    status: 500,
    code: 'LEDGER_SYSTEM_ACCOUNT_MISSING',
  },
  {
    label: 'UnbalancedPostingError（C28：借贷不平是我们自己的 bug）',
    error: () => new UnbalancedPostingError(-1n, 2),
    status: 500,
    code: 'LEDGER_UNBALANCED_POSTING',
  },
  {
    label: 'EmptyPostingError（一次没有任何腿的过账）',
    error: () => new EmptyPostingError('没有腿'),
    status: 500,
    code: 'LEDGER_EMPTY_POSTING',
  },
  {
    label: 'ZeroAmountLegError（金额为 0 的腿）',
    error: () => new ZeroAmountLegError('acct'),
    status: 500,
    code: 'LEDGER_ZERO_AMOUNT_LEG',
  },
  {
    label: 'NetZeroLegError（两条互相抵消的转移）',
    error: () => new NetZeroLegError('acct'),
    status: 500,
    code: 'LEDGER_NET_ZERO_LEG',
  },
  {
    label: 'SelfMoveError（转移的双方是同一个账户）',
    error: () => new SelfMoveError('acct'),
    status: 500,
    code: 'LEDGER_SELF_MOVE',
  },
  {
    label: 'UnknownUserError（C1：这次请求引用的用户不存在）',
    error: () => new UnknownUserError('01920000-0000-7000-8000-0000000000ff'),
    status: 404,
    code: 'LEDGER_UNKNOWN_USER',
  },
  {
    label: 'UnknownAccountKindError（C30：数据里出现了 §8.1 之外的 kind）',
    error: () => new UnknownAccountKindError('SELLER_AVAILABLE'),
    status: 422,
    code: 'LEDGER_UNKNOWN_ACCOUNT_KIND',
  },
  {
    // P3 / Task 4（D5 / 控制器裁定 ⑦）：§8.2 之外的**交易** kind。
    // 与上一档同档（422）的理由逐字写在 `core/errors.ts` 那个类的注释里：`kind` **不是**
    // HTTP 入参（六个原语各自硬编码自己的 kind），因此走到这里的只可能是我们自己的代码传错值
    // ——那是「数据/程序」的问题，与「调用方给的参数不对」（400）不是一回事。
    label: 'UnknownTransactionKindError（D5：§8.2 之外的交易 kind）',
    error: () => new UnknownTransactionKindError('NOT_A_KIND'),
    status: 422,
    code: 'LEDGER_UNKNOWN_TRANSACTION_KIND',
  },
];

describe('领域错误 → HTTP 的翻译表（唯一出口）', () => {
  for (const row of ROWS) {
    it(`${row.label} ⇒ ${String(row.status)} ${row.code}`, () => {
      const mapped = ledgerErrorToHttp(row.error());
      expect(mapped, '这一档没有被翻译（返回了 null，会被当成未预期错误 → 500）').toBeInstanceOf(HttpException);
      expect(mapped?.getStatus()).toBe(row.status);
      const body = mapped?.getResponse() as Record<string, unknown>;
      expect(body.code).toBe(row.code);
      // 响应体只有 code：金额 / 余额 / 账户 id 这些内部量一个都不进对外契约（C11 的边界）。
      expect(Object.keys(body), `响应体里混进了别的字段：${JSON.stringify(body)}`).toEqual(['code']);
    });
  }

  it('两张表不许撞码：每一档的 `code` 两两不同（撞码 = 责任方再也分不开）', () => {
    const codes = ROWS.map((row) => row.code);
    // 非空转前提：先证明这一组确实有 14 档（否则「两两不同」在空数组上恒真）。
    // 12 → 13 是 P2 最终审查 C1 加的 `UnknownUserError`（404）；13 → 14 是 P3 / Task 4（D5）
    // 加的 `UnknownTransactionKindError`（422）。这条下限的用途正是「表里少了一档时必须红一次」，
    // 因此它跟着表一起改，不许单独放宽。
    expect(codes).toHaveLength(14);
    expect(new Set(codes).size).toBe(codes.length);
    // 再看运行期：每一种错误实例真的翻译出上表里那个 code（而不是只在表面上不同）。
    const actual = ROWS.map((row) => (ledgerErrorToHttp(row.error())?.getResponse() as { code: string }).code);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('未登记的错误 ⇒ null（交给 Nest 的默认过滤器，不伪装成已知错误）', () => {
    expect(ledgerErrorToHttp(new Error('别的东西坏了'))).toBeNull();
    expect(ledgerErrorToHttp(new RangeError('还是别的'))).toBeNull();
  });

  it('非 Error 的输入不抛（翻译表自己不能崩）', () => {
    // 抛在这里的失效形态最难查：调用方的 catch 里再抛一次，得到的是一个与根因无关的 500。
    expect(() => ledgerErrorToHttp(null)).not.toThrow();
    expect(() => ledgerErrorToHttp(undefined)).not.toThrow();
    expect(() => ledgerErrorToHttp('boom')).not.toThrow();
    expect(() => ledgerErrorToHttp({ code: 500 })).not.toThrow();
    expect(ledgerErrorToHttp(null)).toBeNull();
    expect(ledgerErrorToHttp('boom')).toBeNull();
    expect(ledgerErrorToHttp({ code: 500 })).toBeNull();
  });
});

/**
 * **基础设施层**的错误（不是领域错误）也只有一个出口 —— P2 最终审查 M3。
 *
 * ## 它挡的是什么
 * 请求路径的事务用 Prisma 的**默认**预算（`maxWait` 2 s / `timeout` 5 s），而测试里那些
 * 持锁的用例显式放宽到 20 s。争用超过 5 s 时 Prisma 抛 `P2028`，而它此前**没有翻译** ⇒ 500。
 * 500 让调用方无法区分「别重试」与「重试是安全的」，而这里的事实是：**重试是安全的**
 * （同一个幂等键会走重放路径 ⇒ `created:false`，不会记第二笔）。因此它是 **503**。
 *
 * ## 为什么它单独一张表
 * 上面那张表的每一行都是**领域错误类**（`instanceof`）；这一档判的是 Prisma 的 `code`——
 * 它是基础设施的形状，不是账本的语义。两张表分开，是为了让「谁负责哪一类」在文件里看得见。
 */
interface InfraRow {
  label: string;
  error: () => unknown;
  status: number;
  code: string;
}

/** 用真实形状构造：Prisma 的已知错误是 `Error` 的实例，`code` 挂在实例上。 */
function prismaError(code: string): Error {
  return Object.assign(new Error(`Prisma 报了一个 ${code}`), { code });
}

const INFRA_ROWS: InfraRow[] = [
  {
    label: 'P2028（Prisma 交互式事务超时：争用/锁等待超出事务预算）',
    error: () => prismaError('P2028'),
    status: 503,
    code: 'LEDGER_TX_TIMEOUT',
  },
];

describe('基础设施层错误 → HTTP：P2028 是可安全重试的 503（M3）', () => {
  for (const row of INFRA_ROWS) {
    it(`${row.label} ⇒ ${String(row.status)} ${row.code}`, () => {
      const mapped = ledgerErrorToHttp(row.error());
      expect(mapped, '这一档没有被翻译（返回了 null ⇒ 500，调用方看不出重试是安全的）').toBeInstanceOf(HttpException);
      expect(mapped?.getStatus()).toBe(row.status);
      const body = mapped?.getResponse() as Record<string, unknown>;
      expect(body.code).toBe(row.code);
      // 与上面那张表同一条纪律：响应体只有 code（不回显 Prisma 的内部消息）。
      expect(Object.keys(body), `响应体里混进了别的字段：${JSON.stringify(body)}`).toEqual(['code']);
    });
  }

  it('**别的** Prisma 错误码仍然 ⇒ null（不许把任意 Prisma 错误都当成「可重试」）', () => {
    // 这条是 503 那一档的反面：判别式必须是**恰好一个** code。
    // 放宽成「任何 Prisma 错误都回 503」会把一次真正的不变量破坏说成一次可重试的争用。
    for (const code of ['P2002', 'P2025', 'P2034', 'P1001', 'P2010']) {
      expect(ledgerErrorToHttp(prismaError(code)), `${code} 被误判成事务超时`).toBeNull();
    }
  });
});
