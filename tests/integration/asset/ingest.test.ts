import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../../helpers/app.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { testEnv } from '../../helpers/env.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';
import { ARTIFACT_STORE, type ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';
import { ArchiveRejectedError, AssetService } from '@vca/api/modules/asset/asset.service.js';
import { decodeHeader } from '@vca/api/modules/asset/crypto/artifact-format.js';
import { createKeyRing, type KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
import { ARCHIVE_SAMPLES } from '../../fixtures/archives/generate.js';

/**
 * 「加密即入库」流程（P1 / Task 5；设计决定 D1 + C19/C21）。
 *
 * ## 这一组跑的是**真实**制品库（不是内存替身）
 *
 * 「恶意样本零残留」和「明文不落盘」这两条判据在内存储上**恒真**，证明不了任何东西
 * （Task 4 的报告 §5 有同样的记载）。因此这里注入的制品库是 `LocalArtifactStore`
 * ——真实目录、真实文件，`storedObjects()` 直接列目录来数对象。
 *
 * ## 两条半边（为什么不是一个大方法）
 *
 * 上传流由 multer 的存储引擎接走并**立刻加密写入**（`putStream`，D1 第 1 条），
 * 而校验需要一个已经写完的制品（zip 的中央目录在**末尾**，单趟前向流读不到）。
 * 于是流程天然分成两半，`AssetService` 的两个方法就是这两半：
 *
 * 1. `putStream(source, { maxBytes })`：边收边加密、边数明文、边算 sha256，写进制品库；
 * 2. `finalize(write, { uploadedById })`：打开解密读取器 → **先认证末块**（Task 4 Step 0b）
 *    → `validateArchive`（带**写入侧**的明文长度做交叉核对）→ 拒绝就删掉密文对象。
 *
 * 两半合起来就是 brief 的那条流水线；HTTP 路径由 `AssetController` 依次调用它们。
 *
 * ## 明文长度的**来源**（Task 4 §9.2 的移交义务）
 *
 * 格式里**没有任何字段认证制品有多长**：`plaintextLength` 是制品**自称**的值（在尾部，
 * 且不在任何 AAD 里）。因此这里传给 `validateArchive` 的 `expectedPlaintextLength`
 * **只能**是 `putStream` 在加密过程中数出来的**明文字节数**——既不是密文对象的字节数，
 * 也不是上传元数据里的任何数。用例里有一条正对着这个陷阱的断言：
 * `receipt.plaintextBytes !== upload.bytes`（后者是制品对象的字节数，两者必然不等）。
 */
const STORE_DIR = process.env.ARTIFACT_STORE_DIR as string;
const MAX_UPLOAD_BYTES = Number(testEnv.ARTIFACT_MAX_UPLOAD_BYTES);

/**
 * 真库客户端与用户序号放在**模块级**：两组用例（正常流程 / 删除失败处置）各自引导一个应用，
 * 但共用同一个 testcontainer 与同一份用户序号，免得两处各写一份。
 */
let prisma: PrismaService;
/** 会话用户的序号：`upload` 限流是 **10 次/天/用户**，每个用例一个用户才不会被上一条用例透支。 */
let userSeq = 0;

/** 样本字节（八样本表；惰性生成，这里取一份）。 */
function sampleBytes(name: string): Buffer {
  const sample = ARCHIVE_SAMPLES.find((item) => item.name === name);
  if (sample === undefined) throw new Error(`八样本表里没有 ${name}`);
  return sample.bytes();
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 环境夹具里的密钥环（与 `AssetService` 构造期用的是同一份输入）。 */
function keyRingFromEnv(): KeyRing {
  return createKeyRing({
    ARTIFACT_KEYS: testEnv.ARTIFACT_KEYS,
    ARTIFACT_ACTIVE_KEY_ID: testEnv.ARTIFACT_ACTIVE_KEY_ID,
  });
}

/** 把一段流收成 Buffer。 */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** 制品库里现有的文件（相对路径 + 字节数）。列目录而不是猜路径，才数得准残留。 */
async function storedObjects(): Promise<Array<{ name: string; size: number }>> {
  const names = await readdir(STORE_DIR, { recursive: true, withFileTypes: false }).catch(() => [] as string[]);
  const out: Array<{ name: string; size: number }> = [];
  for (const name of names) {
    const info = await stat(join(STORE_DIR, name)).catch(() => null);
    if (info?.isFile()) out.push({ name: name.split('\\').join('/'), size: info.size });
  }
  return out;
}

describe('加密即入库（D1）：上传流 → 加密写制品库 → 校验 → 拒绝则删对象', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let store: ArtifactStore;
  let assets: AssetService;
  let csrf: string;
  let sessionId: string;

  beforeAll(async () => {
    await rm(STORE_DIR, { recursive: true, force: true });
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
      ],
    });
    store = app.get<ArtifactStore>(ARTIFACT_STORE);
    assets = app.get(AssetService);
    csrf = await fetchCsrfToken(app);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
    await rm(STORE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(STORE_DIR, { recursive: true, force: true });
    userSeq += 1;
    sessionId = (
      await app.get(SessionService).create(`user-ingest-${userSeq}`, { ip: '127.0.0.1', userAgent: 'vitest' })
    ).sessionId;
  });

  /** 真实 multipart 上传（带会话与 CSRF 令牌；字段名与控制器一致）。 */
  function uploadOverHttp(bytes: Buffer, filename = 'pkg.zip'): request.Test {
    return request(app.getHttpServer())
      .post('/assets/upload')
      .set('Cookie', `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .attach('file', bytes, filename);
  }

  it('写入侧：制品库里是一个**密文**对象，回执里的明文长度与 sha256 是写入端自己数出来的', async () => {
    const plaintext = sampleBytes('ok.zip');

    const upload = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });

    // 落盘的是**密文**：字节数比明文多（头 + 每块的 tag + 索引 + 尾部），内容也不再是明文。
    const onDisk = await store.stat(upload.key);
    expect(onDisk.bytes).toBe(upload.bytes);
    expect(onDisk.bytes).toBeGreaterThan(plaintext.length);

    // 明文长度来自写入侧计数，**不是**制品的字节数（两者必须不同，否则下面那条断言是空话）
    expect(upload.receipt.plaintextBytes).toBe(plaintext.length);
    expect(upload.receipt.plaintextBytes).not.toBe(upload.bytes);
    expect(upload.receipt.sha256).toBe(sha256(plaintext));

    // keyId 来自环境的**活动**键（不是写死的默认键），fileId 与制品头里的那一份一致
    const artifact = await store.getRange(upload.key, 0, onDisk.bytes - 1);
    const { header } = decodeHeader(artifact);
    expect(header.keyId).toBe(testEnv.ARTIFACT_ACTIVE_KEY_ID);
    expect(upload.receipt.keyId).toBe(header.keyId);
    expect(upload.receipt.fileId).toBe(header.fileId.toString('hex'));

    // 明文不落盘的另一半：目录里**只有**这一个对象（没有任何临时/明文副本）
    const objects = await storedObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0]?.size).toBe(onDisk.bytes);
  });

  it('校验通过：给出待落库的版本记录，其中的明文长度就是写入侧的那个数', async () => {
    const plaintext = sampleBytes('ok.zip');
    const upload = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });

    const version = await assets.finalize(upload, { uploadedById: 'user-1' });

    expect(version).toEqual({
      storageKey: upload.key,
      sha256: sha256(plaintext),
      plaintextBytes: plaintext.length,
      keyId: testEnv.ARTIFACT_ACTIVE_KEY_ID,
      fileId: upload.receipt.fileId,
      kind: 'zip',
      uploadedById: 'user-1',
    });
    // 记录里的明文长度**不可能**是密文对象长度：这是 Task 4 §9.2 点名的那个口径错误。
    expect(version.plaintextBytes).not.toBe((await store.stat(upload.key)).bytes);
    // 通过校验的制品留在制品库里（拒绝路径才删）；此时库里恰好一个对象
    await expect(storedObjects()).resolves.toHaveLength(1);
  });

  it('往返一致：制品库里那份**密文**解回来与上传的字节逐字节相同', async () => {
    const plaintext = sampleBytes('ok.zip');
    const upload = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });
    await assets.finalize(upload, { uploadedById: null });

    // 用**环境里的密钥环**重新打开（这正是将来下载路径要做的事：按头里的 keyId 选键）。
    // 它同时证明「明文从不落盘」的那一半：能从密文里读回来的，只有真正被加密进去的那份。
    const reader = await EncryptedArtifactReader.open(store, upload.key, keyRingFromEnv());
    const restored = await collect(reader.createReadStream({ start: 0, end: reader.plaintextLength }));

    expect(restored.equals(plaintext), '解回来的字节与上传的不一致').toBe(true);
    expect(restored).toHaveLength(plaintext.length);
  });

  for (const name of ['symlink.zip', 'zip-slip.zip', 'fake-mime.zip']) {
    it(`恶意样本 ${name}：拒绝、密文对象被删除、不给出任何记录`, async () => {
      const plaintext = sampleBytes(name);
      const upload = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });

      // 先证明对象**确实写进去过**——否则「跑完没有残留」这条断言在没有写入时也成立。
      await expect(store.stat(upload.key)).resolves.toMatchObject({ bytes: expect.any(Number) });
      await expect(storedObjects()).resolves.toHaveLength(1);

      const error = await assets.finalize(upload, { uploadedById: null }).catch((thrown: unknown) => thrown);

      expect(error, `期望被拒，实际拿到 ${String(error)}`).toBeInstanceOf(ArchiveRejectedError);
      const rejection = error as ArchiveRejectedError;
      // 拒绝理由必须落在**具体的控制**上（不是「反正拒了」）
      expect(rejection.reason.length).toBeGreaterThan(0);
      if (name === 'symlink.zip') expect(rejection.reason).toContain('符号链接');
      if (name === 'fake-mime.zip') expect(rejection.reason).toContain('png');

      // D1 第 3 条：拒绝 ⇒ 删掉已写入的密文对象；制品库里零残留
      await expect(store.stat(upload.key)).rejects.toThrow();
      await expect(storedObjects()).resolves.toEqual([]);
    });
  }

  it('HTTP：合法 zip 走完上传 → 201 + 版本记录（**不含**存储键）+ 制品库里只有一个密文对象', async () => {
    const plaintext = sampleBytes('ok.zip');

    const res = await uploadOverHttp(plaintext);
    const body = res.body as Record<string, unknown>;

    expect(res.status, `响应体=${res.text}`).toBe(201);
    // 响应就是「作品/版本记录」的那三个非内部字段（Task 1 的 {key, bytes} 临时形态到此结束）
    expect(body).toEqual({ sha256: sha256(plaintext), plaintextBytes: plaintext.length, kind: 'zip' });
    // 存储键属于服务端内部状态，**不**出现在响应里（Task 1 的控制器注释把这条写成了 Task 5 的义务）
    expect(JSON.stringify(body)).not.toContain('storageKey');
    expect(JSON.stringify(body)).not.toContain('fileId');

    // 落盘的是密文：目录里恰好一个对象，而且它比明文大（头 + tag + 索引 + 尾部）
    const objects = await storedObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0]?.size).toBeGreaterThan(plaintext.length);
  });

  it('HTTP：恶意样本 → 4xx + 制品库零残留 + 响应里没有任何元数据', async () => {
    const plaintext = sampleBytes('fake-mime.zip');

    const res = await uploadOverHttp(plaintext);
    const body = res.body as Record<string, unknown>;

    expect(res.status, `响应体=${res.text}`).toBe(422);
    expect(body.code).toBe('ASSET_ARCHIVE_REJECTED');
    // 类型在被拒时是 unknown：**没走到嗅探就不该声称知道类型**（Task 4 的契约）
    expect(body.kind).toBe('unknown');
    expect(String(body.reason)).toContain('png');
    // 被拒的上传不返回任何元数据
    expect(body).not.toHaveProperty('sha256');
    expect(body).not.toHaveProperty('plaintextBytes');
    await expect(storedObjects()).resolves.toEqual([]);
  });

  /**
   * **删除密文对象失败时的处置**（规格 §5 第 3 条；brief 的「先验再做」第 1 条）。
   *
   * ## 选定：同步重试 N 次 → 记审计 → 抛错（500）
   *
   * 三个候选（同步重试+审计 / 待清理标记 + worker 兜底 / 两者结合）里，**前两个在本仓库里是同一件事**：
   *
   * - 「重试」在当下就能救回绝大多数瞬时失败（卷忙、杀软短暂占用、fd 没释放）；
   * - 「待清理标记」需要一个**持久**的落点，而新建一张清理表是 **Task 7** 的 schema 所有权
   *   （本任务明令不得自造 schema）。今天唯一现成的、持久的、append-only 的、可查询的落点就是
   *   `audit_logs`——于是一行 `asset.artifact.cleanup_failed` 审计**同时就是那个标记**：
   *   `resource_id` 是被留下的对象键（UUIDv7），运维与将来的 worker 可以按 `action` 扫出来清掉。
   *   这就是「两者结合」，却没有自造任何表；
   * - 最后仍然**抛错**（控制器回 500）：清理失败意味着制品库里多了一个没有版本记录的孤儿，
   *   这时回 4xx 会把「服务端没清干净」说成「你上传的东西不行」。
   *
   * 失败的可见性因此有两层：可检索的审计行（持久）+ 500（当下）——**绝不静默吞掉**。
   *
   * ## 为什么注入的是「包装过的真实存储」
   *
   * 只把 `delete` 换成会失败的实现，写入 / 读取 / 解密 / 校验走的全是真实实现：
   * 这样「拒绝路径要不要删、删几次、删不掉之后留下什么」才是被真正观测的东西。
   */
  describe('删除密文对象失败时的处置（重试 → 审计 → 500）', () => {
    let failingApp: INestApplication;
    let failing: DeleteFailingStore;
    let failingSession: string;
    let failingCsrf: string;

    beforeAll(async () => {
      failing = new DeleteFailingStore(new LocalArtifactStore(STORE_DIR));
      failingApp = await createTestApp({
        overrides: [
          // 复用本文件已经起好的 Redis 与真库；唯一的差别是制品库换成一个「删除会失败」的包装
          (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
          (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
          (builder) => builder.overrideProvider(ARTIFACT_STORE).useValue(failing),
        ],
      });
      failingCsrf = await fetchCsrfToken(failingApp);
    }, 240_000);

    afterAll(async () => {
      await failingApp?.close();
    });

    beforeEach(async () => {
      failing.failTimes = 0;
      failing.deleteCalls = 0;
      userSeq += 1;
      failingSession = (
        await failingApp
          .get(SessionService)
          .create(`user-cleanup-${userSeq}`, { ip: '127.0.0.1', userAgent: 'vitest' })
      ).sessionId;
    });

    it('第一次删除失败、重试成功：仍然回 4xx，对象被删掉，且**没有**审计行', async () => {
      failing.failTimes = 1; // 只有第一次失败

      const res = await request(failingApp.getHttpServer())
        .post('/assets/upload')
        .set('Cookie', `${SESSION_COOKIE}=${failingSession}; ${CSRF_COOKIE}=${failingCsrf}`)
        .set(CSRF_HEADER, failingCsrf)
        .attach('file', sampleBytes('fake-mime.zip'), 'pkg.zip');

      expect(res.status, `响应体=${res.text}`).toBe(422);
      expect(failing.deleteCalls, '删除只试了一次——重试没有发生').toBeGreaterThanOrEqual(2);
      await expect(storedObjects()).resolves.toEqual([]);
      const rows = await prisma.auditLog.findMany({ where: { action: 'asset.artifact.cleanup_failed' } });
      expect(rows, '重试成功之后不该留下「清理失败」的审计行').toHaveLength(0);
    });

    it('三次都失败：留下审计行（含对象键与尝试次数）并回 500，对象仍在库里', async () => {
      failing.failTimes = Number.POSITIVE_INFINITY;

      const res = await request(failingApp.getHttpServer())
        .post('/assets/upload')
        .set('Cookie', `${SESSION_COOKIE}=${failingSession}; ${CSRF_COOKIE}=${failingCsrf}`)
        .set(CSRF_HEADER, failingCsrf)
        .attach('file', sampleBytes('fake-mime.zip'), 'pkg.zip');

      expect(res.status, `响应体=${res.text}`).toBe(500);
      expect((res.body as { code?: string }).code).toBe('ASSET_ARTIFACT_CLEANUP_FAILED');
      // 同步重试了 3 次（不是试一次就放弃）
      expect(failing.deleteCalls).toBe(3);

      // 对象**仍在**制品库里：这正是需要被看见、被兜底清掉的那个孤儿
      const leftovers = await storedObjects();
      expect(leftovers).toHaveLength(1);
      const key = leftovers[0]?.name.split('/').pop() ?? '';
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

      // 可观测痕迹：一行 append-only 审计（它同时就是「待清理标记」，见本组用例的说明）
      const rows = await prisma.auditLog.findMany({ where: { action: 'asset.artifact.cleanup_failed' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resourceId).toBe(key);
      expect(rows[0]?.resource).toBe('AssetArtifact');
      expect(rows[0]?.metadata).toMatchObject({ attempts: 3, errorName: 'Error' });
    });
  });
});

/**
 * 制品库替身：**读路径全部委派**给真实存储，只有 `delete` 按注入的次数失败。
 *
 * 这是**故障注入**，不是把依赖换成假的：密文的写入、读取、解密与校验走的都是真实实现，
 * 被注入的只有「删除会不会失败」这一件事——而它正是那组用例的判据。
 */
class DeleteFailingStore implements ArtifactStore {
  /** 还会失败几次（每次 delete 先扣减）。`Infinity` = 一直失败。 */
  failTimes = 0;
  deleteCalls = 0;

  constructor(private readonly inner: ArtifactStore) {}

  putStream(source: Readable, opts: { maxBytes: number }): ReturnType<ArtifactStore['putStream']> {
    return this.inner.putStream(source, opts);
  }

  getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    return this.inner.getRange(key, start, endInclusive);
  }

  stat(key: string): Promise<{ bytes: number }> {
    return this.inner.stat(key);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls += 1;
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error('注入的删除失败：卷不可写');
    }
    return this.inner.delete(key);
  }
}

