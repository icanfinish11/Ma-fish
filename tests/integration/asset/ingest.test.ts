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
  let prisma: PrismaService;
  let store: ArtifactStore;
  let assets: AssetService;
  let csrf: string;
  let sessionId: string;
  /** 会话用户的序号：`upload` 限流是 **10 次/天/用户**，每个用例一个用户才不会被上一条用例透支。 */
  let userSeq = 0;

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
});
