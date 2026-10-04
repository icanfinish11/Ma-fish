import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { CSRF_COOKIE, CSRF_HEADER, SAFE_METHODS } from './csrf.middleware.js';

/**
 * CSRF 双提交令牌的**校验端**（威胁 #10 / C13）。
 *
 * ## 为什么它是全局守卫（`APP_GUARD`）而不是逐路由装饰器
 *
 * C13 要求「**全部**写操作校验」。逐路由打装饰器时，「漏打」的默认结果是**不校验**——
 * 一个新加的写路由会静默地失去保护，而所有测试照旧全绿。
 * 挂在全局守卫链上时默认是**校验**，漏掉的东西表现为「某个写请求 403 且带 CSRF 消息」，
 * 立刻可见。这与 `PolicyGuard` 的默认拒绝是同一条设计原则。
 *
 * ## 顺序：`CsrfGuard` 排在 `PolicyGuard` **之前**（见 `app.module.ts`）
 *
 * 「请求是否可信」先于「这个身份能不能」。反过来（先判权）会让一次跨站请求走进
 * 资源级条件判定里——条件可能要查库，而它本可以在入口处就被一个字符串比较挡掉。
 *
 * ## 比较为什么用 `timingSafeEqual`
 *
 * 令牌比较若是短路比较（`===`），耗时随「前多少字符相同」变化，攻击者可逐字节猜。
 * CSPRNG 出的 256 位令牌让在线爆破不现实，但这一层几乎零成本，没有理由不做。
 * `timingSafeEqual` 要求两个 Buffer 等长（否则**抛出**，不是返回 false），
 * 所以长度检查必须在前——它本身会泄露令牌长度，而长度不是秘密（固定 43 字符）。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const cookieToken: unknown = req.cookies?.[CSRF_COOKIE];
    const headerToken: unknown = req.headers[CSRF_HEADER];

    // **真实检查，不是类型断言**：`cookie-parser` 支持 `j:` 前缀的 JSON cookie，
    // 那种值会被解析成对象/数组，`Buffer.from({})` 会抛 `TypeError` ⇒ 一次 CSRF 校验
    // 变成 500。`x-csrf-token` 重复发送时 express 给出的是数组，同理。
    // （与 `session.middleware.ts` 对 `SESSION_COOKIE` 的处置是同一条教训。）
    if (
      typeof cookieToken !== 'string' ||
      cookieToken.length === 0 ||
      typeof headerToken !== 'string' ||
      headerToken.length === 0
    ) {
      throw new ForbiddenException('CSRF 令牌缺失');
    }

    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('CSRF 令牌不匹配');
    }
    return true;
  }
}
