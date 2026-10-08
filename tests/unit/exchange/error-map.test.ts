import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { AssetLockedByContractError } from '@vca/api/modules/asset/index.js';
import { AssetNotFoundError } from '@vca/api/modules/asset/ownership.service.js';
import { exchangeErrorToHttp } from '@vca/api/modules/exchange/exchange-error-map.js';
import {
  AssetLockedError,
  EscrowShortfallError,
  ExpiredExchangeWindowError,
  IneligibleAssetError,
  InvalidClaimsError,
  InvalidExchangeTransitionError,
  StaleCommitmentError,
  SwapSelfOfferError,
  UnknownExchangeObjectError,
  UnknownExchangeStatusError,
  UnknownLockOrderError,
} from '@vca/api/modules/exchange/core/errors.js';

/**
 * 交换领域错误 → HTTP 的**唯一**翻译表（P3 / Task 6）。
 *
 * ## 这个文件问的是哪一件事
 *
 * 「同一种错误只有一处出口」。散在各处理器里的 `instanceof` 分支迟早给出不同的状态码，
 * 而那时「谁对」要靠读两处代码判断（`asset.controller.ts` 的 `assetErrorToHttp` 为此
 * 付过一次代价，P1 / Task 8）。因此本表的每一行都要有一个**可判定的**期望。
 *
 * ## 三个断言各自堵的洞（照 `tests/unit/ledger/error-map.test.ts` 的形状）
 *
 * 1. 每一行：状态码 + `code`（**责任方**写在状态码上：409 = 资源当前状态不允许这次请求、
 *    422 = **数据 / 制品本身**不可接受、404 = 这次引用指向的对象不存在、500 = 我们自己的 bug）；
 * 2. `code` **两两不同**：两种不同的领域错误共用一个 code 等于把它们合并了；
 * 3. 响应体**只有** `code` 一个键（C11 的边界：不回显内部标识、金额、版本 id、摘要）。
 *
 * 外加两条**反例**（翻译表自己不能崩，也不能把陌生错误伪装成已知错误）。
 *
 * ## ★ 增量 A-6 新增的两档，各自的状态码是怎么定的
 *
 * | 错误 | 状态码 | 责任方 |
 * |---|---|---|
 * | `InvalidClaimsError` | **422** | 声明**本身**落在闭集外 / 核不动（与 `IneligibleAssetError`、`UnknownAccountKindError` 同一档：不可接受的是**数据**） |
 * | `StaleCommitmentError` | **409** | 请求合法，冲突在于**资源的当前状态**（「资料已变更，请重新查看」正是 409 的语言） |
 */
interface Row {
  label: string;
  error: () => Error;
  status: number;
  code: string;
}

