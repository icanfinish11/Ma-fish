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

/**
 * 收尾竞态会产生的错误（**接住它们正是上面第 2 条的理由**）。
 *
 * 这一行是「一个**完整的**清单」而不是随手几个码：漏掉一个的失效形态正是本文件要消灭的东西
 * ——`[test-redis] write ECONNABORTED` 曾经从 `t1-final-test.txt` 漏进 stderr，
 * 因为当时的清单只有 `EPIPE|ECONNRESET|Connection is closed`（修复轮 1 / Fix 2）。
 *
 * 分类依据（**只收「对端已消失」类**）：
 *
 * - `EPIPE`：socket 已关，写入撞上已关闭的管道（容器先停、或对端已关）；
 * - `ECONNRESET`：对端发了 RST（testcontainers 停容器时会这样）；
 * - `ECONNABORTED`：本机在连接被中断后**仍在写**（容器已消失，写操作被中止）——
 *   即实测漏出来的那一个；
 * - `ESHUTDOWN`：socket 在写入期间被优雅关闭（`end()` 之后 socket 已停）；
 * - `ERR_STREAM_DESTROYED` / `Stream isn't writeable`：ioredis 在 `disconnect()` 之后
 *   到达的命令撞上已销毁的流（与 `Connection is closed.` 同一类，见 `redis.module.ts`）。
 *
 * **刻意不收**：`ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND`。那些是「连不上容器」，
 * 属于真实故障——若被静音，失效形态会变成「会话/限流断言以一堆 403/500 失败」，
 * 而 stderr 里一句解释都没有。清单之外的错误照旧打到 stderr，这个监听器不是静音开关。
 */
const TEARDOWN_ERRORS =
  /EPIPE|ECONNRESET|ECONNABORTED|ESHUTDOWN|ERR_STREAM_DESTROYED|Stream isn't writeable|Connection is closed/;

/**
 * 这个错误是不是「容器收尾」的噪音（**导出是为了让它可被直接测**）。
 *
 * `tests/integration/asset/upload-rules.test.ts` 对「哪些码被吞、哪些码照旧上报」
 * 逐条断言：清单过窄会让噪音漏出（本轮的缺陷），过宽会把**真实故障**静音——
 * 后者更贵，而且没有任何别的东西会红。把判据抽成一个纯函数，才能在不造 socket 故障的前提下
 * 把这两侧都钉住。
 *
 * 同时看 `err.code`：socket 错误的稳定判据是那个码，而消息文本随 Node 版本漂移
 * （`write ECONNABORTED` 里的 `write ` 前缀就是 Node 自己加的）。两者都过一遍是为了不漏，
 * 不是为了多放行。
 */
export function isTeardownError(err: Error): boolean {
  const code = (err as { code?: unknown }).code;
  return TEARDOWN_ERRORS.test(err.message) || (typeof code === 'string' && TEARDOWN_ERRORS.test(code));
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
        if (!isTeardownError(err)) {
          process.stderr.write(`[test-redis] ${err.message}\n`);
        }
      });
      return client;
    },
    stop: async () => void (await container.stop()),
  };
}
