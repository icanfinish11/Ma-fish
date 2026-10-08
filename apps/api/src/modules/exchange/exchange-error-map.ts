import {
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AssetNotFoundError } from '../asset/index.js';
import {
  AssetLockedError,
  EscrowShortfallError,
  IneligibleAssetError,
  InvalidClaimsError,
  InvalidExchangeTransitionError,
  StaleCommitmentError,
  SwapSelfOfferError,
  UnknownExchangeObjectError,
  UnknownExchangeStatusError,
  UnknownLockOrderError,
} from './core/errors.js';

/**
 * 交换领域错误 → HTTP 的**唯一**翻译表（与 `assetErrorToHttp` / `ledgerErrorToHttp`
 * 同一形状与同一理由：同一种错误只有一处出口，否则两个出口迟早给出不同的状态码）。
 *
 * | 错误 | 状态码 | 责任方 |
 * |---|---|---|
 * | `UnknownExchangeStatusError` | **422** | **库里的数据**出现了 §6.3 之外的 status（不可接受的是数据） |
 * | `InvalidClaimsError` | **422** | 声明落在闭集外 / 形状不合法 / **核不动**（同上） |
 * | `IneligibleAssetError` | **422** | **制品本身**不满足 §6.1 第 2 条（与 P1 的 422 同义） |
 * | `InvalidExchangeTransitionError` | **409** | 请求本身合法，冲突在于**资源的当前状态** |
 * | `SwapSelfOfferError` | **409** | 这是同一个人（与 P1 的 `SelfTransferRejectedError` 同档） |
 * | `AssetLockedError` | **409** | 作品正被另一份合约锁着（§6.3:284） |
 * | `StaleCommitmentError` | **409** | 带回的承诺与**当前值**不一致（「资料已变更，请重新查看」） |
 * | `AssetNotFoundError` | **404** | 这次请求引用的作品不存在（**复用 `asset` 的错误类**，见下） |
 * | `EscrowShortfallError` / `UnknownLockOrderError` | **500** | **我们自己的**不变量被破坏了 |
 *
 * ## 为什么 409 与 422 之间不能含糊（与 `ledger-error-map.ts` 同一条读法）
 *
 * 「不可接受的是**数据**」（422）与「不可接受的是**这次请求**」（409）是两件不同的事。
 * 「库里的 `status` 是 `NOT_A_STATUS`」「这份制品完整度为 0」「这条声明核不动」
 * 都不是调用方做错了什么，而「这份要约已经是 `ACCEPTED` 了」「你带回的摘要是旧的」
 * 是请求与资源当前状态的冲突。把它们并成一个错误类型会让那次翻译只能靠猜，
 * 而状态码正是调用方唯一能据以行动的信号。
 *
 * ## 为什么 `AssetNotFoundError` 在这里被翻译而不是让它落到 Nest 的默认过滤器
 *
 * 它是 `asset` 的错误类（**复用，不复制一份**：`asset/index.ts` 导出领域错误类型的理由
 * 正是「边界要能分开说清责任方」），而 `proposeOffer` 用两次 `checkAccess` 判归属——
 * `checkAccess` 对「作品不存在」与「不是你的」返回**同一个** `false`（那是 D11 的既定
 * 形状：授权判定的答案只有「可以」与「不可以」）。
 *
 * **据实记载这一格的选择**：`checkAccess` 为 `false` 时本表只可能是 404，
 * 因为两个失败因由在 D11 的唯一入口上**本来就不可区分**——把它们在响应里分开
 * 需要第二套判定（「这件作品存在吗」），而那正是 D11 要避免的第二条路径。
 * 404 不比 403 多泄露任何东西：它对「不存在」与「不是你的」给同一个答案。
 *
 * ## 为什么响应体**只有** `code` 一个键
 *
 * 500 的响应体里不得出现内部诊断信息（账户 id、金额、版本 id、摘要）——那些进日志与
 * 审计，不进对外契约（C11 的边界）。4xx 同样只给一个可检索的代号。这条性质由
 * `tests/unit/exchange/error-map.test.ts` 逐档断言（`Object.keys(body)` 恰好是 `['code']`）。
 *
 * ## 为什么 **P2002（唯一冲突）不在这里**
 *
 * `proposeOffer` 的并发那一格（同一对 `(target, counterparty)` 上的两份活跃要约同时插入）
 * 以 P2002 被数据库挡下，而**契约要求它在服务里被消化**：重读那一行并返回
 * `created: false`（「重复是调用方需要知道的事实，而不是被静默吞掉的错误」）。
 * 给它一条翻译会让那次并发变成一次 **409**，而调用方唯一正确的下一步是**重试**——
 * 一次 409 说不出这件事。`error-map.test.ts` 有一条断言把这份分工钉住
 * （P2002 ⇒ `null`）。
 */
