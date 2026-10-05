import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../../helpers/app.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { testEnv } from '../../helpers/env.js';
import { buildZip } from '../../fixtures/archives/generate.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';

/**
 * 上传接入的端到端契约（P1 / Task 1）。
 *
 * ## 这一组跑的是**真实**请求流
 *
 * `createTestApp()` 起的是生产 `AppModule`（真中间件栈、真全局守卫链：限流 → CSRF → 授权），
 * Redis 用 testcontainer（限流桶与会话都是真语义）。请求用 **Node 的 http 客户端**逐块发出，
 * 而不是 supertest 的 `.attach()`：后者会把整份 body 一次写完，于是「制品在请求还没结束时
 * 就已经在落盘」这条断言采不到任何中间态——那是本任务唯一能证明「HTTP 层真的在流式转发」
 * 的证据（探针实测：自定义 storage engine 在客户端发到 44ms 时就收到了第一块）。
 *
 * ## 断言的分工（避免「用状态码证明一切」）
 *
 * - **字节**：库里对象的字节数与内容必须和上传的完全相同（`getRange` 逐字节比对）；
 * - **流式**：请求进行中，对象已在盘上且大小在增长，同时目录里**只有对象本身**（无临时副本，C21）；
 * - **上限**：超限 ⇒ 413，且制品库里**一个残留都没有**（验收判据）；
 * - **身份**：未认证 ⇒ 403 且一个字节都没写（这条钉住「上传不是 @Public()」）。
 *
 * ## 据实记载（Task 9）：这一组需要一个**真库**了
 *
 * 本文件此前只起 Redis：上传路径当时**不落库**（`persistIngested` 还没有生产调用方），
 * 因此 `PrismaService` 那一份指向「形状合法但不存在的库」的夹具连接串从未被真的用到
 * （它惰性建连，`$connect()` 不碰数据库——见 `prisma.service.ts`）。
 * 接线之后，一个 201 里**必然**包含作品/版本/元数据三行，于是「上传成功」这个断言
 * 只有在一个真的能写库的应用上才成立。这里因此补上 `startPostgres()` 与
 * `overrideProvider(PrismaService)`，并把会话用户换成**真用户**（`owner_id` 是 `uuid` 列）。
 * 这不是「给流式用例加依赖」，而是它的断言（201 + 盘上一个对象）在接线之后**蕴含**了落库。
 */
/**
 * 本套件的制品目录：由 `tests/setup/artifact-store.ts`（Vitest 的 `setupFiles`）按 worker 定下。
 *
 * 读 `process.env` 而不是自己拼一个路径：应用读的也是这个变量，两者必须是**同一个值**
 * （一个进程只有一份）。为什么它不能在本文件里推导、也不能写在夹具里：
 * 应用的配置在**模块求值期**解析，而本文件的 import 提升会让文件内任何语句都晚于那次求值
 * ——实测两轮（`evidence/t1-fix1-diag2.txt`、`t1-fix1-diag3.txt`），三条用例都变红。
 *
 * 每个 worker 一个目录的理由：本文件在 `beforeAll`/`beforeEach` 里 `rm -rf` 这个目录，
 * 固定的共享路径会让两个并发文件互相删掉对方正在用的对象，失败形态是
 * 「上传成功但读回是空」——看不出原因。
 */
const STORE_DIR = process.env.ARTIFACT_STORE_DIR as string;
const MAX_UPLOAD_BYTES = Number(testEnv.ARTIFACT_MAX_UPLOAD_BYTES);
const BOUNDARY = 'vca-test-boundary-2f9c';

/** 确定性负载：第 i 字节 = (seed + i) % 251（便于逐字节比对，且压缩不掉内容差异）。 */
function payload(size: number, seed = 0): Buffer {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buffer[i] = (seed + i) % 251;
  return buffer;
}

/** 把负载切成若干块（模拟真实客户端的逐块发送）。 */
function chunked(buffer: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}

/** 轮询直到条件成立（用于「异步清理最终会完成」这一类判据）。 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** 库里现有的对象（相对路径 + 字节数）。用递归列目录而不是猜路径，才看得见「临时副本」。 */
async function storedObjects(): Promise<Array<{ name: string; size: number }>> {
  const names = await readdir(STORE_DIR, { recursive: true, withFileTypes: false }).catch(() => [] as string[]);
  const out: Array<{ name: string; size: number }> = [];
  for (const name of names) {
    const info = await stat(join(STORE_DIR, name)).catch(() => null);
    if (info?.isFile()) out.push({ name: name.split('\\').join('/'), size: info.size });
  }
  return out;
}

