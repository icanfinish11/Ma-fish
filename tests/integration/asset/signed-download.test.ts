import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';
import { AssetService } from '@vca/api/modules/asset/asset.service.js';
import { AssetVersionService } from '@vca/api/modules/asset/asset-version.service.js';
import { OwnershipService } from '@vca/api/modules/asset/ownership.service.js';
import { createKeyRing, type KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import { FOOTER_BYTES, decodeFooter, decodeHeader } from '@vca/api/modules/asset/crypto/artifact-format.js';
import { parseMetadata } from '@vca/api/modules/asset/metadata/parse-metadata.js';
import { ARTIFACT_STORE, type ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
import {
  DOWNLOAD_TTL_SECONDS,
  buildDownloadPath,
  createNonce,
  signTicket,
} from '@vca/api/modules/asset/download/signed-url.js';
import { NONCE_KEY_PREFIX, consumeNonce } from '@vca/api/modules/asset/download/nonce-store.js';
import { createTestApp } from '../../helpers/app.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';
import { ARCHIVE_SAMPLES, buildZip } from '../../fixtures/archives/generate.js';
import { MemoryStore, pattern, seedArtifact } from '../../helpers/craft-encrypted-artifact.js';

/**
 * 签名下载（P1 / Task 8；规格 D10 + D11，验收判据 8 / 9）。
 *
 * ## 这个文件问的六件事
 *
 * 1. **签发要有授权**——属主拿到 ≤300 秒的链接，非属主 403，**两种结果都写审计**（判据 9）；
 * 2. **单次使用**——真 Redis 上的 `SET NX`：第一次成，第二次拒（重放），并发只有一个赢；
 * 3. **超时与篡改各自被拒**——判据 8 点名的三种情况（超时 / 篡改 / 重复使用）分开断言；
 * 4. **下载路径的带外长度核对**（Task 5 与 Task 7 两次移交的**强制义务**）——
 *    盘上的制品被换成一份**更短、完全自洽**的制品时必须 422 且**零字节**，
 *    而正面对照（把长度也改对）必须 200。没有后面那半句，前面那句可能只是
 *    「任何被换过的制品都会被拒」，而不是「这条核对真的在承重」；
 * 5. **每个请求一个新读取器**——替换制品之后第二次下载必须给出**新的**字节
 *    （跨请求复用读取器会继续按旧几何解密，静默返回错的内容）；
 * 6. **限流归属真的接上了**（P0 的机制，不是新写的计数器）。
 *
 * ## 为什么必须真库 + 真 Redis
 *
 * 单次使用是 Redis 的原子语义（`SET NX`）、审计是 append-only 的真表、授权读的是真的
 * 归属指针（还包含一次**真的转让**）。替身能证明的只有「我的假对象说了算」。
 *
 * ## 这个文件里的「换制品」是怎么做的
 *
 * 包一层**真实存储**：只拦截某一个键的 `stat`/`getRange`，其余一切（加密、解密、
 * 校验、审计、限流、HTTP）都是真的。这是 Task 5 用过的同一种注入方式（那里是
 * 上传路径，这里是下载路径），因此「盘上的制品被改动」这件事在两个方向上被同一种
 * 判据覆盖。
 */

const MAX_UPLOAD_BYTES = Number(testEnv.ARTIFACT_MAX_UPLOAD_BYTES);

/**
 * 手工签一张**超过** TTL 上界的票时，超出多少秒。
 *
 * 判据是 `expiresAt - now_at_validation > 300`，而 `now_at_validation` 是**服务端读到的那一刻**：
 * 它总是不早于测试这一侧落笔的那一刻。因此一张 `now + 301` 的票只在「这条请求没跨过秒边界」
 * 时才仍然超界——**旧写法就是 +1 秒**，实测（对同一条件注入 1.1 秒延迟）那张票会变成一张
 * *合法*的票并回 200，判据以约 0.5% 的概率红（全量负载下 600 次里 3 次，见报告）。
 *
 * 60 秒比一次请求的往返（全量负载下实测 p99 = 64 ms、最大 77 ms）大两个数量级，因此这条判据
 * 只关于「校验侧有没有那道检查」，不再关于「请求有多快」——判别力有实测：把校验侧那道上界检查
 * 删掉之后，这条判据仍然红（`expected 200 to be 403`）。**±1 秒的边界没有被丢掉**：
 * 它住在 `tests/unit/asset/signed-url.test.ts`（`NOW + 301 ⇒ ttl_too_long`、`NOW + 300 ⇒ ok`，
 * `now` 由调用方传入）——那才是能确定性地钉住边界的地方；HTTP 这一层钉的是接线之后它仍然成立。
 */
const TTL_OVERSHOOT_SECONDS = 60;

/** 样本字节（八样本表里那两个合法归档）。 */
function sampleBytes(name: 'ok.zip' | 'ok.tar.gz'): Buffer {
  const sample = ARCHIVE_SAMPLES.find((item) => item.name === name);
  if (sample === undefined) throw new Error(`样本表里没有 ${name}`);
  return sample.bytes();
}

/** 环境夹具里的密钥环（与应用的 `KEY_RING` 提供者用的是同一份输入）。 */
function ringFromEnv(): KeyRing {
  return createKeyRing({
    ARTIFACT_KEYS: testEnv.ARTIFACT_KEYS,
    ARTIFACT_ACTIVE_KEY_ID: testEnv.ARTIFACT_ACTIVE_KEY_ID,
  });
}

/**
 * 「把盘上某个对象换成另一份字节」的存储包装。
 *
 * 区间检查与 `MemoryStore` 同款（越界**抛错**而不是回一个短缓冲）：静默的短读会把
 * 一次替换读成一段合法数据，而本用例要观察的正是「替换之后会发生什么」。
 */
class SwappingStore implements ArtifactStore {
  /** 现在替换哪一个键（`null` = 不替换）。用例在发请求之前设置它。 */
  substitute: { key: string; bytes: Buffer } | null = null;

  constructor(private readonly inner: ArtifactStore) {}

  putStream(source: Readable, opts: { maxBytes: number }): Promise<{ key: string; bytes: number }> {
    return this.inner.putStream(source, opts);
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    const sub = this.substitute;
    if (sub !== null && sub.key === key) {
      if (start < 0 || endInclusive < start || endInclusive >= sub.bytes.length) {
        throw new Error(`替换制品的区间越界：[${start}, ${endInclusive}]，它只有 ${sub.bytes.length} 字节`);
      }
      return Buffer.from(sub.bytes.subarray(start, endInclusive + 1));
    }
    return this.inner.getRange(key, start, endInclusive);
  }

  async stat(key: string): Promise<{ bytes: number }> {
    const sub = this.substitute;
    if (sub !== null && sub.key === key) return { bytes: sub.bytes.length };
    return this.inner.stat(key);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

/**
 * 响应体的**原始字节**（两种取法都要支持）。
 *
 * 有的请求用默认解析（JSON 进了 `res.body`、原文进 `res.text`），有的用自定义解析
 * （`res.body` 就是 Buffer）。判据落在字节上时不能靠 `res.text`——它在自定义解析下
 * 是 `undefined`，而 `undefined ?? ''` 会让「零字节」这条断言**恒真**
 * （一条在两种取法之间摇摆的判据比没有判据更糟，因此这里显式分开）。
 */
function responseBytes(res: request.Response): Buffer {
  const body: unknown = res.body;
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(typeof res.text === 'string' ? res.text : '', 'utf8');
}

/**
 * 判据：响应体里**一个制品的字节都没有**（被拒时不许流出半个文件）。
 *
 * ## M6：这条判据的**实际射程**（据实记载，别按名字读）
 *
 * 名字承诺的是「内容级别的缺席」，而**内容判据只能比原始字节**。这里做的是与
 * `ingest-memory.test.ts` 同款的那一条：`body.includes(plaintext)` **整份明文**都比一次
 * （取到的样本都不大，代价可以忽略），另加中段与尾段的窗口——只查前缀会漏掉
 * 「从中间开始的一次泄漏」。
 *
 * **它挡不住什么（实测，见报告 M6 的两个探针）**：错误响应体是 `JSON.stringify` 出来的，
 * 明文里那些控制字节与高位字节会变成 `\u00XX` 这样的**转义序列**，于是原始字节判据对
 * 「经 JSON 转义后的、且很短的一次泄漏」是**瞎的**（探针：把 64 字节明文塞进 422 的
 * `reason` 里，本函数三条内容判据与 1 KiB 的形状判据**全部通过**）。
 * 它**能**抓住的是「明文里有足够长的可打印 ASCII 段、且泄漏覆盖了判据窗口」那种形态
 * （探针：同一处泄漏、明文换成 ASCII ⇒ 中段窗口判据立刻变红）。
 * 因此这条路径上「无制品字节」真正承重的还有另外两条：**响应必须是 JSON**
 * （`errorBody()` 在调用方还会 `JSON.parse`）与**响应体很小**（`< 1024`，成规模的泄漏会被它拦下）。
 * 这一条如实写着，免得下一个读者以为内容判据已经覆盖了全部形态。
 */
function expectNoArtifactBytes(res: request.Response, plaintext: Buffer): void {
  expect(res.headers['content-type'] ?? '', `被拒的响应不是 JSON：${res.headers['content-type']}`).toContain('json');
  const body = responseBytes(res);
  // 内容判据（M6）：整份明文 + 中段窗口 + 尾段窗口——三种形态都不许出现在响应体里。
  expect(body.includes(plaintext), '响应体里出现了整份制品明文').toBe(false);
  const middle = Math.floor(plaintext.length / 2);
  expect(body.includes(plaintext.subarray(middle, middle + 32)), '响应体里出现了明文中段的片段').toBe(false);
  expect(body.includes(plaintext.subarray(Math.max(0, plaintext.length - 32))), '响应体里出现了明文尾段的片段').toBe(false);
  // 形状判据（**不是**内容判据）：制品的最小可能形态也远大于 1 KiB 的错误体，
  // 因此它是「没有把文件当错误体发出去」的那道界。放在内容判据之后，失败时不会掩盖原因。
  expect(body.length, `错误响应体里带了 ${body.length} 字节`).toBeLessThan(1024);
  expect(res.headers['content-disposition']).toBeUndefined();
}

describe('签名下载（D10）：授权、单次使用、超时、篡改、审计', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let store: SwappingStore;
  let assets: AssetService;
  let versions: AssetVersionService;
  let ownership: OwnershipService;
  let sessions: SessionService;
  let csrf: string;

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    store = new SwappingStore(new LocalArtifactStore(process.env.ARTIFACT_STORE_DIR as string));
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
        (builder) => builder.overrideProvider(ARTIFACT_STORE).useValue(store),
      ],
    });
    store = store;
    assets = app.get(AssetService);
    versions = app.get(AssetVersionService);
    ownership = app.get(OwnershipService);
    sessions = app.get(SessionService);
    csrf = await fetchCsrfToken(app);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
  });

  /** 造一个真实用户（审计的 `actor_id` 是 uuid 列，因此**必须**是真的用户 id）。 */
  async function createUser(role: 'USER' | 'ADMIN' = 'USER'): Promise<string> {
    const user = await prisma.user.create({ data: { role } });
    return user.id;
  }

  /** 造一条真实的会话 cookie（走 `SessionService`，与生产同一条路）。 */
  async function login(userId: string): Promise<{ sessionId: string; cookie: string }> {
    const { sessionId } = await sessions.create(userId, { ip: '127.0.0.1', userAgent: 'vitest' });
    return { sessionId, cookie: `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}` };
  }

  /**
   * 走**真实**的接入流程（Task 5 的加密即入库 + Task 6 的元数据 + Task 7 的落库），
   * 返回下载路径需要的一切。
   */
  async function createVersion(input: {
    ownerId: string;
    sample?: 'ok.zip' | 'ok.tar.gz';
  }): Promise<{ assetId: string; versionId: string; storageKey: string; plaintext: Buffer }> {
    const plaintext = sampleBytes(input.sample ?? 'ok.zip');
    const asset = await prisma.asset.create({ data: { ownerId: input.ownerId } });
    const write = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });
    const ingested = await assets.finalize(write, { uploadedById: input.ownerId });
    const reader = await EncryptedArtifactReader.open(app.get<ArtifactStore>(ARTIFACT_STORE), ingested.storageKey, ringFromEnv());
    const metadata = await parseMetadata(reader, ingested.kind);
    const persisted = await versions.persistIngested({ assetId: asset.id, ingested, metadata });
    return {
      assetId: asset.id,
      versionId: persisted.assetVersionId,
      storageKey: ingested.storageKey,
      plaintext,
    };
  }

  /** 签发（带会话与双提交令牌；CSRF 是写操作的第一道守卫，缺令牌会是 403 而不是授权结论）。 */
  function issue(versionId: string, cookie: string): request.Test {
    return request(app.getHttpServer())
      .post(`/assets/versions/${versionId}/download-url`)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, csrf);
  }

  /** 兑换（无会话：签名就是凭证）。路径可以带 XFF 以隔离限流桶。 */
  function redeem(path: string, forwardedFor?: string): request.Test {
    const req = request(app.getHttpServer()).get(path);
    return forwardedFor === undefined ? req : req.set('X-Forwarded-For', forwardedFor);
  }

  /**
   * 兑换并把响应体**原样**收成 Buffer。
   *
   * 收原始字节而不是让 supertest 按 `Content-Type` 解析：成功时响应体是制品（二进制），
   * 「被拒时零字节」这条判据也只有在**原始字节**上才有意义（一个被解析过的对象
   * 证明不了「发的不是文件」）。
   */
  function redeemBytes(path: string): request.Test {
    return request(app.getHttpServer())
      .get(path)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  }

  /** 这个版本身上的全部审计行（按时间）。 */
  async function auditRows(versionId: string): Promise<Array<{ action: string; actorId: string | null; metadata: unknown }>> {
    return prisma.auditLog.findMany({
      where: { resourceId: versionId },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorId: true, metadata: true },
    });
  }

  /** 手工签一张票（用例自己构造超时/篡改/超长 TTL 的形态）。 */
  function craftTicket(payload: { assetVersionId: string; userId: string; expiresAt: number; nonce: string }): string {
    return buildDownloadPath({ ...payload, signature: signTicket(payload, testEnv.DOWNLOAD_URL_SECRET) });
  }

  /**
   * 把签名改成**保证不同**的另一个值。
   *
   * 第一版写的是「把最后一位换成 `A`」——而 base64url 的字母表里本来就有 `A`：
   * 签名末位**恰好**是 `A` 时那次「篡改」什么也没改，票据照样通过（实测：全量运行时
   * 以约 1/64 的概率红了「把签名改一位 ⇒ 403」这条）。一次「有时不是篡改」的篡改
   * 与恒真断言是同一个缺陷形状，因此这里先保证改得动、再断言它被拒。
   */
  function flipSignature(signature: string): string {
    const mutated = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    if (mutated === signature) throw new Error('探针没有改变签名：这条用例会变成恒真断言');
    return mutated;
  }

  it('属主签发：200 + 一条相对路径 + 距今 ≤ 300 秒的过期时刻（响应里没有任何内部标识）', async () => {
    const owner = await createUser();
    const { versionId, storageKey } = await createVersion({ ownerId: owner });
    const { cookie } = await login(owner);

    /**
     * 两次时钟采样把**服务端那次采样**夹在中间。
     *
     * `expiresAt` 是服务端在**请求处理期间**算出来的（`floor(它自己的 now) + 300`），那一刻
     * 必然落在 `[before, after]` 里，因此 `expiresAt` 必然落在 `[before + 300, after + 300]` 里。
     * 两侧都是**紧的**（0 秒余量），下面对两侧各断言一次。
     *
     * 为什么要两个锚点：旧写法只采了 `before`（请求**之前**），却拿它去量一个在请求**之后**
     * 才产生的时刻——请求只要跨过一次秒边界，差值就变成 301 而判据变红。实测（全量负载下
     * 签发往返 p50 = 43 ms / p99 = 128 ms）：600 次里 **18 次**跨过 ⇒ 这条判据以约 **3%**
     * 的概率红，而它测的其实是「机器有多快」。现在这条判据与请求快慢无关：对同一条件注入
     * 1.1 秒延迟之后，旧写法必然红（`expected 301 to be less than or equal to 300`），
     * 新写法仍然全绿。
     *
     * 判别力没有变小：删掉校验侧那道上界检查、或者把签发改成 `now + 1`，本文件都仍然红
     * （实测：`expected 200 to be 403` / `expected 1 to be greater than or equal to 300`——
     * 后者是**新**的判别力，旧写法那句 `toBeGreaterThan(0)` 抓不住）。
     *
     * **据实记载**：常数本身的**取值**不由本文件钉住，旧写法亦然——两条判据都是拿
     * `DOWNLOAD_TTL_SECONDS` 去量 `expiresAt`，常数改成 400 时两边一起变，本文件不会红
     * （实测：红的是 `tests/unit/asset/signed-url.test.ts` 的
     * `expected 400 to be less than or equal to 300`）。钉住取值是单测那一侧的职责，
     * 这里钉的是「接线之后这条性质仍然成立」。
     */
    const before = Math.floor(Date.now() / 1000);
    const res = await issue(versionId, cookie);
    const after = Math.floor(Date.now() / 1000);
    const body = res.body as { url?: string; expiresAt?: number };

    expect(res.status, `响应体=${res.text}`).toBe(200);
    expect(body.url?.startsWith('/assets/download?')).toBe(true);
    expect(typeof body.expiresAt).toBe('number');
    // 威胁 #3 的「≤5 分钟」在**响应**上成立（签发侧的常数由单测钉住，这里是端到端的同一件事）
    expect((body.expiresAt as number) - after).toBeLessThanOrEqual(DOWNLOAD_TTL_SECONDS);
    expect((body.expiresAt as number) - before).toBeGreaterThanOrEqual(DOWNLOAD_TTL_SECONDS);
    // 相对路径：本进程不猜自己的对外 origin（理由见 buildDownloadPath）
    expect(body.url?.startsWith('http')).toBe(false);
    // 存储键、fileId、keyId、nonce 之外的任何东西都不该出现在响应里
    expect(res.text).not.toContain(storageKey);
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'url']);

    // 成功也写审计（判据 9 的前一半）
    const rows = await auditRows(versionId);
    expect(rows.map((row) => row.action)).toEqual(['asset.download_url_issued']);
    expect(rows[0]?.actorId).toBe(owner);
  });

  it('非属主签发 ⇒ 403 + 一行失败审计（**失败也写**：判据 9 的后一半）', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { versionId } = await createVersion({ ownerId: owner });
    const { cookie } = await login(stranger);

    const res = await issue(versionId, cookie);

    expect(res.status, `响应体=${res.text}`).toBe(403);
    expect((res.body as { code?: string }).code).toBe('ASSET_DOWNLOAD_NOT_AUTHORIZED');
    // 未授权者拿不到任何链接（判据 11 的那条在**签发**这一侧的落点）
    expect(res.text).not.toContain('/assets/download?');

    const rows = await auditRows(versionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('asset.download_denied');
    expect(rows[0]?.actorId).toBe(stranger);
    expect(rows[0]?.metadata).toMatchObject({ reason: 'not_authorized' });
  });

  it('管理员不是属主 ⇒ 同样 403（§9 的矩阵里没有给 admin 开这一格）', async () => {
    const owner = await createUser();
    const admin = await createUser('ADMIN');
    const { versionId } = await createVersion({ ownerId: owner });
    const { cookie } = await login(admin);

    const res = await issue(versionId, cookie);

    expect(res.status, `响应体=${res.text}`).toBe(403);
    expect((res.body as { code?: string }).code).toBe('ASSET_DOWNLOAD_NOT_AUTHORIZED');
    // 归属是**唯一**的判据：角色不参与判定（今天没有任何地方读 `role`）。
    // 若 P7 要给管理员一个覆盖入口，它必须加在 `checkAccess` 这**一个**地方。
    expect((await auditRows(versionId)).map((row) => row.action)).toEqual(['asset.download_denied']);
  });

  it('版本不存在 ⇒ 404，且**不写审计**（给任意 UUID 都写一行 append-only 的表＝无界写入放大器）', async () => {
    const user = await createUser();
    const { cookie } = await login(user);

    const res = await issue(randomUUID(), cookie);

    expect(res.status, `响应体=${res.text}`).toBe(404);
    expect((res.body as { code?: string }).code).toBe('ASSET_VERSION_NOT_FOUND');
    // 边界明确记录：伪造的 id 不会往审计表里写任何东西
    expect(await prisma.auditLog.count({ where: { actorId: user } })).toBe(0);
  });

  it('非 UUID 的路径参数 ⇒ 404（**不是** 500：参数校验在 HTTP 边界，见 Task 7 的移交）', async () => {
    const user = await createUser();
    const { cookie } = await login(user);

    for (const bad of ['not-a-uuid', '../../etc/passwd', '1', '0199a1b2c3d47e5f8a9b0c1d2e3f4a5b']) {
      const res = await issue(bad, cookie);
      expect(res.status, `${bad} ⇒ ${res.status}（响应体=${res.text}）`).toBe(404);
    }
  });

  it('端到端：属主签发 → 兑换 ⇒ 200 + 字节与上传的明文逐字节相同（并写一行成功审计）', async () => {
    const owner = await createUser();
    const { versionId, plaintext } = await createVersion({ ownerId: owner });
    const { cookie } = await login(owner);

    const issued = await issue(versionId, cookie);
    const res = await redeemBytes((issued.body as { url: string }).url);

    expect(res.status, `响应体=${res.text}`).toBe(200);
    const served = res.body as Buffer;
    expect(served.equals(plaintext), '下载到的字节与上传的明文不一致').toBe(true);
    // 两个头都由**推导**出来的类型决定（Task 7 刻意没有持久化 `kind`，见 DownloadService 的注释）
    expect(res.headers['content-type']).toBe('application/zip');
    expect(Number(res.headers['content-length'])).toBe(plaintext.length);
    expect(res.headers['content-disposition']).toContain(`asset-${versionId}.zip`);

    // 成功路径的审计行；`bytes` 就是写入侧数出的那个数（长度核对通过之后两者必然相等）
    const rows = await auditRows(versionId);
    expect(rows.map((row) => row.action)).toEqual(['asset.download_url_issued', 'asset.download']);
    expect(rows[1]?.metadata).toMatchObject({ bytes: plaintext.length, kind: 'zip' });
  });

  it('单次使用：同一张票第二次 ⇒ 403（重放）+ 一行失败审计，且没有第二次成功行', async () => {
    const owner = await createUser();
    const { versionId } = await createVersion({ ownerId: owner });
    const { cookie } = await login(owner);
    const url = (await issue(versionId, cookie)).body as { url: string };

    const first = await redeem(url.url);
    const second = await redeem(url.url);

    expect(first.status, `第一次=${first.text}`).toBe(200);
    expect(second.status, `第二次=${second.text}`).toBe(403);
    expect((second.body as { code?: string }).code).toBe('ASSET_DOWNLOAD_TICKET_REPLAYED');
    expectNoArtifactBytes(second, sampleBytes('ok.zip'));

    const rows = await auditRows(versionId);
    expect(rows.map((row) => row.action)).toEqual([
      'asset.download_url_issued',
      'asset.download',
      'asset.download_failed',
    ]);
    expect(rows[2]?.metadata).toMatchObject({ reason: 'replayed' });
  });

  it('并发：两个请求同时用同一张票，恰好一个 200、一个 403（`SET NX` 是原子的）', async () => {
    const owner = await createUser();
    const { versionId, plaintext } = await createVersion({ ownerId: owner });
    const { cookie } = await login(owner);
    const url = (await issue(versionId, cookie)).body as { url: string };

    // 两个**同时**发出的请求：先 GET 再 SET 的实现会让两个都过（各自都看到「键不存在」）。
    // 用同步的 `Promise.all` 而不是 `await` 两次——后者在时间上根本不会重叠。
    const [a, b] = await Promise.all([redeemBytes(url.url), redeemBytes(url.url)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);

    expect(statuses, `两个并发请求的状态码：${a.status} / ${b.status}`).toEqual([200, 403]);
    const winner = a.status === 200 ? a : b;
    expect((winner.body as Buffer).equals(plaintext), '赢的那个请求拿到的字节不对').toBe(true);
    const loser = a.status === 200 ? b : a;
    // 输的那个必须**一个字节都没有**（它是被拒的响应，不是半份文件）
    expectNoArtifactBytes(loser, plaintext);
    expect((JSON.parse((loser.body as Buffer).toString('utf8')) as { code?: string }).code).toBe(
      'ASSET_DOWNLOAD_TICKET_REPLAYED',
    );
  });

  /**
   * **nonce 台账的原子性**——这条判据只能在这一层做（据实记载）。
   *
   * 上面那条 HTTP 层的并发用例**没有**判别力：变异探针 p2 把 `SET NX` 换成
   * 「先 GET 再 SET」（经典的竞态写法）之后，它**仍然全绿**——两次 supertest 请求的
   * 连接建立把两个请求错开了，而那个竞态窗口只有微秒级（实测：`18 passed`，
   * 见 `evidence/t8-mutation-p2-nonce-get-then-set.txt`）。一条没有判别力的用例
   * 留着只会让人误以为「并发已经被覆盖」。
   *
   * 真正能踩到那个窗口的形态是：**同一个 tick 里发出两条命令**（两个 `consumeNonce`
   * 同时在飞）。此时「先 GET 再 SET」的两个 `EXISTS` 都会在任何一个 `SET` 之前返回 0
   * ⇒ 两个都拿到 `true`（本用例变红），而 `SET ... NX` 只有一个拿到 `OK`。
   */
  it('nonce 台账：同一 tick 里发出的两条 consumeNonce 恰好一条为真（`SET NX` 的原子性）', async () => {
    const client = redis.newClient();
    try {
      const nonce = createNonce();
      const results = await Promise.all([
        consumeNonce(client, nonce, 60),
        consumeNonce(client, nonce, 60),
      ]);

      expect(results.filter(Boolean), `两条并发命令的结果：${JSON.stringify(results)}`).toHaveLength(1);
      // 键留在库里（第三个人也拿不到）
      expect(await consumeNonce(client, nonce, 60)).toBe(false);
      // 且**有**过期时间：台账不会无限增长（TTL 是这条控制的另一半）
      const ttl = await client.ttl(`${NONCE_KEY_PREFIX}${nonce}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      // 形状不对的 nonce 不建任何键（它是 Redis 键的一部分，必须有界）
      expect(await consumeNonce(client, nonce, 60), '同一个 nonce 被消费了两次').toBe(false);
      expect(await consumeNonce(client, 'short', 60)).toBe(false);
    } finally {
      client.disconnect();
    }
  });

  it('超时：手工签一张已过期的票 ⇒ 403（EXPIRED）+ 审计行（当事人来自票据，因此可信）', async () => {
    const owner = await createUser();
    const { versionId } = await createVersion({ ownerId: owner });
    const now = Math.floor(Date.now() / 1000);
    const path = craftTicket({ assetVersionId: versionId, userId: owner, expiresAt: now - 1, nonce: createNonce() });

    const res = await redeem(path);

    expect(res.status, `响应体=${res.text}`).toBe(403);
    expect((res.body as { code?: string }).code).toBe('ASSET_DOWNLOAD_TICKET_EXPIRED');
    expectNoArtifactBytes(res, sampleBytes('ok.zip'));
    expect((await auditRows(versionId)).map((row) => row.action)).toEqual(['asset.download_failed']);
  });

  it('TTL 超过 300 秒（签名合法）⇒ 403（TTL_TOO_LONG）：上界在校验侧也成立', async () => {
    const owner = await createUser();
    const { versionId } = await createVersion({ ownerId: owner });
    const now = Math.floor(Date.now() / 1000);
    const path = craftTicket({
      assetVersionId: versionId,
      userId: owner,
      // 超出量见 `TTL_OVERSHOOT_SECONDS` 的注释：+1 秒会被一次跨过秒边界的请求吃掉
      expiresAt: now + DOWNLOAD_TTL_SECONDS + TTL_OVERSHOOT_SECONDS,
      nonce: createNonce(),
    });

    const res = await redeem(path);

    expect(res.status, `响应体=${res.text}`).toBe(403);
    expect((res.body as { code?: string }).code).toBe('ASSET_DOWNLOAD_TICKET_TTL_TOO_LONG');
    expect((await auditRows(versionId)).map((row) => row.action)).toEqual(['asset.download_failed']);
  });

  it('篡改票据载荷 ⇒ 403 且**不写审计**（伪造的票据里没有可信当事人）', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { versionId } = await createVersion({ ownerId: owner });
    const { cookie } = await login(owner);
    const issued = (await issue(versionId, cookie)).body as { url: string };
    const query = Object.fromEntries(new URLSearchParams(issued.url.split('?')[1] as string));
    // 签发本身写了一行（那是**真的**发生过的授权）。要断言的是：伪造的那些尝试
    // **一行都不加**——因此先记下此刻的行数，再比。
    const afterIssuance = await auditRows(versionId);
    expect(afterIssuance.map((row) => row.action)).toEqual(['asset.download_url_issued']);

    const tampered: Array<[string, Record<string, unknown>]> = [
      ['把 userId 换成别人', { ...query, userId: stranger }],
      ['把 assetVersionId 换成另一个', { ...query, assetVersionId: randomUUID() }],
      ['把过期时间往后挪（不重签）', { ...query, expiresAt: String(Number(query['expiresAt']) + 3600) }],
      ['把 nonce 换掉', { ...query, nonce: createNonce() }],
      ['把签名改一位', { ...query, signature: flipSignature(String(query['signature'])) }],
      ['把签名截短', { ...query, signature: String(query['signature']).slice(0, 20) }],
      ['超长签名', { ...query, signature: 'A'.repeat(4096) }],
      ['缺一个字段', Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'nonce'))],
    ];

    for (const [label, q] of tampered) {
      const path = `/assets/download?${new URLSearchParams(q as Record<string, string>).toString()}`;
      const res = await redeemBytes(path);
      expect(res.status, `${label} ⇒ ${res.status}（响应体=${res.text}）`).toBe(403);
      expectNoArtifactBytes(res, sampleBytes('ok.zip'));
    }

    // 一次都不许写审计：那些 `userId` 是攻击者填的，写进去就是一条他编的内容
    expect(await auditRows(versionId)).toEqual(afterIssuance);
  });

  it('转让之后：前手手里那张票失效（兑换时**再判一次** checkAccess），新属主可以重新签发', async () => {
    const owner = await createUser();
    const buyer = await createUser();
    const { versionId, assetId, plaintext } = await createVersion({ ownerId: owner });
    const { cookie } = await login(owner);
    const issued = (await issue(versionId, cookie)).body as { url: string };

    // 真的转让一次（Task 7 的服务；本用例只关心那张已经签出去的票会怎样）。
    // Task 1 起转让收调用方的事务（`tx` 必填），因此调用点在明处写一个 `$transaction`。
    await prisma.$transaction((tx) =>
      ownership.transferOwnership(tx, { assetId, toUserId: buyer, reason: '测试：转让后旧票失效' }),
    );

    const afterTransfer = await redeem(issued.url);
    expect(afterTransfer.status, `响应体=${afterTransfer.text}`).toBe(403);
    expect((afterTransfer.body as { code?: string }).code).toBe('ASSET_DOWNLOAD_NOT_AUTHORIZED');
    expectNoArtifactBytes(afterTransfer, plaintext);

    // 新属主不受影响：他能签发也能下载
    const { cookie: buyerCookie } = await login(buyer);
    const reissued = (await issue(versionId, buyerCookie)).body as { url: string };
    expect((await redeem(reissued.url)).status).toBe(200);
  });

  it('元数据端点：**匿名 403 / 登录后 200**，且只回元数据——没有存储键/摘要/内部标识（P3 / Task 1 裁定 ①）', async () => {
    const owner = await createUser();
    const { versionId, storageKey } = await createVersion({ ownerId: owner });
    const version = await prisma.assetVersion.findUniqueOrThrow({ where: { id: versionId } });

    /**
     * ★ **拒绝面**（P3 / Task 1，控制器裁定 ①）。
     *
     * 被替换掉的旧契约原文（`it` 标题是「元数据端点：所有人可读（§9 的一行）…」）：
     * ```
     * // 匿名（不带任何 cookie）也能读：这正是 §9 矩阵里「Asset 元数据 read = 所有人」那一行
     * const res = await request(app.getHttpServer()).get(`/assets/versions/${versionId}/metadata`);
     * expect(res.status, `响应体=${res.text}`).toBe(200);
     * ```
     * 「所有人」现在读作**所有已登录用户**：匿名可枚举文件树 / 语言分布 / 依赖清单
     * 正是威胁 #9 要防的侦察面。判据取守卫那句「需要登录」，并断言**响应里没有任何
     * 元数据**——一个「403 但顺手回了一份」的实现会让后两句红。
     */
    const anonymous = await request(app.getHttpServer()).get(`/assets/versions/${versionId}/metadata`);
    expect(anonymous.status, `响应体=${anonymous.text}`).toBe(403);
    expect((anonymous.body as { message?: string }).message).toBe('需要登录');
    expect(anonymous.body).not.toHaveProperty('assetVersionId');
    expect(anonymous.body).not.toHaveProperty('fileTree');

    // ★ **验收对照**：登录之后照旧 200，且下面这一整组内容判据一个字都没放宽。
    //   一个「谁都不许读」的实现会让这里红——拒绝与放行必须**同时**被钉住。
    const { cookie } = await login(owner);
    const res = await request(app.getHttpServer())
      .get(`/assets/versions/${versionId}/metadata`)
      .set('Cookie', cookie);

    expect(res.status, `响应体=${res.text}`).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.assetVersionId).toBe(versionId);
    expect(body.completeness).toBeTypeOf('number');
    expect(Array.isArray(body.fileTree)).toBe(true);
    // 「只回元数据」不是靠过滤，是靠 `select` 里根本没有那些列
    expect(res.text).not.toContain(storageKey);
    expect(res.text).not.toContain(version.sha256);
    expect(res.text).not.toContain(version.fileId);
    expect(body).not.toHaveProperty('storageKey');
    expect(body).not.toHaveProperty('sha256');

    // 同一份「已登录」请求打一个不存在的版本 ⇒ 404（**「没有」与「空」不是同一件事**）：
    // 这一句同时证明上面那个 200 不是「这条路由现在对谁都回 200」。
    const missing = await request(app.getHttpServer())
      .get(`/assets/versions/${randomUUID()}/metadata`)
      .set('Cookie', cookie);
    expect(missing.status).toBe(404);
  });
});

/**
 * **下载路径的带外长度核对**（Task 5 / Task 7 两次移交的强制义务）。
 *
 * 制品格式里没有任何字段认证「制品有多长」：`plaintextLength` 写在尾部、不进任何 AAD。
 * 于是一份**更短、完全自洽**的制品（另一份合法归档重新加密：末块标记正确、三条完整性
 * 校验全过）在只信自称值的路径上会被当成合法的。Task 5 的探针 m6 在**接入期**实测过：
 * 不传带外长度 ⇒ 201 接受；传 ⇒ 422。**下载期必须同样成立**，否则这条核对等于没有。
 *
 * 判据有两半，缺一不可：
 *
 * 1. 长度不符 ⇒ **422 + 零字节**（不是「读的时候抛了」，是**一个字节都没发出去**）；
 * 2. **正面对照**——把长度也改对 ⇒ 200，且发出来的就是那份更短的制品。
 *    没有这一半，第 1 条也可能只是「任何被换过的制品都会被拒」，而不是这条核对在承重。
 *
 * 变异探针（见报告 p1）：删掉 `expectedPlaintextLength` 那个入参，第 1 条立刻变成
 * 200 并把**错的字节**发出去。
 *
 * ## I1 之后这些用例为什么要显式对齐「身份」两列（据实记载）
 *
 * I1 给下载路径加上了**制品身份**核对（`reader.fileId !== version.fileId` ⇒ 500），
 * 而它排在内容校验**之前**（一份被换过的对象根本不该再被当成内容去解读）。
 * 于是「把别的制品换进制品卷」现在**先**在那一关被拒——本节原先靠替换对象来观测的
 * **长度核对**因此不再可达。要**单独**观测长度那一列，就必须先把身份两列对齐
 * （`alignIdentityColumns`）：「长度不符」这条判据的完整含义因此是
 * **「身份一致时，长度是剩下的那道界」**。
 *
 * 「一份别的制品被换进来」这个形态本身由**同文件的「等长」用例**覆盖（它不碰库、只换对象，
 * 判据是 500 + 零字节）——两条用例合起来，两个控制各自都有会变红的见证。
 */
describe('签名下载：制品被换成更短的自洽制品时，带外长度核对必须拒掉它（零字节）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let store: SwappingStore;
  let assets: AssetService;
  let versions: AssetVersionService;
  let sessions: SessionService;
  let csrf: string;

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    store = new SwappingStore(new LocalArtifactStore(process.env.ARTIFACT_STORE_DIR as string));
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
        (builder) => builder.overrideProvider(ARTIFACT_STORE).useValue(store),
      ],
    });
    assets = app.get(AssetService);
    versions = app.get(AssetVersionService);
    sessions = app.get(SessionService);
    csrf = await fetchCsrfToken(app);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
  });

  /** 与上一节同款的最短路径：真实接入 → 真实落库 → 签发 → 兑换。 */
  async function setupVersion(plaintext: Buffer = sampleBytes('ok.zip')): Promise<{
    owner: string;
    cookie: string;
    assetId: string;
    versionId: string;
    storageKey: string;
    original: Buffer;
  }> {
    const owner = (await prisma.user.create({ data: {} })).id;
    const original = plaintext;
    const asset = await prisma.asset.create({ data: { ownerId: owner } });
    const write = await assets.putStream(Readable.from([original]), { maxBytes: MAX_UPLOAD_BYTES });
    const ingested = await assets.finalize(write, { uploadedById: owner });
    const reader = await EncryptedArtifactReader.open(app.get<ArtifactStore>(ARTIFACT_STORE), ingested.storageKey, ringFromEnv());
    const metadata = await parseMetadata(reader, ingested.kind);
    const persisted = await versions.persistIngested({ assetId: asset.id, ingested, metadata });
    const { sessionId } = await sessions.create(owner, { ip: '127.0.0.1', userAgent: 'vitest' });
    return {
      owner,
      cookie: `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`,
      assetId: asset.id,
      versionId: persisted.assetVersionId,
      storageKey: ingested.storageKey,
      original,
    };
  }

  async function issue(versionId: string, cookie: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/assets/versions/${versionId}/download-url`)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, csrf);
    expect(res.status, `签发失败：${res.text}`).toBe(200);
    return (res.body as { url: string }).url;
  }

  /**
   * 兑换并保留**原始字节**（与上一节的 `redeemBytes` 同款）。
   *
   * 本节既有 200（响应体是制品）又有 422（响应体是 JSON），因此统一收字节、
   * 在需要时**显式** `JSON.parse` —— 「零字节」这条判据只能在原始字节上做。
   */
  function download(path: string): request.Test {
    return request(app.getHttpServer())
      .get(path)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  }

  /** 从一个「被拒」的响应里取出 JSON 错误体（解析失败时把原文带进断言消息）。 */
  function errorBody(res: request.Response): { code?: string; kind?: string; reason?: string } {
    const raw = responseBytes(res);
    try {
      return JSON.parse(raw.toString('utf8')) as { code?: string; kind?: string; reason?: string };
    } catch {
      throw new Error(`被拒的响应不是 JSON（${raw.length} 字节）：${raw.subarray(0, 64).toString('latin1')}`);
    }
  }

  /**
   * 把版本行里的**身份两列**改成与盘上那个对象一致（`file_id` / `key_id`）。
   *
   * I1 之后这两列是承重的：任何「把别的制品换进制品卷」的形态都会先被身份核对拒掉
   * （500），因此要单独观测**长度**那一列的判据必须先对齐它们——见本节注释末段。
   * 改得动库的人当然能改任何东西，这一点本节的用例从来没有否认过：
   * 它们证明的是「哪一列在承重」，而不是「改库也能骗过」。
   */
  async function alignIdentityColumns(versionId: string, artifact: Buffer): Promise<void> {
    const { header } = decodeHeader(artifact);
    await prisma.assetVersion.update({
      where: { id: versionId },
      data: { fileId: header.fileId.toString('hex'), keyId: header.keyId },
    });
  }

  it('被换成更短的制品（**身份已对齐**、长度仍记为原值）⇒ 422 + **零字节**：核对发生在写出第一个字节之前', async () => {
    const { versionId, storageKey, original, cookie } = await setupVersion();
    const replacementPlaintext = sampleBytes('ok.tar.gz');
    // 「攻击者形态」的那份字节：**另一份合法归档**重新加密（完全自洽、末块标记正确）
    const replacement = (await seedArtifact(new MemoryStore(), replacementPlaintext, { ring: ringFromEnv() })).artifact;
    expect(replacementPlaintext.length).toBeLessThan(original.length);

    store.substitute = { key: storageKey, bytes: replacement };
    // 身份两列对齐到这份替换制品 ⇒ 唯一还不符的就是**长度**那一列（见本节注释末段）。
    await alignIdentityColumns(versionId, replacement);
    try {
      const res = await download(await issue(versionId, cookie));

      expect(res.status, `响应体=${res.text}`).toBe(422);
      const body = errorBody(res);
      expect(body.code).toBe('ASSET_ARCHIVE_REJECTED');
      // 长度不符是在**读任何字节之前**判定的 ⇒ 类型还不该被声称为已知（没走到嗅探）
      expect(body.kind).toBe('unknown');
      expect(String(body.reason)).toContain('带外记录的明文长度');
      // 零字节：错误体里既没有原制品的字节，也没有那份替换制品的字节
      expectNoArtifactBytes(res, original);
      expectNoArtifactBytes(res, replacementPlaintext);
      // 失败也写审计（理由落在具体的控制上，而不是「反正拒了」）
      const rows = await prisma.auditLog.findMany({
        where: { resourceId: versionId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, metadata: true },
      });
      expect(rows.map((row) => row.action)).toEqual(['asset.download_url_issued', 'asset.download_failed']);
      expect(rows[1]?.metadata).toMatchObject({ reason: 'artifact_rejected' });
    } finally {
      store.substitute = null;
    }
  });

  it('正面对照：把长度也改成替换制品的长度 ⇒ 200，且发出来的就是那份更短的制品', async () => {
    const { versionId, storageKey, original, cookie } = await setupVersion();
    const replacementPlaintext = sampleBytes('ok.tar.gz');
    const replacement = (await seedArtifact(new MemoryStore(), replacementPlaintext, { ring: ringFromEnv() })).artifact;

    store.substitute = { key: storageKey, bytes: replacement };
    try {
      // 这一行就是「攻击者还得同时改库」的那一步：改得动库的人已经能改任何东西，
      // 因此本用例证明的**不是**「改库也能骗过」，而是**上面那条 422 是长度值造成的**——
      // 同一份字节、同一个请求，只把那个数改对，结论就从 422 变成 200。
      // `alignIdentityColumns` 是 I1 之后必须先做的一步（身份两列也是承重的，见本节注释末段）：
      // 对齐之后两份请求之间**唯一**的差别仍然只有长度那一列。
      await alignIdentityColumns(versionId, replacement);
      await prisma.assetVersion.update({ where: { id: versionId }, data: { plaintextBytes: replacementPlaintext.length } });

      const res = await download(await issue(versionId, cookie));

      expect(res.status, `响应体=${res.text}`).toBe(200);
      const served = res.body as Buffer;
      expect(served.equals(replacementPlaintext), '发的不是那份替换制品').toBe(true);
      expect(served.equals(original)).toBe(false);
      // 类型是**推导**出来的：这份制品是 tar.gz，响应头因此跟着变
      expect(res.headers['content-type']).toBe('application/gzip');
    } finally {
      store.substitute = null;
    }
  });

  /**
   * **I1：制品的身份必须与版本行比对**（最终全分支审查的 Important 项）。
   *
   * ## 这一条补的是哪个洞（攻击者形态）
   *
   * 上面两条用例钉的是**长度**：更短的制品被 422 拦下、把长度也改对就 200。
   * 但长度**不是身份**。任何能往制品卷里写一个文件的人（**正是**本地加密卷设计所针对的
   * 那个不可信角色）可以把对象 K 换成**另一份明文长度完全相同的、合法加密的制品**：
   * zip 让「等长」变得很容易（条目名同长、内容同长、stored 条目 ⇒ 整份 zip 同长）。
   * 它会通过 `sniff`、`inspectZip`、末块认证与那条长度核对，然后**以那位创作者的作品之名
   * 被发出去**。
   *
   * 而版本行里早就有能抓住它的东西：`file_id` 出现在**每一个块的 AAD** 里——它就是这份
   * 制品的身份——只是从来没有执行者去比对它（「声明了但未强制」那一类）。这条用例就是
   * 那个执行者：长度相同、结构自洽、末块正确，**身份不同就一律拒**。
   *
   * 判据同时钉住责任方：拒绝落在**存储侧**（`ASSET_ARTIFACT_UNREADABLE` / 500 / 审计
   * `unreadable`），不是「调用方的制品不可接受」（那是 422）——盘上那份不是这条记录指向的
   * 那一份，这是服务端/存储侧的问题。
   */
  it('被换成**等长**的另一份合法制品 ⇒ 拒绝且零字节：长度相同不算同一份制品（I1）', async () => {
    // 两份 zip 的总长度逐字节相等：条目名同长（a.txt / b.txt）、内容同长、都是 stored 条目。
    const original = buildZip([{ name: 'a.txt', data: pattern(64 * 1024, 1) }]);
    const replacementPlaintext = buildZip([{ name: 'b.txt', data: pattern(64 * 1024, 2) }]);
    expect(replacementPlaintext.length, '本用例的前提是两份明文等长').toBe(original.length);
    expect(replacementPlaintext.equals(original), '本用例的前提是两份明文不同').toBe(false);

    const { versionId, storageKey, cookie } = await setupVersion(original);
    // 「攻击者形态」的那份字节：另一次加密（**另一把 fileId**）、同一把活动密钥、
    // 同样的明文长度 ⇒ 长度核对、末块认证、归档校验全部会通过。
    const replacement = (await seedArtifact(new MemoryStore(), replacementPlaintext, { ring: ringFromEnv() })).artifact;
    expect(replacement.length).not.toBe(0);

    store.substitute = { key: storageKey, bytes: replacement };
    try {
      const res = await download(await issue(versionId, cookie));

      expect(res.status, `响应体=${res.text}`).toBe(500);
      const body = errorBody(res);
      expect(body.code).toBe('ASSET_ARTIFACT_UNREADABLE');
      // 内容级别：替换制品的**一个字节**都不许出去，原制品同样不许
      expectNoArtifactBytes(res, replacementPlaintext);
      expectNoArtifactBytes(res, original);
      // 失败理由落在存储侧，而不是「内容不可接受」那条出口
      const rows = await prisma.auditLog.findMany({
        where: { resourceId: versionId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, metadata: true },
      });
      expect(rows.map((row) => row.action)).toEqual(['asset.download_url_issued', 'asset.download_failed']);
      expect(rows[1]?.metadata).toMatchObject({ reason: 'unreadable' });
    } finally {
      store.substitute = null;
    }
  });

  /**
   * `key_id` 那半行也有见证（**它不是安全边界，但它是承重的契约**）。
   *
   * 造法：对象**一个字节都不换**，只把版本行的 `key_id` 改成一个别的合法取值。
   * 身份（`fileId`）仍然一致 ⇒ I1 的第一道比对通过；而读取器报出来的 `keyId` 与记录不符 ⇒
   * 拒绝。删掉那一行的话这次下载会**照常成功**（读取器按**头里**的 keyId 选键，对象是真的）
   * ——也就是说，没有这一行，「记录说用 v1、对象其实是 v2」这件事在服务端**没有任何痕迹**。
   * 它不是安全边界：改头里的 keyId 会选错密钥、解密直接失败（见 `reader.keyId` 的注释）。
   */
  it('版本行的 key_id 与对象头里的不符 ⇒ 同样拒绝（契约核对，不是安全边界）', async () => {
    const { versionId, cookie } = await setupVersion();
    await prisma.assetVersion.update({ where: { id: versionId }, data: { keyId: 'v9-retired' } });

    const res = await download(await issue(versionId, cookie));

    expect(res.status, `响应体=${res.text}`).toBe(500);
    expect(errorBody(res).code).toBe('ASSET_ARTIFACT_UNREADABLE');
  });

  it('尾块被改一位（长度自洽）⇒ 422 + 零字节：末块认证在任何结论之前', async () => {
    const { versionId, storageKey, original, cookie } = await setupVersion();
    const storePort = app.get<ArtifactStore>(ARTIFACT_STORE);
    const size = (await storePort.stat(storageKey)).bytes;
    const artifact = await storePort.getRange(storageKey, 0, size - 1);
    const forged = Buffer.from(artifact);
    // 末块的最后一个字节（tag 的末字节）：结构、长度、条数全部不变
    const indexOffset = Number(decodeFooter(forged.subarray(forged.length - FOOTER_BYTES)).indexOffset);
    forged[indexOffset - 1] = forged[indexOffset - 1]! ^ 0xff;

    store.substitute = { key: storageKey, bytes: forged };
    try {
      const res = await download(await issue(versionId, cookie));

      expect(res.status, `响应体=${res.text}`).toBe(422);
      const body = errorBody(res);
      expect(body.kind).toBe('unknown');
      expect(String(body.reason)).toContain('末块认证失败');
      expectNoArtifactBytes(res, original);
    } finally {
      store.substitute = null;
    }
  });

  it('每个请求一个新读取器：换掉对象（身份与长度都改对）之后，第二次下载给出的是**新的**字节', async () => {
    const { versionId, storageKey, original, cookie } = await setupVersion();

    const first = await download(await issue(versionId, cookie));
    expect(first.status).toBe(200);
    expect((first.body as Buffer).equals(original)).toBe(true);

    const replacementPlaintext = sampleBytes('ok.tar.gz');
    const replacement = (await seedArtifact(new MemoryStore(), replacementPlaintext, { ring: ringFromEnv() })).artifact;
    store.substitute = { key: storageKey, bytes: replacement };
    await alignIdentityColumns(versionId, replacement);
    await prisma.assetVersion.update({ where: { id: versionId }, data: { plaintextBytes: replacementPlaintext.length } });
    try {
      const second = await download(await issue(versionId, cookie));
      expect(second.status, `响应体=${second.text}`).toBe(200);
      // 一个跨请求复用的读取器会继续按**旧几何**解密（它的索引与块表是打开那一刻读的），
      // 于这里它会给出旧字节或直接失败——两种都不会是「新的字节」。
      expect((second.body as Buffer).equals(replacementPlaintext), '第二次下载给出的仍是旧内容：读取器被跨请求复用了').toBe(
        true,
      );
    } finally {
      store.substitute = null;
    }
  });
});

