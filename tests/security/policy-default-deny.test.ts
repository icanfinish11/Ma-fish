import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  type INestApplication,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { PolicyGuard, type PolicyContext } from '@vca/api/common/policy/policy.guard.js';
import { Policy, Public } from '@vca/api/common/policy/policy.decorator.js';
import { runInContext, type RequestContext } from '@vca/api/common/context/request-context.js';
import { createTestApp } from '../helpers/app.js';

/**
 * PolicyGuard 的默认拒绝矩阵（威胁 #1 / 设计 §9 / 验收 13.2）。
 *
 * ## 为什么用探针控制器而不是真实业务路由
 *
 * 真实 `AppModule` 目前只有 `/health`（`@Public()`），它**只能**证明「公开路由放行」这一格；
 * 「未声明即拒绝」「条件放行」「条件未注册即拒绝」这几格在真实路由里根本不存在。
 * 探针控制器让这些格子成为**可执行的契约**，而不是注释里的承诺。
 * 生产侧的覆盖率门由 `policy-route-coverage.test.ts` 单独承担。
 *
 * ## 身份从哪来
 *
 * 守卫读的是 `currentContext()`（Task 4 的 ALS）。测试用 `ProbeIdentityMiddleware` 模拟
 * Task 6 的会话中间件：带上 `x-test-user` 头即视为已认证，不带则匿名。
 * 中间件与生产同款（`runInContext(ctx, () => next())`，见 `trace.middleware.ts`）。
 *
 * ## 默认是「已认证」而不是「所有人」（方案 B，修复轮裁决）
 *
 * 除 `@Public()` 外的**任何**声明都要求身份，包括**没有** condition 的声明——
 * 判据是「忘了写 condition」只该降级成「任何已登录用户」，而不是「任何人」。
 * 「所有人可访问」由 `@Public()` 独占表达。因此本文件里那条无 condition 的 `/probe/declared`
 * **匿名必须 403**（它下面有正反两条用例）。
 *
 * ## Ruling 3：输出必须 pristine，但**不许**把生产日志删掉
 *
 * 默认拒绝那条路径会 `logger.warn`，条件未注册那条会 `logger.error`。
 * 本文件用 `vi.spyOn(Logger.prototype, …)` 把它们接管：既让 stdout 保持干净，
 * 又**顺带断言这两条信号真的发出去了**（否则「静音」会把一个哑掉的告警伪装成通过）。
 *
 * 实测背景（据实记载）：`@nestjs/testing` 的 `compile()` 会执行
 * `Logger.overrideLogger(new TestingLogger())`，而 `TestingLogger` 把 log/warn/debug/verbose
 * 全部置空、只留 error。所以现有套件的 pristine 其实有一半来自这个**偶然**；
 * 本文件的 spy 不依赖该偶然性，并且在 error 那条路径上确实拦掉了一次真实输出。
 * 生产环境（`main.ts`，没有 testing 模块）走的是默认 `ConsoleLogger`：warn 会打到 stdout，
 * 且**不经过 pino**（全仓没有 `app.useLogger`），因此只有消息里插值的 traceId，没有结构化字段。
 */

/** 测试专用身份中间件：`x-test-user` 存在即视为已认证，否则匿名。 */
@Injectable()
class ProbeIdentityMiddleware implements NestMiddleware {
  use(req: { headers: Record<string, unknown> }, _res: unknown, next: () => void): void {
    const raw = req.headers['x-test-user'];
    const ctx: RequestContext = { traceId: 'probe-trace' };
    if (typeof raw === 'string') ctx.userId = raw;
    runInContext(ctx, () => next());
  }
}

/**
 * 每次条件求值的入参。用数组而不是「最近一次的值」：这样既能断言条件拿到了什么，
 * 也能断言匿名请求下条件**一次都没被调用**（而不是「最后一次是 undefined」）。
 */
const conditionCalls: PolicyContext[] = [];

@Controller('probe')
class ProbeController {
  /** 既无 @Policy 也无 @Public：默认拒绝。 */
  @Get('undeclared')
  undeclared(): { ok: boolean } {
    return { ok: true };
  }

  @Public()
  @Get('public')
  open(): { ok: boolean } {
    return { ok: true };
  }

  /**
   * 声明「资源-动作」但**无**附加条件：语义是「登录即可」——仍然要求身份（方案 B）。
   * 它同时是「忘了写 condition」这一失误的**降级形态**：爆炸半径被压到「任何已登录用户」。
   */
  @Policy({ resource: 'Asset', action: 'read' })
  @Get('declared')
  declared(): { ok: boolean } {
    return { ok: true };
  }

  /** 已注册且恒真的条件：已认证时放行。 */
  @Policy({ resource: 'Asset', action: 'read', condition: 'alwaysAllow' })
  @Get('conditional')
  conditional(): { ok: boolean } {
    return { ok: true };
  }

