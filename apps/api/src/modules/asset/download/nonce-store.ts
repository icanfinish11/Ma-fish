import type { Redis } from 'ioredis';
import { DOWNLOAD_TTL_SECONDS } from './signed-url.js';

/**
 * 下载票据的 **nonce 台账**（P1 / Task 8；规格 D10 的「单次使用」）。
 *
 * ## 判据只有一条：`SET key 1 EX <ttl> NX` 的返回值
 *
 * `true` = 这次是**第一次**用它（键原本不存在，原子地建起来了）；
 * `false` = 这个 nonce **已经被用过**（键在），或者这个值根本不该被接受。
 * 单次使用因此不是「先 GET 再 SET」那种可以被两个并发请求同时穿过的写法——
 * 并发下恰好一个请求拿到 `OK`，另一个拿到 `nil`（TS 里的 `null`）。
 *
 * ## 为什么键必须**有**过期时间
 *
 * nonce 台账只为一个 ≤5 分钟的窗口服务。没有 TTL 的键会让 Redis 无限增长
 * （每一张票一条），而且那条增长是**攻击者可以直接驱动的**（他只要有权限签发/兑换，
 * 或者干脆重放一堆伪造票据让服务端去查）。TTL 取「票据剩余寿命」，因此台账里的键
 * 不会比它保护的那张票活得更久。
 *
 * ## 这个函数为什么收 `redis` 这个入参，而 brief 的契约里没有它
 *
 * brief 写的是 `consumeNonce(nonce, ttlSeconds)`。那两参数版只能把客户端做成**模块级**
 * 单例，而本仓库的 Redis 客户端是 DI 注入的（每应用一个，生命周期归
 * `RedisLifecycle`，测试里每个套件一个容器）——模块级单例会让「测试用哪个 Redis」
 * 变成一件靠 import 顺序决定的事。客户端因此显式传进来，其余逐字照 brief。
 *
 * ## 不抛错（除了存储故障）
 *
 * 形状不对的 nonce 回 `false`：这条路径由调用方输入驱动（虽然上游
 * `parseTicketQuery` 已经拒过一次），而这里抛出就是一次 500。
 * **存储故障照旧抛**（ioredis 的错误原样冒出去）：Redis 不可用时「票据能不能兑换」
 * 没有答案，把那当成「已用过」会把一次基础设施故障伪装成一次重放攻击——
 * 那是两种完全不同的东西，不该在日志里长得一样。
 */

/** Redis 键命名空间：`vca:asset:download-nonce:<nonce>`（与限流/会话的键分开）。 */
export const NONCE_KEY_PREFIX = 'vca:asset:download-nonce:';

/** nonce 的形状（与 `signed-url.ts` 的 `isWellFormed` 同源：base64url(16 字节)）。 */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * 消费一个 nonce。
 *
 * @param redis 应用注入的客户端（`REDIS` 令牌）。
 * @param nonce 票据里的 nonce（形状不对 ⇒ `false`，不建任何键）。
 * @param ttlSeconds 台账里保留多久。会被夹到 `[1, 300]`：下界是 Redis 的要求
 *   （`EX 0` 是语法错误），上界与票据的 TTL 上界同一个数——台账不该比票活得更久。
 * @returns `true` = 首次使用（消费成功）；`false` = 已被用过或形状非法。
 */
export async function consumeNonce(redis: Redis, nonce: string, ttlSeconds: number): Promise<boolean> {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return false;
  const ttl = clampTtl(ttlSeconds);
  const result = await redis.set(`${NONCE_KEY_PREFIX}${nonce}`, '1', 'EX', ttl, 'NX');
  // ioredis 把 `SET ... NX` 的「没写进去」表达为 `null`（RESP 的 nil），写成 `OK` 才算赢。
  return result === 'OK';
}

/**
 * 把 TTL 夹到合法范围。
 *
 * `Math.trunc` 而不是直接比较：调用方可能给出一个小数秒（例如
 * `expiresAt - Date.now()/1000` 那种算法），而 Redis 的 `EX` 只接受整数
 * （小数会让整条命令以语法错误失败——一次 500）。
 */
function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return 1;
  return Math.min(Math.max(Math.trunc(ttlSeconds), 1), DOWNLOAD_TTL_SECONDS);
}
