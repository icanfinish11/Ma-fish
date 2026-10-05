import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  RedisThrottlerStorage,
  THROTTLE_KEY_PREFIX,
} from '@vca/api/common/security/redis-throttler.storage.js';
import { startTestRedis, type TestRedis } from '../helpers/redis.js';

/**
 * `RedisThrottlerStorage` 的**语义**验证（修复轮 1 / C-1）：直接对着真 Redis 调
 * `increment`，不经过 HTTP。
 *
 * ## 为什么这组用例必须存在
 *
 * 端到端用例（`rate-limit.test.ts`）只能观察到「第 N 次请求返回 429」，
 * 而存储实现里真正容易写错的三件事在那条路径上看不见：
 *
 * 1. **封锁期间不再累加命中**——写成「每次都 hits+1」时，第 4、5、6 次仍然都是 429，
 *    HTTP 断言全绿，但窗口被反复推后，封锁实际上变成了「永久封锁」；
 * 2. **窗口与封锁的过期**——两种写法的 HTTP 表现都是「一段时间后恢复」，
 *    而 ttl 写错单位（毫秒当秒）会让 15 分钟的窗口变成 15 秒；
 * 3. **`blockDuration <= 0` 这条分支**（库的 `incrementWithoutBlock`）——
 *    本仓库的层都不配 `blockDuration`，因此端到端路径永远走不到它；
 *    但它是接口的一部分，写错了不会有任何用例变红（未测代码 = 未验证的声明）。
 *
 * 语义的**参照系**是库里那个内存实现 `ThrottlerStorageService.increment`
 * （`@nestjs/throttler@6.7.1` 的 `throttler.service.js`：阈值 `> limit` 进封锁、
 * 封锁期间不累加、`blockDuration <= 0` 时阈值是 `>=` 且 `totalHits` 仍 +1），
 * 以及 guard 对返回值的用法（`isBlocked` ⇒ 429 + `Retry-After` = `timeToBlockExpire` 秒；
 * 否则 `X-RateLimit-Remaining` = `limit - totalHits`）。本文件把这三条逐条钉住。
 *
 * 时间单位：入参 `ttl`/`blockDuration` 是**毫秒**，返回的两个时间是**秒**（见接口文档）。
 * 因此这里既断言数值的量级（60 秒而不是 60 毫秒），也用「短 ttl + 真等待」验证过期。
 */
