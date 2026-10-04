import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

/**
 * 限流桶在 Redis 里的键前缀。
 *
 * 与 `session.service.ts` 的 `vca:sess:` 同一命名空间约定（`vca:` 前缀 = 本应用的键）。
 * 导出是**给测试用**的：判别性用例要断言「桶真的落在 Redis 里」，
 * 而不是只断言「两个实例合起来会 429」——后者在「模块级共享 Map」这种假实现下也会通过。
 */
export const THROTTLE_KEY_PREFIX = 'vca:throttle:';

/**
 * `ThrottlerStorage.increment` 的返回记录。
 *
 * ## 为什么这里**自己**声明一遍形状，而不是 import 库的类型
 *
 * 实测（`@nestjs/throttler@6.7.1` 的 `dist/index.d.ts`）：包入口 `export *` 了
 * `throttler-storage.interface`，但 `ThrottlerStorageRecord`（那个接口）住在
 * `throttler-storage-record.interface.d.ts` 里，**没有被入口再导出**——只有它的名字
 * 出现在别的模块的签名里。所以 `import type { ThrottlerStorageRecord } from '@nestjs/throttler'`
 * 编译不过；能拿到它的唯一办法是深入 `dist/throttler-storage-record.interface`，
 * 而那正是本仓库已经在 `throttler.ts` 里明确拒绝过的事（依赖包的内部路径，
 * 升级时改名会**静默**漂移）。
 *
 * 结构化声明（TypeScript 的 structural typing）在这里比深路径导入更安全：
 * 下面 `implements ThrottlerStorage` 会在**编译期**校验四个字段的名字与类型，
 * 库改了形状我们就编译不过，而不是运行期悄悄错位。
 */
export interface ThrottleRecord {
  /** 当前窗口内的命中数。 */
  totalHits: number;
  /** 窗口剩余秒数（库的 `X-RateLimit-Reset` 用它）。 */
  timeToExpire: number;
  isBlocked: boolean;
  /** 封锁剩余秒数（库的 `Retry-After-<层名>` 用它）。 */
  timeToBlockExpire: number;
}

/**
 * 一次 `increment` 的全部状态迁移，**在 Redis 里原子执行**。
 *
 * ## 为什么是 Lua（`EVAL`）而不是 `MULTI`/pipeline 或 `INCR` + `PEXPIRE`
 *
 * 需求是「读当前计数 → 判断是否超限 → 决定是否进入封锁 → 写回」这**一段**逻辑，
 * 而 Redis 的事务（`MULTI`/`EXEC`）**不能根据读到的值分支**：`WATCH` + 重试能凑出
 * 正确结果，但要两轮往返加一个重试循环，且重试风暴正是限流路径最不能有的东西。
 * pipeline 更不行——它连「先读后写」都不是原子的。
 * 朴素的 `INCR` + `PEXPIRE` 也有两个坑：`INCR` 与 `PEXPIRE` 之间进程挂掉会留下
 * **永不过期**的计数器（一次部署卡住就把某条路由永久锁死），而「超限后是否已进入封锁」
 * 这个状态仍然需要另一条命令去读。Lua 脚本由 Redis 单线程**整体**执行，
 * 上述所有坑一次消失，且只需要一次往返。
 *
 * ## 为什么 `defineCommand`（EVALSHA）没用在这里
 *
 * ioredis 的 `defineCommand` 会把脚本缓存成 `EVALSHA`，省掉每次请求发送脚本正文的开销。
 * 当前不用它的理由是可测性优先：脚本调用面保持在标准 `eval` 上，
 * 测试里换一个"必定失败"的 Redis 替身只需要实现 `eval` 一个方法。
 * 本任务的五个层里最严的是「登录 5 次/15 分钟」——每请求多 ~1.5 KB 上行可以忽略。
 * 若将来限流路径成为热点，改成 `defineCommand` 是局部改动。
 *
 * ## 与库内存实现（`ThrottlerStorageService`）的语义对齐
 *
 * 逐条对照 `throttler.service.js`（6.7.1）的 `increment`：
 *
 * 1. 窗口：命中数在 `ttl` 毫秒的**固定窗口**里累加，窗口开始时定死结束时刻
 *    （内存实现的 `expiresAt` 只在过期后才刷新，单个命中虽然各自带过期时间戳，
 *    但窗口起点就是第一个命中，因此两者的可观测行为一致）；
 * 2. 封锁：`blockDuration > 0` 时，**第 limit+1 次**命中把记录置为封锁，
 *    封锁到 `now + blockDuration`。封锁期间**不再累加命中**，
 *    因此反复敲门不会把窗口推后（这正是「封锁」与「计数」的区别）；
 * 3. 封锁到期：清空命中并重新开始窗口，当前这次请求算作第 1 次命中
 *    （内存实现在 `timeToBlockExpire <= 0 && isBlocked` 分支里 `resetBlockedRequest()` 后
 *    立刻 `fireHitCount()`，同一语义）；
 * 4. `blockDuration <= 0`：走库的 `incrementWithoutBlock` 分支——阈值是 `>=`（不是 `>`），
 *    且被拒时 `totalHits` 仍然 +1；
 * 5. 时间单位：`ttl`/`blockDuration` 是**毫秒**入参，返回的两个时间是**秒**（库的
 *    `Retry-After`/`X-RateLimit-Reset` 直接取用，所以单位必须是秒）；
 * 6. 键的身份是 `(key, throttlerName)`——内存实现按这两个维度做二维 Map，
 *    因此这里把层名编进 Redis 键，而不是只依赖 `key`。
 *
 * ## 与内存实现的一处**已知差异**（据实记录）
 *
 * 内存实现在「封锁到期」时只清命中、**不重置窗口**（除非窗口恰好也过期了）。
 * 本实现无条件重开窗口。两者只有在 `blockDuration > ttl` 时才会分叉，
 * 而库的 guard 在层没有显式配 `blockDuration` 时把它默认成 `ttl`
 * （`throttler.guard.js` 第 93 行：`?? namedThrottler.blockDuration ?? ttl`），
 * 本仓库五个层都没有显式配置 ⇒ 封锁一定晚于窗口开始、早于窗口结束，
 * 因此两条路径在我们支持的全部配置下**结果相同**。
 *
 * ## 时间取的是 **Redis 服务器**的时钟（`redis.call('TIME')`）
 *
 * 不把 `Date.now()` 从客户端传进来：多实例部署时每个实例的时钟略有偏差，
 * 而窗口与 `PEXPIRE` 都在 Redis 侧生效；用同一个时钟源，语义才是自洽的。
 * 实测（Redis 7.4.11，探针见修复轮报告）：`redis.call('TIME')` 在脚本里可用。
 * 依赖这一点的前提是 Redis ≥ 5（effects replication），
 * `infra/docker-compose.yml` 固定 `redis:7-alpine`，与之相符。
 *
 * ## 过期与回收
 *
 * 每次写入都重设 `PEXPIRE` 到 `max(窗口结束, 封锁结束) - now`：
 * 记录一旦不再需要就被 Redis 自己回收，不会像「永不 EXPIRE 的计数器」那样
 * 把一个桶永久留在库里（内存实现里对应的是它的 `evictIdleRecords` 扫描）。
 */
