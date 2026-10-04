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
 * ## 窗口语义：**滚动窗口**（修复轮 2 改正；此前是固定窗口）
 *
 * 契约是 C12 的「登录 5 次 / 15 分钟」——一句**数值**话。要让它成立，
 * 在**任意**一个长度为 `ttl` 的时间片里，被放行的命中都不得超过 `limit`。
 * 这要求**逐命中过期**：每条记录只在自己的时刻起算 `ttl`，到期各自消失。
 *
 * 上一版实现的是**固定窗口**（脚本开头 `windowEndsAt <= now` 就把计数整体清零、
 * 并把窗口结束时刻定死），并把两者写成「可观测行为一致」——**那句话是错的**，
 * 而且差的方向是**放宽**：贴着边界放 5 次、边界之后再放 5 次，10 次全部放行，
 * 于是「15 分钟内最多 5 次口令猜测」变成「15 分钟跨度内最多 10 次」。更糟的是
 * 窗口边界会通过 `X-RateLimit-Reset-<层名>` 响应头**告诉客户端**
 * （guard 把 `timeToExpire` 直接塞进那个头），对齐边界因此是零成本的。
 * 等价性说明已删除，本文件现在只描述**实际**语义。
 *
 * 现在用**有序集合**（score = 该次命中的毫秒时间戳）实现逐命中过期：
 * 每次 `increment` 先 `ZREMRANGEBYSCORE` 剪掉「已经出窗」的成员（`score <= now - ttl`），
 * 再 `ZCARD` 数出**当前窗口内**的命中数。因此：
 *
 * - 每次命中都带自己的过期时刻，互不影响；
 * - 窗口是滑动的，不存在「对齐边界就能多拿一倍额度」这回事；
 * - 集合在 `ttl` 内最多留下 `limit + 1` 个成员（超限即进封锁、封锁期间不再入账），
 *   因此内存占用有界。
 *
 * 与库的内存实现（`throttler.service.js`，6.7.1）的关系**逐条**如下（不再声称"等价"）：
 *
 * 1. **窗口**：内存实现把每次命中的过期时刻逐条记在 `hitExpirations` 里
 *    （`fireHitCount` 推入 `Date.now() + ttl`），每次 `increment` 先用
 *    `pruneExpiredHits` 按 `expiresAt > now` 过滤，也就是滚动窗口。
 *    本实现同为滚动窗口——这一条现在**真的**对上了（上一版的固定窗口是对不上的）。
 *    边界取 `score <= now - ttl` 即出窗（左闭右开，时长恰好 `ttl`）。
 *    计数与**键的寿命**是两件不同的事，修复轮 3 才把后者改正（见下条与文件末段）；
 *    修好之后，连「桶什么时候才能被回收」这一条也对上了：内存实现的
 *    `evictIdleRecords` 用 `hasLiveHits`（任一命中未过期就不删记录）拦住回收，
 *    本实现则把寿命设到**最新**命中的出窗时刻。
 *
 * 2. **封锁**：`blockDuration > 0` 时，**第 limit+1 次**命中把记录置为封锁，
 *    封锁到 `now + blockDuration`。封锁期间**不再累加命中**（也不写入有序集合），
 *    因此反复敲门不会把窗口推后（这正是「封锁」与「计数」的区别）。
 *    被拒的那次命中**不入账**：入了的话「每分钟敲一次、每次都被拒」会让窗口
 *    永远有成员（每次都把最老的那条挤在 `ttl` 内）⇒ 实际效果是**永久封锁**，
 *    而那正是本仓库在 `throttler-storage.test.ts` 里专门钉住的反面。
 *
 * 2. **封锁期间的报告值**（修复轮 3 补记，此前漏了）：内存实现封锁期间
 *    `totalHits` 停在「进入封锁时那个数」不动，直到封锁到期才 `resetBlockedRequest()`
 *    清零；本实现报告的是「当前窗口内命中数 + 本次敲门」，而窗口里的命中会**继续**
 *    随时间出窗 ⇒ 长时间封锁下这个数会**衰减**（趋向 1），内存实现则是恒定的。
 *    据实记录：它**不影响**放行/拒绝的判定（封锁期间一律 429），只影响
 *    `X-RateLimit-Remaining-<层名>` 这个展示值；本轮**没有**为它改结构。
 * 3. **封锁到期**：清空窗口并重新开始，当前这次请求算作第 1 次命中
 *    （内存实现在 `timeToBlockExpire <= 0 && isBlocked` 分支里 `resetBlockedRequest()` 后
 *    立刻 `fireHitCount()`）。**据实记录的差异**：本实现在这里**无条件清空**
 *    刚才存活的窗口成员，内存实现只清命中、不重置窗口。两者只在
 *    `blockDuration > ttl` 时分叉，而 guard 默认 `blockDuration = ttl`
 *    （`throttler.guard.js` 第 93 行 `?? namedThrottler.blockDuration ?? ttl`），
 *    本仓库五个层都没显式配 ⇒ 在我们支持的全部配置下结果相同。
 * 4. `blockDuration <= 0`：走库的 `incrementWithoutBlock` 分支——阈值是 `>=`（不是 `>`），
 *    且被拒时 `totalHits` 仍然 +1（`reportedHits`），但**不写入**有序集合（理由同第 2 条）。
 * 5. 时间单位：`ttl`/`blockDuration` 是**毫秒**入参，返回的两个时间是**秒**（库的
 *    `Retry-After`/`X-RateLimit-Reset` 直接取用，所以单位必须是秒）。
 *    `timeToExpire` 在滚动窗口下的含义是「**最老的那次命中**出窗还有多久」——
 *    也就是「下一次可能有额度空出来」的秒数，这与 `X-RateLimit-Reset` 的用法一致；
 *    窗口为空时退回封锁剩余（没有任何命中时它是唯一有意义的时刻）。
 * 6. **`timeToExpire` 与内存实现的差异**（修复轮 3 补记）：内存实现那个值是
 *    **记录级**的（`increment` 里 `getExpirationTime(key)` = `record.expiresAt - now`，
 *    而 `expiresAt` 只在记录新建或到期时重设为 `now + ttl`），本实现则是
 *    「最老命中出窗还有多久」——**逐命中**的滚动量。两者都是「下一次可能有额度空出来」
 *    的单调上界，在「窗口内一直有命中」的稳态下近似一致，但**不是同一个量**；
 *    本实现的取值对客户端更保守（不会比真实空出时刻更早）。据实记录，不改。
 * 7. 键的身份是 `(key, throttlerName)`——内存实现按这两个维度做二维 Map，
 *    因此这里把层名编进 Redis 键，而不是只依赖 `key`。
 *
 * ## 时间取的是 **Redis 服务器**的时钟（`redis.call('TIME')`）
 *
 * 不把 `Date.now()` 从客户端传进来：多实例部署时每个实例的时钟略有偏差，
 * 而窗口与 `PEXPIRE` 都在 Redis 侧生效；用同一个时钟源，语义才是自洽的。
 * 实测（Redis 7.4.11，探针见修复轮报告）：`redis.call('TIME')` 在脚本里可用。
 * 依赖这一点的前提是 Redis ≥ 5（effects replication），
 * `infra/docker-compose.yml` 固定 `redis:7-alpine`，与之相符。
 *
 * ## 过期与回收：**计数**逐命中过期，**键的寿命**按最新命中算（修复轮 3 改正）
 *
 * 两件事必须分开看，上一版把它们当成了一件（这正是修复轮 3 的缺陷）：
 *
 * 1. **计数**只认还在 `ttl` 之内的命中——每次 `increment` 用 `ZREMRANGEBYSCORE` 剪掉出窗成员。
 *    这一条修复轮 2 就是对的。
 * 2. **键的寿命**必须让桶活过**它自己装着的每一个命中**，因此取**最**新命中的出窗时刻：
 *    `PEXPIRE` 到 `max(最新命中 + ttl, 封锁结束) - now`（两个键都设）。
 *    上一版取的是**最老**命中：最老那条一出窗，Redis 就删掉整个桶，**仍在 `ttl` 内的新命中
 *    被一起丢掉**，计数于是在 `X-RateLimit-Reset-<层名>` 昭告的那个时刻重新从零开始——
 *    而那个头正是客户端读一眼就能对齐的东西。方向是**放宽**：本该继续算数的命中被遗忘。
 *    判别性用例：`throttler-storage.test.ts` 的「空转越过最老命中：仍在 `ttl` 内的命中不许
 *    被一起丢掉」（把寿命改回最老命中 ⇒ 立刻变红）。
 *
 * 而**返回**给调用方的 `timeToExpire` 仍然取最老命中（见上方注释第 5 条）：
 * 那是「下一次可能有额度空出来」的时刻，也是唯一适合放进 `X-RateLimit-Reset` 的量。
 * 寿命比它长是**应该的**——存储多留一会儿只会让计数更准，不会误伤任何请求；
 * 反过来（寿命短于它）才会丢掉真实的命中。
 *
 * 两个键都设是**承重**的：修复轮 2 把计数搬进有序集合时漏掉了记录键，
 * 它立刻变成永不过期（`PTTL` 回 -1），被 `rate-limit.test.ts` 的既有断言当场抓到。
 */