  /** 声明了条件，但没有任何地方 `registerCondition` 它：fail-closed 拒绝。 */
  @Policy({ resource: 'Asset', action: 'read', condition: 'neverRegistered' })
  @Get('unregistered')
  unregistered(): { ok: boolean } {
    return { ok: true };
  }

  /** 已注册但判定为假（异步）：拒绝。 */
  @Policy({ resource: 'Asset', action: 'read', condition: 'alwaysDeny' })
  @Get('denied')
  denied(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * 类级 `@Public()` 的探针：装饰器的类型是 `MethodDecorator & ClassDecorator`
 * （登录入口、健康检查这类整个控制器都免鉴权的场景用它）。两条路由一起断言，
 * 是为了证明类级声明覆盖**该控制器的全部路由**，而不是只碰巧放过第一条。
 */
@Public()
@Controller('probe-class')
class ClassPublicProbeController {
  @Get('a')
  a(): { ok: boolean } {
    return { ok: true };
  }

  @Get('b')
  b(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  controllers: [ProbeController, ClassPublicProbeController],
  providers: [
    PolicyGuard,
    // `useExisting` 而不是 `useClass`：条件注册在**同一个**实例上，全局守卫才看得见。
    // （`useClass` 会另造一个实例，各模块注册的条件到不了全局守卫。）
    { provide: APP_GUARD, useExisting: PolicyGuard },
  ],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ProbeIdentityMiddleware).forRoutes('*');
  }
}

/**
 * 生产接线的探针：**不含任何守卫**，只有一条带条件的路由。
 * 它被挂到真实 `AppModule` 旁边，用来验证「条件注册能到达真正的全局守卫」。
 */
@Controller('wiring')
class WiringProbeController {
  @Policy({ resource: 'Asset', action: 'read', condition: 'alwaysAllow' })
  @Get('conditional')
  conditional(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [WiringProbeController] })
class WiringProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ProbeIdentityMiddleware).forRoutes('*');
  }
}

// Ruling 3：接管 Nest logger 的输出，同时把「信号确实发出」变成断言。
const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

