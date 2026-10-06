import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { currentContext } from '../../common/context/request-context.js';
import { parseOrBadRequest } from '../../common/http/parse-or-bad-request.js';
import { formatMinorUnits } from '../../common/money/minor-units.js';
import { Policy } from '../../common/policy/policy.decorator.js';
import { RateLimited } from '../../common/security/throttler.js';
import { grantCreditsSchema, type GrantCreditResponse } from './dto.js';
import { ledgerErrorToHttp } from './ledger-error-map.js';
import { LedgerService } from './ledger.service.js';

/**
 * 策略条件的名字（**唯一**定义处，两侧引用它：本文件的声明 + `LedgerModule` 的注册）。
 *
 * ## 为什么它在本文件里，而不是计划字面写的 `ledger.module.ts`（实测偏离）
 *
 * 实测：把常量放在 `ledger.module.ts` 会让依赖成环
 * （`ledger.module.ts → ledger.controller.ts → ledger.module.ts`），而 `@Policy({…})`
 * 的实参在**类定义期**求值——ESM 的循环导入下那一刻模块绑定还没初始化，于是模块加载
 * 直接失败，三个 security 套件在**收集阶段**就红：
 *
 * ```
 * TypeError: Cannot read properties of undefined (reading 'ledgerAdminGrant')
 *  ❯ apps/api/src/modules/ledger/ledger.controller.ts:52:79
 *  ❯ apps/api/src/modules/ledger/ledger.module.ts:5:1
 * ```
 *
 * 这不是风格问题：**声明方**（本文件的装饰器）与**注册方**（`LedgerModule.onModuleInit`）
 * 必须引用同一个字符串，而两者之间只有一条无环的依赖方向——模块 → 控制器。
 * 因此常量定义在**使用它的那个装饰器所在的文件**里，模块反向 import 它
 * （与 `asset` 的 `DOWNLOAD_PATH` 住在 `download/signed-url.ts` 同一个处置：
 * 常量跟着「拥有这个概念的那处代码」走）。
 *
 * 写成两份字面量的代价是真实的：改名会让「声明了一个没人注册的条件」在运行期表现为
 * 一条**看不出原因**的 403（`PolicyGuard` 对未注册条件是 fail-closed）。
 */
export const POLICY_CONDITIONS = { ledgerAdminGrant: 'ledgerAdminGrant' } as const;

/**
 * 额度发放路由（D9 / §2.1 / §8.1）。
 *
 * ## 声明：`Ledger` + `grant` + 条件 `ledgerAdminGrant`
 *
 * §9 的矩阵里没有这一行，因此这里取的是**最保守并且在今天可判定**的一档：
 * 只有管理员。矩阵缺行这件事据实记载（与 P1 的 `Asset.create` 同一处置）。
 * 这条声明同时是**唯一**的授权执行点：`PolicyGuard` 在处理器之前运行，
 * 因此被拒的请求不会留下任何一行（由 `tests/security/ledger/authz-matrix.test.ts` 断言）。
 *
 * ## 限流归属 `search`（**据实记载**）
 *
 * 威胁 #13 点名的五类端点里没有「管理动作」，而 `RATE_LIMITS` 是**设计文档 §4.1 威胁 #13
 * 的投影**——`tests/security/rate-limit.test.ts` 逐条断言它与设计一致。新增一个安全参数
 * 是一次**设计裁定**，不是实现者能顺手做的（P1 的三个新端点因此也都归了 `search`）。
 * 本路由按 IP、60 次/分钟，对一条管理动作是足够的；要自己的一档时的改法是
 * 「一行表项 + 设计文档一行 + 这里的装饰器」。
 *
 * ## 幂等：同键重放返回 **200 + `created:false`**，不是 201
 *
 * 这条路由没有创建可寻址的资源（交易是内部对象），而重放不产生新对象；两种情形都回 200，
 * 由 `created` 字段区分——调用方拿到的是一个**能据以行动的事实**，而不是被吞掉的重复。
 *
 * ## 为什么注入的依赖里**没有** `PrismaService`
 *
 * 计划的草稿把它注进了构造函数但**一次都没用**（余额来自 `LedgerService.readBalances`，
 * 而那是它在过账事务里的读）。留着一个不用的依赖正是 C16 意义上的空抽象，
 * 而且它会误导下一个读它的人以为「这条路由自己查库」。据实记载这处偏离。
 *
 * ## 为什么先 `parseOrBadRequest` 再进 `try`
 *
 * DTO 的 400 与领域错误的 409/422/500 是**两条**责任方不同的事：前者是调用方给错了参数
 * （`parseOrBadRequest` 已经抛出 `BadRequestException`），后者是账本的状态/数据。
 * 把校验放进 `try` 里会让 `ledgerErrorToHttp` 有机会再次翻译一个已经是 `HttpException`
 * 的东西——它今天返回 `null`（未登记），于是行为不变，但那是一条靠巧合成立的路径。
 */
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Policy({ resource: 'Ledger', action: 'grant', condition: POLICY_CONDITIONS.ledgerAdminGrant })
  // 归属 `search` 那一层（60 次/分钟，按 IP）——理由见类注释末尾的限流一节。
  @RateLimited('search')
  @HttpCode(HttpStatus.OK)
  @Post('credits')
  async grant(@Body() body: unknown): Promise<GrantCreditResponse> {
    // `@Body()` 拿到的是**未校验**的原始值，zod 在这里才是真正的校验点
    // （用 `parseOrBadRequest` 而不是 `schema.parse`：后者抛出的 `ZodError` 会变成 500）。
    const dto = parseOrBadRequest(grantCreditsSchema, body);
    try {
      const { result, balance } = await this.ledger.runWithIdempotentRetry(async (tx) => {
        const result = await this.ledger.grantCredit(tx, {
          userId: dto.userId,
          amount: dto.amount,
          idempotencyKey: dto.idempotencyKey,
          // 发起人来自会话上下文（`SessionMiddleware` 填的），**不是**请求体里的字段：
          // 「谁发的」只能由服务端认定，否则审计里的 `actorId` 就是调用方的自述。
          // `PolicyGuard` 已经保证它存在（有条件声明要求身份）。
          actorId: currentContext()?.userId ?? null,
        });
        // 余额与过账**同一个事务**里读：事务外的读会给出一个可能已经变了的值，
        // 而「发放之后他的余额是多少」正是这条路由要回答的问题。
        const balances = await this.ledger.readBalances(tx, dto.userId);
        return { result, balance: balances.available };
      });
      // C22：**绝不**把 bigint 放进响应体（`JSON.stringify(1n)` 会抛；而 Nest 响应链路上
      // 的 bigint 行为是预检 §G.3 明确留白的未验证面）。进出都是字符串，那条未验证面
      // 在这条路由上因此**不可达**。
      return { transactionId: result.transactionId, created: result.created, balance: formatMinorUnits(balance) };
    } catch (error) {
      // 翻译只有一处（`ledgerErrorToHttp`）：409/400/422/500 的每一档都在那里说明责任方。
      throw ledgerErrorToHttp(error) ?? error;
    }
  }
}