const INCREMENT_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])
local memberSeed = ARGV[4]

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local blockedUntil = tonumber(redis.call('HGET', key, 'blockedUntil') or '0')

-- 封锁到期：清空窗口（含有序集合），当前这次请求随后算作第 1 次命中。
if blockedUntil > 0 and blockedUntil <= now then
  blockedUntil = 0
  redis.call('DEL', key .. ':hits')
end

-- 逐命中过期：只保留「从自己的时刻起算还没走完 ttl」的命中。
-- 右边界用 '(cutoff'（开区间）：score <= now - ttl 的成员被移除，
-- 于是恰好满 ttl 的那次命中已经出窗，窗口长度精确等于 ttl。
local cutoff = now - ttl
redis.call('ZREMRANGEBYSCORE', key .. ':hits', '-inf', '(' .. cutoff)

local hits = redis.call('ZCARD', key .. ':hits')
local isBlocked = blockedUntil > now
local reportedHits = hits
local timeToBlockExpire = 0

if blockDuration > 0 then
  if not isBlocked then
    -- 先记这一次命中，再判阈值：本次命中一定落在自己的窗口里
    -- （score = now > now - ttl），因此「窗口内最多 limit 次」这条不变量是精确的。
    local member = memberSeed .. ':' .. now
    redis.call('ZADD', key .. ':hits', now, member)
    if hits + 1 > limit then
      isBlocked = true
      blockedUntil = now + blockDuration
      -- 被拒的这次**不入账**（见上方注释第 2 条）：否则反复敲门会让窗口
      -- 永远有成员，实际效果是永久封锁。
      redis.call('ZREM', key .. ':hits', member)
    end
  end
  -- 报告值统一是「窗口内被放行的次数 + 本次（被拒的）尝试」，与内存实现一致
  -- （那里 totalHits 把进入封锁的那一次也算在内）。于是：
  --   * 进入封锁的那一次（第 limit+1 次敲门）报告 limit + 1；
  --   * 封锁期间的每一次敲门报告同一个值（hits 不再增长，本次尝试恒为 1），
  --     也就是**不随敲门次数增长**——这正是 throttler-storage.test.ts 第 2 条
  --     钉住的性质（写成「每次 +1」会让窗口被反复推后 = 永久封锁）。
  reportedHits = hits + 1
  if isBlocked then
    timeToBlockExpire = math.ceil((blockedUntil - now) / 1000)
  end
