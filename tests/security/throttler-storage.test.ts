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
