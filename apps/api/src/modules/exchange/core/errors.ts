/**
 * 交换的领域错误族（**只有这一处定义**，Task 3）。
 *
 * 分类标准与 `ledger/core/errors.ts` 逐字同源：HTTP 边界要按它们分开说清**责任方**。
 * 七种因由 → 五种状态码（`exchange-error-map.ts` 是**唯一**的翻译表，Task 6）：
 *
 * | 错误 | 状态码 | 责任方 |
 * |---|---|---|
 * | `UnknownExchangeStatusError` | 422 | **库里的数据**出现了 §6.3 之外的 status（不可接受的是数据） |
 * | `InvalidExchangeTransitionError` | 409 | 请求本身合法，冲突在于**资源的当前状态** |
 * | `SwapSelfOfferError` | 409 | 这是同一个人（「转给自己」的交换版，与 P1 的 `SelfTransferRejectedError` 同档） |
 * | `AssetLockedError` | 409 | 作品正被另一份合约锁着 / 正是本案要锁的那一件 |
 * | `IneligibleAssetError` | 422 | **制品本身**不满足 §6.1 第 2 条（与 P1 的 422 同义） |
 * | `EscrowShortfallError` | 500 | 不变式 #4 被破坏 —— **我们自己的**不变量 |
 * | `UnknownLockOrderError` | 500 | 调用方没有按全局锁序取锁（**我们的 bug**） |
 *
 * ★ 增量 A-6 新增两档（Task 6 的保真链写入侧）：
 *
 * | 错误 | 状态码 | 责任方 |
 * |---|---|---|
 * | `InvalidClaimsError` | 422 | 声明**本身**不可接受：落在闭集外、形状不合法、或者**核不动** |
 * | `StaleCommitmentError` | 409 | 请求合法，冲突在于**资源的当前状态**：带回的承诺与当前值不一致 |
 * | `UnknownExchangeObjectError` | 404 | 这次请求引用的要约 / 合约**不可见**（不存在，或不是当事人的） |
 *
 * 两者的分档与上面那条读了两次的切法一致：**不可接受的是数据**（422）与
 * **不可接受的是这次请求**（409）。`InvalidClaimsError` 的另一半（核不动的声明）
 * 尤其必须停在 422：那一次失败的责任方**不是**调用方（缺列是平台的数据事实），
 * 因此它不能伪装成一次 409「你自己再来一次」。
 *
 * ## 为什么「422 与 409」这一刀切在这里
 * 与 `ledger` 的同一条读法：**不可接受的是数据**（422）与**不可接受的是这次请求**
 * （409）是两件不同的事。「库里的 `status` 是 `NOT_A_STATUS`」不是用户做错了什么，
 * 而「这份要约已经是 `ACCEPTED` 了，你不能再拒绝它」是请求与资源当前状态的冲突。
 * 把它们并成一个错误类型会让那次翻译只能靠猜，而状态码正是调用方唯一能据以行动的信号。
 */

/** 库里的 `status` 落在 §6.3 的闭集之外 ⇒ 422（不可接受的是**数据**）。 */
export class UnknownExchangeStatusError extends Error {
  constructor(readonly status: string) {
    super(`未知的交换状态（§6.3 之外）：${status}`);
    this.name = 'UnknownExchangeStatusError';
  }
}

/** §6.3 的图上没有这条边 ⇒ 409（请求合法，冲突在资源的当前状态）。 */
export class InvalidExchangeTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`非法的状态迁移（§6.3 的图上没有这条边）：${from} → ${to}`);
    this.name = 'InvalidExchangeTransitionError';
  }
}

/** 向自己发要约：`proposer === counterparty`（`top_up_payer_id` 之外的另一处自指）。 */
export class SwapSelfOfferError extends Error {
  constructor(readonly userId: string) {
    super(`不能向自己发要约：${userId}`);
    this.name = 'SwapSelfOfferError';
  }
}

/** 作品已被锁定（§6.3:284 的「不可编辑 / 不可另行上架 / 不可删除」）⇒ 409。 */
export class AssetLockedError extends Error {
  constructor(
    readonly assetId: string,
    readonly holder: string,
  ) {
    super(`作品已被锁定（§6.3:284）：${assetId}，持有者 ${holder}`);
    this.name = 'AssetLockedError';
  }
}