interface UploadResult {
  status: number;
  body: string;
  /**
   * 请求过程中采到的：最大文件数、采样次数、是否见过「写到一半」的对象、未完成字节数峰值。
   *
   * `peakUnfinished` 在本文件里**没有断言**（理由见下面 `upload()` 的注释与那条用例里的整段记载）。
   */
  observed: { maxFiles: number; samples: number; sawPartial: boolean; peakUnfinished: number };
}
/**
 * 真实 multipart 上传：逐块写、每块之间让出事件循环，并在发送期间采样制品库。
 *
 * 采样得到的两件事对上前两条判据：`sawPartial`（请求还没结束对象已在盘上）、
 * `maxFiles`（无临时副本，C21）。
 *
 * **`peakUnfinished` 仍然采着，但本文件里没有任何断言用它的值**（修复轮 1 的据实记载）：
 * 本文件的上传上限是 4 MiB、生产块大小是 8 MiB ⇒ 每个合法负载都落在**一块之内**，
 * 而加密器对末块要「押后」⇒ 这个量≈负载长度的形态**恒成立**，
 * 无论 HTTP 层有没有攒整份 body（详见下面那条用例里的整段记载）。
 * 判据 13 的**端到端**见证因此搬到了 `ingest-memory.test.ts`：那里用 24 MiB 的载荷
 * （= 3 个生产块）走真实 HTTP 路径，断言它 `< 2 × CHUNK_SIZE`——只有超过两块，
 * 这个量才能把流式实现与「攒够再写」的实现分开。
 */