describe('RedisThrottlerStorage 的语义（修复轮 1 / C-1）', () => {
  let redis: TestRedis;
  let client: Redis;
  let storage: RedisThrottlerStorage;

  beforeAll(async () => {
    redis = await startTestRedis();
    // 一个客户端供本文件全部用例使用：它**不属于**任何应用（存储类不拥有连接），
    // 因此生命周期由本文件自己管，见 afterAll。
    client = redis.newClient();
    storage = new RedisThrottlerStorage(client);
  }, 180_000);

  afterAll(async () => {
    client?.disconnect();
    await redis?.stop();
  });

  it('阈值是 limit+1：前 limit 次放行，第 limit+1 次进入封锁并给出秒级的封锁剩余', async () => {
    const key = 'semantics-threshold';
    const ttl = 60_000;
    const limit = 3;
    const blockDuration = 60_000;

    const first = await storage.increment(key, ttl, limit, blockDuration, 'register');
    expect(first).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(first.timeToExpire).toBeGreaterThan(0);
    expect(first.timeToExpire).toBeLessThanOrEqual(60); // 秒，不是 60000（毫秒当秒的单位错误）

    await storage.increment(key, ttl, limit, blockDuration, 'register');
    const third = await storage.increment(key, ttl, limit, blockDuration, 'register');
    expect(third, '第 3 次（= limit）仍然放行').toMatchObject({ totalHits: 3, isBlocked: false });

    const fourth = await storage.increment(key, ttl, limit, blockDuration, 'register');
    expect(fourth, '第 4 次（= limit+1）必须被封锁').toMatchObject({ totalHits: 4, isBlocked: true });
    // 封锁剩余是 blockDuration 的量级（秒），guard 直接把它写进 `Retry-After-<层名>`。
    expect(fourth.timeToBlockExpire).toBeGreaterThan(0);
    expect(fourth.timeToBlockExpire).toBeLessThanOrEqual(60);
  });

  it('封锁期间**不再累加命中**（否则窗口被反复推后 = 永久封锁）', async () => {
    const key = 'semantics-blocked-no-increment';
    const args = [key, 60_000, 3, 60_000, 'register'] as const;
    for (let i = 0; i < 4; i++) await storage.increment(...args);

    const fifth = await storage.increment(...args);
    const sixth = await storage.increment(...args);
    expect(fifth.isBlocked).toBe(true);
    expect(sixth.isBlocked).toBe(true);
    // 命中数停在 limit+1（进入封锁的那一次），不随敲门次数增长。
    expect(fifth.totalHits).toBe(4);
    expect(sixth.totalHits).toBe(4);
  });

  it('窗口过期后计数归零（ttl 是毫秒：60ms 的窗口真的会在 60ms 后放开）', async () => {
    const key = 'semantics-window-expiry';
    const ttl = 60; // 毫秒
    for (let i = 0; i < 3; i++) await storage.increment(key, ttl, 3, ttl, 'search');

    const blocked = await storage.increment(key, ttl, 3, ttl, 'search');
    expect(blocked.isBlocked).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 90));

    const after = await storage.increment(key, ttl, 3, ttl, 'search');
    expect(after, '窗口过期后必须从头计数，而不是把桶永久锁死').toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('封锁到期后放行，并重新从第 1 次算起', async () => {
    const key = 'semantics-block-expiry';
    const ttl = 80;
    const blockDuration = 80;
    const limit = 1;

    await storage.increment(key, ttl, limit, blockDuration, 'login');
    const blocked = await storage.increment(key, ttl, limit, blockDuration, 'login');
    expect(blocked.isBlocked).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 220));

    const after = await storage.increment(key, ttl, limit, blockDuration, 'login');
    expect(after, '封锁到期后必须放行（否则一次触发就是永久拒绝）').toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('blockDuration <= 0 走库的非封锁分支：阈值是 `>=`，`totalHits` 仍 +1', async () => {
    // 本仓库的五个层都不配 `blockDuration`（guard 会把它默认为 ttl），因此这条分支
    // 在端到端路径上永远走不到——但接口给了它，参照系是内存实现的
    // `incrementWithoutBlock`：`isBlocked = hits >= limit`、被拒时 totalHits 仍 +1、
    // `timeToBlockExpire` 是**窗口剩余**（不是 blockDuration）。
    const key = 'semantics-no-block-branch';
    const ttl = 60_000;
    const limit = 3;

    for (let i = 1; i <= 3; i++) {
      const res = await storage.increment(key, ttl, limit, 0, 'bid');
      expect(res, `第 ${i} 次（< limit）放行`).toMatchObject({ totalHits: i, isBlocked: false });
      expect(res.timeToBlockExpire).toBe(0);
    }

    const rejected = await storage.increment(key, ttl, limit, 0, 'bid');
    expect(rejected, '第 4 次（= limit）在该分支下即被拒').toMatchObject({ totalHits: 4, isBlocked: true });
    expect(rejected.timeToBlockExpire).toBeGreaterThan(0);
    expect(rejected.timeToBlockExpire).toBeLessThanOrEqual(60);
  });

  it('不同层的桶互不影响（键的身份是 (key, 层名)）', async () => {
    const key = 'semantics-per-tier';
    await storage.increment(key, 60_000, 3, 60_000, 'register');
    await storage.increment(key, 60_000, 3, 60_000, 'register');
    await storage.increment(key, 60_000, 3, 60_000, 'register');
    const blocked = await storage.increment(key, 60_000, 3, 60_000, 'register');
    expect(blocked.isBlocked).toBe(true);

    // 同一个 key（guard 只在 generateKey 里混入层名；这里刻意用同一个字符串）
    // 在**另一个层**下必须是独立计数，否则一层被限会连带另一层。
    const other = await storage.increment(key, 60_000, 3, 60_000, 'login');
    expect(other).toMatchObject({ totalHits: 1, isBlocked: false });
  });
});