describe('PolicyGuard 默认拒绝（威胁 #1）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = mod.createNestApplication();
    // 条件注册发生在 init 之前：与「业务模块在 onModuleInit 注册自己的条件」同一时机。
    const guard = app.get(PolicyGuard);
    guard.registerCondition('alwaysAllow', (ctx) => {
      conditionCalls.push(ctx);
      return true;
    });
    // 故意用 **async**：Task 6 的条件多半要查库（「这是不是他的 Asset」），因此
    // `Promise<boolean>` 是常态。若守卫漏了 `await`，Promise 对象恒为真 ⇒ 拒绝变成放行；
    // 这条 async(=>false) 的用例正是那个漏洞的看守者（见报告里的变异探针 8）。
    guard.registerCondition('alwaysDeny', async () => false);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('未声明策略的路由被拒绝（403），而非放行', async () => {
    warnSpy.mockClear();
    const res = await request(app.getHttpServer()).get('/probe/undeclared');
    expect(res.status).toBe(403);
    // 默认拒绝是**显式**行为，不是静默 404：既要有 403，也要留下可观测的告警。
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('traceId=probe-trace');
  });

  it('显式 @Public() 的路由放行', async () => {
    const res = await request(app.getHttpServer()).get('/probe/public');
    expect(res.status).toBe(200);
  });

  it('声明了策略但无附加条件，且请求匿名：拒绝（无 condition 不等于「无需身份」）', async () => {
    // 方案 B 的核心断言，也是「忘了写 condition」这一失误的看守者：
    // 没有身份 ⇒ 403『需要登录』，而不是放行。改坏守卫（无条件声明直接 return true）
    // 会让**恰好这一条**变红，见报告修复轮的变异探针 P9。
    const res = await request(app.getHttpServer()).get('/probe/declared');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: '需要登录' });
  });

  it('声明了策略但无附加条件，且已认证：放行（身份由 ALS 上下文提供，与生产路径同款）', async () => {
    // 身份不是靠「削弱守卫」造出来的：走的是 ProbeIdentityMiddleware → runInContext(...)
    // → currentContext().userId，即 Task 6 会话中间件将要走的同一条路径。
    const res = await request(app.getHttpServer()).get('/probe/declared').set('x-test-user', 'user-1');
    expect(res.status).toBe(200);
  });

  it('类级 @Public() 覆盖该控制器的每条路由', async () => {
    const a = await request(app.getHttpServer()).get('/probe-class/a');
    const b = await request(app.getHttpServer()).get('/probe-class/b');
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('已注册的条件返回 true 且已认证：放行，且条件拿到请求上下文与当事人身份', async () => {
    conditionCalls.length = 0;
    const res = await request(app.getHttpServer()).get('/probe/conditional').set('x-test-user', 'user-1');
    expect(res.status).toBe(200);
    expect(conditionCalls).toHaveLength(1);
    expect(conditionCalls[0]?.userId).toBe('user-1');
    expect(conditionCalls[0]?.decl).toEqual({ resource: 'Asset', action: 'read', condition: 'alwaysAllow' });
    expect(conditionCalls[0]?.req.method).toBe('GET');
  });

  it('声明了未注册的条件：无需身份也拒绝（fail-closed），并留下 error 日志', async () => {
    errorSpy.mockClear();
    const res = await request(app.getHttpServer()).get('/probe/unregistered').set('x-test-user', 'user-1');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: '该资源未被授权访问' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('neverRegistered');
  });

  /**
   * **匿名 + 条件未注册**这一格（最终评审的 Minor：此前整个矩阵里没有它）。
   *
   * 为什么缺这一格会让「判定顺序」变成散文：`canActivate` 里「条件未注册」排在
   * 「要求身份」**之前**（理由见守卫的注释：接线错误不该被伪装成「你没登录」）。
   * 而这个顺序只有在**匿名**请求上才看得出来——已认证的那条用例（上一条）无论谁先谁后
   * 都会走到同一个 fail-closed 分支。因此这一条是顺序的**唯一**判别式：
   * 反过来的实现（先查身份）会让匿名请求拿到『需要登录』而这里变红。
   *
   * ## 消息可区分这件事（据实记录，不改）
   *
   * 匿名调用方因此能看出「这条路由的条件注册过」与「没注册过」——前者回『需要登录』，
   * 后者回『该资源未被授权访问』。这是**有意保留**的：后者是**接线错误**，
   * 它需要被响亮地报出来（同时有 error 日志），而它对调用方不构成任何越权线索
   * （两条路都是 403，泄露的只是「服务端配置有问题」）。因此这里只把事实钉住，
   * 不为了让两者同形而牺牲那条告警的可定位性。
   */
  it('匿名请求 + 条件未注册：仍按「未注册」拒绝（顺序：未注册先于身份判定）', async () => {
    errorSpy.mockClear();
    const res = await request(app.getHttpServer()).get('/probe/unregistered');

    expect(res.status).toBe(403);
    expect(
      res.body,
      '匿名请求拿到了「需要登录」：说明守卫先查身份、后查条件是否注册——接线错误被伪装成了「你没登录」',
    ).toMatchObject({ message: '该资源未被授权访问' });
    // 判据不只是消息文本：那条 error 日志证明走的确实是「条件未注册」这个分支，
    // 而不是别的恰好也回同一句话的路径（例如条件返回了 false）。
    expect(errorSpy, '未注册条件这条接线错误没有留下 error 日志').toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('neverRegistered');
  });

  it('已注册的异步条件返回 false：拒绝（漏 await 会让 Promise 恒真 ⇒ 放行）', async () => {
    const res = await request(app.getHttpServer()).get('/probe/denied').set('x-test-user', 'user-1');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: '该资源未被授权访问' });
  });

  it('已注册的条件返回 true，但请求匿名：仍然拒绝（条件判定必须有主体）', async () => {
    conditionCalls.length = 0;
    const res = await request(app.getHttpServer()).get('/probe/conditional');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: '需要登录' });
    // 条件函数**根本没有被调用**：匿名请求不进入「这个人能不能」的判定。
    expect(conditionCalls).toHaveLength(0);
  });

  it('生产 AppModule：全局守卫与可注入的 PolicyGuard 是同一实例（各模块注册条件的前提）', async () => {
    // 只对着 token 断言「是不是同一个对象」不够（`app.get(APP_GUARD)` 在守卫被消费成全局增强器
    // 之后根本取不到，实测抛 `Nest could not find APP_GUARD element`），所以这里做**行为**证明：
    // 在一个不含任何守卫的探针模块里声明条件，把条件注册到「从真实 AppModule 注入来的」实例上，
    // 再看真实 `APP_GUARD` 是否认这个条件。
    // 若 AppModule 写成 `useClass`，全局守卫是另一个实例 ⇒ 条件永远未注册 ⇒ 403 而不是 200。
    //
    // Task 7：这条用例的引导改走**共用**的 `createTestApp()`（`extraModules` + `conditions`），
    // 此前它自己抄了一份 `Test.createTestingModule({ imports: [AppModule, …] })`。
    // 抄件的代价在 Task 7 现形：那份引导不会随生产接线演进（不装安全中间件栈、
    // 不随全局守卫链变化），于是「生产接线是否正确」变成了「抄件是否正确」。
    const wiredApp = await createTestApp({
      extraModules: [WiringProbeModule],
      conditions: [{ name: 'alwaysAllow', fn: () => true }],
    });
    try {
      const res = await request(wiredApp.getHttpServer()).get('/wiring/conditional').set('x-test-user', 'user-1');
      expect(res.status).toBe(200);
    } finally {
      await wiredApp.close();
    }
  });
});