function upload(
  port: number,
  bytes: Buffer,
  opts: { csrf?: string; sessionId?: string; gapMs?: number },
): Promise<UploadResult> {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="pkg.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const parts = [head, ...chunked(bytes, 64 * 1024), tail];
  const total = parts.reduce((n, part) => n + part.length, 0);

  // 会话与 CSRF 令牌**各自独立**地进 cookie：匿名用例要能带上合法 CSRF 令牌
  // （否则它的 403 可能只是 CSRF 拦的，断言就测不到策略判定，见该用例的说明）。
  const cookies = [
    ...(opts.sessionId ? [`${SESSION_COOKIE}=${opts.sessionId}`] : []),
    ...(opts.csrf ? [`${CSRF_COOKIE}=${opts.csrf}`] : []),
  ];

  return new Promise((resolve, reject) => {
    const observed = { maxFiles: 0, samples: 0, sawPartial: false, peakUnfinished: 0 };
    let acked = 0;
    const timer = setInterval(() => {
      void storedObjects()
        .then((files) => {
          observed.samples += 1;
          observed.maxFiles = Math.max(observed.maxFiles, files.length);
          const onDisk = files.reduce((n, f) => n + f.size, 0);
          if (onDisk > 0 && onDisk < bytes.length) observed.sawPartial = true;
          observed.peakUnfinished = Math.max(observed.peakUnfinished, acked - onDisk);
        })
        .catch(() => undefined);
    }, 1);

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/assets/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          'content-length': String(total),
          ...(cookies.length > 0 ? { cookie: cookies.join('; ') } : {}),
          ...(opts.csrf ? { [CSRF_HEADER]: opts.csrf } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          clearInterval(timer);
          resolve({ status: res.statusCode ?? 0, body, observed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('上传超时')));

    let index = 0;
    const next = (): void => {
      if (index >= parts.length) {
        req.end();
        return;
      }
      const part = parts[index++]!;
      req.write(part, () => (acked += part.length));
      if (opts.gapMs && opts.gapMs > 0) setTimeout(next, opts.gapMs);
      else setImmediate(next);
    };
    next();
  });
}

describe('上传接入与制品存储（Task 1）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let port: number;
  let sessionId: string;
  let csrf: string;

  beforeAll(async () => {
    await rm(STORE_DIR, { recursive: true, force: true });
    redis = await startTestRedis();
    // 真库（理由见文件头「据实记载（Task 9）」那段）：接线之后 201 蕴含三行落库。
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
      ],
    });
    const server = app.getHttpServer() as http.Server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;

    csrf = await fetchCsrfToken(app);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
    // 只删**本 worker 自己的**目录（每 worker 一个，见文件头）。不再动 `process.env`：
    // 那个值由 `tests/setup/artifact-store.ts` 定下，本进程内所有用例共用同一个目录，
    // 因此这里没有「改了全局输入要还原」的账——它本来就是这个 worker 的配置。
    await rm(STORE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 每个用例从空库开始：「无残留」这类断言需要一个已知的起点。
    await rm(STORE_DIR, { recursive: true, force: true });

    // **每个用例一个用户**，而不是共用 `beforeAll` 里那一个（修复轮 1 / Fix 6）。
    //
    // `upload` 层是 **10 次 / 24 小时 / 用户**（`RATE_LIMITS.upload`，按当事人分桶），
    // 而本文件光已认证请求就有 8 次（本用例 1 + 流式 1 + 超限 1 + 重试 2 + 缺字段 1…）。
    // 共用一个用户时余量只剩 2 次：**下一个上传用例会以 429 红**，而那个失败看起来像产品缺陷
    // （状态码断言直接指向限流，没人会想到是夹具的账已透支）。
    // 每用例一个用户让「本用例用掉了几次配额」变成局部可算的量——余量永远是 10 减去本用例的次数。
    //
    // **Task 9 起这个用户必须是真的**（`asset.assets.owner_id` 是 `uuid` 列，而上传路径
    // 现在会落库）：`user-uploader-N` 这样的编造身份会让合法上传以 500 结束。
    const user = await prisma.user.create({ data: {} });
    sessionId = (
      await app.get(SessionService).create(user.id, { ip: '127.0.0.1', userAgent: 'vitest' })
    ).sessionId;
  });

  it('上传成功：明文加密后入库（密文对象），返回作品与版本的标识', async () => {
    // **Task 5 起这个负载必须是真的归档**：上传路径现在会在写完之后立刻校验内容
    // （加密即入库，D1），随便一段字节会在 `validateArchive` 那里以 422 结束。
    const body = buildZip([
      { name: 'README.md', data: Buffer.from('# 加密即入库\n') },
      // **stored（method 0）**而不是 deflate：`payload()` 是低熵的循环字节，deflate 后约 194:1，
      // 会被 D6 的**压缩比上限（100:1）**拒掉——那是校验器在正常工作，不是这条用例要测的东西。
      { name: 'src/index.ts', data: payload(256 * 1024, 7) },
    ]);

    const res = await upload(port, body, { csrf, sessionId });
    const parsed = JSON.parse(res.body) as {
      assetId: string;
      assetVersionId: string;
      sha256: string;
      plaintextBytes: number;
      kind: string;
    };

    expect(res.status, `响应体=${res.body}`).toBe(201);
    // 响应是「这次上传诞生的作品与版本」（Task 1 的 {key, bytes} 临时形态 → Task 5 的三个字段
    // → Task 9 起再加上两个 id，理由见控制器的 `IngestResponse`）。
    expect(parsed.plaintextBytes).toBe(body.length);
    expect(parsed.kind).toBe('zip');
    expect(parsed.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(parsed.assetVersionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // 两个 id 指向**库里真的存在**的行（一个 201 现在蕴含三行落库）
    const version = await prisma.assetVersion.findUniqueOrThrow({ where: { id: parsed.assetVersionId } });
    expect(version.assetId).toBe(parsed.assetId);
    expect(version.plaintextBytes).toBe(body.length);

    const objects = await storedObjects();
    expect(objects).toHaveLength(1);
    // 落盘的是**密文**：对象字节数比明文多（头 + 每块 tag + 索引 + 尾部）。
    // 旧版这条断言是 `size === body.length` 且逐字节相等——「加密即入库」之后它恒不成立，
    // 判据因此换成「比明文大且解回来一致」（往返一致的那一半在 `ingest.test.ts` 里，
    // 那里有真实密钥环与解密读取器）。
    expect(objects[0]?.size).toBeGreaterThan(body.length);
  });

  it('请求进行中对象已在落盘（真流式），且目录里始终只有对象本身（无临时副本）', async () => {
    // 2 MiB 的**合法 zip**（一个 stored 条目，未压缩）：内容必须真的是归档，
    // 否则这条用例会在校验那一步以 422 结束，测不到流式行为。
    const body = buildZip([{ name: 'big.bin', data: payload(2 * 1024 * 1024, 11) }]);

    const res = await upload(port, body, { csrf, sessionId, gapMs: 2 });

    expect(res.status, `响应体=${res.body}`).toBe(201);
    expect(
      res.observed.samples,
      '采样器几乎没采到东西——「请求进行中对象已在盘上」这条断言会因此恒真',
    ).toBeGreaterThan(10);
    expect(
      res.observed.sawPartial,
      '整个上传期间都没见过「写到一半」的对象——这是「先把整份攒起来再落盘」的形态',
    ).toBe(true);
    expect(res.observed.maxFiles, `采样到的最大文件数=${res.observed.maxFiles}（>1 说明出现过临时副本）`).toBeLessThanOrEqual(1);
    /**
     * **据实记载：Task 1 那条「未完成字节数有界」的断言在这里失去了判别力，已删掉。**
     *
     * 原来的口径是「已发出的明文 − 已落盘的字节」< 负载长度，它挡的是
     * 「HTTP 层把整份 body 攒起来、最后才落盘」。加密即入库（Task 5）之后这个口径不再成立：
     * 生产块大小是 **8 MiB**，而这台测试的上传上限只有 4 MiB ⇒ 任何合法负载都落在**一块之内**，
     * 而加密器对末块要「押后」（末块标记只有流结束才知道，Task 2）⇒ 整段密文在源流结束前
     * 根本不会出现在盘上，盘上先有的只有制品头（测量时 33 字节 = `31 + keyId(2)`；
     * I3 之后同一份头是 **37** 字节 = `35 + 2`，见 `artifact-format.ts` 的 `HEADER_FIXED_BYTES`），
     * 也就是上面 `sawPartial` 看到的那个）。
     * 于是这个量≈负载长度**恒成立**（实测峰值 2,097,355 = 负载 2,097,264 + multipart 框架字节），
     * 无论 HTTP 层有没有攒整份 body。
     *
     * 真正的内存上界（与输入大小无关，恒为 `2 × CHUNK_SIZE + 一个源块`）在
     * `tests/unit/asset/chunk-cipher.test.ts` 上用 16/64/128 MiB 的**未完成字节数**量过
     * （Task 2，`evidence/t2-probe-crypto-8mib.txt`）；本文件能证明的是另外两件事：
     * 请求还没结束对象就已经在盘上（`sawPartial`），以及目录里**始终只有对象本身**（C21：无临时副本）。
     *
     * ---
     *
     * **修复轮 1 的补充（据实记载）：上面这段「删除」在判据 13 这一侧留下了一个洞。**
     *
     * 本文件**留下的**两条判据都拦不住「攒够再写」的实现：`sawPartial` 只要求
     * `0 < 已落盘 < 负载`（整份攒在内存里、最后一口气写下去**同样满足**），
     * 而 `maxFiles ≤ 1` 只排除临时副本。上面「本文件能证明的是另外两件事」这句话因此
     * 需要收窄：**它证明的其实是「请求还没结束时磁盘上已经有那个对象」，不是「边收边写」。**
     * （实测：对象落盘的第一批字节就是**制品头**——测量时 33 字节，I3 之后 37 字节。）
     *
     * 判据 13（内存上界与文件大小无关，用未完成字节数而不是 RSS）的**端到端**见证因此
     * 放到了 `tests/integration/asset/ingest-memory.test.ts`：那里把上传上限按文件抬到 64 MiB
     * （本文件的 4 MiB 上限下，16 MiB 以上的载荷会被 multer 以 413 先拦掉），
     * 用 **24 MiB（3 个生产块）的合法 zip 走真实 HTTP 路径**，断言
     * 「已发出的明文 − 已落盘的制品字节」的峰值 `< 2 × CHUNK_SIZE + 256 KiB`。
     * 只有载荷超过 `2 × CHUNK_SIZE` 时这个量才有判别力——两条变异探针实测：
     * 上游攒整份 ⇒ `25,166,033`，下游攒整份 ⇒ `25,166,102`（上界 `17,039,360`），两条都变红。
     */
  });

  it('超过硬上限：413，且制品库里没有任何残留对象', async () => {
    const body = payload(MAX_UPLOAD_BYTES + 1024 * 1024, 13);

    const res = await upload(port, body, { csrf, sessionId });
    const parsed = JSON.parse(res.body) as { statusCode?: number; message?: string };

    expect(res.status).toBe(413);
    expect(parsed.statusCode).toBe(413);
    /**
     * **判据是「最终零残留」，不是「响应那一刻恰好为零」**——据实记载（Task 5 实测到的一次
     * 满负载下的偶发失败）：存储端的「中止即删除」是**异步**的，而 multer 在超限那一刻就把
     * 413 回了，它**不等待**存储引擎（`asset.module.ts` 记过同一条：中止时存储层交回的
     * HttpException 会被忽略，因为 multer 已经先返回了）。于是紧随响应之后的列目录可能看到
     * 那个**刚被 open 创建、还没来得及删**的空对象——它不是残留，只是还没删完。
     * 这里等它删完（上限 5 秒）；真出现残留时下面这条断言照样红。
     */
    const cleared = await waitFor(async () => (await storedObjects()).length === 0);
    expect(cleared, `制品库里仍有残留：${JSON.stringify(await storedObjects())}`).toBe(true);
  });

  it('超限中止之后，同一连接池里的下一次上传仍然正常（中止没把解析器写坏）', async () => {
    const tooBig = payload(MAX_UPLOAD_BYTES + 512 * 1024, 17);
    const oversize = await upload(port, tooBig, { csrf, sessionId });
    expect(oversize.status).toBe(413);
    // 等上一条被中止的写入清完，下面那条「恰好一个对象」才是确定性的（理由同上一条用例）
    await waitFor(async () => (await storedObjects()).length === 0);

    // 合法 zip（理由同「上传成功」那条：上传路径现在会校验内容）
    const body = buildZip([{ name: 'ok.txt', data: payload(128 * 1024, 19) }]);
    const res = await upload(port, body, { csrf, sessionId });

    expect(res.status, `响应体=${res.body}`).toBe(201);
    const objects = await storedObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0]?.size).toBeGreaterThan(body.length);
  });

  it('缺少文件字段：400，且不落地任何字节', async () => {
    const res = await request(app.getHttpServer())
      .post('/assets/upload')
      .set('Cookie', `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .field('note', '没有附件');

    expect(res.status).toBe(400);
    await expect(storedObjects()).resolves.toEqual([]);
  });

  it('字段过多：400（不靠 fileSize 兜底），且不落地任何字节', async () => {
    /**
     * 这条钉住 `asset.module.ts` 的 `limits.fields`（修复轮 1 / Fix 4）。
     *
     * **据实记载（M1：上一版这条断言不可能失败）**：上一版发 **24 个字段且不带文件**，
     * 于是「把 `fields: 16` 删掉」时 multer 的 `parts: 17`（第 18 个部分）照样给出 400——
     * 断言只钉状态码，因此它对 `fields` 的存亡**完全无感**。一个不可能失败的见证
     * 比没有见证更糟：它让「这条控制还有看守者」这句话变成假的。
     *
     * 现在的形状：发 **17 个字段 + 一个合法 zip**，并断言响应**点名了字段数上限**。
     * `fields: 16` 在时，第 17 个字段（部分 17）触发 `LIMIT_FIELD_COUNT` ⇒ `Too many fields`；
     * 把它删掉，同一份请求会继续读到后面那个文件（部分 18）而落到 `LIMIT_PART_COUNT`
     * ⇒ `Too many parts`——**消息不同**，因此这条断言会红。
     * （两者都是 400，所以只钉状态码是不够的：这正是本条用例的全部意义。）
     */
    const big = request(app.getHttpServer())
      .post('/assets/upload')
      .set('Cookie', `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf);
    for (let i = 0; i < 17; i++) void big.field(`f${i}`, 'x'.repeat(32));
    // 合法 zip：否则这个 400 可能有第三个来源（内容校验）。它排在字段之后 ⇒ 字段数上限先到。
    void big.attach('file', buildZip([{ name: 'ok.txt', data: payload(1024, 29) }]), 'pkg.zip');

    const res = await big;

    // 400 而不是 413：`LIMIT_FIELD_COUNT` 是**请求形状**错误，413 只属于 `fileSize`。
    expect(res.status, `响应体=${res.body}`).toBe(400);
    const raw = typeof res.text === 'string' && res.text !== '' ? res.text : JSON.stringify(res.body);
    expect(
      raw,
      `这条 400 不是字段数上限给出的（去掉 limits.fields 就会变成 LIMIT_PART_COUNT）：${raw}`,
    ).toContain('Too many fields');
    await expect(storedObjects()).resolves.toEqual([]);
  });

  it('未认证：403，且一个字节都没写（上传不是 @Public()）', async () => {
    const body = payload(64 * 1024, 23);

    // **必须带上合法 CSRF 令牌**，否则这个 403 有两个可能的来源（CsrfGuard 或 PolicyGuard），
    // 断言就没有判别力。变异探针 IMP5 实测过：把路由改成 `@Public()` 之后，
    // 不带令牌的版本照旧 403（这次是 CSRF 拦的），用例全绿——一个恒真的断言。
    // 带上令牌之后，唯一还能拒绝它的就是「要求登录」这条策略声明。
    const res = await upload(port, body, { csrf, sessionId: undefined });

    expect(res.status, `响应体=${res.body}`).toBe(403);
    const parsed = JSON.parse(res.body) as { message?: string };
    expect(parsed.message, '拒绝理由必须来自策略判定（需要登录）').toBe('需要登录');
    await expect(storedObjects()).resolves.toEqual([]);
  });
});

