import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/policy/policy.decorator.js';

@Controller('health')
export class HealthController {
  /**
   * 存活探针。
   *
   * `@Public()` 是**必须**的：Task 5 起全局 `PolicyGuard` 默认拒绝一切未声明的路由，
   * 探针若不打这个标就会被 403 掉（LB 会把整个实例判死）。它也证明了「公开」这件事
   * 需要显式书写，而不是「忘记声明」的副产品。
   */
  @Public()
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
