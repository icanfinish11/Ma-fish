import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { currentContext } from '../../common/context/request-context.js';
import { parseOrBadRequest } from '../../common/http/parse-or-bad-request.js';
import { Policy } from '../../common/policy/policy.decorator.js';
import { RateLimited } from '../../common/security/throttler.js';
import { acceptOfferSchema, offerReasonSchema, proposeOfferSchema, uuidParamSchema } from './dto.js';
import type { AcceptOfferResponse, ContractView, OfferView, ProposeOfferResponse } from './dto.js';
import { exchangeErrorToHttp } from './exchange-error-map.js';
import { ExchangeService } from './exchange.service.js';

/**
 * 策略条件的名字（**唯一**定义处；`ExchangeModule.onModuleInit` 反向 import 它）。
 *
 * ## 为什么它在本文件里，而不是计划字面写的 `exchange.module.ts`（与 `ledger` 逐字同源）
 *
 * 实测过的那一次（`ledger.controller.ts` 的常量头注释里有完整输出）：把常量放在模块文件里
 * 会让依赖成环（`exchange.module.ts → exchange.controller.ts → exchange.module.ts`），
 * 而 `@Policy({…})` 的实参在**类定义期**求值——ESM 的循环导入下那一刻模块绑定还没初始化，
 * 于是模块加载直接失败、三个 security 套件在**收集阶段**就红。
 * ⇒ 常量跟着「拥有这个概念的那处代码」走：**声明方**（本文件的装饰器）拥有名字，
 * **注册方**（`ExchangeModule`）反向 import 它。
 */
export const POLICY_CONDITIONS = {
  /** 本用户是不是这份要约的目标对手方，且要约处于 `SENT`（§9:475 / §9:477 两行共用）。 */
  swapOfferSent: 'swapOfferSent',
  /** 本用户是不是这份合约的当事人（§9:478 `SwapContract confirmLock`）。 */
  swapContractParty: 'swapContractParty',
} as const;

/**
 * 交换的六条路由（P3 / Task 6；§6.3 的要约生命周期 + §9 的矩阵）。
 *
 * ## 两条策略条件的注册在 `ExchangeModule`（D11 的接缝）
 *
 * 条件体**只查本模块的表**（C5）。它们从 `req.params` 取业务 id，**不**从请求体取
 * ——体是调用方完全可控的，而路径参数至少被路由约束过。
 * 未注册的条件一律拒绝（fail-closed），因此漏注册的表现是「本模块的路由全部 403」，
 * 而不是悄悄放行。
 *
 * ## ★★ C33：限流档名与用途不吻合（**据实记载**，与 `ledger.controller.ts` 逐字同源）
 *
 * 控制器裁定 ④：交换路由挂 **`bid` 档（30 次/分钟、按用户）**，并**记录档名不吻合**。
 * 理由是 `RATE_LIMITS` 是设计文档 §4.1 威胁 #13 那张表的投影，
 * `tests/security/rate-limit.test.ts` 逐条断言它与设计一致 —— **新增一个安全参数是一次
 * 设计裁定**（阈值多少、按什么分桶），不是实现者可以顺手做的。P1 的三个新端点因此
 * 也都归了 `search`。这里的代价是：档名叫 `bid` 而挂的是**要约**的收发。
 * 要自己的一档时的改法是「一行表项 + 设计文档一行 + 这里的装饰器」。
 *
 * **读路径**（两条 `GET`）挂 `search` —— 表里唯一「按 IP、短窗口」的档（60 次/分钟）。
 *
 * ## 三条不在 §9 矩阵里的声明（**逐字记录矩阵缺行**，C16 的最小改动）
 *
 * §9 只写了 `SwapOffer accept / reject` 与 `SwapContract confirmLock`。因此：
 *
 * | 路由 | 声明 | 取这一档的理由 |
 * |---|---|---|
 * | `propose`（`SwapOffer.create`） | **无条件**（登录即可） | §9 没有这一行。按 P2 `Ledger.grant` 的处置取「最保守并且在今天可判定的一档」；「谁能发要约」在 §6.3 里就是对**自己的**作品发起的动作，因此「登录即可」是今天可判定的那一档 |
 * | `withdraw`（`SwapOffer.withdraw`） | **无条件**（登录即可） | 同上。**「只有发起方」这条限制由服务层执行**（`ExchangeService.withdrawOffer`），理由写在那里 |
 * | `readOffer`（`SwapOffer.read`） | 条件 `swapOfferSent` | 计划明写这一条。**据实记载它与自己的注释冲突**：注释说「双方可见」，而 `swapOfferSent` 只放行「被要约方 + `SENT`」——发起方与终态要约因此读不到。本任务取**声明**（覆盖率门逐条断言的就是它），冲突进报告 §concerns |
 *
 * **不发明**一条 §9 没有的授权规则，是这一段的全部内容。
 *
 * ## 为什么每一个处理器都先 `parseOrBadRequest`
 *
 * 路径参数的 UUID 形状与理由的闭集是**调用方**的错误（400），而领域错误是
 * **资源当前状态**的冲突（409/422/404）。两者是不同责任方的事，因此校验**在 `try` 之外**：
 * 把 DTO 的校验放进 `try` 会让 `exchangeErrorToHttp` 有机会再翻译一次
 * `BadRequestException`（它今天返回 `null`，于是行为不变，但那是一条靠巧合成立的路径
 * ——`ledger.controller.ts` 的类注释里有同一条理由）。
 *
 * ## 为什么 `actorId` 一律来自 `currentContext()`
 *
 * 「谁发的」只能由服务端认定（会话中间件填进 ALS 的），否则审计里的 `actorId` 就是
 * 调用方的自述。`PolicyGuard` 已经保证它存在（每条路由的声明都要求身份）。
 */