/** 制品本身不满足 §6.1 第 2 条（D16 的资格判据）⇒ 422，与 P1 的 422 同义。 */
export class IneligibleAssetError extends Error {
  constructor(
    readonly assetId: string,
    readonly reason: string,
  ) {
    super(`作品不满足交换资格（§6.1 第 2 条）：${assetId} —— ${reason}`);
    this.name = 'IneligibleAssetError';
  }
}

/**
 * 不变式 #4 被破坏：托管余额 < 未结算义务之和 ⇒ **500**。
 *
 * ## 它为什么是 500 而不是 409
 * 预检 §0.3 的证伪逐字：「两个合约各锁 1000，其中一笔释放 1500 ⇒ **接受**、
 * ESCROW = 500（≥ 0）、`isBalanced = true`、审计如实。**平台为该合约付出了它从未为
 * 这份合约持有的 500 分，而没有任何一条不变式看得见。**」
 *
 * 也就是说：一旦这个不等式被破坏，**平台已经付出了它没有的钱** —— 那不是调用方的
 * 操作问题，是我们自己的账做错了。两个量都记在错误上（金额是内部标识，**不进响应体**：
 * C11 的边界由 Task 6 的翻译表把守，它只回 `code`）。
 */
export class EscrowShortfallError extends Error {
  constructor(
    readonly escrowBalance: bigint,
    readonly outstanding: bigint,
  ) {
    super(`托管不足（不变式 #4）：ESCROW=${escrowBalance.toString()} < 未结算义务=${outstanding.toString()}`);
    this.name = 'EscrowShortfallError';
  }
}

/**
 * 取锁顺序违反了全局锁序（C35）⇒ **500**（我们的 bug，不是调用方的）。
 *
 * `held` 是本次事务**已经**持有行锁的资产（按取的先后），`wanted` 是即将要取的。
 * 唯一会抛它的是 `lock-order.ts` 的 `assertLockOrderHeld`，而它是给人看的：
 * 真出现这条错误说明某条双锁路径**写错了顺序** —— 那正是预检 §B.1 实测的两类死锁
 * （`P2010` / `P2034`，带 `40P01`）的**成因**，而这里把它变成一条在取锁之前就响的错。
 */
export class UnknownLockOrderError extends Error {
  constructor(
    readonly held: readonly string[],
    readonly wanted: readonly string[],
  ) {
    super(`取锁顺序违反了全局锁序（C35）：已持 [${held.join(',')}]，又要 [${wanted.join(',')}]`);
    this.name = 'UnknownLockOrderError';
  }
}

/**
 * 一份声明不可接受（增量 A-6 / 规格 §6）⇒ **422**。
 *
 * 三种因由共用这一个类（它们的状态码与责任方相同，都是「数据/声明本身不可接受」）：
 *   ① 闭集外的 `kind`（`quality_is_good` 这种自由文本声明）；
 *   ② 形状不合法（空数组、空字符串、非正数、超长列表、多余字段、重复项）；
 *   ③ **核不动**的一条声明（`min_code_lines` 而 `asset_metadata.code_lines` 是 NULL）。
 *
 * ## 为什么它不是 400
 * 400 在本仓库的既定含义是「调用方给的**参数**不对」，而 400 会把闭集的第二份实现
 * 逼进 `dto.ts` 的 zod 里——规格 §6.3 明写「解析器与判据都从**同一张表**派生，
 * 禁止两处各写一份」。③ 更明确地不是 400：缺列是**平台的**数据事实。
 *
 * ## 为什么 `reason` 不进响应体
 * 它是诊断（会点名闭集、点名列），而 C11 的边界要求响应体只有 `code`
 * （由 `exchange-error-map.ts` 的唯一出口把守，`error-map.test.ts` 逐档断言）。
 */
export class InvalidClaimsError extends Error {
  constructor(readonly reason: string) {
    super(`承诺声明不可接受：${reason}`);
    this.name = 'InvalidClaimsError';
  }
}