const ROWS: Row[] = [
  {
    label: 'UnknownExchangeStatusError（库里的数据出现了 §6.3 之外的状态）',
    error: () => new UnknownExchangeStatusError('NOT_A_STATUS'),
    status: 422,
    code: 'EXCHANGE_UNKNOWN_STATUS',
  },
  {
    label: 'InvalidExchangeTransitionError（§6.3 的图上没有这条边）',
    error: () => new InvalidExchangeTransitionError('SENT', 'EXPIRED'),
    status: 409,
    code: 'EXCHANGE_INVALID_TRANSITION',
  },
  {
    label: 'SwapSelfOfferError（向自己发要约）',
    error: () => new SwapSelfOfferError('01920000-0000-7000-8000-0000000000ff'),
    status: 409,
    code: 'EXCHANGE_SELF_OFFER',
  },
  {
    label: 'AssetLockedError（作品已被锁定，§6.3:284）',
    error: () => new AssetLockedError('a', 'contract'),
    status: 409,
    code: 'EXCHANGE_ASSET_LOCKED',
  },
  {
    label: 'IneligibleAssetError（制品本身不满足 §6.1 第 2 条）',
    error: () => new IneligibleAssetError('a', '完整度为 0'),
    status: 422,
    code: 'EXCHANGE_INELIGIBLE_ASSET',
  },
  {
    label: 'EscrowShortfallError（不变式 #4 被破坏：我们自己的不变量）',
    error: () => new EscrowShortfallError(0n, 1n),
    status: 500,
    code: 'EXCHANGE_ESCROW_SHORTFALL',
  },
  {
    label: 'UnknownLockOrderError（取锁顺序违反 C35：我们的 bug）',
    error: () => new UnknownLockOrderError(['b'], ['a']),
    status: 500,
    code: 'EXCHANGE_LOCK_ORDER',
  },
  {
    // ★ 增量 A-6：解析器（`core/claims.ts`）是抛它的唯一地方，因此它同时也带着
    //   「闭集只有一处实现」这条纪律的证据——若有人把闭集复制进 zod，那条路径会得到
    //   400 而不是这一档的 422，`dto.test.ts` 的那条断言会先红。
    label: 'InvalidClaimsError（增量 A-6：声明落在闭集外 / 含核不动的一条）',
    error: () => new InvalidClaimsError('闭集外的 kind：quality_is_good'),
    status: 422,
    code: 'EXCHANGE_INVALID_CLAIMS',
  },
  {
    label: 'StaleCommitmentError（增量 A-6：带回的承诺与当前值不一致）',
    error: () => new StaleCommitmentError('versionId', '01920000-0000-7000-8000-0000000000aa', '01920000-0000-7000-8000-0000000000bb'),
    status: 409,
    code: 'EXCHANGE_STALE_COMMITMENT',
  },
  {
    // 一个类、**两个** code（`kind` 决定它）：与 `DownloadTicketRejectedError` 同一形状。
    // 两行都在表里，因为它们的状态码相同而 `code` 不同——`code` 是调用方与告警规则
    // 唯一能据以分流的东西，而「作品」与「合约」的排障路径不同。
    label: 'UnknownExchangeObjectError（要约不存在 / 不可见）',
    error: () => new UnknownExchangeObjectError('offer', '01920000-0000-7000-8000-0000000000dd'),
    status: 404,
    code: 'EXCHANGE_OFFER_NOT_FOUND',
  },
  {
    // ★ P3 / Task 7：**双锁**那一侧的作品锁（`asset` 的锁服务抛的那个类）。
    // 它与 `AssetLockedError` 是同一件事实的两条路径，而 `code` 不同 ——
    // 调用方的下一步不同（换一件作品再发 vs 这份合约走不下去）。
    label: 'AssetLockedByContractError（Task 7：双锁时作品已被另一份合约持有）',
    error: () => new AssetLockedByContractError('a', '01920000-0000-7000-8000-0000000000ff'),
    status: 409,
    code: 'EXCHANGE_ASSET_LOCKED_BY_CONTRACT',
  },
  {
    // ★ P3 / Task 7：24 小时窗口过期。它与 `InvalidExchangeTransitionError` 同为 409，
    // 而**因由不同**（时间 vs 状态）—— 计划逐字要求两者分开（Step 3 第 3 条）。
    label: 'ExpiredExchangeWindowError（Task 7：双锁的 24 小时窗口已过）',
    error: () => new ExpiredExchangeWindowError('lock', new Date(0), new Date(1_000)),
    status: 409,
    code: 'EXCHANGE_WINDOW_EXPIRED',
  },
  {
    label: 'UnknownExchangeObjectError（合约不存在 / 不可见）',
    error: () => new UnknownExchangeObjectError('contract', '01920000-0000-7000-8000-0000000000ee'),
    status: 404,
    code: 'EXCHANGE_CONTRACT_NOT_FOUND',
  },
  {
    // 复用 `asset` 的错误类（不复制一份：`asset/index.ts` 导出领域错误类型的理由正是
    // 「边界要能分开说清责任方」）。`exchange` 的翻译表给它一个**具名**的出口，
    // 而不是让 `assetErrorToHttp` 在这条路由上也生效（两个出口迟早给出不同的状态码）。
    label: 'AssetNotFoundError（这次引用指向的作品不存在）',
    error: () => new AssetNotFoundError('01920000-0000-7000-8000-0000000000cc'),
    status: 404,
    code: 'EXCHANGE_ASSET_NOT_FOUND',
  },
];

