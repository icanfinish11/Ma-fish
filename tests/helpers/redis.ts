import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';

/**
 * 安全套件的**真** Redis 夹具（修复轮 1 / C-1）。
 *
 * ## 为什么安全套件需要一个自己的 Redis 容器
 *
 * 限流桶搬进 Redis 之后（见 `redis-throttler.storage.ts`），任何会打到
 * `@RateLimited(...)` 路由的用例都会**写进**那个 Redis。若沿用测试进程默认的
 * `REDIS_URL`（本机 compose 的那一个），计数会**跨运行累积**：
 * `tests/security/rate-limit.test.ts` 的注册层断言是「前 3 次 201、第 4 次 429」，
 * 而注册层的 TTL 是 1 小时——第二次跑同一个套件时桶里可能已经有 4 次命中，
 * 于是第一次请求就是 429，断言变成随机红。多份文件还会互相污染
 * （`csrf.test.ts` 的正向用例也注册一次）。
 *
 * 容器给的是「每次运行都是干净桶」+「同一个 Redis 可以被多个应用实例共用」这两个性质，
 * 后者正是判别性用例（两个实例共享计数）需要的前提。
 * 这也是集成套件既有的做法（`auth-pipeline.test.ts` 用 `RedisContainer` + 真 ioredis）。
 *
 * ## 客户端为什么长这样
 *
 * 与 `auth-pipeline.test.ts` 的 `newTestRedis` 同三条理由（那里有完整实测记录）：
 *
 * 1. **关掉自动重连**（`retryStrategy: () => null`）：容器停掉之后，ioredis 默认会不断
 *    重连，而第一次重连的 `INFO`（ready check）会撞上已经消失的 socket，打出
 *    `[ioredis] Unhandled error event: Error: write EPIPE`——不影响断言，但污染输出，
 *    而本仓库要求输出 pristine；
 * 2. **显式接管 `error` 事件**：ioredis 在没有监听者时会把错误打成
 *    `[ioredis] Unhandled error event: …`（`silentEmit`）。预期内的收尾噪音接住，
 *    非预期的错误照旧打到 stderr，避免这个监听器变成静音开关；
 * 3. **每个应用一个新客户端**：客户端的生命周期属于应用（`RedisLifecycle` 在
 *    `app.close()` 时 `disconnect()` 它）。两个实例共用一个客户端会让「关掉 A」把
 *    B 的连接一起掐断——那不是两个实例，而是一个连接被两个应用借用。
 *
 * 容器必须**显式**停（`stop()`），且要在所有 `app.close()` **之后**：容器不属于任何应用，
 * 没有钩子会替你收；反过来则会让应用在关停时对着一个已经消失的 Redis 发命令。
 */
export interface TestRedis {
  /** 容器暴露的连接串（**同一个** Redis 的地址，供多个实例共用）。 */
  readonly url: string;
  /** 新建一个指向该容器的客户端（每个应用一个，见上文第 3 条）。 */
  newClient(): Redis;
  /** 停止容器。必须在所有 `app.close()` 之后调用。 */
  stop(): Promise<void>;
}

/** 起一个一次性 Redis 容器（`redis:7-alpine`，与 `infra/docker-compose.yml` 同版本）。 */
export async function startTestRedis(): Promise<TestRedis> {
  const container: StartedRedisContainer = await new RedisContainer('redis:7-alpine').start();
  const url = container.getConnectionUrl();
  return {
    url,
    newClient: () => {
      const client = new Redis(url, { retryStrategy: () => null, maxRetriesPerRequest: 1 });
      client.on('error', (err: Error) => {
        if (!/EPIPE|ECONNRESET|Connection is closed/.test(err.message)) {
          process.stderr.write(`[test-redis] ${err.message}\n`);
        }
      });
      return client;
    },
    stop: async () => void (await container.stop()),
  };
}