const INCREMENT_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local hits = tonumber(redis.call('HGET', key, 'hits') or '0')
local windowEndsAt = tonumber(redis.call('HGET', key, 'windowEndsAt') or '0')
local blockedUntil = tonumber(redis.call('HGET', key, 'blockedUntil') or '0')

if windowEndsAt <= now then
  hits = 0
  windowEndsAt = now + ttl
end

if blockedUntil > 0 and blockedUntil <= now then
  blockedUntil = 0
  hits = 0
  windowEndsAt = now + ttl
end

local isBlocked = blockedUntil > now
local timeToBlockExpire = 0
local reportedHits = hits

if blockDuration > 0 then
  if not isBlocked then
    hits = hits + 1
    reportedHits = hits
    if hits > limit then
      isBlocked = true
      blockedUntil = now + blockDuration
    end
  end
  if isBlocked then
    timeToBlockExpire = math.ceil((blockedUntil - now) / 1000)
  end
else
  isBlocked = hits >= limit
  if isBlocked then
    reportedHits = hits + 1
    timeToBlockExpire = math.ceil((windowEndsAt - now) / 1000)
  else
    hits = hits + 1
    reportedHits = hits
  end
end

redis.call('HSET', key, 'hits', hits, 'windowEndsAt', windowEndsAt, 'blockedUntil', blockedUntil)

local expiresIn = math.max(windowEndsAt, blockedUntil) - now
if expiresIn < 1 then
  expiresIn = 1
end
redis.call('PEXPIRE', key, expiresIn)