@Controller('exchange')
export class ExchangeController {
  constructor(private readonly exchange: ExchangeService) {}

  /** 发要约（§9:477 的 `DRAFT → SENT`）。**挂 `bid` 档**（C33）。 */
  @Policy({ resource: 'SwapOffer', action: 'create' })
  @RateLimited('bid')
  @Post('offers')
  async propose(@Body() body: unknown): Promise<ProposeOfferResponse> {
    const dto = parseOrBadRequest(proposeOfferSchema, body);
    try {
      return await this.exchange.proposeOffer({
        proposerId: actorId(),
        offeredAssetId: dto.offeredAssetId,
        targetAssetId: dto.targetAssetId,
        offeredDossierDigest: dto.offeredDossierDigest,
        claims: dto.claims,
      });
    } catch (error) {
      throw exchangeErrorToHttp(error) ?? error;
    }
  }

  /** 接受（§9:477）。**条件 `swapOfferSent`**：被要约方 + 状态 `SENT`。 */
  @Policy({ resource: 'SwapOffer', action: 'accept', condition: POLICY_CONDITIONS.swapOfferSent })
  @RateLimited('bid')
  @HttpCode(HttpStatus.OK)
  @Post('offers/:offerId/accept')
  async accept(@Param('offerId') offerId: string, @Body() body: unknown): Promise<AcceptOfferResponse> {
    const id = parseOrBadRequest(uuidParamSchema, { id: offerId });
    const dto = parseOrBadRequest(acceptOfferSchema, body);
    try {
      return await this.exchange.acceptOffer({ offerId: id, actorId: actorId(), targetCommitment: dto.targetCommitment });
    } catch (error) {
      throw exchangeErrorToHttp(error) ?? error;
    }
  }

  /** 拒绝（§9:477）。同一条条件：只有被要约方，且要约还在 `SENT`。 */
  @Policy({ resource: 'SwapOffer', action: 'reject', condition: POLICY_CONDITIONS.swapOfferSent })
  @RateLimited('bid')
  @HttpCode(HttpStatus.OK)
  @Post('offers/:offerId/reject')
  async reject(@Param('offerId') offerId: string, @Body() body: unknown): Promise<void> {
    const id = parseOrBadRequest(uuidParamSchema, { id: offerId });
    const reason = parseOrBadRequest(offerReasonSchema, body);
    try {
      await this.exchange.rejectOffer({ offerId: id, actorId: actorId(), reason });
    } catch (error) {
      throw exchangeErrorToHttp(error) ?? error;
    }
  }

  /** 撤回（§6.3:279 的 `WITHDRAWN`）。**只有发起方**（服务层判定，见类注释）。 */
  @Policy({ resource: 'SwapOffer', action: 'withdraw' })
  @RateLimited('bid')
  @HttpCode(HttpStatus.OK)
  @Post('offers/:offerId/withdraw')
  async withdraw(@Param('offerId') offerId: string, @Body() body: unknown): Promise<void> {
    const id = parseOrBadRequest(uuidParamSchema, { id: offerId });
    const reason = parseOrBadRequest(offerReasonSchema, body);
    try {
      await this.exchange.withdrawOffer({ offerId: id, actorId: actorId(), reason });
    } catch (error) {
      throw exchangeErrorToHttp(error) ?? error;
    }
  }

  /** 读一份要约。挂 `search`（读路径，按 IP）。声明与注释的冲突见类注释。 */
  @Policy({ resource: 'SwapOffer', action: 'read', condition: POLICY_CONDITIONS.swapOfferSent })
  @RateLimited('search')
  @Get('offers/:offerId')
  async readOffer(@Param('offerId') offerId: string): Promise<OfferView> {
    const id = parseOrBadRequest(uuidParamSchema, { id: offerId });
    try {
      return await this.exchange.getOffer(id, actorId());
    } catch (error) {
      throw exchangeErrorToHttp(error) ?? error;
    }
  }

  /** 读一份合约（当事人可见）。挂 `search`。 */
  @Policy({ resource: 'SwapContract', action: 'read', condition: POLICY_CONDITIONS.swapContractParty })
  @RateLimited('search')
  @Get('contracts/:contractId')
  async readContract(@Param('contractId') contractId: string): Promise<ContractView> {
    const id = parseOrBadRequest(uuidParamSchema, { id: contractId });
    try {
      return await this.exchange.getContract(id, actorId());
    } catch (error) {
      throw exchangeErrorToHttp(error) ?? error;
    }
  }
}

/**
 * 当事人。**必然存在**：六条路由的声明都要求身份，而 `PolicyGuard` 的判定顺序第 4 步
 * 对**任何**非 `@Public()` 的声明都先要求身份（`userId` 缺失 ⇒ 403「需要登录」）。
 * 写成函数而不是在每个处理器里 `?? ''`：一个空串会以「查不到这一行」的形式表现出来，
 * 那是把一次**接线错误**伪装成一次**正常的 404**（`policy.guard.ts` 的注释里有同一条理由）。
 */
function actorId(): string {
  const userId = currentContext()?.userId;
  if (userId === undefined) {
    // 走到这里说明守卫被绕过或接线错了。抛一个**不是**领域错误的错（⇒ 500），
    // 因为这不是调用方的责任，而 `exchangeErrorToHttp` 不会翻译它。
    throw new Error('交换路由在没有任何当事人上下文的情况下被执行（PolicyGuard 未生效？）');
  }
  return userId;
}