else
  isBlocked = hits >= limit
  if isBlocked then
    reportedHits = hits + 1
    timeToBlockExpire = math.ceil(ttl / 1000)
  else
    local member = memberSeed .. ':' .. now
    redis.call('ZADD', key .. ':hits', now, member)
    hits = hits + 1
    reportedHits = hits
  end
end

redis.call('HSET', key, 'blockedUntil', blockedUntil)

-- 记录/集合的寿命 = max(最**新**命中的出窗时刻, 封锁结束) - now，至少 1ms。
-- 修复轮 3 改正（此前取的是最**老**命中）：寿命必须让桶活过它**自己装着的每一个命中**。
-- 取最老命中时，最老那条一出窗 Redis 就把整个桶删掉，把仍在 ttl 内的新命中一起丢掉，
-- 于是计数在**告诉客户端**的那个 X-RateLimit-Reset-<层名> 时刻重新从零开始——方向是放宽
-- （一条本该继续算数的命中被遗忘），也就是「贴着重置时刻回来」即可多拿额度。
-- 判别性用例：throttler-storage.test.ts 的「空转越过最老命中…」。
local newest = redis.call('ZRANGE', key .. ':hits', -1, -1, 'WITHSCORES')
local newestExpiresAt = now
if newest[2] then
  newestExpiresAt = tonumber(newest[2]) + ttl
