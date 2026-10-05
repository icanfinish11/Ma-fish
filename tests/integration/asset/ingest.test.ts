import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
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
import { ARTIFACT_STORE, ArtifactTooLargeError, type ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';
import { ArchiveRejectedError, ArtifactUnreadableError, AssetService } from '@vca/api/modules/asset/asset.service.js';
import {
  FOOTER_BYTES,
  decodeFooter,
  decodeHeader,
  encodeFooter,
} from '@vca/api/modules/asset/crypto/artifact-format.js';
import { createKeyRing, type KeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
import { MemoryStore, seedArtifact } from '../../helpers/craft-encrypted-artifact.js';
import { ARCHIVE_SAMPLES, buildZip } from '../../fixtures/archives/generate.js';

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

/**
 * 制品对象的**磁盘路径**（`LocalArtifactStore` 的分片布局：`<root>/<前2位>/<次2位>/<键>`）。
 *
 * 测试里直接改盘上的字节，是因为存储端口**刻意没有**覆写 API——写入端不该能改写已有的对象。
 * 而「制品在静态存储上被攻击者/损坏改写」正是要模拟的威胁形态，所以这里落到文件系统。
 */
function objectPath(key: string): string {
  return join(STORE_DIR, key.slice(0, 2), key.slice(2, 4), key);
}

/** 改写盘上某个对象（`mutate` 拿旧字节、给新字节）。 */
async function rewriteObject(key: string, mutate: (artifact: Buffer) => Buffer): Promise<void> {
  await writeFile(objectPath(key), mutate(await readFile(objectPath(key))));
}

/** 在**内存里**生成一份完全自洽的制品字节（真实加密器 + 环境里的密钥环，不碰存储）。 */
async function buildArtifactBytes(plaintext: Buffer): Promise<Buffer> {
  const seeded = await seedArtifact(new MemoryStore(), plaintext, { ring: keyRingFromEnv() });
  return seeded.artifact;
}

/**
 * 递归列出一个目录下的全部**文件**（绝对路径）。
 *
 * **逐个目录容错**（而不是对整棵树用一次 `readdir(recursive)`）：系统临时目录里往往有
 * 读不进去的子目录（权限、正在被别的进程使用），而 `recursive: true` 下**任何一处**失败
 * 都会让整次调用被拒——那会让探测器静默地什么都找不到（本用例第一版就撞上了它，
 * 是下面那条「哨兵必须被找到」的自检把它揪出来的）。
 */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

/**
 * 找出「**新出现**且内容里含这段明文标记」的文件。
 *
 * 这是 C21 的探测器：明文一旦以文件形式落过盘（临时文件、副本、缓存），它必然出现在
 * 这段时间内新增的文件里。只扫**新增**文件，因此别的进程往临时目录里写东西不会造成噪音；
 * 判据是内容，所以「名字随机、扩展名不同」的临时文件也躲不掉。
 */
async function newFilesContaining(root: string, known: ReadonlySet<string>, marker: Buffer): Promise<string[]> {
  const found: string[] = [];
  for (const file of await listFiles(root)) {
    if (known.has(file)) continue;
    // 超过 8 MiB 的新文件跳过（本用例的上传只有几 KB，任何相关写入都远小于它）
    const info = await stat(file).catch(() => null);
    if (info === null || info.size > 8 * 1024 * 1024) continue;
    const bytes = await readFile(file).catch(() => null);
    if (bytes?.includes(marker) === true) found.push(file);
  }
  return found;
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

/** 采样流的替身：先给一段字节，再多给若干字节（用来踩「恰好超一个字节」这类边界）。 */
function chunkedStream(bytes: Buffer, total: number): Readable {
  return Readable.from([bytes, Buffer.alloc(total - bytes.length, 7)]);
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
    // 直接的内容判据：整份明文**不在**对象里（大小关系只是弱信号，密文里不该出现明文）
    expect(artifact.includes(plaintext), '制品对象里出现了明文').toBe(false);
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

  it('并发上传：每个请求各自一个读取器，互不串味（Task 4 的约束 4：绝不池化读取器）', async () => {
    /**
     * 读取器最多在内存里留**一块明文**（生产 8 MiB）。「一次请求一个读取器」今天靠的是
     * 结构（读取器是 `finalize` 的局部变量，服务里没有任何字段持有它），而没有运行期强制；
     * 这条用例是它的**行为判据**：四条上传并发跑完，每一条拿到的明文长度 / 摘要 / 类型
     * 都必须是**它自己那份**——若读取器被池化或共享，块 memo 会串味，结论随即错位。
     */
    const inputs = [
      sampleBytes('ok.zip'),
      sampleBytes('ok.tar.gz'),
      buildZip([{ name: 'other.txt', data: Buffer.from('另一份 zip，长度不同\n') }]),
      sampleBytes('ok.tar.gz'),
    ];

    const results = await Promise.all(
      inputs.map(async (bytes, index) => {
        const upload = await assets.putStream(Readable.from([bytes]), { maxBytes: MAX_UPLOAD_BYTES });
        return { bytes, version: await assets.finalize(upload, { uploadedById: `u${index}` }) };
      }),
    );

    expect(results.map((item) => item.version.kind)).toEqual(['zip', 'tar.gz', 'zip', 'tar.gz']);
    for (const [index, item] of results.entries()) {
      expect(item.version.sha256).toBe(sha256(item.bytes));
      expect(item.version.plaintextBytes).toBe(item.bytes.length);
      expect(item.version.uploadedById).toBe(`u${index}`);
    }
    // 四份互不相同的明文 ⇒ 四个 fileId 各不相同（各自的头，各自的密钥流）
    expect(new Set(results.map((item) => item.version.fileId)).size).toBe(4);
    // 四条都通过了校验 ⇒ 四个对象都留在库里
    await expect(storedObjects()).resolves.toHaveLength(4);

    // **本用例自己收尾**（修复轮 1）：这四条是**接受路径**的产物，不是残留，
    // 留着它们等于把「库是干净的」这件事记在下一条用例的 `beforeEach` 上——
    // 一条用例的起点于是取决于执行顺序，而这正是「无残留」那类断言最怕的形状。
    for (const item of results) await store.delete(item.version.storageKey);
    await expect(storedObjects()).resolves.toEqual([]);
  });

  it('明文限额的边界：恰好 maxBytes 放行，maxBytes + 1 中止且零残留', async () => {
    /**
     * 上限的**口径是明文**（用户上传的字节），而落盘的是密文（比明文大）。
     * 两个量不能共用一个限额：把 `maxBytes` 原样交给存储层，**恰好顶格**的合法上传
     * 会被存储层以 `ArtifactTooLargeError` 拒掉（HTTP 层放行 ⇒ 500 而不是 201）。
     * 这条用例的左半边正是那个边界。
     */
    const exact = sampleBytes('ok.zip');
    const atLimit = await assets.putStream(Readable.from([exact]), { maxBytes: exact.length });
    await expect(assets.finalize(atLimit, { uploadedById: null })).resolves.toMatchObject({ kind: 'zip' });
    await rm(STORE_DIR, { recursive: true, force: true });

    // 右半边：多一个字节就必须**在流中间**中止（不是收完了再判断），且不留残留
    const over = await assets
      .putStream(chunkedStream(exact, exact.length + 1), { maxBytes: exact.length })
      .catch((error: unknown) => error);
    expect(over).toBeInstanceOf(ArtifactTooLargeError);
    await expect(storedObjects()).resolves.toEqual([]);
  });

  it('明文不落盘（C21）：接受与拒绝两条路径跑完，临时目录零新增、制品库新增里也没有明文', async () => {
    /**
     * ## 口径一：**临时目录必须是空的**
     *
     * `os.tmpdir()` 在 Node 里是**每次调用**读 `TMPDIR/TMP/TEMP` 的（实测：进程内改掉之后
     * 立刻生效），因此把这三个变量指向一个**本用例私有的空目录**，「流程里有没有写临时文件」
     * 就变成了一条可断言的判据——不只是「制品库里没有」，而是**系统临时目录里也没有**。
     * 已实测的边界（与 Task 4 §9.2 Concern 3 的记载一致）：硬编码 `/tmp` 的写法绕过这一条。
     *
     * ## 口径二：**内容**（一段随机字节）
     *
     * 名字什么都证明不了（临时文件可以叫任何名字），因此这里用一段 4 KiB 的**随机**字节
     * 做标记：它只可能来自这次上传，出现在哪个新文件里就是明文落盘的直接证据。
     * 探测器本身也有自检（下面的哨兵文件）：恒返回空的探测器什么都证明不了
     * ——本用例第一版就撞上过这件事（整棵树用 `readdir(recursive)` 时一处权限错误
     * 会让它静默地什么都找不到）。
     */
    const secret = randomBytes(4096);
    const plaintext = buildZip([
      { name: 'secret.bin', data: secret },
      { name: 'README.md', data: Buffer.from('# 明文不该落盘（C21）\n') },
    ]);
    const refuse = sampleBytes('symlink.zip');

    const probeTmp = await mkdtemp(join(tmpdir(), 'vca-t5-tmp-'));
    expect(STORE_DIR.startsWith(probeTmp), '制品库不该落在本用例的私有临时目录里').toBe(false);
    const savedEnv = new Map(['TMPDIR', 'TMP', 'TEMP'].map((name) => [name, process.env[name]]));
    const beforeStore = new Set(await listFiles(STORE_DIR));

    try {
      for (const name of savedEnv.keys()) process.env[name] = probeTmp;
      expect(tmpdir(), '临时目录没有切过去——下面那条「零新增」会成为恒真的断言').toBe(probeTmp);

      // 探测器自检：哨兵里放同样的标记，必须被找到
      const canary = join(probeTmp, 'canary.bin');
      await writeFile(canary, Buffer.concat([Buffer.from('哨兵\n'), secret]));
      expect(
        await newFilesContaining(probeTmp, new Set(), secret),
        '探测器找不到哨兵——它对「明文落盘」这件事没有判别力',
      ).toContain(canary);
      await rm(canary, { force: true });

      // ① 接受路径（真实 HTTP：multipart → 加密即入库 → 校验 → 版本记录）
      const accepted = await uploadOverHttp(plaintext);
      expect(accepted.status, `响应体=${accepted.text}`).toBe(201);
      // ② 拒绝路径（同样走完加密与校验，只是结论是被拒）
      const rejected = await uploadOverHttp(refuse);
      expect(rejected.status, `响应体=${rejected.text}`).toBe(422);

      // 临时目录：一个新增都不能有
      const newInTmp = await listFiles(probeTmp);
      expect(newInTmp, `私有临时目录里出现了新文件：${JSON.stringify(newInTmp)}`).toEqual([]);
      // 制品库：新增里没有任何文件含那段明文（密文对象必须不含它）
      const leaked = await newFilesContaining(STORE_DIR, beforeStore, secret);
      expect(leaked, `制品库的新文件里含上传的明文：${JSON.stringify(leaked)}`).toEqual([]);
      // 而制品库里确实多了**一个**对象（密文）——否则上面那条断言可能只是「什么都没写」
      const objects = await storedObjects();
      expect(objects).toHaveLength(1);
      expect(objects[0]?.size).toBeGreaterThan(plaintext.length);
    } finally {
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(probeTmp, { recursive: true, force: true });
    }
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
      failing.lastKey = '';
      failing.failureError = () => new Error('注入的删除失败：卷不可写');
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
      // **按 `resourceId` 过滤**（修复轮 1）：只按 `action` 过滤时，这条断言的正确性依赖
      // 「同组别的用例没有留下同动作的行」——那是一个跨用例的假设。
      // `resource_id` 就是那个刚被删掉的对象键（`resourceId` 的唯一来源是存储键）。
      const rows = await prisma.auditLog.findMany({
        where: { action: 'asset.artifact.cleanup_failed', resourceId: failing.lastKey },
      });
      expect(rows, '重试成功之后不该留下「清理失败」的审计行').toHaveLength(0);
    });

    it('三次都失败：留下审计行（含对象键、尝试次数与**有界的失败类别**）并回 500，对象仍在库里', async () => {
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

      // 可观测痕迹：一行 append-only 审计（它同时就是「待清理标记」，见本组用例的说明）。
      // 同样按 `resourceId`（= 被留下的那个对象键）过滤，与执行顺序无关。
      const rows = await prisma.auditLog.findMany({
        where: { action: 'asset.artifact.cleanup_failed', resourceId: key },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resourceId).toBe(key);
      expect(rows[0]?.resource).toBe('AssetArtifact');
      expect(rows[0]?.metadata).toMatchObject({ attempts: 3, errorName: 'Error', reasonClass: 'Error' });
    });

    it('失败类别：注入一个带 `code` 的失败 ⇒ 审计行的 `reasonClass` 记下那个 code（原始消息仍不落档）', async () => {
      /**
       * 修复轮 1：上面那条用例只覆盖了「裸 `Error`」这一种失败，于是
       * `reasonClass` 的三个分支里只有一个被走到——而**有界分类**这件事本身
       * （「按理由分流」在数据层不会退化成一行一个值）正是加它的理由。
       *
       * 这里注入的 `EACCES` 是本地卷上「删不掉」的现实形态（权限/占用）。
       * 同时断言**原始消息不在审计行里**：那条消息带的是卷的路径（C11）。
       */
      failing.failTimes = Number.POSITIVE_INFINITY;
      failing.failureError = () => {
        const error = new Error(`注入的删除失败：制品卷路径 D:\\vca\\${'x'.repeat(20)}`) as Error & { code?: string };
        error.code = 'EACCES';
        return error;
      };

      const res = await request(failingApp.getHttpServer())
        .post('/assets/upload')
        .set('Cookie', `${SESSION_COOKIE}=${failingSession}; ${CSRF_COOKIE}=${failingCsrf}`)
        .set(CSRF_HEADER, failingCsrf)
        .attach('file', sampleBytes('fake-mime.zip'), 'pkg.zip');

      expect(res.status, `响应体=${res.text}`).toBe(500);
      const key = failing.lastKey;
      const rows = await prisma.auditLog.findMany({
        where: { action: 'asset.artifact.cleanup_failed', resourceId: key },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({
        attempts: 3,
        errorName: 'Error',
        errorCode: 'EACCES',
        reasonClass: 'EACCES',
      });
      // 原始消息（含路径）**不**在审计行里：C11 的那条边界
      expect(JSON.stringify(rows[0]?.metadata)).not.toContain('制品卷路径');
    });
  });

  /**
   * **制品在静态存储上被改动**（Task 3 §13.6 / Task 4 Step 0b 移交的那条边界）。
   *
   * ## 为什么这一组必须在**本任务**的边界上成立
   *
   * 归档校验（`validateArchive`）只拿到一个读取器；而这条链路真正承重的是**接入流程怎么用它**：
   * 「先认证末块再下任何结论」与「把**写入侧**记下的明文长度当作带外核对值」。
   * 只证明「读取器读到坏字节会抛错」是不够的——判据是**端到端**：自洽的坏制品必须被拒、
   * **不返回任何元数据**、密文对象被删掉。
   *
   * ## 三种「自洽」的坏制品
   *
   * 1. **被换短的制品**：另一份完全自洽的制品（重新加密、末块标记正确、三条完整性校验全过）。
   *    挡住它的**只有**长度交叉核对——末块标记在它身上是正确的，嗅探与 inspector 也都会放行；
   * 2. **末块密文被翻一位**：长度与结构都自洽，只有 GCM 认证能发现。它必须在**嗅探之前**
   *    就被拒（`kind` 是 `unknown`），这正是「先认证末块」那条顺序的证据；
   * 3. **尾部被改坏**：连 `open()` 都过不去 ⇒ 制品读不回来，删对象 + 500（不是 4xx）。
   *
   * 注入方式是**包装真实存储**：写入完成之后按用例给的 `mutate` 改写盘上的字节
   * （模拟制品在静止状态下被改动），其余一切（加密、读取、解密、校验、审计）都是真的。
   */
  describe('制品在静态存储上被改动（自洽的坏制品必须被拒）', () => {
    let tamperingApp: INestApplication;
    let tampering: TamperingStore;
    let tamperingSession: string;
    let tamperingCsrf: string;

    beforeAll(async () => {
      tampering = new TamperingStore(new LocalArtifactStore(STORE_DIR));
      tamperingApp = await createTestApp({
        overrides: [
          (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
          (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
          (builder) => builder.overrideProvider(ARTIFACT_STORE).useValue(tampering),
        ],
      });
      tamperingCsrf = await fetchCsrfToken(tamperingApp);
    }, 240_000);

    afterAll(async () => {
      await tamperingApp?.close();
    });

    beforeEach(async () => {
      tampering.mutate = null;
      userSeq += 1;
      tamperingSession = (
        await tamperingApp
          .get(SessionService)
          .create(`user-tamper-${userSeq}`, { ip: '127.0.0.1', userAgent: 'vitest' })
      ).sessionId;
    });

    function uploadThroughTamper(bytes: Buffer): request.Test {
      return request(tamperingApp.getHttpServer())
        .post('/assets/upload')
        .set('Cookie', `${SESSION_COOKIE}=${tamperingSession}; ${CSRF_COOKIE}=${tamperingCsrf}`)
        .set(CSRF_HEADER, tamperingCsrf)
        .attach('file', bytes, 'pkg.zip');
    }

    it('被换成**更短的、完全自洽的**制品：长度核对拒掉它 —— 末块标记与三条完整性校验都会放行', async () => {
      // 先造一份「攻击者形态」的制品字节：另一份**合法**归档加密成的新制品（完全自洽）
      const replacement = await buildArtifactBytes(sampleBytes('ok.tar.gz'));
      tampering.mutate = () => replacement; // 上传的制品会被整体换成它

      const res = await uploadThroughTamper(sampleBytes('ok.zip'));

      expect(res.status, `响应体=${res.text}`).toBe(422);
      const body = res.body as { code?: string; kind?: string; reason?: string };
      expect(body.code).toBe('ASSET_ARCHIVE_REJECTED');
      // 长度不符是在**读任何字节之前**判定的，因此类型是 unknown（没走到嗅探）
      expect(body.kind).toBe('unknown');
      expect(String(body.reason)).toContain('带外记录的明文长度');
      // 被拒 ⇒ 删对象、不返回任何元数据
      await expect(storedObjects()).resolves.toEqual([]);
      expect(body).not.toHaveProperty('sha256');
    });

    it('末块密文被翻一位：在**任何结论之前**被末块认证拒掉（kind=unknown）', async () => {
      // 改的是**末块记录的最后一个字节**（tag 的末字节）：制品结构不变、
      // 尾部自称的长度不变 ⇒ 只可能是认证失败。
      tampering.mutate = (artifact) => {
        const { indexOffset } = decodeFooter(artifact.subarray(artifact.length - FOOTER_BYTES));
        const forged = Buffer.from(artifact);
        forged[Number(indexOffset) - 1] = forged[Number(indexOffset) - 1]! ^ 0xff;
        return forged;
      };

      const res = await uploadThroughTamper(sampleBytes('ok.zip'));

      expect(res.status, `响应体=${res.text}`).toBe(422);
      const body = res.body as { code?: string; kind?: string; reason?: string };
      expect(body.code).toBe('ASSET_ARCHIVE_REJECTED');
      expect(body.kind).toBe('unknown');
      expect(String(body.reason)).toContain('末块认证失败');
      await expect(storedObjects()).resolves.toEqual([]);
    });

    it('尾部被改坏（open 阶段就失败）：删对象 + 500，制品库零残留', async () => {      tampering.mutate = (artifact) => {
        // 把索引起点改到头部之前：几何校验立刻不成立（连索引区都不会去读）
        const forged = Buffer.from(artifact);
        encodeFooter({
          indexOffset: 0n,
          chunkCount: decodeFooter(artifact.subarray(artifact.length - FOOTER_BYTES)).chunkCount,
          plaintextLength: decodeFooter(artifact.subarray(artifact.length - FOOTER_BYTES)).plaintextLength,
        }).copy(forged, artifact.length - FOOTER_BYTES);
        return forged;
      };

      const res = await uploadThroughTamper(sampleBytes('ok.zip'));

      expect(res.status, `响应体=${res.text}`).toBe(500);
      expect((res.body as { code?: string }).code).toBe('ASSET_ARTIFACT_UNREADABLE');
      // 读不回来的制品没有任何用途 ⇒ 同样要被删掉（否则制品库里会攒下永远下不来的孤儿）
      await expect(storedObjects()).resolves.toEqual([]);
    });

    it('**中间**块被篡改（末块完好）：嗅探一读就认证失败 ⇒ 删对象 + 制品读不回来（不是未处理异常）', async () => {
      /**
       * 这一条盯的是**非末块**的篡改：末块认证会**放行**（末块没被动过），坏在下一次读上——
       * `sniffArchive` 读制品开头时认证失败并**把错误抛出来**（它的注释写明了「读制品本身
       * 失败属于存储/解密层的问题，不吞」）。于是**接入层必须接住它**：读不出来的制品
       * 没有任何用途 ⇒ 删掉 + 归类成「制品读不回来」（500 + 代号），而不是让一个未处理异常
       * 冒到框架层（那会变成没有代号的 500，还会在日志里留下无上下文的堆栈）。
       *
       * 需要**两块**制品才能构造出「被篡改的不是末块」：生产块大小 8 MiB，因此这里用
       * 9 MiB 的合法 zip（stored 条目，不可压缩）。这条用例只走服务边界（HTTP 层的
       * 上传上限是 4 MiB，9 MiB 会被 multer 先拦下——那测不到本路径）。
       */
      const plaintext = buildZip([{ name: 'big.bin', data: randomBytes(9 * 1024 * 1024) }]);
      const upload = await assets.putStream(Readable.from([plaintext]), { maxBytes: 16 * 1024 * 1024 });
      // 翻掉**第一块**密文里的一个字节（制品头之后就是块数据区，偏移 40 必在第一块内）
      await rewriteObject(upload.key, (artifact) => {
        const forged = Buffer.from(artifact);
        forged[40] = forged[40]! ^ 0xff;
        return forged;
      });

      const error = await assets.finalize(upload, { uploadedById: null }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ArtifactUnreadableError);
      expect((error as ArtifactUnreadableError).detail).toContain('认证失败');
      await expect(storedObjects()).resolves.toEqual([]);
    });
  });
});

/**
 * 制品库替身：写入成功之后，按用例给的 `mutate` **改写盘上的字节**（其余全部委派真实实现）。
 *
 * 它模拟的是「制品在静止存储上被改动」——这是 Task 3 §13.6 / Task 4 Step 0b 点名的威胁形态：
 * 攻击者（或损坏）拿到的是一份**自洽**的坏制品，而不是一段坏字节。
 */
class TamperingStore implements ArtifactStore {
  /** 为 `null` 时不改动（用例需要先生成一份合法制品时用它）。 */
  mutate: ((artifact: Buffer) => Buffer) | null = null;

  constructor(private readonly inner: ArtifactStore) {}

  async putStream(source: Readable, opts: { maxBytes: number }): Promise<{ key: string; bytes: number }> {
    const stored = await this.inner.putStream(source, opts);
    if (this.mutate !== null) await rewriteObject(stored.key, this.mutate);
    return stored;
  }

  getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    return this.inner.getRange(key, start, endInclusive);
  }

  stat(key: string): Promise<{ bytes: number }> {
    return this.inner.stat(key);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

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
  /**
   * 最近一次写入的存储键（修复轮 1）。用途：把审计行**按 `resourceId` 过滤**——
   * 只按 `action` 过滤时，「有没有留下清理失败的行」这条断言的正确性依赖
   * 「同组的其它用例没有留下同动作的行」，那是一个跨用例的假设。
   * 端口刻意没有列举 API（C16），而键本来就由 `putStream` 返回，这里只是把它记下来。
   */
  lastKey = '';
  /**
   * 注入的失败形状（默认一个裸 `Error`）。
   *
   * 让用例能覆盖**有界的失败类别**：`errorCode` 只在错误带 `code` 时才有值，
   * 而 `reasonClass` 的分类分支（fs 的 code / HTTP 状态码 / 兜底）各需要一种形状才能走到。
   */
  failureError: () => Error = () => new Error('注入的删除失败：卷不可写');

  constructor(private readonly inner: ArtifactStore) {}

  async putStream(source: Readable, opts: { maxBytes: number }): Promise<{ key: string; bytes: number }> {
    const stored = await this.inner.putStream(source, opts);
    this.lastKey = stored.key;
    return stored;
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
      throw this.failureError();
    }
    return this.inner.delete(key);
  }
}