export function exchangeErrorToHttp(error: unknown): HttpException | null {
  if (error instanceof UnknownExchangeStatusError) {
    return new UnprocessableEntityException({ code: 'EXCHANGE_UNKNOWN_STATUS' });
  }
  if (error instanceof InvalidClaimsError) {
    // 422：与 `IneligibleAssetError` 同一档——不可接受的是**声明 / 数据本身**。
    // 刻意不是 400：400 会把闭集的第二份实现逼进 `dto.ts` 的 zod 里（规格 §6.3
    // 禁止两处各写一份），而「核不动」（缺列）更明确地不是调用方的参数问题。
    return new UnprocessableEntityException({ code: 'EXCHANGE_INVALID_CLAIMS' });
  }
  if (error instanceof IneligibleAssetError) {
    return new UnprocessableEntityException({ code: 'EXCHANGE_INELIGIBLE_ASSET' });
  }
  if (error instanceof InvalidExchangeTransitionError) {
    return new ConflictException({ code: 'EXCHANGE_INVALID_TRANSITION' });
  }
  if (error instanceof SwapSelfOfferError) {
    return new ConflictException({ code: 'EXCHANGE_SELF_OFFER' });
  }
  if (error instanceof AssetLockedError) {
    return new ConflictException({ code: 'EXCHANGE_ASSET_LOCKED' });
  }
  if (error instanceof StaleCommitmentError) {
    // 409：请求合法（两个 UUID、一个有界的摘要都对），冲突在**资源的当前状态**
    // ——作者在上一次查看之后上传了新版本。409 带着「先裁决、再重试」的意思，
    // 而那正是调用方唯一正确的下一步（重新查看预览）。
    return new ConflictException({ code: 'EXCHANGE_STALE_COMMITMENT' });
  }
  if (error instanceof UnknownExchangeObjectError) {
    // 404，且 `kind` 决定 `code`：两种对象的排障路径不同，而 `code` 是调用方与告警
    // 规则唯一能据以分流的东西。`objectId` **不回显**（它是调用方自己给的那个 id）。
    return new NotFoundException({
      code: error.kind === 'offer' ? 'EXCHANGE_OFFER_NOT_FOUND' : 'EXCHANGE_CONTRACT_NOT_FOUND',
    });
  }
  if (error instanceof AssetNotFoundError) {
    // 具名的出口，而不是让 `asset` 的翻译表在这条路由上也生效：两个出口迟早给出
    // 不同的状态码（`ASSET_VERSION_NOT_FOUND` 在那边是「版本 / 作品」共用的 404）。
    return new NotFoundException({ code: 'EXCHANGE_ASSET_NOT_FOUND' });
  }
  if (error instanceof EscrowShortfallError) {
    return new InternalServerErrorException({ code: 'EXCHANGE_ESCROW_SHORTFALL' });
  }
  if (error instanceof UnknownLockOrderError) {
    return new InternalServerErrorException({ code: 'EXCHANGE_LOCK_ORDER' });
  }
  // 未登记的错误 ⇒ null：交给 Nest 的默认过滤器，**不**伪装成一个已知错误。
  // 它自己**绝不抛**（输入可能是 null / 字符串 / 任意对象）——翻译表在 catch 里被调用，
  // 这里再抛一次会让调用方拿到一个与根因无关的 500。
  return null;
}
