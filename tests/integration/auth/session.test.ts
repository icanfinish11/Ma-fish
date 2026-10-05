import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { SessionService } from '@vca/api/modules/auth/session.service.js';

describe('会话（§4.2 / C13）', () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let svc: SessionService;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis(container.getConnectionUrl());
    svc = new SessionService(redis);
  }, 180_000);

  afterAll(async () => {
    await redis?.quit();
    await container?.stop();
  });

  it('创建后可校验', async () => {
    const { sessionId } = await svc.create('user-1', { ip: '127.0.0.1', userAgent: 'vitest' });
    const s = await svc.verify(sessionId);
    expect(s?.userId).toBe('user-1');
  });

  it('未知 sessionId 返回 null（不抛错，避免枚举）', async () => {
    await expect(svc.verify('does-not-exist')).resolves.toBeNull();
  });

  it('销毁后不可用', async () => {
    const { sessionId } = await svc.create('user-2', { ip: '127.0.0.1', userAgent: 'vitest' });
    await svc.destroy(sessionId);
    await expect(svc.verify(sessionId)).resolves.toBeNull();
  });

  /**
   * `MULTI/EXEC` 的**逐条**结果必须被检查（最终评审 I-5）。
   *
   * ## 前提（这一条用**真 Redis**证明，不是我说的）
   *
   * ioredis 对事务里逐条命令的执行期错误（WRONGTYPE / OOM / READONLY）是 **resolve**
   * 而不是 reject——错误躺在 `[err, res][]` 里。因此「`await` 了就当写成功」的实现会留下
   * 一个**没有 TTL 的会话哈希**：C13 的空闲 7 天过期在这条记录上变成永不过期，
   * 而外部表现完全正常（会话一直有效、没有报错）。
   *
   * 这里先把这个前提钉住（用 WRONGTYPE 造一条真实的逐条错误），再对 `create()` 断言
   * 「任一条命令失败 ⇒ 抛错」。少了前提那半条，「异常被抛出来」也可能只是因为
   * 那条命令在**排队期**就失败了——那是另一个机制，与本缺陷无关。
   */
  it('create()：任一条命令失败时必须报错，绝不留下没有 TTL 的会话哈希', async () => {
    // ── 前提：真 Redis 上，逐条错误是 resolve 出来的 ──────────────────────────
    await redis.set('probe:wrongtype', 'string');
    const replies = await redis.multi().incr('probe:wrongtype').exec();
    expect(replies, 'ioredis 对 MULTI 的逐条错误直接 reject 了：下面的前提不成立').not.toBeNull();
    expect(
      replies?.[0]?.[0],
      'ioredis 没有把逐条错误放进结果数组（前提变了：本用例要防的静默失效形态也随之改变）',
    ).toBeInstanceOf(Error);

    // ── 行为：三种失败形状都必须变成抛出 ──────────────────────────────────────
    const failure = new Error('OOM command not allowed when used memory > maxmemory.');
    const cases: Array<{ label: string; exec: () => Promise<[Error | null, unknown][] | null> }> = [
      // HSET 失败（例如 OOM）：哈希没写进去，但 EXPIRE 可能写在一个不存在的键上（返回 0）。
      { label: 'HSET 失败', exec: async () => [[failure, null], [null, 0]] },
      // EXPIRE 失败：**本缺陷的要害形态**——哈希写进去了、TTL 没设上 ⇒ 永不过期。
      { label: 'EXPIRE 失败（写了一半：有哈希、没有 TTL）', exec: async () => [[null, 1], [failure, 0]] },
      // 事务被中止（排队期就失败）：`exec()` 回 null，同样不能算成功。
      { label: 'EXEC 被中止（null）', exec: async () => null },
    ];

    for (const { label, exec } of cases) {
      const pipeline = {
        hset: () => pipeline,
        expire: () => pipeline,
        exec,
      };
      const broken = new SessionService({ multi: () => pipeline } as unknown as Redis);

      let thrown: unknown;
      try {
        await broken.create('user-broken', { ip: '127.0.0.1', userAgent: 'vitest' });
      } catch (err: unknown) {
        thrown = err;
      }
      expect(thrown, `${label}：失败被吞掉了——会话会被当成创建成功，而它可能永不过期`).toBeInstanceOf(
        Error,
      );
      // 错误消息里**不得**出现会话 id：它是完整的 bearer 凭证，而这个异常多半会被记进日志。
      expect(String((thrown as Error).message)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    }
  });

  it('空闲 7 天后过期（TTL 已设置）', async () => {
    const { sessionId } = await svc.create('user-3', { ip: '127.0.0.1', userAgent: 'vitest' });
    const ttl = await redis.ttl(`vca:sess:${sessionId}`);
    expect(ttl).toBeGreaterThan(6 * 24 * 3600);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600);
  });

  it('requireRecentAuth：刚认证过为 true，认证时间过久为 false', async () => {
    const { sessionId } = await svc.create('user-4', { ip: '127.0.0.1', userAgent: 'vitest' });
    await expect(svc.requireRecentAuth(sessionId, 15 * 60_000)).resolves.toBe(true);
    // 模拟 20 分钟前认证
    await redis.hset(`vca:sess:${sessionId}`, 'authAt', String(Date.now() - 20 * 60_000));
    await expect(svc.requireRecentAuth(sessionId, 15 * 60_000)).resolves.toBe(false);
  });

  /**
   * 会话标识本身的形状与不可预测性（§4.2 / C13）。
   *
   * 为什么这三条断言值得存在：`sessionId` 是**唯一**的凭证（cookie 里只有它，
   * 没有任何签名或第二因子），因此它的熵就是整套会话安全的熵。三条分别钉住
   * 「足够长」「URL 安全（能原样放进 cookie 而不必转义）」「每次不同（不是时间戳或计数器）」。
   * 任何一条被改坏（例如换成 `randomUUID()` 之外的短 id、或退化成可预测值），
   * 下面就会有断言变红——而不是等到线上被人撞库撞出来。
   */
  it('sessionId 是 256 位随机、URL 安全，且两次创建不相同', async () => {
    const a = await svc.create('user-5', { ip: '127.0.0.1', userAgent: 'vitest' });
    const b = await svc.create('user-5', { ip: '127.0.0.1', userAgent: 'vitest' });

    // 32 字节 base64url ⇒ 恰好 43 个字符，字符集 [A-Za-z0-9_-]
    expect(a.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  /**
   * 会话必须**服务端存储**（C13）。
   *
   * 断言的是「Redis 里确实有这条记录且带着归属人」——这正是「服务端会话」的定义。
   * 若将来有人把会话退回成「cookie 里带 userId 的自包含令牌」，Redis 里就什么都不会有，
   * 这条会立刻变红。
   */
  it('会话状态在服务端（Redis 哈希里带着 userId/authAt/ip/userAgent）', async () => {
    const { sessionId } = await svc.create('user-6', { ip: '10.0.0.7', userAgent: 'vitest-ua' });
    const stored = await redis.hgetall(`vca:sess:${sessionId}`);
    expect(stored).toMatchObject({ userId: 'user-6', ip: '10.0.0.7', userAgent: 'vitest-ua' });
    expect(Number(stored.authAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  /**
   * 滑动过期：**每次校验都续期**（C13「空闲 7 天」的「空闲」二字由此成立）。
   *
   * 用 `redis.expire` 把 TTL 人工压到 100 秒再 `verify()`：若 `verify` 不续期，
   * TTL 会继续往下走（≤100）；续期过则回到 7 天。这条把「空闲」与「绝对」两种
   * 过期语义区分开——写错了不会报错，只会让活跃用户在满 7 天时被静默踢出。
   */
  it('verify 会续期（空闲过期，而非绝对过期）', async () => {
    const { sessionId } = await svc.create('user-7', { ip: '127.0.0.1', userAgent: 'vitest' });
    await redis.expire(`vca:sess:${sessionId}`, 100);
    await svc.verify(sessionId);
    const ttl = await redis.ttl(`vca:sess:${sessionId}`);
    expect(ttl).toBeGreaterThan(6 * 24 * 3600);
  });

  /**
   * `requireRecentAuth` 对**不存在的会话**与**没有 authAt 的会话**都返回 false（fail-closed）。
   *
   * 这条守的是「敏感操作要求最近 15 分钟内认证过」（C13）。若未知会话返回 true，
   * 那么任何伪造的 sessionId 都能通过「最近认证」检查——正是这个检查要防的事情。
   */
  it('requireRecentAuth 对未知会话 / 缺 authAt 的会话一律 false（fail-closed）', async () => {
    await expect(svc.requireRecentAuth('does-not-exist', 15 * 60_000)).resolves.toBe(false);

    const { sessionId } = await svc.create('user-8', { ip: '127.0.0.1', userAgent: 'vitest' });
    await redis.hdel(`vca:sess:${sessionId}`, 'authAt');
    await expect(svc.requireRecentAuth(sessionId, 15 * 60_000)).resolves.toBe(false);
  });

  /**
   * 会话是**不透明**的：`verify` 只回它自己记下的字段，不回 password/email 之类（C11/C13）。
   *
   * 会话哈希是「谁来都读得到」的存储（任何拿到 Redis 的人），只应放鉴权必需的最小面。
   */
  it('verify 的返回面恰好是 SessionData 的四个字段（不夹带额外身份信息）', async () => {
    const { sessionId } = await svc.create('user-9', { ip: '1.2.3.4', userAgent: 'ua' });
    const s = await svc.verify(sessionId);
    expect(Object.keys(s ?? {}).sort()).toEqual(['authAt', 'ip', 'userAgent', 'userId']);
  });
});
