import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/policy/policy.decorator.js';
import { SkipRateLimit } from '../../common/security/throttler.js';

@Controller('health')
export class HealthController {
  /**
   * 存活探针。
   *
   * `@Public()` 是**必须**的：Task 5 起全局 `PolicyGuard` 默认拒绝一切未声明的路由，
   * 探针若不打这个标就会被 403 掉（LB 会把整个实例判死）。它也证明了「公开」这件事
   * 需要显式书写，而不是「忘记声明」的副产品。
   *
   * `@SkipRateLimit()`（修复轮 1 / C-4）是**必须**的，理由方向相反但同样是「别把实例判死」：
   * 探针由负载均衡按秒级频率调用，任何限流层压在它上面都会让探针先于真实流量被拒。
   * 此前的行为是「未声明 ⇒ 不限流」但**没有任何东西记录这个决定**；现在它是显式的，
   * 且 `tests/security/rate-limit-coverage.test.ts` 会要求每条路由都做出选择。
   */
  @Public()
  @SkipRateLimit()
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
