import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PolicyGuard } from './policy.guard.js';
import { PolicyRegistry } from './policy.registry.js';

/**
 * 授权基础设施模块。
 *
 * `@Global()` 是刻意的：`PolicyGuard` 需要被各业务模块注入以便 `registerCondition`
 * （条件注册必须落在**全局守卫那一个实例**上），逐模块 `imports: [PolicyModule]`
 * 只会制造样板。`DiscoveryModule` 只有 `PolicyRegistry` 需要（枚举全部 controller）。
 *
 * 注意本模块**不**把 `PolicyGuard` 接到 `APP_GUARD`：全局守卫的注册属于 `AppModule`
 * （那里能看到全部守卫的顺序，见 `app.module.ts` 关于 CSRF 先于策略的注释）。
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [PolicyGuard, PolicyRegistry],
  exports: [PolicyGuard, PolicyRegistry],
})
export class PolicyModule {}