/**
 * **窗口形状**：契约是滚动窗口（修复轮 2 / Fix 2），这组用例是它的判别器。
 *
 * ## 为什么必须单独钉住「形状」
 *
 * 修复轮 1 的实现是**固定窗口**：`windowEndsAt <= now` 时把计数整体清零。
 * 它的阈值行为（第 limit+1 次被拒）与滚动窗口**完全一样**，所以
 * 上面那 6 条语义用例、以及全部 HTTP 用例在两种实现下都是绿的——它们都在
 * **单个窗口内部**打满，看不见窗口之间的差别。差别只在**跨界处**，
 * 而且方向是**放宽**：贴着边界放 limit 次、边界之后再放 limit 次，
 * 固定窗口会全部放行（2×limit），于是「15 分钟内最多 5 次口令猜测」实际变成
 * 「15 分钟跨度内最多 10 次」。更糟的是边界会经 `X-RateLimit-Reset-<层名>`
 * 告诉客户端，对齐它是零成本的。
 *
 * ## 怎么做到**确定性**（不靠 sleep、不靠「跑得够快」）
 *
 * 直接写 Redis 里的**有序集合成员**（脚本的数据结构）来构造「一条命中的发生时刻」，
 * 于是窗口的整个历史都由测试决定，而不是由执行速度决定。具体两步：
 *
 * 1. 用 `ZADD` 把 limit 次命中放在 `T - 10s`（对 `ttl = 60s` 而言**还在窗口内**，
 *    但离窗口左沿只差 10 秒）；
 * 2. 调 `increment`，此时窗口内的命中数已达上限 ⇒ 必须**封锁**。
 *
 * 固定窗口实现下这两步给出的结果是 `{ totalHits: 1, isBlocked: false }`
 * （它只认得自己那对 `hits`/`windowEndsAt` 哈希字段，看到的是「空桶」，于是放行），
 * 因此这组用例在旧实现上**必红**（变异探针见报告 M2）。
 *
 * 时间余量：整个用例的执行窗口是**几十毫秒**（几次 Redis 往返），
 * 而两次构造之间相隔 10 秒 ⇒ 时间余量是执行时间的两个数量级，
 * 不存在「跑慢一点就换一种语义」的抖动。
 */
