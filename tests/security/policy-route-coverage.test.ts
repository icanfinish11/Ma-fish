import { describe, expect, it } from 'vitest';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createTestApp } from '../helpers/app.js';
import { PolicyModule } from '@vca/api/common/policy/policy.module.js';
import { RouteDeclarationRegistry } from '@vca/api/common/policy/route-declaration.registry.js';
import { Policy, Public } from '@vca/api/common/policy/policy.decorator.js';

/**
 * 「漏声明即失败」的 CI 门（设计 §9 / 验收 13.2）。
 *
 * 第一条用例**必须**跑真实 `AppModule`：它是让「每个路由都要显式声明策略」成为**约束**的
 * 那颗牙。删掉 `HealthController` 的 `@Public()` 会让它变红（变异探针见报告），
 * 将来任何一个新 controller 忘了 `@Policy` / `@Public` 也一样。
 *
 * 但「空数组」本身是个**弱断言**：注册表什么都没扫到、或者被写成 `return []`，它照样绿。
 * 所以另外两条用例从两侧把洞堵上——第二条证明注册表对「未声明」敏感（有漏必报），
 * 第三条（下面 `@Public()` 的类级探针）证明它不会把合法的公开控制器误报成漏声明。
 */

/** 故意漏声明的探针路由：用来证明这道门对「未声明」真的敏感。 */
@Controller('__coverage-probe')
class CoverageProbeController {
  @Get('undeclared')
  undeclared(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * 类级 `@Public()` 的探针：门必须认出「整个控制器都是公开的」，
 * 否则会把一个合法的公开控制器误报成漏声明（假红同样会让这道门失去信任）。
 */
@Public()
@Controller('__coverage-public-probe')
class CoveragePublicProbeController {
  @Get('a')
  a(): { ok: boolean } {
    return { ok: true };
  }

  @Get('b')
  b(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * 正确声明了策略的探针：门必须**接受**它。少了这一格，`listUndeclaredRoutes()` 的过滤器
 * 只被证明「会报错」，没被证明「该放过时会放过」——照着规矩写的人被误拦同样是门坏了。
 */
@Controller('__coverage-declared-probe')
class CoverageDeclaredProbeController {
  @Policy({ resource: 'Asset', action: 'read' })
  @Get('declared')
  declared(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [PolicyModule],
  controllers: [CoverageProbeController, CoveragePublicProbeController, CoverageDeclaredProbeController],
})
class CoverageProbeModule {}

async function withApp<T>(app: INestApplication, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    // 断言失败时也必须关掉应用，否则 worker 会被一个没关的 Nest 实例拖住。
    await app.close();
  }
}

describe('每个路由都必须有策略声明（§9 / 验收 13.2）', () => {
  it('生产 AppModule 中不存在未声明的路由', async () => {
    const app = await createTestApp();
    await withApp(app, () => {
      const registry = app.get(RouteDeclarationRegistry);

      // 顺序是刻意的：**门自己的断言排第一**，这样「漏声明」失败时给出的永远是那句可执行的信息
      // （列出是哪个 controller、哪个方法、哪条路径），而不是一条辅助断言的措辞。
      const undeclared = registry.listUndeclaredRoutes();
      expect(undeclared, `以下路由缺少 @Policy 或 @Public 声明：\n${undeclared.join('\n')}`).toEqual([]);

      // 非空转前提：再证明发现层**真的看到了**已知的那条路由。
      // 没有这一步，`undeclared` 为空既可能是「全都声明了」，也可能是「一个 controller 都没扫到」
      // ——后者（DiscoveryModule 没接上、scanner 行为变化）会让这道门永远绿灯。
      // 第二条用例从另一个方向堵同一个洞（注册表对「未声明」是否敏感）。
      const health = registry.find('HealthController', 'live');
      expect(health, 'RouteDeclarationRegistry 未能发现 HealthController.live，覆盖率门形同虚设').toMatchObject({
        path: '/health',
        isPublic: true,
        decl: null,
      });

      /**
       * **Task 8 新增的三条路由**（Step 6：让这道门包含它们）。
       *
       * 这道门本身是**通用**的：它枚举真实 `AppModule` 的全部路由，因此新路由一注册就
       * 自动进它的视野——**「漏声明必须让测试失败」这条性质不需要为新路由改代码**
       * （变异探针实测：把 `@Policy` 从下载路由上删掉，第一条用例立刻红并点名那条路径）。
       *
       * 那这里为什么还要逐条断言？因为「门会红」与「门**看得见**这三条新路由」是两件事：
       * 若新路由因为模块没被 `imports` 进 `AppModule`（或路径写成了别的东西）而**根本没被
       * 注册**，第一条用例照样全绿（`undeclared` 是空数组），而那三条路由在运行期
       * 会是 404——一个「门看不见」的盲区，正是 `HealthController` 那一条存在的理由。
       */
      expect(registry.find('AssetController', 'issueDownloadUrl'), '新路由没被注册表发现').toMatchObject({
        path: '/assets/versions/:versionId/download-url',
        isPublic: false,
        decl: { resource: 'Asset', action: 'download' },
      });
      expect(registry.find('AssetController', 'download'), '公开的下载路由必须**显式**标 @Public').toMatchObject({
        path: '/assets/download',
        isPublic: true,
        decl: null,
      });
      expect(registry.find('AssetController', 'readMetadata'), '新路由没被注册表发现').toMatchObject({
        path: '/assets/versions/:versionId/metadata',
        /**
         * ★ **P3 / Task 1（控制器裁定 ①）改了这里的声明形状**。
         *
         * 被替换掉的旧契约原文：
         * ```
         * // §9 矩阵里「Asset 元数据 read = 所有人」那一行由 @Public() 独占表达
         * isPublic: true,
         * decl: null,
         * ```
         *
         * 新契约：「登录即可」的**具名条件** `assetMetadataRead`（由 `AssetModule.onModuleInit`
         * 注册）。它不是「无需身份」的第二种写法——`PolicyGuard` 的判定顺序第 4 步对
         * **任何**非 `@Public()` 的声明都先要求身份（`policy.guard.ts` 的方案 B），
         * 因此匿名的表现是 403「需要登录」而不是放行。
         *
         * 判别力：把 `@Policy(...)` 换回 `@Public()`（探针 P-3 的做法）⇒ `isPublic` 变成
         * `true`、`decl` 变成 `null` ⇒ 这条立刻红，而**同一次改动**也让越权矩阵的匿名格
         * 拿到 200 ⇒ 另一条也红。
         */
        isPublic: false,
        decl: { resource: 'Asset', action: 'read', condition: 'assetMetadataRead' },
      });
      expect(registry.find('AssetController', 'upload')).toMatchObject({
        path: '/assets/upload',
        decl: { resource: 'Asset', action: 'create' },
      });

      /**
       * **Task 10 新增的那一条路由**（Step 6：让这道门包含它）。
       *
       * 它是 P2 里唯一一条外部可达的**造钱路径**（`POST /ledger/credits` 能把平台账户记成
       * 负数、把用户余额记成正数），因此「门看得见它」这件事本身值得一条断言，
       * 而不是靠「第一条用例的 `undeclared` 是空数组」间接成立：
       * 若 `LedgerModule` 忘了进 `AppModule.imports`，那条路由在运行期是 **404**，
       * 而第一条用例照样全绿（`undeclared` 依然是空数组）——那正是 `HealthController`
       * 那一条存在的理由（同一个盲区在 P1 / Task 8 也出现过一次）。
       *
       * §9 矩阵里没有 `Ledger.grant` 这一行，因此这一格是「最保守并且在今天可判定」的一档：
       * 只有管理员（条件 `ledgerAdminGrant` 由 `LedgerModule.onModuleInit` 注册）。
       * 限流归属 `search`（表里唯一「按 IP、短窗口」的档）——理由与代价写在
       * `ledger.controller.ts` 的类注释里。
       */
      expect(registry.find('LedgerController', 'grant'), '新路由没被注册表发现').toMatchObject({
        path: '/ledger/credits',
        isPublic: false,
        decl: { resource: 'Ledger', action: 'grant', condition: 'ledgerAdminGrant' },
        rateLimit: 'search',
      });

      /**
       * ── P3 / Task 6：交换的**六条**路由（逐条）────────────────────────────────
       *
       * 与 `HealthController` 那一条同一理由，而这一次的盲区**已经发生过一次**：
       * 若 `ExchangeModule` 忘了进 `AppModule.imports`，那六条路由在运行期是 **404**，
       * 而上面那句 `expect(undeclared).toEqual([])` **照样全绿**
       * —— 没被注册的路由不在注册表里，`undeclared` 依然是空数组。
       * ⇒ 「门会红」与「门**看得见**这些路由」是两件事，下面六条断言的是后者。
       *
       * 判别力（探针 P-T6-a）：把 `ExchangeModule` 从 `AppModule.imports` 里删掉
       * ⇒ 这六条**立刻红**（`registry.find` 返回 `undefined`），
       * 而第一条用例仍然绿 —— 这正是它们存在的证明。
       *
       * ## 三条不在 §9 矩阵里的声明（据实记载，与 `exchange.controller.ts` 的类注释同源）
       * §9 只写了 `SwapOffer accept / reject` 与 `SwapContract confirmLock`。
       * `create` / `withdraw` / `read` 取的是「最保守并且在今天可判定的一档」，
       * 逐条写在这里而不是留在一句注释里：**声明是契约**，而契约要被断言看见。
       */
      expect(registry.find('ExchangeController', 'propose'), '交换的发要约路由没被注册表发现').toMatchObject({
        path: '/exchange/offers',
        isPublic: false,
        decl: { resource: 'SwapOffer', action: 'create' },
        rateLimit: 'bid',
      });
      expect(registry.find('ExchangeController', 'accept')).toMatchObject({
        path: '/exchange/offers/:offerId/accept',
        isPublic: false,
        // 条件 `swapOfferSent` 由 `ExchangeModule.onModuleInit` 注册（D11 的接缝）。
        // 漏注册的表现是**本模块路由全部 403**（fail-closed），而这条断言会在那之前
        // 就把「声明里写着这个条件名」这件事钉住。
        decl: { resource: 'SwapOffer', action: 'accept', condition: 'swapOfferSent' },
        rateLimit: 'bid',
      });
      expect(registry.find('ExchangeController', 'reject')).toMatchObject({
        path: '/exchange/offers/:offerId/reject',
        decl: { resource: 'SwapOffer', action: 'reject', condition: 'swapOfferSent' },
        rateLimit: 'bid',
      });
      expect(registry.find('ExchangeController', 'withdraw')).toMatchObject({
        path: '/exchange/offers/:offerId/withdraw',
        // **无条件**：「只有发起方」那条限制由服务层执行（见控制器类注释里的分工）。
        decl: { resource: 'SwapOffer', action: 'withdraw' },
        rateLimit: 'bid',
      });
      expect(registry.find('ExchangeController', 'readOffer')).toMatchObject({
        path: '/exchange/offers/:offerId',
        /**
         * ★ **P3 / Task 7 换了这里的条件**（控制器裁定「修」，Task 6 报告的那条真缺陷）。
         *
         * 被替换掉的旧契约原文：
         * ```
         * decl: { resource: 'SwapOffer', action: 'read', condition: 'swapOfferSent' },
         * ```
         * 旧条件下**发起方读自己的要约得 403**，而一份 `ACCEPTED` 的要约**谁都读不到**
         * —— 与这条路由自己的注释（「双方可见」）以及服务层的判定都相反。
         * 新条件 `swapOfferParty`（由 `ExchangeModule.onModuleInit` 注册）= 发起方 **或**
         * 被要约方，**不判状态**。
         *
         * 判别力：把声明改回 `swapOfferSent` ⇒ 这一格立刻红，**同一次改动**也让
         * `authz-matrix.test.ts` 的两条新用例（发起方 200 / 终态双方 200）红。
         * 把 `swapOfferParty` 的注册删掉 ⇒ 本模块这条路由 403（fail-closed），
         * 同样红在那两条上（探针 `P-T7-readoffer-*`）。
         */
        decl: { resource: 'SwapOffer', action: 'read', condition: 'swapOfferParty' },
        rateLimit: 'search',
      });
      expect(registry.find('ExchangeController', 'readContract')).toMatchObject({
        path: '/exchange/contracts/:contractId',
        decl: { resource: 'SwapContract', action: 'read', condition: 'swapContractParty' },
        rateLimit: 'search',
      });
      /**
       * ── P3 / Task 7：`confirmLock`（第七条路由）──────────────────────────────
       *
       * 与上面六条同一理由（「门会红」与「门**看得见**这条路由」是两件事）：
       * 若这条路由因为模块/provider 没接上而根本没被注册，`undeclared` 照样是空数组。
       * 它是 §9:478 那一行（`SwapContract confirmLock` = 当事人），条件因此复用
       * `swapContractParty`；限流归 `bid`（C33：交换的写路由）。
       */
      expect(registry.find('ExchangeController', 'confirmLock'), '确认锁定路由没被注册表发现').toMatchObject({
        path: '/exchange/contracts/:contractId/confirm-lock',
        isPublic: false,
        decl: { resource: 'SwapContract', action: 'confirmLock', condition: 'swapContractParty' },
        rateLimit: 'bid',
      });
    });
  });

  it('对「未声明」敏感：探针模块上必须**恰好**报出那一条漏声明的路由', async () => {
    // 这条是上一条的**对照**：若 `listUndeclaredRoutes()` 被写成 `return []`，上一条会假绿，
    // 而这一条会红。缺了它，「空数组」就分不清是「全都声明了」还是「根本没在查」。
    //
    // 探针模块里同时放了三类路由，正好压住过滤器的三个分支：
    // 漏声明（报出）、类级 @Public()（放过）、显式 @Policy（放过）。因此这里断言的是
    // **恰好一条**，而不是「至少一条」——多报（误拦）与少报（漏拦）都会让它变红。
    const mod = await Test.createTestingModule({ imports: [CoverageProbeModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    await withApp(app, () => {
      expect(app.get(RouteDeclarationRegistry).listUndeclaredRoutes()).toEqual([
        'CoverageProbeController.undeclared  /__coverage-probe/undeclared',
      ]);
    });
  });
});
