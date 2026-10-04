import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisThrottlerStorage } from '@vca/api/common/security/redis-throttler.storage.js';
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
