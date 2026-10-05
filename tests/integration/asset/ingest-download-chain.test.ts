import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from 'pg';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';
import { createKeyRing, type KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import { ARTIFACT_STORE, type ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';
import { createTestApp } from '../../helpers/app.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';
import { MemoryStore, seedArtifact } from '../../helpers/craft-encrypted-artifact.js';
import { ARCHIVE_SAMPLES, buildZip } from '../../fixtures/archives/generate.js';

/**
 * **「上传一个包，然后把它下载回来」**（P1 / Task 9；规格判据 + D1 + D10/D11 的端到端链路）。
 *
 * ## 这个文件为什么必须存在
 *
 * Task 5 把「加密即入库 + 校验」做成了流水线，Task 6 做了解析，Task 7 做了落库（`persistIngested`），
 * Task 8 做活了签名下载——**但四段之间缺一根线**：`persistIngested` 没有生产调用方。
 * 于是上传端点会校验、加密、解析元数据，却**从不创建 `Asset`/`AssetVersion`**，
 * 而下载路径的输入今天只能由测试手搓（`signed-download.test.ts` 的 `createVersion`）。
 * 换句话说：**「创作者上传一个包，然后下载它」在接线之前是不成立的**，而没有任何一条用例
 * 会发现这件事——每一条都在自己那一段里自洽。
 *
 * 这个文件问的就是那一句话，而且只问它：**一个真实用户走真实 HTTP 上传一个包，
 * 能不能在同一个进程里把它下载回来、拿到的字节是不是原样、别人能不能拿。**
 *
 * ## 为什么每一段都必须是真的
 *
 * 手搓一条 `AssetVersion` 行再断言下载，证明的是「我写的那行能被下载」——那正是这条缝
 * 被漏掉的原因。因此这里：真 multipart HTTP 上传、真加密落盘、真库、真 Redis、
 * 真签名票据、真解密流出，**没有任何一段替身**（唯一的包装是故障注入，见下）。
 *
 * ## 判据与它们的判别力
 *
 * | 用例 | 判别力（变异探针，见报告） |
 * |---|---|
 * | 上传 ⇒ Asset/Version/Metadata 三行 + 所有人是上传者 | m2（所有人写成别的值）、m3（跳过校验） |
 * | 属主签发并下载 ⇒ 与上传的明文逐字节相同 | m5（明文长度不来自计量器 ⇒ 422）、m7（响应不回 id） |
 * | 非属主 ⇒ 403、拿不到链接 | Task 8 的 p7（签发绕过 `checkAccess`） |
 * | 恶意上传 ⇒ 没有行、没有对象 | m3（跳过校验 ⇒ 恶意样本也会落库） |
 * | 落库失败 ⇒ 500 且**密文对象被删掉** | m4（失败时留下孤儿对象） |
 * | 制品在静止状态被换成更短的 ⇒ 422 + 零字节 | m6（下载不传带外长度 ⇒ 200） |
 */

const STORE_DIR = process.env.ARTIFACT_STORE_DIR as string;

/** 样本字节（八样本表里那两个合法归档 + 两个恶意样本）。 */
function sampleBytes(name: 'ok.zip' | 'ok.tar.gz' | 'symlink.zip' | 'fake-mime.zip'): Buffer {
  const sample = ARCHIVE_SAMPLES.find((item) => item.name === name);
  if (sample === undefined) throw new Error(`八样本表里没有 ${name}`);
  return sample.bytes();
}

/** 环境夹具里的密钥环（与应用的 `KEY_RING` 提供者用的是同一份输入）。 */
function ringFromEnv(): KeyRing {
  return createKeyRing({
    ARTIFACT_KEYS: testEnv.ARTIFACT_KEYS,
    ARTIFACT_ACTIVE_KEY_ID: testEnv.ARTIFACT_ACTIVE_KEY_ID,
  });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 制品库里的**全部文件**（相对路径，排好序）——「零残留」这类判据列目录来数，不猜路径。
 */
async function listObjects(root: string): Promise<string[]> {
  const out: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name);
      // 分隔符统一成 `/`：分片路径（`<前2位>/<次2位>/<键>`）在 Windows 上拼出来的是反斜杠，
      // 而判据里写的是正斜杠——不归一的话这条断言在 Windows 上恒红、在 Linux 上恒绿。
      if (entry.isDirectory()) pending.push(full);
      else out.push(full.slice(root.length + 1).split('\\').join('/'));
    }
  }
  return out.sort();
}

