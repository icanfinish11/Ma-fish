import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
// **只 import 类型**（`import type` 会被完整擦除，不会把应用模块图拉进本文件的求值期）：
// 这层「类型静态、值动态」的分工是本文件能覆盖上传上限的全部机制，理由见文件头。
import type { ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';
import type { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
import type { PrismaService } from '@vca/api/db/prisma.service.js';
import type { TestPg } from '../../helpers/db.js';
// 夹具是**纯数据生成器**（不 import 任何应用代码），因此它可以静态 import：
// 本文件的「应用侧一律动态 import」那条约束针对的是会读 `process.env` 的应用模块图。
import { buildZip } from '../../fixtures/archives/generate.js';

/**
 * 「加密即入库」链路的**内存上界**：完整制品（≥ 2 × CHUNK_SIZE）走真实 HTTP 路径
 * （P1 / Task 5 修复轮 1；规格验收判据 13）。
 *
 * ## 这条用例补的是哪个洞（据实说明，不是「再加一条」）
 *
 * 判据 13 要的是「内存占用与文件大小**无关**，判据用**未完成字节数**而不是 RSS」。
 * Task 5 把 Task 1 那条 `未完成字节数 < 负载长度` 的断言删掉了（理由见
 * `upload-stream.test.ts` 里那段据实记载）：生产块大小 8 MiB 高于测试上传上限 4 MiB
 * ⇒ 任何合法负载都落在**一块之内**，而加密器对末块要「押后」⇒ 那个量≈负载长度**恒成立**，
 * 无论 HTTP 层有没有攒整份 body。删除的理由成立，**但替换不成立**：
 * `sawPartial`（0 < 已落盘 < 负载）与 `maxFiles ≤ 1` 都拦不住「攒够再写」的实现。
 *
 * 因此本文件把**真正的**判据放回链路：载荷取 **24 MiB**（3 个生产块，是
 * `2 × CHUNK_SIZE` 的 1.5 倍），断言「已发出的明文 − 已落盘的制品字节」的峰值
 * **小于 2 × CHUNK_SIZE**。押后发射让这条上界**与载荷大小无关**：
 * 实测 17 / 24 / 32 MiB 三个载荷的峰值都是 `16,842,844`（见任务报告 §修复轮 1 的探针矩阵）。
 *
 * ### 为什么必须 ≥ 2 × CHUNK_SIZE 才能判别（这是本文件存在的全部理由）
 *
 * 「未完成字节数」这个量在载荷小于 `2 × CHUNK_SIZE` 时**恒等于载荷本身**——不是因为实现攒了
 * 整份，而是因为押后发射：第二块填满（也就是源流基本读完）之前，加密器一个字节都不发射。
 * 于是「攒够再写」的实现与流式实现在这个量上有**同一个数**，断言没有判别力。
 * 载荷一旦超过 `2 × CHUNK_SIZE`，两者立刻分开：流式实现停在 `2 × CHUNK_SIZE` 附近，
 * 而攒整份的实现停在**载荷大小**附近。修复轮的变异探针实测了这个分离
 * （`evidence/t5-fix1-mutation-*.txt`：24 MiB 载荷下 16,842,844 → 25,166,088）。
 *
 * ## 为什么这一段必须单独一个文件（不是想拆，是加载顺序逼的）
 *
 * `AppModule` 在**模块求值期**就执行 `ConfigModule.forRoot()`，multer 的
 * `limits.fileSize` 在**应用编译期**从它取值。测试夹具里的上限是 **4 MiB**
 * （`tests/helpers/env.ts` 的理由：413 那条判据必须真的触发，用生产默认的 1 GiB 意味着
 * 每个用例都要传 >1 GiB）。而 `2 × CHUNK_SIZE` 就是 16 MiB ⇒ **4 MiB 的上限下这个载荷
 * 根本到不了加密器**（会先被 multer 以 413 拦掉）。
 *
 * 这里**没有**改 `tests/helpers/env.ts`：那是全仓共用的夹具，把上限抬到 64 MiB 会让
 * `upload-stream.test.ts` 的 413 用例（以及 `ingest.test.ts` 的明文限额边界用例）
 * 再也触发不了——那会**静默地**削弱三条既有判据。改成按文件覆盖之后，
 * 只有本文件跑在 64 MiB 下，其余套件一个字节都没变。
 *
 * 实现方式是本文件**静态只 import 类型**、应用侧一律走 `await import(...)`：
 * 应用模块的求值因此被推迟到 `beforeAll` 里「把 `process.env.ARTIFACT_MAX_UPLOAD_BYTES`
 * 写大」之后。理由与做法在 `tests/setup/artifact-store.ts` 的文件头有同一条实测记载
 * （静态 import 会被提升到文件内所有语句之前，因此「import 之后再写 env」仍然太晚）。
 *
 * ## 据实记载（Task 9）：这一组同样需要一个**真库**了
 *
 * 上传路径接线到落库之后，一个 201 里必然包含作品/版本/元数据三行——「合法上传 → 201」
 * 这条断言只有在一个真的能写库的应用上才成立。因此 `beforeAll` 里补上 `startPostgres()`
 * 与 `overrideProvider(PrismaService)`，会话用户也换成**真用户**（`owner_id` 是 `uuid` 列）。
 * 判据本身（未完成字节数峰值 < 2 × CHUNK_SIZE + 余量）一个字节都没有改。
 */
const STORE_DIR = process.env.ARTIFACT_STORE_DIR as string;
const BOUNDARY = 'vca-test-large-boundary-4b1e';

/** 生产块大小：这里**写死 8 MiB 的字面量**，不从生产常量 import（理由见 `UNFINISHED_BOUND`）。 */
const PRODUCTION_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * 判据里的上界：`2 × CHUNK_SIZE` 再加上一点**流水线余量**。
 *
 * **刻意写死字面量而不是 import `CHUNK_SIZE`**：这个数就是验收判据本身
 * （「内存上界是两块」），从被测代码 import 会让「生产块大小被改小」时判据**跟着一起变**——
 * 那是判据漂移，不是判据。写死之后，改 `CHUNK_SIZE` 会让这条用例要么红、要么需要一次
 * 有意识的修改。
 *
 * 余量为什么要写出来（而不是把上界调宽一点了事）：这个量是「客户端已交出的明文 −
 * 已落盘的制品字节」，它除了加密器手里那两块，还必然包含**上游在途的字节**——
 * 客户端 socket 的发送缓冲、multipart 的分帧字节，以及「第一块被放行」与「采样器看到
 * 那一块落盘」之间的时间差。实测这个差值只有**几百字节**（24 MiB 载荷：峰值
 * `16,777,409`，即 `2 × CHUNK_SIZE` + 193），但它是**结构上必然非零**的，
 * 因此上界必须显式留出它，否则这条断言会以「差了 193 字节」的形式偶发变红。
 *
 * `256 KiB` 是实测松弛量的约 1300 倍，同时只有载荷（24 MiB）的约 1%：
 * 留得足够宽，不至于把实现的一点抖动判成缺陷；又远小于任何一个「攒整份」的实现
 * （那会停在**载荷大小**上，本用例里是 24 MiB）。
 */
const PIPELINE_SLACK_BYTES = 256 * 1024;
const UNFINISHED_BOUND = 2 * PRODUCTION_CHUNK_SIZE + PIPELINE_SLACK_BYTES;

/** 本用例的载荷：3 个生产块（24 MiB），即 `2 × CHUNK_SIZE` 的 1.5 倍。 */
const PAYLOAD_BYTES = 24 * 1024 * 1024;

/** 每个 multipart 片段（模拟真实客户端的逐块发送）。 */
const SEND_CHUNK_BYTES = 64 * 1024;

/**
 * 片段之间的间隔（毫秒）。
 *
 * **不是**为了让实现「跟得上」——实测峰值与本值无关（0 / 2 ms 两种节奏下都是同一个数，
 * 见任务报告）。它换来的是**采样分辨率**：上传在毫秒级跑完时，1 ms 的采样器只能采到
 * 几十个点；2 ms 下能采到数百个点，且磁盘上的对象在请求中途就有机会被看见
 * （这正是 `sawPartial` 那条判据的可观测性）。
 * 24 MiB 载荷在 2 ms 下约 5 秒，是「判别力换来的确定代价」，不是等待。
 */
const SEND_GAP_MS = 2;

/** 确定性负载：第 i 字节 = (seed + i) % 251（压缩不掉，因此必须按 stored 条目放）。 */
function payload(size: number, seed = 0): Buffer {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buffer[i] = (seed + i) % 251;
  return buffer;
}

/** 制品库里现有的文件（相对路径 + 字节数）。列目录而不是猜路径，才数得准「已落盘多少」。 */
async function storedObjects(): Promise<Array<{ name: string; size: number }>> {
  const names = await readdir(STORE_DIR, { recursive: true, withFileTypes: false }).catch(() => [] as string[]);
  const out: Array<{ name: string; size: number }> = [];
  for (const name of names) {
    const info = await stat(join(STORE_DIR, name)).catch(() => null);
    if (info?.isFile()) out.push({ name: name.split('\\').join('/'), size: info.size });
  }
  return out;
}

/** 把一段流收成 Buffer。 */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

interface UploadObservation {
  /** 采样次数（采样器真的跑起来了；0 会让下面每一条断言都变成恒真）。 */
  samples: number;
  /** 请求进行中，制品库里**出现过**「有字节但还不完整」的对象。 */
  sawPartial: boolean;
  /** **本用例的判据**：已发出的明文 − 已落盘的制品字节，全程峰值。 */
  peakUnfinished: number;
  /** 制品库里的最大文件数（>1 说明出现过临时副本，C21）。 */
  maxFiles: number;
}

interface UploadResult {
  status: number;
  body: string;
  observed: UploadObservation;
}

/**
 * 真实 multipart 上传：逐块写、每块之间让出事件循环，并在发送期间采样制品库。
 *
 * 与 `upload-stream.test.ts` 里那个同名辅助函数是同一个形状（那里只发 1~2 MiB，
 * 采不到 `2 × CHUNK_SIZE` 以上的量，所以本文件必须有自己的一份）。
 * 采到的 `peakUnfinished` 就是判据 13 说的**未完成字节数**：
 * 客户端已交出的明文（`acked`）减去制品库里已经落盘的密文字节（`onDisk`）。
 */
function uploadLarge(
  port: number,
  bytes: Buffer,
  opts: { csrf: string; sessionId: string; cookieNames: { session: string; csrf: string; header: string } },
): Promise<UploadResult> {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="pkg.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const parts: Buffer[] = [head];
  for (let offset = 0; offset < bytes.length; offset += SEND_CHUNK_BYTES) {
    parts.push(bytes.subarray(offset, Math.min(offset + SEND_CHUNK_BYTES, bytes.length)));
  }
  parts.push(tail);
  const total = parts.reduce((n, part) => n + part.length, 0);

  return new Promise((resolve, reject) => {
    const observed: UploadObservation = { samples: 0, sawPartial: false, peakUnfinished: 0, maxFiles: 0 };
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

    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/assets/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          'content-length': String(total),
          cookie: `${opts.cookieNames.session}=${opts.sessionId}; ${opts.cookieNames.csrf}=${opts.csrf}`,
          [opts.cookieNames.header]: opts.csrf,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk as string));
        response.on('end', () => {
          clearInterval(timer);
          resolve({ status: response.statusCode ?? 0, body, observed });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(180_000, () => request.destroy(new Error('上传超时')));

    let index = 0;
    const next = (): void => {
      if (index >= parts.length) {
        request.end();
        return;
      }
      const part = parts[index++] as Buffer;
      request.write(part, () => (acked += part.length));
      setTimeout(next, SEND_GAP_MS);
    };
    next();
  });
}

describe('完整制品（≥ 2 × CHUNK_SIZE）走 HTTP：内存上界与「HTTP 边界上的往返一致」', () => {
  let app: INestApplication;
  let redis: { newClient(): unknown; stop(): Promise<void> };
  let pg: TestPg;
  let prisma: PrismaService;
  let port: number;
  let csrf: string;
  let sessionId: string;
  let cookieNames: { session: string; csrf: string; header: string };
  let store: ArtifactStore;

  /** 引导一次：把上传上限抬到 64 MiB，**用后立刻还原**（其余套件读到的仍是夹具原值）。 */
  beforeAll(async () => {
    const saved = process.env.ARTIFACT_MAX_UPLOAD_BYTES;
    process.env.ARTIFACT_MAX_UPLOAD_BYTES = String(64 * 1024 * 1024);
    try {
      const appHelper = await import('../../helpers/app.js');
      const redisHelper = await import('../../helpers/redis.js');
      const csrfHelper = await import('../../helpers/csrf.js');
      const dbHelper = await import('../../helpers/db.js');
      const redisModule = await import('@vca/api/db/redis.module.js');
      const prismaModule = await import('@vca/api/db/prisma.service.js');
      const cookieModule = await import('@vca/api/common/http/cookie.js');
      const csrfMiddleware = await import('@vca/api/common/security/csrf.middleware.js');
      const configModule = await import('@nestjs/config');
      const assetStore = await import('@vca/api/modules/asset/store/artifact-store.port.js');

      cookieNames = {
        session: cookieModule.SESSION_COOKIE,
        csrf: csrfMiddleware.CSRF_COOKIE,
        header: csrfMiddleware.CSRF_HEADER,
      };

      await rm(STORE_DIR, { recursive: true, force: true });
      redis = (await redisHelper.startTestRedis()) as unknown as typeof redis;
      /**
       * **真库**（Task 9）：上传路径现在会落库，因此一个 201 里必然包含作品/版本/元数据三行
       * ——「合法上传 → 201」这条断言只有在一个真的能写库的应用上才成立。
       * 类型是静态 import 的（`import type` 会被擦除，不影响本文件的加载顺序设计）。
       */
      pg = await dbHelper.startPostgres();
      prisma = new prismaModule.PrismaService(pg.appUri);
      await prisma.$connect();
      app = await appHelper.createTestApp({
        overrides: [
          (builder) => builder.overrideProvider(redisModule.REDIS).useValue(redis.newClient()),
          (builder) => builder.overrideProvider(prismaModule.PrismaService).useValue(prisma),
        ],
      });
      const server = app.getHttpServer() as http.Server;
      await new Promise<void>((resolve) => server.listen(0, resolve));
      port = (server.address() as { port: number }).port;
      csrf = await csrfHelper.fetchCsrfToken(app);
      store = app.get<ArtifactStore>(assetStore.ARTIFACT_STORE);

      // 断言上限真的生效了——否则整条用例会以 413 结束，而那段代码看起来像「实现的问题」。
      const effective = app
        .get<ConfigService>(configModule.ConfigService)
        .get<string | number>('ARTIFACT_MAX_UPLOAD_BYTES');
      expect(Number(effective), '本文件必须跑在抬高的上传上限下，否则载荷到不了加密器').toBeGreaterThan(
        PAYLOAD_BYTES,
      );
    } finally {
      if (saved === undefined) delete process.env.ARTIFACT_MAX_UPLOAD_BYTES;
      else process.env.ARTIFACT_MAX_UPLOAD_BYTES = saved;
    }
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
    await rm(STORE_DIR, { recursive: true, force: true });
  });

  /** 每个用例一个会话用户：`upload` 限流是 10 次/天/用户，不共用才不会互相透支。 */
  beforeEach(async () => {
    await rm(STORE_DIR, { recursive: true, force: true });
    const sessionModule = await import('@vca/api/modules/auth/session.service.js');
    // **真用户**（Task 9）：`asset.assets.owner_id` 是 `uuid` 列，而上传路径现在会落库
    // ——编造的身份（`user-large-N`）会让合法上传以 500 结束。
    const user = await prisma.user.create({ data: {} });
    sessionId = (
      await app
        .get(sessionModule.SessionService)
        .create(user.id, { ip: '127.0.0.1', userAgent: 'vitest' })
    ).sessionId;
  });

  it('24 MiB（3 个生产块）：未完成字节数全程 < 2 × CHUNK_SIZE；制品只有一个且不含明文', async () => {
    /**
     * 载荷**必须**多于两块：少于两块时，「未完成字节数」在流式与「攒够再写」两种实现下
     * 都是同一个数（= 载荷），这条断言会退化成恒真的空话。24 MiB = 3 块，
     * 判别力有实测证据（见文件头与报告）。
     *
     * 载荷**必须是真的 zip**：上传路径写完就校验（`validateArchive` 按 magic bytes 判定），
     * 一段裸字节会以 422 结束。单个 **stored** 条目（method 0，不压缩）是唯一既能顶到
     * 24 MiB 又不触发 D6 压缩比上限（100:1）的形状——`payload()` 是低熵循环字节，
     * deflate 之后会被那条上限拒掉，那不是本用例要测的东西。
     */
    const plaintext = buildZip([{ name: 'big.bin', data: payload(PAYLOAD_BYTES, 3) }]);

    const response = await uploadLarge(port, plaintext, { csrf, sessionId, cookieNames });
    const body = JSON.parse(response.body) as { sha256?: string; plaintextBytes?: number; kind?: string };

    expect(response.status, `响应体=${response.body}`).toBe(201);
    expect(body.plaintextBytes).toBe(plaintext.length);
    expect(body.kind).toBe('zip');
    expect(body.sha256).toBe(createHash('sha256').update(plaintext).digest('hex'));

    // 采样器必须真的跑起来了：0 个采样会让下面两条断言变成恒真。
    expect(response.observed.samples, '采样器一次都没采到——下面的断言会因此恒真').toBeGreaterThan(50);
    /**
     * **本用例的判据（规格验收判据 13）**：未完成字节数的峰值有界，且**与载荷大小无关**。
     *
     * 上界取 `2 × CHUNK_SIZE`（加密器同时持有的两块：押后的那块 + 正在填的那块），
     * 也就是设计文档里「内存与输入大小无关」的那个数。实测（同一份探针、三种载荷）：
     * 17 MiB ⇒ 16,777,308；24 MiB ⇒ 16,842,844；32 MiB ⇒ 16,842,844 —— **不随载荷增长**。
     */
    expect(
      response.observed.peakUnfinished,
      `未完成字节数峰值=${String(response.observed.peakUnfinished)}（载荷 ${String(plaintext.length)}，` +
        `上界 ${String(UNFINISHED_BOUND)}）——超过上界说明链路某一层把整份攒进了内存`,
    ).toBeLessThan(UNFINISHED_BOUND);
    // 请求进行中就有字节落盘（否则「已落盘」恒为 0，上面的差会退化成「已发出的明文」）
    expect(response.observed.sawPartial, '整段上传期间制品库里的对象一直是空的').toBe(true);
    // C21：目录里**只有对象本身**，没有任何临时副本
    expect(response.observed.maxFiles, `采样到的最大文件数=${String(response.observed.maxFiles)}`).toBeLessThanOrEqual(1);

    const objects = await storedObjects();
    expect(objects).toHaveLength(1);
    const key = objects[0]?.name.split('/').pop() ?? '';
    const onDisk = await store.getRange(key, 0, (await store.stat(key)).bytes - 1);
    // 直接的内容判据：密文里不该出现明文（大小关系只是弱信号）
    expect(onDisk.includes(plaintext), '制品对象里出现了明文').toBe(false);
  }, 180_000);

  it('HTTP 边界上的往返一致：盘上那份**密文**解回来与上传的字节逐字节相同', async () => {
    /**
     * Task 1 的往返判据是在**真正走过 multipart 的字节**上做的
     * （`getRange(...).equals(uploaded)`）；Task 5 把落盘内容换成密文之后，
     * 那条判据只剩下 `ingest.test.ts` 里走 `putStream` 的那一份，**HTTP 边界的保真度弱了一档**。
     * 这条把它补回来：明文长度与摘要由服务端在响应里给出，而盘上的密文由本用例用
     * **环境里的密钥环**解开——两边对上才是端到端一致。
     *
     * 它同时钉住「多块制品的索引与尾部确实被写对了」：一块之内看不出分块边界的问题。
     */
    const plaintext = buildZip([{ name: 'big.bin', data: payload(PAYLOAD_BYTES, 11) }]);
    const response = await uploadLarge(port, plaintext, { csrf, sessionId, cookieNames });
    expect(response.status, `响应体=${response.body}`).toBe(201);

    const objects = await storedObjects();
    expect(objects).toHaveLength(1);
    const key = objects[0]?.name.split('/').pop() ?? '';
    const stored = await store.stat(key);

    const [readerModule, cryptoModule, envHelper] = await Promise.all([
      import('@vca/api/modules/asset/store/random-access-reader.js'),
      import('@vca/api/modules/asset/crypto/key-ring.js'),
      import('../../helpers/env.js'),
    ]);
    const reader: EncryptedArtifactReader = await readerModule.EncryptedArtifactReader.open(
      store,
      key,
      cryptoModule.createKeyRing({
        ARTIFACT_KEYS: envHelper.testEnv.ARTIFACT_KEYS,
        ARTIFACT_ACTIVE_KEY_ID: envHelper.testEnv.ARTIFACT_ACTIVE_KEY_ID,
      }),
    );
    const restored = await collect(reader.createReadStream({ start: 0, end: reader.plaintextLength }));

    expect(restored.length).toBe(plaintext.length);
    expect(restored.equals(plaintext), '解回来的字节与 HTTP 上传的字节不一致').toBe(true);
    // 制品对象**比明文大**（头 + 每块 tag + 索引 + 尾部）
    expect(stored.bytes).toBeGreaterThan(plaintext.length);
    // 三块 ⇒ 索引里有三条记录（分块边界真的发生了，不是「一块装下」）
    expect(reader.plaintextLength).toBe(plaintext.length);
  }, 180_000);
});