/**
 * 「签名下载这条新路由真的接进了 P0 的限流器」的**行为**见证。
 *
 * 标题里带「签名下载」是刻意的：验收命令是 `vitest run --project integration -t 签名下载`，
 * 而这个文件里的每一条都该被那条命令覆盖到（否则「跑了验收命令」与「跑了本文件的全部用例」
 * 会差一条，而那一条恰好是限流归属的见证）。
 *
 * 覆盖率门只证明「声明存在」（那是它能证明的全部），而这里打满一个桶：
 * 第 61 次要 429。判据选**元数据**端点（公开、只读、无副作用、无审计）。
 *
 * ## 请求里的那个 `X-Forwarded-For` **不是**在证明「按 IP 分桶」（M9：修正一条假理由）
 *
 * 上一版这里写着「用一个独立的 `X-Forwarded-For` 把它与同文件其它请求的桶分开
 * （`TRUST_PROXY=loopback` 下来自 127.0.0.1 的请求其 XFF 是被信任的，因此 `req.ip` 就是
 * 这里给的值——`search` 层正是按 IP 分桶）」。**那句话是假的**，两处都假：
 *
 * 1. **这一节自己起了一个新的 Redis**（`beforeAll` 里的 `startTestRedis()`），因此这个桶
 *    从空开始——无论 `req.ip` 是什么、无论分桶键是什么，前 60 次都会通过。
 *    「隔离」这件事在这里**没有被证明，也不可能被证伪**：断言无论如何都过。
 * 2. 更直接的是：**测试应用从未设置 trust proxy**，所以 `req.ip` 根本不是这里给的值
 *    （实测，见进度文件 M9：200 个不同的 XFF 值恰好拿到 60 次通过 = **同一个桶**）。
 *
 * 保留这个请求头是可以的（它让请求形状与真实反代下的样子一致），但**不能声称它在隔离**。
 * 这条用例真正证明的是：**这三条新路由确实挂了 P0 的 `search` 限流层**（第 61 次 429）。
 * 分桶键（`req.ip`）是否正确，由 `tests/security/trust-proxy.test.ts` 负责——
 * 那才是能确定性地钉住「XFF 被信任 / 不被信任」两种形态的地方。
 */