/**
 * 「把盘上某个键的对象换成另一份字节」的存储包装（与 `signed-download.test.ts` 同一个形状）。
 *
 * 它模拟的是**制品在静止存储上被改动**：攻击者（或损坏）拿到的是一份**自洽**的坏制品，
 * 而不是一段坏字节。区间越界**抛错**而不是回一个短缓冲——静默的短读会把一次替换
 * 读成一段合法数据，而本文件要观察的正是替换之后会发生什么。
 */
class SwappingStore implements ArtifactStore {
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

/** 响应体的**原始字节**（下载成功时它是制品，被拒时它是错误体）。 */
function responseBytes(res: request.Response): Buffer {
  const body: unknown = res.body;
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(typeof res.text === 'string' ? res.text : '', 'utf8');
}

/**
 * 被拒的下载响应是 **JSON**，而兑换用例为了拿原始字节用了自定义 parser
 * （`res.body` 因此是 Buffer）。错误体只有这一种取法：显式解析那串字节。
 */
function errorBody(res: request.Response): { code?: string } {
  return JSON.parse(responseBytes(res).toString('utf8')) as { code?: string };
}

/** 兑换并把响应体原样收成 Buffer（不让 supertest 按 `Content-Type` 解析二进制）。 */
function redeem(app: INestApplication, path: string): request.Test {
  return request(app.getHttpServer())
    .get(path)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

describe('上传 → 落库 → 签发 → 下载：一条真的能走通的链路（Task 9 的接线）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let owner: Client;
  let prisma: PrismaService;
  let store: SwappingStore;
  let sessions: SessionService;
  let csrf: string;

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    store = new SwappingStore(new LocalArtifactStore(STORE_DIR));
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
        (builder) => builder.overrideProvider(ARTIFACT_STORE).useValue(store),
      ],
    });
    sessions = app.get(SessionService);
    csrf = await fetchCsrfToken(app);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await owner?.end();
    await pg?.stop();
    await redis?.stop();
    await rm(STORE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 每个用例从空制品库开始：「零残留」这类断言需要一个已知的起点。
    await rm(STORE_DIR, { recursive: true, force: true });
    store.substitute = null;
  });

  /**
   * 造一个**真用户**（不是随手编的字符串）：`Asset.ownerId` 与 `AssetVersion.uploadedById`
   * 都是 `uuid` 列，而「上传者即所有人」这条裁定要落在真实的用户身份上。
   */
  async function createUser(): Promise<string> {
    return (await prisma.user.create({ data: {} })).id;
  }

  /** 造一条真实的会话 cookie（走 `SessionService`，与生产同一条路）。 */
  async function login(userId: string): Promise<string> {
    const { sessionId } = await sessions.create(userId, { ip: '127.0.0.1', userAgent: 'vitest' });
    return `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`;
  }

  /** 真实 multipart 上传（带会话与双提交令牌；字段名与控制器一致）。 */
  function upload(bytes: Buffer, cookie: string, filename = 'pkg.zip'): request.Test {
    return request(app.getHttpServer())
      .post('/assets/upload')
      .set('Cookie', cookie)
      .set(CSRF_HEADER, csrf)
      .attach('file', bytes, filename);
  }

  /** 签发（写操作：缺 CSRF 令牌会是 403，而不是授权结论）。 */
  function issue(versionId: string, cookie: string): request.Test {
    return request(app.getHttpServer())
      .post(`/assets/versions/${versionId}/download-url`)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, csrf);
  }

  it('上传一个合法包：Asset + AssetVersion + AssetMetadata 三行落库，所有人是上传者，响应给出两个 id', async () => {
    const uploader = await createUser();
    const cookie = await login(uploader);
    const plaintext = sampleBytes('ok.zip');
    const assetsBefore = await prisma.asset.count();

    const res = await upload(plaintext, cookie);
    const body = res.body as Record<string, unknown>;

    expect(res.status, `响应体=${res.text}`).toBe(201);
    /**
     * **响应里有可以据以行动的东西**：`assetId`（这次上传诞生的作品）与
     * `assetVersionId`（凭它去签发下载）。Task 1 的 `{key, bytes}` 里那个存储键
     * 是服务端内部状态，一个字节都不该出现在这里——下面两条断言把它钉住。
     */
    expect(Object.keys(body).sort()).toEqual(['assetId', 'assetVersionId', 'kind', 'plaintextBytes', 'sha256']);
    expect(body.sha256).toBe(sha256(plaintext));
    expect(body.plaintextBytes).toBe(plaintext.length);
    expect(body.kind).toBe('zip');
    const assetId = body.assetId as string;
    const versionId = body.assetVersionId as string;
    expect(assetId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(versionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(res.text).not.toContain('storageKey');
    expect(res.text).not.toContain('fileId');
    expect(res.text).not.toContain(STORE_DIR);

    // ① 作品：**这次上传新建了一个**（不是复用别人的），所有人是上传者本人。
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.ownerId, '新作品的所有人不是上传者').toBe(uploader);
    await expect(prisma.asset.count()).resolves.toBe(assetsBefore + 1);

    // ② 版本：指向那个作品，字段来自**写入侧**（明文长度与明文摘要，不是密文对象的）。
    const version = await prisma.assetVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.assetId).toBe(assetId);
    expect(version.sha256).toBe(sha256(plaintext));
    expect(version.plaintextBytes).toBe(plaintext.length);
    expect(version.uploadedById).toBe(uploader);
    expect(version.keyId).toBe(testEnv.ARTIFACT_ACTIVE_KEY_ID);
    // 存储键确实指向盘上那个对象，而它不是明文长度（两者必须不同，否则那条断言是空话）
    const onDisk = await store.stat(version.storageKey);
    expect(onDisk.bytes).toBeGreaterThan(version.plaintextBytes);
    await expect(listObjects(STORE_DIR)).resolves.toEqual([`${version.storageKey.slice(0, 2)}/${version.storageKey.slice(2, 4)}/${version.storageKey}`]);

    // ③ 元数据：Task 6 解析出来的那一行。期望值是**样本自己的内容**（地面真值，
    //    见 `fixtures/archives/generate.ts` 的 `ok.zip`），不是从被测代码里回读的。
    const metadata = await prisma.assetMetadata.findUniqueOrThrow({ where: { assetVersionId: versionId } });
    expect(metadata.readmeExcerpt).toContain('# demo');
    expect(metadata.fileTree).toEqual([
      { path: 'README.md', bytes: Buffer.byteLength('# demo\n\n一个正常的归档。\n') },
      { path: 'src/index.ts', bytes: Buffer.byteLength('export const answer = 42;\n'.repeat(8)) },
    ]);
    expect(metadata.completeness).toBeGreaterThanOrEqual(0);
  });

  it('属主签发并下载：拿回来的字节与上传的明文**逐字节相同**', async () => {
    const uploader = await createUser();
    const cookie = await login(uploader);
    const plaintext = sampleBytes('ok.tar.gz');

    const uploaded = await upload(plaintext, cookie, 'pkg.tar.gz');
    expect(uploaded.status, `响应体=${uploaded.text}`).toBe(201);
    const versionId = (uploaded.body as { assetVersionId: string }).assetVersionId;

    // 签发（D10：≤5 分钟、单次有效的签名链接）
    const issued = await issue(versionId, cookie);
    expect(issued.status, `响应体=${issued.text}`).toBe(200);
    const url = (issued.body as { url?: string }).url ?? '';
    expect(url.startsWith('/assets/download?')).toBe(true);

    // 兑换：**签名就是凭证**，不带任何会话 cookie。
    const downloaded = await redeem(app, url);
    expect(downloaded.status, `响应体=${downloaded.text}`).toBe(200);
    expect(downloaded.headers['content-type']).toBe('application/gzip');
    const bytes = responseBytes(downloaded);
    expect(bytes.length, `下载到 ${bytes.length} 字节，上传的是 ${plaintext.length} 字节`).toBe(plaintext.length);
    expect(bytes.equals(plaintext), '下载回来的字节与上传的明文不一致').toBe(true);

    // 下载留下了审计（判据 9 的成功那一半）
    const rows = await prisma.auditLog.findMany({ where: { resourceId: versionId, action: 'asset.download' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(uploader);

    // 单次使用：同一张票再用一次必须被拒（D10）——顺带钉住「下载走的是真的票据原语」
    const replay = await redeem(app, url);
    expect(replay.status).toBe(403);
    expect(errorBody(replay).code).toBe('ASSET_DOWNLOAD_TICKET_REPLAYED');
    expect(responseBytes(replay).includes(plaintext.subarray(0, 16))).toBe(false);
  });

  it('非属主：拿不到签名 URL（403），响应里没有任何链接', async () => {
    const uploader = await createUser();
    const stranger = await createUser();
    const plaintext = sampleBytes('ok.zip');

    const uploaded = await upload(plaintext, await login(uploader));
    expect(uploaded.status, `响应体=${uploaded.text}`).toBe(201);
    const versionId = (uploaded.body as { assetVersionId: string }).assetVersionId;

    const res = await issue(versionId, await login(stranger));

    expect(res.status, `响应体=${res.text}`).toBe(403);
    expect((res.body as { code?: string }).code).toBe('ASSET_DOWNLOAD_NOT_AUTHORIZED');
    expect(res.text).not.toContain('/assets/download?');
    // 「拿不到链接」与「下载被拒」是两件事，这里把前者钉死在库上：**那串 URL 从来没有被签出来**
    // （判据是**零**行 `asset.download_url_issued`，而不是「响应里没有」——后者只说明这一条响应）。
    await expect(
      prisma.auditLog.count({ where: { resourceId: versionId, action: 'asset.download_url_issued' } }),
    ).resolves.toBe(0);
    // 而这次尝试留下了它自己那一行（失败也写：判据 9 的失败那一半）
    await expect(
      prisma.auditLog.count({ where: { resourceId: versionId, action: 'asset.download_denied' } }),
    ).resolves.toBe(1);
  });

  for (const name of ['symlink.zip', 'fake-mime.zip'] as const) {
    it(`恶意样本 ${name}：422 + 库里没有作品/版本行 + 制品库零残留`, async () => {
      const uploader = await createUser();
      const cookie = await login(uploader);
      const assetsBefore = await prisma.asset.count();
      const versionsBefore = await prisma.assetVersion.count();
      const metadataBefore = await prisma.assetMetadata.count();

      const res = await upload(sampleBytes(name), cookie);

      expect(res.status, `响应体=${res.text}`).toBe(422);
      expect((res.body as { code?: string }).code).toBe('ASSET_ARCHIVE_REJECTED');
      // **校验之前不建作品**：被拒的上传在库里一个字节的行都不留。
      // 三句都用**前后差值**（库级计数在同文件前面的用例里已经被改过，直接断言 0 是同义反复）。
      await expect(prisma.asset.count({ where: { ownerId: uploader } })).resolves.toBe(0);
      await expect(prisma.asset.count()).resolves.toBe(assetsBefore);
      await expect(prisma.assetVersion.count()).resolves.toBe(versionsBefore);
      // 而且没有「没有版本记录的作品」这种半成品
      await expect(prisma.assetMetadata.count()).resolves.toBe(metadataBefore);
      // D1 第 3 条：拒绝 ⇒ 刚写进去的密文对象被删掉（零残留）
      await expect(listObjects(STORE_DIR)).resolves.toEqual([]);
    });
  }

  /**
   * **落库失败时的处置**（本任务必须明确选一个，这就是选定的那个）。
   *
   * 校验通过、元数据也解析出来了，但版本行写不进去（这里注入的是一个真实的失败：
   * 把运行时角色对 `asset_versions` 的 `INSERT` 收掉）。此刻制品库里有一个**没有任何行
   * 指向它**的密文对象——它与「校验不通过」的那份孤儿是同一个东西，因此走**同一条**处置：
   * 调用**唯一**的删除出口（`AssetService.delete`，它自带重试 → 审计 → 500），然后回 500。
   *
   * 判据有两半：HTTP 上是 500（不是 4xx——这是服务端故障，别说成「你上传的东西不行」），
   * 制品库与库表**都是空的**（没有孤儿对象，也没有半成品作品）。
   */
  it('落库失败：500 + 密文对象被删掉 + 没有任何行留下（不留没有 DB 行的孤儿）', async () => {
    const uploader = await createUser();
    const cookie = await login(uploader);
    const assetsBefore = await prisma.asset.count();
    const versionsBefore = await prisma.assetVersion.count();
    const metadataBefore = await prisma.assetMetadata.count();

    await owner.query(`REVOKE INSERT ON asset.asset_versions FROM app_user`);
    let res: request.Response;
    try {
      res = await upload(sampleBytes('ok.zip'), cookie);
    } finally {
      await owner.query(`GRANT INSERT ON asset.asset_versions TO app_user`);
    }

    expect(res.status, `响应体=${res.text}`).toBe(500);
    expect((res.body as { code?: string }).code).toBe('ASSET_PERSIST_FAILED');

    // 负后果：**孤儿密文不存在**（那份制品没有任何行指向它，留着只会攒下永远下不来的对象）
    await expect(listObjects(STORE_DIR)).resolves.toEqual([]);
    // 事务整体回滚：连作品那一行也不留（半成品作品比没有作品更糟）。同样是**前后差值**
    // ——本文件前面的用例已经在库里留下过行，断言库级 0 是同义反复。
    await expect(prisma.asset.count({ where: { ownerId: uploader } })).resolves.toBe(0);
    await expect(prisma.asset.count()).resolves.toBe(assetsBefore);
    await expect(prisma.assetVersion.count()).resolves.toBe(versionsBefore);
    await expect(prisma.assetMetadata.count()).resolves.toBe(metadataBefore);

    // 反面对照：权限恢复之后同一份包能正常上传（否则上面那句在「怎么都失败」的实现上也绿）
    const retry = await upload(sampleBytes('ok.zip'), cookie);
    expect(retry.status, `响应体=${retry.text}`).toBe(201);
    await expect(prisma.asset.count({ where: { ownerId: uploader } })).resolves.toBe(1);
  });

  /**
   * **带外长度核对必须在这条链路上承重**（Task 5 / Task 7 两次移交的那条义务）。
   *
   * 造法：走**真实 HTTP 上传**（`ok.zip`）落一条版本记录，然后把**盘上那个对象**换成
   * 另一份更短、完全自洽的制品（另一份合法归档加密出来的产物：末块标记正确、
   * 三条完整性校验全过、`open()` 成功）。只有**库里那个明文长度**能挡住它。
   *
   * 正面对照在同一个用例里：把那一列也改成替换制品的长度之后，下载必须成功并**原样**
   * 发出那份更短的制品。少了这半句，前面那句可能只是「任何被换过的制品都会被拒」，
   * 而不是「这条核对真的在承重」。
   */
  it('制品在静止状态被换成更短的：带外长度核对拒绝它（422 + 零字节）；把长度改对则 200', async () => {
    const uploader = await createUser();
    const cookie = await login(uploader);
    const plaintext = sampleBytes('ok.zip');
    const replacementPlaintext = buildZip([{ name: 'tiny.txt', data: Buffer.from('更短的一份合法归档\n') }]);
    expect(replacementPlaintext.length).toBeLessThan(plaintext.length);

    const uploaded = await upload(plaintext, cookie);
    expect(uploaded.status, `响应体=${uploaded.text}`).toBe(201);
    const versionId = (uploaded.body as { assetVersionId: string }).assetVersionId;
    const version = await prisma.assetVersion.findUniqueOrThrow({ where: { id: versionId } });

    // 把盘上那份换成**更短、完全自洽**的制品（用环境里的密钥环真实加密出来的字节）
    const seeded = await seedArtifact(new MemoryStore(), replacementPlaintext, { ring: ringFromEnv() });
    store.substitute = { key: version.storageKey, bytes: seeded.artifact };

    const issued = await issue(versionId, cookie);
    expect(issued.status, `响应体=${issued.text}`).toBe(200);
    const rejected = await redeem(app, (issued.body as { url: string }).url);

    expect(rejected.status, `响应体=${rejected.text}`).toBe(422);
    expect(errorBody(rejected).code).toBe('ASSET_ARCHIVE_REJECTED');
    // 核对发生在**写出第一个字节之前**：响应体里一个制品的字节都没有
    const rejectedBody = responseBytes(rejected);
    expect(rejectedBody.length).toBeLessThan(1024);
    expect(rejectedBody.includes(replacementPlaintext.subarray(0, 16))).toBe(false);
    expect(rejectedBody.includes(plaintext.subarray(0, 16))).toBe(false);
    // 下载路径**不删**对象：那是一份已经被版本记录引用的制品（删它等于销毁证据）
    await expect(store.stat(version.storageKey)).resolves.toMatchObject({ bytes: seeded.artifact.length });

    // 正面对照：把那一列改成替换制品的明文长度 ⇒ 同一次替换必须**成功**发出那份更短的制品
    await prisma.assetVersion.update({
      where: { id: versionId },
      data: { plaintextBytes: replacementPlaintext.length },
    });
    const reissued = await issue(versionId, cookie);
    expect(reissued.status, `响应体=${reissued.text}`).toBe(200);
    const accepted = await redeem(app, (reissued.body as { url: string }).url);

    expect(accepted.status, `响应体=${accepted.text}`).toBe(200);
    const acceptedBytes = responseBytes(accepted);
    expect(acceptedBytes.equals(replacementPlaintext), '把长度改对之后仍然没发出那份更短的制品').toBe(true);
    expect(accepted.headers['content-type']).toBe('application/zip');
  });
});