end

-- 报给调用方的窗口结束时刻仍然取**最老**命中（返回值的第二个元素就是它）：
-- 滚动窗口下它的含义是「下一次可能有额度空出来」，与 X-RateLimit-Reset 的用法一致
-- （见上方注释第 5 条）。寿命与它**故意**不是同一个量。
local reportedExpiresAt = newestExpiresAt
local oldest = redis.call('ZRANGE', key .. ':hits', 0, 0, 'WITHSCORES')
if oldest[2] then
  reportedExpiresAt = tonumber(oldest[2]) + ttl
end

local expiresIn = math.max(newestExpiresAt, blockedUntil) - now
if expiresIn < 1 then
  expiresIn = 1
end
-- **两个键都要设过期**（修复轮 2 的回归：搬进有序集合后只给 key:hits 设了 TTL，
-- 记录键 key 于是变成 -1「永不过期」，被 rate-limit.test.ts 的 PTTL 断言当场抓到）。
-- 记录键在窗口为空且未封锁时只剩一个 0，寿命取 1ms 即可——下次命中会重新写它。
redis.call('PEXPIRE', key, expiresIn)
redis.call('PEXPIRE', key .. ':hits', expiresIn)

return { reportedHits, math.ceil((reportedExpiresAt - now) / 1000), isBlocked and 1 or 0, timeToBlockExpire }
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

  /**
   * 有序集合成员名的去重序号（修复轮 2）。
   *
   * 成员名是 `<序号>:<now>`，而 `now` 是**毫秒**——同一毫秒内的两次命中会撞名，
   * 于是 `ZCARD` 少数一次（阈值被**放宽**，方向不对）。加一个自增序号即可；
   * 它**不需要**跨进程唯一：不同进程的时间戳不同毫秒的概率极高，即使撞了，
   * 也只会像上面那样少算一次，而下面的 `hits > limit` 判断仍在同一脚本里原子完成。
   */
  private memberSeq = 0;

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
      // 第四个参数是本次命中的**成员名种子**（见 `memberSeq`）：脚本内部会拼上
      // Redis 服务器时钟的毫秒值，作为有序集合的成员与 score 来源。
      this.memberSeq += 1;
      reply = await this.redis.eval(
        INCREMENT_SCRIPT,
        1,
        redisKey,
        ttl,
        limit,
        blockDuration,
        this.memberSeq,
      );
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
 *
 * 校验只剩**一步**（修复轮 2 精简）：`reply.length !== 4` 之后，解构出的四个值必然
 * 存在（`reply.map()` 对每个元素都产出值），所以上一版那四个 `x === undefined`
 * 判断是**不可达**的——它们只让这段校验看起来比实际更严。真正会触发的是
 * `Number.isFinite`：Lua 返回的非数字（`nil` 元素会被 Redis 转成 `false`）、
 * 或者换了一个只会回字符串的替身时，`Number(...)` 就是 `NaN`。
 */
function parseRecord(reply: unknown): ThrottleRecord {
  if (!Array.isArray(reply) || reply.length !== 4) {
    throw new Error(`限流脚本返回了意外形状（期望 4 个整数）：${JSON.stringify(reply)}`);
  }
  const [totalHits, timeToExpire, blockedFlag, timeToBlockExpire] = (reply as unknown[]).map((value) =>
    Number(value),
  ) as [number, number, number, number];
  if (![totalHits, timeToExpire, blockedFlag, timeToBlockExpire].every((value) => Number.isFinite(value))) {
    throw new Error(`限流脚本返回了非数值字段：${JSON.stringify(reply)}`);
  }
  return { totalHits, timeToExpire, isBlocked: blockedFlag !== 0, timeToBlockExpire };
}