describe('滚动窗口的形状：逐命中过期，而不是整桶清零（修复轮 2 / Fix 2）', () => {
  let redis: TestRedis;
  let client: Redis;
  let storage: RedisThrottlerStorage;

  /** 与 `RedisThrottlerStorage.increment` 拼键的方式逐字一致（见那里的 `redisKey`）。 */
  const bucketKey = (name: string, key: string): string => `${THROTTLE_KEY_PREFIX}${name}:${key}`;
  const hitsKey = (name: string, key: string): string => `${bucketKey(name, key)}:hits`;

  beforeAll(async () => {
    redis = await startTestRedis();
    client = redis.newClient();
    storage = new RedisThrottlerStorage(client);
  }, 180_000);

  afterAll(async () => {
    client?.disconnect();
    await redis?.stop();
  });

  it('窗口左沿决定阈值：10 秒前的 limit 次命中仍然算数（≡ 固定窗口会放行）', async () => {
    const key = 'rolling-window-left-edge';
    const ttl = 60_000;
    const limit = 60;
    const tenSecondsAgo = Date.now() - 10_000;

    // 构造「窗口内已经有 limit 次命中」的**真实历史**：每个成员一条，
    // score 是它发生的毫秒时刻，成员名唯一（不用 `now` 拼，避免同毫秒撞名）。
    const members: Array<string | number> = [];
    for (let i = 0; i < limit; i++) members.push(tenSecondsAgo + i, `seed:${i}`);
    await client.zadd(hitsKey('search', key), ...members);

    // 契约：这 limit 次都还在 `ttl` 之内 ⇒ 第 limit+1 次必须被拒。
    const next = await storage.increment(key, ttl, limit, ttl, 'search');
    expect(
      next.isBlocked,
      `10 秒前的 ${limit} 次命中被无视了：这是**固定窗口**的形状（整桶清零），` +
        `契约要求滚动窗口（逐命中过期）。实际 totalHits=${next.totalHits}`,
    ).toBe(true);
    expect(next.totalHits).toBe(limit + 1);

    // 顺带钉住「窗口右沿来自**真实的历史**，而不是「现在 + ttl」」：
    // 最老的那次命中发生在 10 秒前，它的出窗时刻是 `那时 + ttl`，也就是「现在 + 50 秒」。
    // 固定窗口（把窗口结束定死为「首次命中 + ttl」，且无视已有历史）在这里会给出
    // 整整 60 秒——差 10 秒，而整个用例的执行窗口只有几十毫秒，不可能靠抖动混淆。
    expect(
      next.timeToExpire,
      '窗口结束时刻被当成「现在 + ttl」= 固定窗口的形状（真实历史没被算进去）',
    ).toBeLessThanOrEqual(51);
    expect(next.timeToExpire).toBeGreaterThan(40);

    // 「桶真的落在 Redis 的有序集合里」：固定窗口实现写的是 hits/windowEndsAt 哈希字段，
    // 有序集合的成员数会是 0 或 1——这条断言把数据结构本身也钉住。
    expect(await client.zcard(hitsKey('search', key))).toBe(limit);
  });

  it('过期的命中会被剪掉，窗口内的命中仍然算数（逐命中过期，不是整桶清零）', async () => {
    const key = 'rolling-window-per-hit-expiry';
    const ttl = 60_000;
    const limit = 3;

    // 三条命中：两条是「刚刚」发生的（还在窗口内），一条是 5 秒前发生的（同样在窗口内）。
    const now = Date.now();
    await client.zadd(
      hitsKey('bid', key),
      now - 20, 'seed:fresh-1',
      now - 10, 'seed:fresh-2',
      now - 5_000, 'seed:older',
    );

    // 窗口内已有 3 次（= limit）⇒ 第 4 次被拒。
    const blocked = await storage.increment(key, ttl, limit, ttl, 'bid');
    expect(blocked.isBlocked, '窗口内的命中没有被连续计数').toBe(true);
    expect(blocked.totalHits).toBe(limit + 1);

    // 关键区别：剪枝是**逐命中**的，不是整桶清零——三条命中都还在窗口内，
    // 一条都不该被删掉（固定窗口那种「整桶清零」会把它们全丢掉）。
    expect(await client.zcard(hitsKey('bid', key))).toBe(limit);

    // 而一条**已经出窗**的命中则必须被剪掉（否则桶只会越攒越满，最后变成永久封锁）。
    await client.zadd(hitsKey('bid', key), Date.now() - ttl - 1_000, 'seed:expired');
    const afterPrune = await storage.increment(key, ttl, limit, ttl, 'bid');
    // 那次出窗的命中被剪掉后，窗口里仍是 3 条 ⇒ 仍然封锁（但报告值不变）。
    expect(afterPrune.isBlocked).toBe(true);
    expect(await client.zcard(hitsKey('bid', key)), '出窗的命中没有被剪掉：桶会无限增长').toBe(limit);
  });

  it('空转越过**最老**命中：仍在 `ttl` 内的命中不许被一起丢掉（键的寿命按最新命中算）', async () => {
    const key = 'rolling-window-bucket-lifetime';
    const tier = 'search' as const; // 60 次/60 秒：这条用例要的是一条**够宽**的额度
    const ttl = 60_000;
    const limit = 60;

    // ## 为什么这里**刻意不把额度打满**（修复轮 3 的教训，写下来免得下一个人改回去）
    //
    // 第一版这条用例让历史命中达到 `limit`，于是本次 increment 进入封锁，而封锁会把
    // 寿命抬到 `blockedUntil`——**恰好盖住**了「寿命取最老命中」这个缺陷，用例在旧实现上
    // 也是绿的（实测：`increment#1` 之后 `PTTL = 59997`）。评审给出缺陷时用的历史是
    // **未达上限**的（两条命中、1500ms 间隔、`PTTL ≈ 1486ms` 而不是 3000ms），
    // 因为只有「没有封锁插手」时，寿命才**只**由 `max(最老命中 + ttl, blockedUntil)` 决定。
    // 因此这里用 limit=60、只放 5 条历史——够「有东西可丢」，又不会引入封锁。
    //
    // ## 时间安排（两种老命中 + 一种新命中，全部显式给出，不靠 sleep 构造历史）
    //
    //   - 一条 61 秒前 ⇒ 已出窗，本次 increment 会剪掉它（剪枝这一半照旧被钉住）；
    //   - 四条 56 秒前 ⇒ **仍在 ttl 内**，本次之后 4 秒出窗——这就是「昭告客户端的重置时刻」；
    //     它们之后还有 4 秒余量，足以活过下面那 2.4 秒的等待（56 减 2.4 ≈ 53.6 < 60）。
    //   - 寿命的候选值：最老命中 + ttl = 本次之后 **4 秒**；最新命中 + ttl ≈ **56 秒**。
    //
    // ## 这条用例的判别力落在哪一条断言上（最终评审的 Minor 更正了此处说法）
    //
    // **判别「寿命取最老命中」这个缺陷的是上面那个 `PTTL > 5_000`**：有缺陷的寿命 ≈4 秒、
    // 正确的 ≈56 秒，5 秒的阈值落在两者之间。
    //
    // 下面的 2.4 秒等待**不**跨越最老命中的出窗时刻（那是本次之后 ≈4 秒），因此**它本身
    // 辨别不了这个缺陷**——上一版注释写的是「等待 2.4 秒 = 越过最老命中出窗的时刻（≈2 秒）」，
    // 与同一段里「最老命中 + ttl = 本次之后 4 秒」自相矛盾，而且把它说成了判别式。
    // 它的真实作用是**粗粒度的兜底**：寿命若短到 2.4 秒以内（例如误写成 1 秒、
    // 或干脆没设 TTL 之外的另一类错误），排空之后的 `totalHits` 与存活成员就会不对。
    // 不能把等待延长到 4 秒以上来「让它判别」：那四条 56 秒前的种子命中会在等待期间
    // 真的出窗，下面「仍在 ttl 内的命中必须留着」的断言就失去意义了。
    const hits = hitsKey(tier, key);
    const now = Date.now();
    await client.zadd(
      hits,
      now - 61_000, 'seed:left-the-window',
      now - 56_000, 'seed:in-window-1',
      now - 55_999, 'seed:in-window-2',
      now - 55_998, 'seed:in-window-3',
      now - 55_997, 'seed:in-window-4',
    );

    // 本次命中（第 6 次，limit=60 ⇒ 放行、不进封锁，寿命因此只由命中决定）。
    // 这次 increment 把**键的寿命**写进 Redis：下面读到的就是生产代码真正设下的那个值。
    const first = await storage.increment(key, ttl, limit, ttl, tier);
    expect(first.isBlocked, '本用例需要一条未达上限的历史（一旦进封锁，封锁会把桶的寿命盖住）').toBe(false);
    expect(first.totalHits).toBe(5);
    // 报给调用方的窗口结束时刻仍然取自**最老**的窗内命中（56 秒前）⇒ 约 4 秒。
    expect(first.timeToExpire, 'X-RateLimit-Reset 的语义被改动了：它应当报「最老命中出窗」').toBeLessThanOrEqual(5);
    expect(first.timeToExpire).toBeGreaterThan(0);

    // ── ① 寿命本身（就是「先于实现说出来的判据」）───────────────────────────────
    // 有缺陷的寿命 = 最老命中 + ttl = 本次之后 ≈4 秒；正确的寿命 ≈56 秒。
    // 断言「>= 5 秒」落在两者之间，且离两边都足够远（毫秒级的抖动影响不到它）。
    // 记录键与有序集合**都要**满足（修复轮 2 漏设记录键的 PTTL 回归靠这里一起钉住）。
    const bucketPttl = await client.pttl(bucketKey(tier, key));
    const hitsPttl = await client.pttl(hits);
    for (const [label, pttl] of [
      ['记录键', bucketPttl],
      ['有序集合', hitsPttl],
    ] as const) {
      expect(
        pttl,
        `限流桶的${label}寿命（${pttl}ms）短于它装着的最新命中（≈56 秒）：最老那条一出窗，` +
          'Redis 就会把整个桶删掉，仍在 ttl 内的命中被一起丢掉 ⇒ 计数在昭告客户端的重置时刻从零开始',
      ).toBeGreaterThan(5_000);
    }

    // ── ② 把它落成**实际后果**，而不是一条「TTL 看起来够长」的性质 ────────────────
    // 等待 2.4 秒：**不**跨越最老命中的出窗时刻（≈4 秒），因此它在这里是粗粒度兜底
    // （详见上面「这条用例的判别力落在哪一条断言上」），真正判别的是①里的 PTTL 断言。
    // 这 2.4 秒仍然有它自己的价值：它把「桶在一两秒内就消失」这类更粗的错误变成一条
    // 会红的断言，而不是只留在 PTTL 的数值里。
    await new Promise((resolve) => setTimeout(resolve, 2_400));

    const survived = await client.zcard(hits);
    const after = await storage.increment(key, ttl, limit, ttl, tier);

    expect(
      after.totalHits,
      survived > 0
        ? `仍在 ttl 内的 ${survived} 条命中被忘了：计数变成 ${after.totalHits}（应 > 1）`
        : '限流桶在自己仍然装着命中的时候就过期了：仍在 ttl 内的命中被一起丢掉，计数从 1 重新开始',
    ).toBe(6);
    // 出窗那条必须被剪掉，而 4 条仍在窗内的必须留着（逐命中过期）。
    // 另外还有**两次** increment 各记下的一条命中（本用例调了两次 increment，
    // 脚本写入的成员名是 `<自增序号>:<now>`，与 seed: 前缀不会撞名）⇒ 合计 6 条。
    // 断言按**成员名**而不是只看基数：基数相同但「丢错了一条」的实现也该变红。
    const survivors = await client.zrange(hits, '0', '-1');
    expect(survivors, '出窗的那条命中没有被剪掉：桶会无限增长').not.toContain('seed:left-the-window');
    for (const id of ['seed:in-window-1', 'seed:in-window-2', 'seed:in-window-3', 'seed:in-window-4']) {
      expect(survivors, `${id} 仍在 ttl 内，却被一起丢掉了`).toContain(id);
    }
    expect(survivors).toHaveLength(6);
  });

  it('封锁期间的敲门既不入账、也不把窗口推后（否则每次敲门都刷新「最老命中」）', async () => {
    const key = 'rolling-window-blocked-does-not-slide';
    const ttl = 60_000;
    const limit = 2;

    const first = await storage.increment(key, ttl, limit, ttl, 'login');
    expect(first).toMatchObject({ totalHits: 1, isBlocked: false });
    const second = await storage.increment(key, ttl, limit, ttl, 'login');
    expect(second).toMatchObject({ totalHits: 2, isBlocked: false });
    const third = await storage.increment(key, ttl, limit, ttl, 'login');
    expect(third, '第 limit+1 次必须进入封锁').toMatchObject({ totalHits: 3, isBlocked: true });

    const zsetSizeAtBlock = await client.zcard(hitsKey('login', key));

    // 封锁期间连敲 5 次：报告值不变（不随敲门次数增长），
    // 且有序集合也不增长——两者一起说明「窗口没有被这些被拒的请求推后」。
    for (let i = 0; i < 5; i++) {
      const knocked = await storage.increment(key, ttl, limit, ttl, 'login');
      expect(knocked.isBlocked).toBe(true);
      expect(knocked.totalHits, '被拒的敲门被算进了计数：窗口会被反复推后 ⇒ 实际是永久封锁').toBe(limit + 1);
    }
    expect(
      await client.zcard(hitsKey('login', key)),
      '被拒的敲门写进了有序集合：最老命中会被不断推向「现在」⇒ 实际是永久封锁',
    ).toBe(zsetSizeAtBlock);
  });
});
