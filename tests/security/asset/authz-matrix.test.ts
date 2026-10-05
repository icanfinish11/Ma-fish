import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { RouteDeclarationRegistry } from '@vca/api/common/policy/route-declaration.registry.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';
import { AssetService } from '@vca/api/modules/asset/asset.service.js';
import { AssetVersionService } from '@vca/api/modules/asset/asset-version.service.js';
import { createKeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';
import { parseMetadata } from '@vca/api/modules/asset/metadata/parse-metadata.js';
import { ARTIFACT_STORE, type ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
import { DOWNLOAD_TTL_SECONDS, createNonce } from '@vca/api/modules/asset/download/signed-url.js';
import { createTestApp } from '../../helpers/app.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { disableRateLimit } from '../../helpers/rate-limit.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';
import { ARCHIVE_SAMPLES } from '../../fixtures/archives/generate.js';

/**
 * **资产模块的越权矩阵**（P1 / Task 8；规格 D11 + 判据 11；设计文档 §9）。
 *
 * ## 它问的是哪一件事（与 P0 的默认拒绝门的分工）
 *
 * P0 已经有两条门，本文件**不重复**它们：
 *
 * | 问题 | 由谁回答 |
 * |---|---|
 * | 「没声明策略的路由会不会被放行」 | `tests/security/policy-default-deny.test.ts`（探针路由）|
 * | 「每条已注册路由有没有声明」 | `tests/security/policy-route-coverage.test.ts`（覆盖率门）|
 * | **「声明了的那些路由，四种角色下各自到底放不放行」** | **本文件** |
 *
 * 换成一句话：**默认拒绝是默认行为，而本矩阵要钉住的是「例外只有 §9 明确写下的那几格」**
 * ——每一个端点 × 匿名 / 已登录非属主 / 管理员 / 属主，逐格断言。
 *
 * ## 四种角色的构造（每一种都走**真实**路径，没有一处「削弱守卫」）
 *
 * - **匿名**：没有会话 cookie；
 * - **非属主**：真用户 + 真会话（`SessionService.create`），只是不是这份作品的所有人；
 * - **管理员**：`role = 'ADMIN'` 的**真**用户 + 真会话。§9 的矩阵里**没有**给管理员
 *   开 `Asset` 制品的任何一格，因此他在这条路径上与陌生人**同档**——这一格是刻意的：
 *   「角色大」不等于「拿到别人的制品」；
 * - **属主**：作品的 `ownerId`。
 *
 * 断言的状态码里，`403` 有两处来源（守卫的「需要登录」与 `checkAccess` 的
 * 「该资源未被授权访问」），本文件按**响应体**把两者分开——只看状态码会把
 * 「没登录」与「登了但不是你的」读成同一件事。
 *
 * ## 矩阵自身的覆盖率也是断言（「空的矩阵」是本仓库反复抓到的缺陷形状）
 *
 * 最后一条用例枚举真实 `AssetController` 的**全部**已注册路由，要求它们与本文件
 * 逐格断言的那四条**逐个对上**。少写一条端点（或者将来新增一条忘了加进矩阵），
 * 那条用例就会红——否则「矩阵全绿」可能只是「矩阵里没写那条端点」。
 *
 * ## 限流在**本文件**被显式关掉（复用 P0 的开关，不是发明一个）
 *
 * 这里打的是授权判定，而 `search` 层是 60 次/分钟：矩阵本身会把桶打满，让状态码变成
 * 429（那是限流在正常工作，不是越权结论）。`tests/helpers/rate-limit.ts` 的
 * `disableRateLimit` 是 P0 就有的那一个开关（`tests/security/rate-limit.test.ts`
 * 用真实存储断言限流本身仍然生效），因此这里关掉计数**不削弱任何安全断言**：
 * 限流归属有覆盖率门 + 集成套件那条「第 61 次 429」的行为见证。
 */

const MAX_UPLOAD_BYTES = Number(testEnv.ARTIFACT_MAX_UPLOAD_BYTES);

/** 四种角色（矩阵的两个维度之一是它）。 */
const ROLES = ['anonymous', 'stranger', 'admin', 'owner'] as const;
type Role = (typeof ROLES)[number];

/** 一格的期望：状态码 + 用它区分两种 403 的判据（响应体的 `code` 或 `message`）。 */
interface Expectation {
  status: number;
  /** 403 的来源：`login` = 守卫要求身份；`denied` = 资源级判定为否。其余不用它。 */
  kind?: 'login' | 'denied' | 'ok' | 'content';
  code?: string;
  message?: string;
}

/** 一行 = 一条端点；`handler` 用来与注册表比对（矩阵覆盖率那条用例）。 */
interface MatrixRow {
  /** 注册表里的方法名（与 `RouteDeclarationRegistry` 的 `handler` 对齐）。 */
  handler: string;
  label: string;
  /** 发一个该角色下的请求（会话/令牌由调用方准备好）。 */
  call: (role: Role) => request.Test;
  expect: Record<Role, Expectation>;
}

describe('越权矩阵：asset 模块的每个端点 × 每个角色（判据 11 / §9）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let sessions: SessionService;
  let csrf: string;

  /** 每个角色的请求头（Cookie 里同时带会话与 CSRF 令牌，写操作才走得完整条守卫链）。 */
  const cookies = new Map<Role, string>();

  let versionId = '';
  let assetId = '';
  /** 一条形状合法、签名错误的票据（伪造者拿不出密钥）——「签名即凭证」那一格的输入。 */
  let forgedTicketPath = '';

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
        // 授权判定的矩阵：把**计数**关掉（不是把守卫拆掉），理由见文件头。
        disableRateLimit,
      ],
    });
    sessions = app.get(SessionService);
    csrf = await fetchCsrfToken(app);

    // ── 四种角色的当事人（真用户：审计的 actor_id 是 uuid 列）──
    const owner = (await prisma.user.create({ data: {} })).id;
    const stranger = (await prisma.user.create({ data: {} })).id;
    const admin = (await prisma.user.create({ data: { role: 'ADMIN' } })).id;
    const login = async (userId: string): Promise<string> => {
      const { sessionId } = await sessions.create(userId, { ip: '127.0.0.1', userAgent: 'vitest' });
      return `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`;
    };
    cookies.set('owner', await login(owner));
    cookies.set('stranger', await login(stranger));
    cookies.set('admin', await login(admin));
    // 「匿名」= 只带 CSRF 令牌（浏览器拿得到它），**不带**会话 cookie
    cookies.set('anonymous', `${CSRF_COOKIE}=${csrf}`);

    // ── 一份真实的制品与版本（走 Task 5 的接入 + Task 7 的落库）──
    const assets = app.get(AssetService);
    const versions = app.get(AssetVersionService);
    const plaintext = (() => {
      const sample = ARCHIVE_SAMPLES.find((item) => item.name === 'ok.zip');
      if (sample === undefined) throw new Error('样本表里没有 ok.zip');
      return sample.bytes();
    })();
    const asset = await prisma.asset.create({ data: { ownerId: owner } });
    assetId = asset.id;
    const write = await assets.putStream(Readable.from([plaintext]), { maxBytes: MAX_UPLOAD_BYTES });
    const ingested = await assets.finalize(write, { uploadedById: owner });
    const reader = await EncryptedArtifactReader.open(
      app.get<ArtifactStore>(ARTIFACT_STORE),
      ingested.storageKey,
      createKeyRing({
        ARTIFACT_KEYS: testEnv.ARTIFACT_KEYS,
        ARTIFACT_ACTIVE_KEY_ID: testEnv.ARTIFACT_ACTIVE_KEY_ID,
      }),
    );
    const metadata = await parseMetadata(reader, ingested.kind);
    versionId = (await versions.persistIngested({ assetId: asset.id, ingested, metadata })).assetVersionId;

    const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
    const forged = new URLSearchParams({
      assetVersionId: versionId,
      userId: owner,
      expiresAt: String(expiresAt),
      nonce: createNonce(),
      // 43 个字符、字符集合法 ⇒ 形状**通过**，只有签名是错的（伪造者没有密钥）。
      signature: 'A'.repeat(43),
    });
    forgedTicketPath = `/assets/download?${forged.toString()}`;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
  });

  /** 带该角色的 cookie（写操作还要带双提交令牌的头）。 */
  function withRole(req: request.Test, role: Role): request.Test {
    return req.set('Cookie', cookies.get(role) as string).set(CSRF_HEADER, csrf);
  }

  /**
   * 失败消息里的「响应里到底说了什么」——**刻意不回显正文**。
   *
   * 签发**成功**时的正文里就是那串签名 URL（票据本身），而 C11 不允许把凭证写进
   * 日志/CI 输出：一次变异探针（p7）实测过这个形态——断言消息把一整条可用的签名 URL
   * 打进了失败输出。这里只取两个**非凭证**字段（`code` 与 `message`），
   * 排障需要的信息一个不少，凭证一个都不出现。
   */
  function failureDetail(res: request.Response): string {
    const body = res.body as { code?: unknown; message?: unknown } | null;
    return `status=${res.status} code=${JSON.stringify(body?.code ?? null)} message=${JSON.stringify(body?.message ?? null)}`;
  }

  const MATRIX: MatrixRow[] = [
    {
      handler: 'upload',
      label: 'POST /assets/upload（声明：Asset.create，登录即可）',
      call: (role) => withRole(request(app.getHttpServer()).post('/assets/upload'), role),
      expect: {
        // 匿名上传是实打实的漏洞：这一格必须是 403（而且来自守卫的「需要登录」）
        anonymous: { status: 403, kind: 'login', message: '需要登录' },
        // 已登录的四档都会被放行进处理器；请求里没有文件字段 ⇒ 400。
        // 这一格记的是「授权层面放行，内容层面拒绝」——两者不能混谈。
        stranger: { status: 400, kind: 'content' },
        admin: { status: 400, kind: 'content' },
        owner: { status: 400, kind: 'content' },
      },
    },
    {
      handler: 'issueDownloadUrl',
      label: 'POST /assets/versions/:versionId/download-url（声明：Asset.download）',
      call: (role) => withRole(request(app.getHttpServer()).post(`/assets/versions/${versionId}/download-url`), role),
      expect: {
        anonymous: { status: 403, kind: 'login', message: '需要登录' },
        // 三种「已登录但不是属主」的形态：普通用户、**管理员**、以及任何别的身份，
        // 全都在 `checkAccess` 这**一个**入口上被拒（§9 没有给 admin 开这一格）。
        stranger: { status: 403, kind: 'denied', code: 'ASSET_DOWNLOAD_NOT_AUTHORIZED' },
        admin: { status: 403, kind: 'denied', code: 'ASSET_DOWNLOAD_NOT_AUTHORIZED' },
        owner: { status: 200, kind: 'ok' },
      },
    },
    {
      handler: 'download',
      label: 'GET /assets/download（@Public：签名即凭证）',
      call: (role) => withRole(request(app.getHttpServer()).get(forgedTicketPath), role),
      expect: {
        // 这一格是「公开路由不等于公开资源」：四种角色（含属主、含管理员）拿一张
        // **签名不对**的票都是 403——放行与否只由签名决定，与会话毫无关系。
        anonymous: { status: 403, kind: 'denied', code: 'ASSET_DOWNLOAD_TICKET_BAD_SIGNATURE' },
        stranger: { status: 403, kind: 'denied', code: 'ASSET_DOWNLOAD_TICKET_BAD_SIGNATURE' },
        admin: { status: 403, kind: 'denied', code: 'ASSET_DOWNLOAD_TICKET_BAD_SIGNATURE' },
        owner: { status: 403, kind: 'denied', code: 'ASSET_DOWNLOAD_TICKET_BAD_SIGNATURE' },
      },
    },
    {
      handler: 'readMetadata',
      label: 'GET /assets/versions/:versionId/metadata（@Public：§9 的「元数据 read = 所有人」）',
      call: (role) => withRole(request(app.getHttpServer()).get(`/assets/versions/${versionId}/metadata`), role),
      expect: {
        // §9 矩阵里**唯一**授权给「所有人」的资产行。四格同形是刻意的：
        // 它证明的是「这一行的放行与身份无关」，而不是「我们忘了加判定」。
        anonymous: { status: 200, kind: 'ok' },
        stranger: { status: 200, kind: 'ok' },
        admin: { status: 200, kind: 'ok' },
        owner: { status: 200, kind: 'ok' },
      },
    },
  ];

  for (const row of MATRIX) {
    for (const role of ROLES) {
      const expected = row.expect[role];
      it(`${row.label} × ${role} ⇒ ${expected.status}`, async () => {
        const res = await row.call(role);
        const body = res.body as { code?: string; message?: string; assetVersionId?: string };

        expect(res.status, failureDetail(res)).toBe(expected.status);

        if (expected.kind === 'login') {
          // 守卫的「需要登录」：身份缺失，判定还没开始
          expect(body.message, '匿名请求拿到的不是「需要登录」').toBe(expected.message);
        }
        if (expected.kind === 'denied') {
          // 资源级判定为否：`code` 让「这张票不行」与「这个人不行」分得开
          expect(body.code, '拒绝的理由不是资源级判定').toBe(expected.code);
          // 被拒的响应里**没有**任何制品字节，也没有下载链接（未授权者拿不到签名 URL）
          expect(res.text).not.toContain('/assets/download?');
          expect(res.headers['content-disposition']).toBeUndefined();
        }
        if (expected.kind === 'ok' && row.handler === 'readMetadata') {
          // 四格不只是「状态码相同」：拿到的是**同一份**元数据（而不是每个角色一份）
          expect(body.assetVersionId).toBe(versionId);
        }
        if (expected.kind === 'ok' && row.handler === 'issueDownloadUrl') {
          expect(String((body as { url?: string }).url).startsWith('/assets/download?')).toBe(true);
        }
        if (expected.kind === 'content') {
          // 授权层放行、内容层拒绝：`message` 是那句「请求里没有 multipart 文件字段」
          expect(String(body.message)).toContain('multipart');
        }
      });
    }
  }

  it('矩阵自身覆盖 asset 控制器的**全部**已注册路由（少一条端点就是一个盲区）', async () => {
    // 「空的矩阵」与「空的覆盖率门」是同一种失败：全绿可能只是「矩阵里没写那条端点」。
    // 这里把注册表里属于 `AssetController` 的处理器名与矩阵逐行比对——多一条（新端点
    // 忘了加进矩阵）或少一条（端点被删/改名）都会红。
    const registered = app
      .get(RouteDeclarationRegistry)
      .listRoutes()
      .filter((route) => route.controller === 'AssetController');

    expect(registered.length, '注册表里没有 AssetController 的任何路由：发现层没接通').toBeGreaterThan(0);
    expect(registered.map((route) => route.handler).sort()).toEqual(MATRIX.map((row) => row.handler).sort());

    // 非空转前提的加强版：三条新路由（Task 8 加的）确实在注册表里，且路径正确。
    // 少了这一条，把三条新路由**整个删掉**也能让上面的集合相等（两边都只剩 upload）。
    expect(registered.map((route) => `${route.handler} ${route.path}`).sort()).toEqual([
      `download /assets/download`,
      `issueDownloadUrl /assets/versions/:versionId/download-url`,
      `readMetadata /assets/versions/:versionId/metadata`,
      `upload /assets/upload`,
    ]);
    expect(assetId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
