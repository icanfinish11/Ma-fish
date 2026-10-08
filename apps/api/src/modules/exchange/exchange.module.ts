import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { PolicyGuard } from '../../common/policy/policy.guard.js';
import { PrismaService } from '../../db/prisma.service.js';
import { AssetModule } from '../asset/index.js';
import { AuditModule } from '../audit/index.js';
import { ExchangeController, POLICY_CONDITIONS } from './exchange.controller.js';
import { ExchangeService } from './exchange.service.js';

/**
 * 交换模块（P3 / Task 6）。
 *
 * ## 它注册两条策略条件（D11 的接缝 / 预检 §0.2 的第二段）
 *
 * ## 为什么条件在这里注册，而不是让 `asset` 去判
 *
 * 预检实测：`asset` 为了判「是不是交换对手方」而 import `exchange` **会成环**，
 * 仓库自己的 `no-circular` 报 **6 条 error、exit 6**（单向时 `exit 0`）。
 * 而 `PolicyGuard.registerCondition` 是一条**已验证的接缝**（`policy.guard.ts:66`）：
 * 条件由各模块自己注册，守卫从不 import 业务模块——与 `LedgerModule` 注册
 * `ledgerAdminGrant`、`AssetModule` 注册 `assetMetadataRead` 是同一形状。
 *
 * ## 为什么是 `onModuleInit` 而不是字段初始化时
 *
 * `registerCondition` 必须落在**全局守卫那一个实例**上（`PolicyModule` 是 `@Global()`，
 * `AppModule` 用 `useExisting` 把同一个实例接到 `APP_GUARD`）。在 `onModuleInit` 里注册
 * 保证 DI 已经就绪，且注册发生在应用 `init()` 之前——`PolicyGuard.canActivate` 只会
 * 在 `init()` 之后被调用。（写成 `useClass` 时那些条件永远到不了真正拦截请求的守卫上，
 * 表现为「本模块的路由全部 403」；常驻回归在
 * `tests/security/policy-default-deny.test.ts` 的「同一实例」用例里。）
 *
 * ## 条件体的三条纪律
 *
 * 1. **两条判定都在同一条查询里**：`status = 'SENT'` 与 `counterpartyId = userId`
 *    都在 `swapOfferSent` 的 `where`/返回值比较里。把状态判定挪到处理器里会让
 *    「读一份已过期要约」变成一次 200，而那正是条件存在的理由。
 * 2. **只查本模块的表**（C5）：两条都是 `this.prisma.swapOffer` / `this.prisma.swapContract`。
 * 3. **`userId === undefined` 一律 false**：守卫在条件之前就已经把匿名请求拒了
 *    （判定顺序第 4 步），这一句是纵深防御——条件必须**自足**，
 *    否则第二个调用方出现时会变成两条不同的规则。
 *
 * ## 为什么 `prisma` 注进来而 `asset` / `audit` 不注
 *
 * 条件体只需要本模块的两张表。`AssetAccessService` 与 `AuditService` 是
 * `ExchangeService` 的依赖，由 Nest 在它自己的注入器里解析——把它们挂在模块类上
 * 会多两个**一次都没用到**的字段（C16 意义上的空抽象，而且它会误导下一个读它的人
 * 以为条件也查作品）。
 *
 * ## ★ 为什么 `providers` 里**只有** `ExchangeService`（一处据实记载的偏离）
 *
 * 计划的 `ExchangeModule` 列出六个 provider：
 * `[ExchangeService, SwapContractService, SwapSettlementService, SwapTimersService,
 *   ObligationService, PreviewService]`，而其中**五个**是别人的交付物
 * （`SwapContractService` 与 `PreviewService` 属 Task 7–9，`SwapSettlementService` /
 * `SwapTimersService` 属 Task 10，`ObligationService` 属 Task 7/10）。
 * 它们的文件今天**不存在**，而创建一个「什么都没有的服务类」是 C16 明文禁止的
 * 投机抽象（「不建空抽象……不为 P8/P9 预埋空表、空接口、空模块」）——
 * 本 brief 的 Files 行也逐字只列了 `{index,exchange.module,exchange.controller,
 * exchange.service,dto,exchange-error-map}.ts` 六个文件，**不含**那五个。
 * ⇒ 每一个任务把自己的 provider 加进这一行（与 Task 7–10 各自修改本文件同一形状），
 * 而 `index.ts` 的接口清单同理：它导出**今天存在**的东西。
 *
 * ## 为什么 `imports` 里有 `AuditModule` 与 `AssetModule`
 *
 * 两者都是**显式接口**（§3.3 第 2 条；`modules/<other>/index.ts`）：
 * `AuditService`（要约的每一个状态迁移都要落一行 append-only 审计）与
 * `AssetAccessService`（D11 的唯一授权入口 + A-6 要读的四个事实）。
 * **不**引 `LedgerModule`：要约的生命周期一分钱都不动（D9），补差进托管是 Task 8 的事。
 */
@Module({
  imports: [AuditModule, AssetModule],
  controllers: [ExchangeController],
  providers: [ExchangeService],
  exports: [ExchangeService],
})
export class ExchangeModule implements OnModuleInit {
  constructor(
    @Inject(PolicyGuard) private readonly policy: PolicyGuard,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.policy.registerCondition(POLICY_CONDITIONS.swapOfferSent, async ({ req, userId }) => {
      if (userId === undefined) return false;
      const offerId = String((req.params as Record<string, string>)['offerId'] ?? '');
      if (offerId === '') return false;
      const row = await this.prisma.swapOffer.findUnique({
        where: { id: offerId },
        select: { counterpartyId: true, status: true },
      });
      // 两条判定在这里**一起**成立：是这份要约的对手方，且它还在 `SENT`。
      return row !== null && row.status === 'SENT' && row.counterpartyId === userId;
    });

    this.policy.registerCondition(POLICY_CONDITIONS.swapContractParty, async ({ req, userId }) => {
      if (userId === undefined) return false;
      const contractId = String((req.params as Record<string, string>)['contractId'] ?? '');
      if (contractId === '') return false;
      const row = await this.prisma.swapContract.findUnique({
        where: { id: contractId },
        select: { partyAId: true, partyBId: true },
      });
      // **不判状态**：当事人看自己的合约与它走到哪一步无关（§9:478 的「谁」是当事人，
      // 没有第二个维度）。这一点与 `swapOfferSent` 的差别是刻意的：要约的状态是
      // 那一行的语义的一部分，合约的状态不是「谁能看」的一部分。
      return row !== null && (row.partyAId === userId || row.partyBId === userId);
    });
  }
}
