import { describe, expect, it } from 'vitest';
import { Controller, Get, Module, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createTestApp } from '../helpers/app.js';
import { PolicyModule } from '@vca/api/common/policy/policy.module.js';
import { PolicyRegistry } from '@vca/api/common/policy/policy.registry.js';
import { RateLimited, SkipRateLimit } from '@vca/api/common/security/throttler.js';

/**
 * 「漏声明限流归属即失败」的 CI 门（修复轮 1 / C-4，形态照 Task 5 的策略门）。
 *
 * ## 它拦的是什么
 *
 * 运行期规则是「每层只对显式声明它的路由生效」（见 `throttler.ts` 的 `throttlerOptions`），
 * 因此一条**没有任何声明**的新路由在运行期**完全不限流**，而所有测试照旧全绿。
 * 这是「声明了但没执行」的同一个缺陷类（空操作的 `REVOKE`、漏掉 `.tsx` 的扫描器、
 * 死代码规则、恒真断言）。威胁 #13 点名的 5 类端点里，P0 只有 login/register 存在；
 * P1–P4 要新增 upload/bid/search 时，漏写 `@RateLimited` 就是「不限流的出价接口」。
 *
 * ## 为什么不用「默认层」兜（另一种直觉写法）
 *
 * 「所有路由默认套最严的一层」会让 `/health` 第 4 次就被 429（实测见
 * `rate-limit.test.ts` 的变异探针 P3），负载均衡会把整个实例判死；
 * 而且五层叠加的语义（任一命中即拒）与设计里的「每类端点一个桶」并不一致。
 * 因此默认仍然「未声明即不限流」（fail-quiet 的**运行期**方向不变），
 * 但**编译期/CI** 补上一道显式的门：每条路由要么归属某一层、要么显式说「有意不限流」。
 *
 * ## 三条用例各自堵的洞
 *
 * 1. 生产 `AppModule` 上没有任何缺归属的路由（门本身）；
 * 2. **对照**：探针模块里故意漏一条、故意矛盾一条，门必须**恰好**报出那两条
 *    ——Task 5 的教训是「空数组」本身是弱断言：门被写成 `return []` 时它也绿；
 *    再补一条「该放过时必须放过」（`@SkipRateLimit()` 与 `@RateLimited()` 都算合规）；
 * 3. 发现层确实看到了已知的两条真实路由（`/health` 与 `/auth/register`），
 *    否则「没有缺归属的路由」也可能只是「一个 controller 都没扫到」。
 */