describe('签名下载：资产模块的新路由归属 P0 的限流层（打到上限即 429）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let store: SwappingStore;
  let assets: AssetService;
  let versions: AssetVersionService;
  let sessions: SessionService;

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    store = new SwappingStore(new LocalArtifactStore(process.env.ARTIFACT_STORE_DIR as string));
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
        (builder) => builder.overrideProvider(ARTIFACT_STORE).useValue(store),
      ],
    });
    assets = app.get(AssetService);
    versions = app.get(AssetVersionService);
    sessions = app.get(SessionService);
    /**
     * 这一节打的元数据端点 **P3 / Task 1 起要求登录**（控制器裁定 ①）。
     *
     * 旧注释的原文是「这一节打的是**公开**的元数据端点（不需要会话），CSRF 令牌也不必带」。
     * 那句话现在是**旧行为**的记录：不带会话的 61 次会**全部**停在 403 上，
     * `statuses.slice(0, 60).every(200)` 立刻红——限流层因此根本没被行使。
     * GET 仍是安全方法，`CsrfGuard` 对它不做校验（C13 只覆盖写操作），
     * 所以只需要会话 cookie，不需要 CSRF 令牌——请求形状的这一半没有变。
     */
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
  });

  it('元数据端点：第 60 次仍然 200，第 61 次 429（`search` 层 60 次/分钟，按 IP）', async () => {
    const owner = (await prisma.user.create({ data: {} })).id;
    const plaintext = sampleBytes('ok.zip');
    const asset = await prisma.asset.create({ data: { ownerId: owner } });
    const write = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });
    const ingested = await assets.finalize(write, { uploadedById: owner });
    const reader = await EncryptedArtifactReader.open(app.get<ArtifactStore>(ARTIFACT_STORE), ingested.storageKey, ringFromEnv());
    const metadata = await parseMetadata(reader, ingested.kind);
    const persisted = await versions.persistIngested({ assetId: asset.id, ingested, metadata });

    // ★ P3 / Task 1（控制器裁定 ①）：这条路由现在要求登录，因此这 61 次必须**带会话**。
    //   不带会话时它们会全部停在 403（守卫的「需要登录」），限流层一次都没被行使，
    //   而下面前 60 次那一句会以「前 60 次里出现了非 200：403,…」红。
    //   带会话**不改变**这条用例问的事：它证明的是「这条路由真的挂了 P0 的 `search` 层」。
    const { sessionId } = await sessions.create(owner, { ip: '127.0.0.1', userAgent: 'vitest' });

    const call = (): request.Test =>
      request(app.getHttpServer())
        .get(`/assets/versions/${persisted.assetVersionId}/metadata`)
        .set('Cookie', `${SESSION_COOKIE}=${sessionId}`)
        .set('X-Forwarded-For', '203.0.113.9');

    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await call()).status);

    expect(statuses.slice(0, 60).every((status) => status === 200), `前 60 次里出现了非 200：${statuses.join(',')}`).toBe(true);
    expect(statuses[60], `第 61 次是 ${statuses[60]}，不是 429：这条路由没有被 P0 的限流器覆盖`).toBe(429);
  });
});
