import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
// `REDIS` 令牌的**定义**在 `db/redis.module.ts`（与提供者同处一地）。这里只 import：
// 本模块是**使用者**，平台层不该反过来依赖功能模块的内部文件（Task 9 修复轮 1）。
import { REDIS } from '../../db/redis.module.js';

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
 * 检查 `MULTI/EXEC` 的**逐条**结果（最终评审 I-5）。
 *
 * ## 为什么这件事必须做，而且必须在这里做
 *
 * `multi().hset(...).expire(...).exec()` 的两条命令要么都生效、要么都不生效——这句话只对
 * 「排队期」成立。**执行期**的失败（OOM、READONLY 副本、WRONGTYPE）是**逐条**返回的：
 * ioredis 把每一条的结果放进 `[err, res][]`，并且**整体 resolve**（不 reject）。
 * 于是「`await` 了就以为写成功了」的实现会把一个**没有 TTL 的会话哈希**留在 Redis 里：
 * C13 的「空闲 7 天过期」在这条记录上变成**永不过期**，而外部表现完全正常
 * （会话一直有效、没有任何报错）——正是本仓库反复抓到的那种静默失效。
 *
 * 因此判据是「**每一条**都没有错误」，而不是「`exec()` 没有 reject」。
 * `exec()` 返回 `null` 表示事务被**中止**（排队期就失败了，例如 EXECABORT），
 * 同样不能当成成功。
 *
 * ## 为什么错误消息里**不含** `sessionId`
 *
 * 它就是完整的 bearer 凭证（见类注释），而这个异常会一路冒到调用方、多半会被记进日志。
 * 没有 id 也完全能排查：这条路径失败的原因在 Redis 那一侧（OOM/ROLE/类型），
 * 与是哪个会话无关。
 */
function assertSessionWriteApplied(results: [Error | null, unknown][] | null): void {
  if (results === null) {
    throw new Error(
      '会话写入未生效：MULTI/EXEC 被中止（事务里至少有一条命令在排队期就失败了）。' +
        '按失败处理，避免留下没有 TTL 的会话记录。',
    );
  }
  const failedAt = results.findIndex(([err]) => err !== null && err !== undefined);
  if (failedAt >= 0) {
    const err = results[failedAt]?.[0];
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new Error(
      `会话写入未生效：MULTI 里第 ${failedAt + 1} 条命令执行失败（${detail}）。` +
        '这条记录可能只写了一半（例如哈希写进去了、TTL 没设上），因此按失败处理——' +
        '一个没有过期的会话永远不会被 C13 的空闲 7 天回收。',
    );
  }
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
    //
    // **但执行期的失败是逐条返回的**（修复轮 4 / I-5）：ioredis 对 `[err, res][]` 里的错误
    // 是 **resolve** 而不是 reject，因此结果必须被逐条检查，否则 OOM/READONLY/WRONGTYPE
    // 会留下一个**没有 TTL 的会话哈希**（永不过期，且没有任何报错）。判据见
    // `assertSessionWriteApplied`。
    const applied = await this.redis
      .multi()
      .hset(KEY(sessionId), {
        userId,
        authAt: String(Date.now()),
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      .expire(KEY(sessionId), IDLE_TTL_SECONDS)
      .exec();
    assertSessionWriteApplied(applied);
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