/**
 * 带回的承诺与**当前值**不一致 ⇒ **409**（「资料已变更，请重新查看」，增量 A-6 / 规格 §5.1）。
 *
 * ## 它守的是什么（规格 §5.1 逐字）
 * 「预览响应返回 `(assetVersionId, dossierDigest)`，而 `POST /exchange/offers/:id/accept`
 * **必须把它们原样带回**。……**这是「钉住」在竞态下的唯一正确形状**：没有它，
 * `pinnedVersionId` 记的是「平台此刻的版本」，而不是「接受方当时判的那一份」。」
 *
 * ⇒ 三个字段一起才是「哪一份」，因此**哪一项不一致都抛同一个类**：
 * 它们是同一个事实的三个投影，分开成三个错误类只会让 HTTP 层多三种要处理的形状，
 * 而调用方唯一正确的下一步在三种情形下**是同一步**：重新查看，再重试。
 *
 * ## 为什么是 409 而不是 422
 * 请求本身完全合法（两个 UUID、一个有界的摘要），冲突在于**资源的当前状态**
 * （作者在上一次查看之后上传了新版本）。这正是 409 携带的「先裁决、再重试」。
 *
 * ## 为什么 `expected` / `actual` 不进响应体
 * 它们是内部标识（版本 id / 摘要），且回显它们会把一次「你自己看过了」变成一次
 * 「平台告诉你现在是什么」——C11 的边界由唯一出口 `exchangeErrorToHttp` 把守。
 */
export class StaleCommitmentError extends Error {
  constructor(
    /** 哪一项不一致（`assetVersionId` / `dossierDigest`），用于日志与测试定位。 */
    readonly field: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`带回的承诺与当前值不一致（${field}）：期望 ${expected}，收到 ${actual}`);
    this.name = 'StaleCommitmentError';
  }
}

/**
 * 这次请求引用的要约 / 合约**不可见** ⇒ **404**（P3 / Task 6）。
 *
 * ## 一个类覆盖两种因由（这是刻意的，与 `DownloadTicketRejectedError` 同一形状）
 *   * 那一行**不存在**；
 *   * 它存在，但调用方**不是当事人**（既不是发起方也不是被要约方；合约的两位当事人同理）。
 *
 * 两者给**同一个**答案，理由是 `checkAccess` 那条既定的读法：「授权判定的答案只有
 * 『可以』与『不可以』」。把两者分开会让「这个 id 存在吗」变成一条**不需要身份**就能
 * 问出来的问题——一次枚举面。**这不是拒绝面的含糊**：它拒的是同一种东西
 * （「这次引用没有指向一个你能看见的对象」），而 404 已经把责任方说清楚了。
 *
 * ## 为什么它必须存在（而不是复用 `AssetNotFoundError` 或干脆抛一个 500）
 * 四条要约路由里有两条（`withdraw` / `getOffer`）在**服务层**做当事人判定，
 * 而 HTTP 层的 `swapOfferSent` 条件对另外两条只覆盖「被要约方 + `SENT`」——
 * 一份 `ACCEPTED` 的要约、或者一个不存在的 id，必须有一条**具名**的出口。
 * 复用 `AssetNotFoundError` 会让日志与响应体把「作品」与「要约」混成同一个对象名，
 * 而这两个名字在排障时是唯一的线索。
 *
 * ## 为什么 `objectId` 不进响应体
 * 它是调用方自己给的那个 id（回显它没有意义），而 C11 的边界由唯一出口
 * `exchangeErrorToHttp` 把守：响应体只有 `code`。
 * **`kind` 决定 `code`**（`EXCHANGE_OFFER_NOT_FOUND` / `EXCHANGE_CONTRACT_NOT_FOUND`）：
 * 两种对象的排障路径不同，而 `code` 是调用方与告警规则唯一能据以分流的东西。
 */
export class UnknownExchangeObjectError extends Error {
  constructor(
    readonly kind: 'offer' | 'contract',
    readonly objectId: string,
  ) {
    super(`不可见的交换对象（${kind}）：${objectId}`);
    this.name = 'UnknownExchangeObjectError';
  }
}