return { reportedHits, math.ceil((windowEndsAt - now) / 1000), isBlocked and 1 or 0, timeToBlockExpire }
`;

/**
 * Redis 版限流存储（设计 §3.1：限流桶放在 Redis，与会话、锁同一个存储）。
 *
 * ## 为什么必须有它（C-1）
 *
 * 库默认的 `ThrottlerStorageService` 是**每个应用实例一份进程内 Map**。两个后果：
 *
 * 1. **横向扩容会把每个阈值乘以实例数**：声明的是「登录 5 次/15 分钟」，
 *    N 个实例下实际是 5N 次——一个安全控制在它本该抗住的部署变更下**静默失效**；
 * 2. **重启即清零**：计数器随进程消失，攻击者不必扩容也能拿回额度。
 *
 * 这两条都不是「性能问题」，而是「声明了但没执行」——本仓库已经抓到过四次同一形状的缺陷
 * （append-only 的 `REVOKE` 是空操作、C9 的 XSS 门漏掉 `.tsx`、C10 的占位符规则是死代码、
 * 以及 brief 里 `expect([200,429]).toContain(...)` 那条恒真断言）。
 *
 * ## 为什么它不是 `@Injectable()`（DI 的装饰器在这里会是**谎话**）
 *
 * 库的 `ThrottlerStorageProvider`（`throttler.providers.js` 第 16–24 行）是
 * `useFactory: (options) => options.storage ? options.storage : new ThrottlerStorageService()`——
 * 也就是说它要的是**一个实例**，不是类。标注 `@Injectable()` 会让人以为可以 `app.get(...)`，
 * 而实际拿到的那个实例是模块配置工厂里 `new` 出来的。
 * 因此这里保持成一个朴素类，由 `security.module.ts` 的 `forRootAsync` 工厂构造。
 *
 * ## 故障语义：**fail-closed**（存储不可用时不放行）
 *
 * Redis 命令失败时本类**抛错**，绝不返回一个「未拦截」的记录。理由见 `increment`。
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: Redis) {}

  /**
   * 一次命中的原子记账。
   *
   * ## 为什么故障时**抛错**而不是 `return { isBlocked: false }`（fail-open）
   *
   * 这是一次真实的取舍，理由按重要性排序：
   *
   * 1. **fail-open 的失效形态恰好落在攻击者手里。** 让限流器「Redis 一挂就放行」，
   *    等于把「能不能无限次猜口令」的开关交给一次连接抖动、一次故障转移、
   *    甚至一次运维重启——攻击者只要能造成 Redis 短时不可用（或等一次部署窗口），
   *    就拿到了无上限的登录尝试。这正是威胁 #13 要防的东西。
   * 2. **本应用在 Redis 挂掉时本来就无法完成这些请求。** 会话存在 Redis 里
   *    （设计 §3.1 / C13）：登录、注册、登出都要写会话。fail-open 换来的不是可用性，
   *    只是「一个必然失败的请求变成了另一个必然失败的请求」，却顺带丢掉了限流。
   *    唯一的例外是那些不碰会话的路由（P1 起的搜索等），而它们同样吃 Redis 的幂等键/锁。
   * 3. **爆炸半径的方向不同。** fail-closed 的形态是 500 + 一行日志：**响**、可告警、可回滚；
   *    fail-open 的形态是一切看起来正常（200、指标平稳），而防护已经不在——
   *    本仓库的评审原则是「宁可响着坏，不可静悄悄地没有」。
   * 4. **可用性该由别处兜。** 限流存储的可用性属于基础设施（Redis 主从/哨兵、重启策略），
   *    不该用「悄悄放行」来兜——那会把一次基础设施故障转写成一次安全事件。
   *
   * 代价（据实记录）：Redis 不可用期间，**声明了限流层的路由**会返回 500
   * （而不是 429、也不是放行）。判别性用例：`tests/security/rate-limit.test.ts` 的
   * 「存储故障时受限路由被拒（500），不会被放行」——把它改成 fail-open 立刻变红。
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    const redisKey = `${THROTTLE_KEY_PREFIX}${throttlerName}:${key}`;
    let reply: unknown;
    try {
      reply = await this.redis.eval(INCREMENT_SCRIPT, 1, redisKey, ttl, limit, blockDuration);
    } catch (error: unknown) {
      // **测试环境不打这行日志**，与 `SessionMiddleware.logVerificationFailure` 同一条理由
      // （那里有完整说明）：套件里「存储不可用」这条路径是被**故意**触发的
      // （判别性用例就是要看它 500），打成 error 会让真正的失败淹在预期噪音里，
      // 而本仓库要求套件输出 pristine。生产/开发照旧记，且是**点名**的一行：
      // 「限流存储挂了」不该只表现为一个无主的 500。
      if (process.env.NODE_ENV !== 'test') {
        // 不记录桶键（它是 sha256，不含明文邮箱，但也没有排查价值）。
        this.logger.error(
          `限流存储（Redis）不可用，按 fail-closed 拒绝放行：${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      throw error;
    }
    return parseRecord(reply);
  }
}
/**
 * 把脚本的返回值收敛成记录；形状不对就**抛错**（同样是 fail-closed 的方向）。
 *
 * 返回 `null`/`undefined`、字段缺失、非有限数——任何一种都可能是「脚本被改坏」
 * 或「连到了别的服务」。若把这些当成 `isBlocked: false`，限流会静默失效；
 * 因此唯一的处置是拒绝这次请求。
 */
function parseRecord(reply: unknown): ThrottleRecord {
  if (!Array.isArray(reply) || reply.length !== 4) {
    throw new Error(`限流脚本返回了意外形状（期望 4 个整数）：${JSON.stringify(reply)}`);
  }
  const [totalHits, timeToExpire, blockedFlag, timeToBlockExpire] = reply.map((value) => Number(value));
  if (
    totalHits === undefined ||
    timeToExpire === undefined ||
    blockedFlag === undefined ||
    timeToBlockExpire === undefined ||
    ![totalHits, timeToExpire, blockedFlag, timeToBlockExpire].every((value) => Number.isFinite(value))
  ) {
    throw new Error(`限流脚本返回了非数值字段：${JSON.stringify(reply)}`);
  }
  return { totalHits, timeToExpire, isBlocked: blockedFlag !== 0, timeToBlockExpire };
}