/** 故意漏声明的探针：门必须报出它。 */
@Controller('__rate-limit-probe')
class RateLimitProbeController {
  @Post('undeclared')
  undeclared(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * 两个**合法**状态的探针：显式豁免（`@SkipRateLimit()`）与显式归属（`@RateLimited`）。
 * 少了这一格，门只被证明「会报错」，没被证明「照着规矩写的人会被放过」。
 */
@Controller('__rate-limit-declared-probe')
class RateLimitDeclaredProbeController {
  @SkipRateLimit()
  @Get('skipped')
  skipped(): { ok: boolean } {
    return { ok: true };
  }

  @RateLimited('bid')
  @Post('limited')
  limited(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * 自相矛盾的探针：既声明了 `search` 层、又要求豁免。
 *
 * 运行期以层声明为准（fail-strict，见 `SkipRateLimit` 的注释），
 * 但两种声明里必有一个在说谎，因此门一样报出来——静默挑一个执行，
 * 正是「配置写了但不生效」那类最难查的形态。
 */
@Controller('__rate-limit-conflict-probe')
class RateLimitConflictProbeController {
  @SkipRateLimit()
  @RateLimited('search')
  @Get('conflict')
  conflict(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [PolicyModule],
  controllers: [RateLimitProbeController, RateLimitDeclaredProbeController, RateLimitConflictProbeController],
})
class RateLimitCoverageProbeModule {}

async function withApp<T>(app: INestApplication, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    // 断言失败时也必须关掉应用，否则 worker 会被一个没关的 Nest 实例拖住。
    await app.close();
  }
}

describe('每个路由都必须有明确的限流归属（修复轮 1 / C-4）', () => {
  it('生产 AppModule 中不存在「既未声明层、也未标有意不限流」的路由', async () => {
    const app = await createTestApp();
    await withApp(app, () => {
      const registry = app.get(PolicyRegistry);

      // 顺序是刻意的：**门自己的断言排第一**，这样失败时给出的永远是那句可执行的信息
      // （哪个 controller、哪个方法、哪条路径、该补什么），而不是辅助断言的措辞。
      const gaps = registry.listRateLimitGaps();
      expect(
        gaps,
        `以下路由没有限流归属（必须二选一：@RateLimited('层名') 或 @SkipRateLimit()）：\n${gaps.join('\n')}`,
      ).toEqual([]);

      // 非空转前提：发现层确实读到了已知的两条路由及其声明。
      // 没有这一步，「gaps 为空」既可能是「全都声明了」，也可能是「一条都没扫到」。
      expect(registry.find('AuthController', 'register'), 'PolicyRegistry 未能发现 AuthController.register').toMatchObject({
        path: '/auth/register',
        rateLimit: 'register',
        rateLimitSkipped: false,
      });
      expect(registry.find('AuthController', 'login')).toMatchObject({ rateLimit: 'login' });
      expect(registry.find('HealthController', 'live'), 'HealthController.live 应显式标为有意不限流').toMatchObject({
        path: '/health',
        rateLimit: null,
        rateLimitSkipped: true,
      });
      // 登录/注册之外的写路由（P0 只有 logout）也必须显式表态，而不是靠「忘了写」。
      expect(registry.find('AuthController', 'logout')).toMatchObject({ rateLimit: null, rateLimitSkipped: true });
    });
  });

  it('对「漏声明」与「声明矛盾」都敏感：探针模块上必须**恰好**报出那两条', async () => {
    // 这条是上一条的**对照**（Task 5 的教训：`toEqual([])` 在门被写成 return [] 时也绿）。
    // 探针模块里同时放过三类路由，正好压住过滤器的三个分支：
    // 漏声明（报出）、声明矛盾（报出）、显式豁免与显式归属（放过）。
    // 因此断言的是**恰好两条**，而不是「至少两条」——多报（误拦守规矩的写法人）
    // 与少报（漏拦）都会让它变红。
    const mod = await Test.createTestingModule({ imports: [RateLimitCoverageProbeModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    await withApp(app, () => {
      const gaps = app.get(PolicyRegistry).listRateLimitGaps();
      expect(gaps).toHaveLength(2);

      // **不**按下标断言（修复轮 2 改正）：`gaps[0]`/`gaps[1]` 依赖
      // `DiscoveryService` 扫到控制器的顺序——今天确定，但那不是本门要保证的性质，
      // 而「顺序变了就红」是一条没人看得懂的假失败。改成「必须包含这一条」，
      // 顺序无关，判别力不变（仍然要求**两条都在**，且第 3 条不许混进来——
      // 由上面的 `toHaveLength(2)` 钉住）。
      const undeclared = gaps.find((g) => g.includes('RateLimitProbeController.undeclared'));
      expect(undeclared, `门没有报出「漏声明」那条：\n${gaps.join('\n')}`).toBeDefined();
      expect(undeclared).toContain('/__rate-limit-probe/undeclared');
      expect(undeclared).toContain('既未声明');

      const conflict = gaps.find((g) => g.includes('RateLimitConflictProbeController.conflict'));
      expect(conflict, `门没有报出「声明矛盾」那条：\n${gaps.join('\n')}`).toBeDefined();
      expect(conflict).toContain('矛盾');

      // 显式豁免与显式归属的那两条路由**不许**出现在报告里。
      expect(gaps.some((g) => g.includes('RateLimitDeclaredProbeController'))).toBe(false);
    });
  });
});