describe('交换领域错误 → HTTP（唯一翻译表）', () => {
  for (const row of ROWS) {
    it(`${row.label} ⇒ ${String(row.status)} ${row.code}`, () => {
      const mapped = exchangeErrorToHttp(row.error());
      expect(mapped, '这一档没有被翻译（返回了 null，会被当成未预期错误 → 500）').toBeInstanceOf(HttpException);
      expect(mapped?.getStatus()).toBe(row.status);
      const body = mapped?.getResponse() as Record<string, unknown>;
      expect(body.code).toBe(row.code);
      // 响应体只有 code：版本 id / 摘要 / 金额 / 作品 id 一个都不进对外契约（C11 的边界）。
      expect(Object.keys(body), `响应体里混进了别的字段：${JSON.stringify(body)}`).toEqual(['code']);
    });
  }

  it('表里不许撞码：每一档的 `code` 两两不同（撞码 = 责任方再也分不开）', () => {
    const codes = ROWS.map((row) => row.code);
    // 非空转前提：先证明这一组确实有 14 档（否则「两两不同」在空数组上恒真）。
    // 7（`core/errors.ts` 的七档，Task 3）+ 2（增量 A-6：`InvalidClaimsError` /
    // `StaleCommitmentError`）+ 2（`UnknownExchangeObjectError` 的两个 `kind`）
    // + 1（复用 `asset` 的 `AssetNotFoundError`）= **12**；
    // ★ P3 / Task 7（增量 A-7 与双锁）再 +2：`AssetLockedByContractError`（双锁那一侧）
    // 与 `ExpiredExchangeWindowError`（24 小时窗口）⇒ **14**。
    // 这条下限的用途正是「表里少了一档时必须红一次」。**首跑实测：我按 9 写，vitest 报
    // `expected … to have a length of 9 but got 10`** —— 这条断言第一次运行就抓到了
    // 一次算术错误，正是它存在的理由。
    expect(codes).toHaveLength(14);
    expect(new Set(codes).size).toBe(codes.length);
    // 再看运行期：每一种错误实例真的翻译出上表里那个 code（而不是只在表面上不同）。
    const actual = ROWS.map((row) => (exchangeErrorToHttp(row.error())?.getResponse() as { code: string }).code);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('未登记的错误 ⇒ null（交给 Nest 的默认过滤器，不伪装成已知错误）', () => {
    expect(exchangeErrorToHttp(new Error('别的东西坏了'))).toBeNull();
    expect(exchangeErrorToHttp(new RangeError('还是别的'))).toBeNull();
    // Prisma 的形状（P2002 = 唯一冲突）：`proposeOffer` 的并发那一格在服务里被**消化**掉，
    // 因此它**不**应该有一条翻译——把它翻成 409 会让「并发下的第二次要约」变成一次失败，
    // 而契约是「复用那一行（`created: false`）」。这条断言把那份分工钉住。
    expect(exchangeErrorToHttp(Object.assign(new Error('unique'), { code: 'P2002' }))).toBeNull();
    // 也不是 `asset` 的错误类：`SelfTransferRejectedError` 是 P1 的（作品转让），
    // 与交换的自要约不是同一件事，两张表各有各的出口。
    expect(exchangeErrorToHttp(new Error('SelfTransferRejectedError'))).toBeNull();
  });

  it('非 Error 的输入不抛（翻译表自己不能崩）', () => {
    // 抛在这里的失效形态最难查：调用方的 catch 里再抛一次，得到的是一个与根因无关的 500。
    for (const value of [null, undefined, 'boom', { code: 500 }, 0, Symbol('x')]) {
      expect(() => exchangeErrorToHttp(value), `${String(value)} 让翻译表崩了`).not.toThrow();
      expect(exchangeErrorToHttp(value)).toBeNull();
    }
  });
});
