import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';

/**
 * Redis 客户端的注入令牌。
 *
 * 用 `Symbol` 而不是字符串常量：字符串令牌会与任何同名提供者相撞（Nest 的令牌空间是平的），
 * 而 `Symbol` 在模块之间只可能通过 import 同一个常量来共享，重复注册会立刻表现为
 * 「找不到提供者」而不是「悄悄注入了另一个东西」。
 */
export const REDIS = Symbol('VCA_REDIS');

/** 空闲 7 天（C13）。**空闲**语义靠 `verify` 里的滑动续期实现，见下。 */
const IDLE_TTL_SECONDS = 7 * 24 * 3600;

/** Redis 键命名空间：`vca:sess:<sessionId>`。前缀让 Redis 里的事件/限流键不至于混在一起。 */
const KEY = (id: string) => `vca:sess:${id}`;

/** 一条会话的服务端状态（**不透明**：只放鉴权所需的最小面）。 */
export interface SessionData {
  userId: string;
  /** 最近一次**完成认证**的时刻（毫秒）。敏感操作按它判定「15 分钟内认证过」。 */
  authAt: number;
  ip: string;
  userAgent: string;
}

/**
 * 服务端会话（C13 / §4.2）。
 *
 * ## 为什么是服务端会话而不是自包含令牌
 *
 * 会话状态放在 Redis、客户端只拿一个不透明 id，因此「登出」「封禁」「改密后踢下线」
 * 都是**即时**的（删一个键）；而签名令牌只能等它自己过期，撤销需要再引入一张黑名单。
 * 代价是每个请求一次 Redis 往返——这是本任务明确选择的交易。
 *
 * ## `sessionId` 就是全部凭证
 *
 * 32 字节 CSPRNG 的 base64url（43 字符，字符集 `[A-Za-z0-9_-]`）。它**必须**同时满足
 * 「不可猜」与「URL 安全」：前者是会话安全的全部熵，后者让它能原样写进 cookie 而不必转义
 * （转义后的值会在某些客户端上被改写成另一个字节序列，表现为随机的「登录后立刻掉线」）。
 *
 * 刻意**不**用 `uuidv7()`（Task 4 的产出）：UUIDv7 含时间戳与进程内计数器，
 * 前 48 位可预测、同毫秒内单调递增——对**主键**是优点（索引局部性好），
 * 对**凭证**是缺点（可枚举）。用途不同，工具不同。
 *
 * ## 未知 id 返回 `null` 而不是抛错
 *
 * 抛错会让调用方不得不按异常类型分支，而更糟的是把「会话不存在」变成一个**响亮**的信号：
 * 攻击者据此区分「这个 id 存在但我没带对 cookie」与「这个 id 压根不存在」。
 * 静默 `null` 让两种情况在外部表现上完全一致。
 */
@Injectable()
export class SessionService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(userId: string, meta: { ip: string; userAgent: string }): Promise<{ sessionId: string }> {
    // 256 位随机，不可猜测
    const sessionId = randomBytes(32).toString('base64url');
    // `HSET` 与 `EXPIRE` **必须是一条原子命令**（修复轮 2）：分两次发的话，
    // 进程在两条命令之间崩掉（或连接断开）会留下一个**没有 TTL 的会话哈希**——
    // 它**永不过期**，于是 C13 的「空闲 7 天」在这条记录上静默失效，
    // 而外部表现（会话一直有效）看起来完全正常，不会有任何报错。
    // `multi().exec()` 把两者包进一个 MULTI/EXEC 事务：要么都生效，要么都不生效。
    await this.redis
      .multi()
      .hset(KEY(sessionId), {
        userId,
        authAt: String(Date.now()),
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      .expire(KEY(sessionId), IDLE_TTL_SECONDS)
      .exec();
    return { sessionId };
  }

  async verify(sessionId: string): Promise<SessionData | null> {
    if (!sessionId) return null;
    const h = await this.redis.hgetall(KEY(sessionId));
    if (!h || !h.userId) return null;
    // 滑动过期：每次访问续期
    await this.redis.expire(KEY(sessionId), IDLE_TTL_SECONDS);
    return {
      userId: h.userId,
      authAt: Number(h.authAt ?? 0),
      ip: h.ip ?? '',
      userAgent: h.userAgent ?? '',
    };
  }

  /** 敏感操作要求最近完成过认证（§4.2 / C13）。 */
  async requireRecentAuth(sessionId: string, withinMs: number): Promise<boolean> {
    const h = await this.redis.hget(KEY(sessionId), 'authAt');
    if (!h) return false;
    return Date.now() - Number(h) <= withinMs;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(KEY(sessionId));
  }
}
