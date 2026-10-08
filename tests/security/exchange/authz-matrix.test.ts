import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { RouteDeclarationRegistry } from '@vca/api/common/policy/route-declaration.registry.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';
import { ExchangeService } from '@vca/api/modules/exchange/exchange.service.js';
import { createTestApp } from '../../helpers/app.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { disableRateLimit } from '../../helpers/rate-limit.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';

/**
 * **交换的越权矩阵**（P3 / Task 6；§9:477-478 + 判据 11）。
 *
 * ## 这一节与 P1 的矩阵有一处**结构性**差别（必须在文件头说清）
 *
 * P1 的矩阵是 4 端点 × 4 角色、每格是「整个制品 / 整个元数据」的**二元**判定。
 * 而交换引入了**「部分访问」**：同一份作品，**交换对手方**在 `RELEASED` 后能下载，
 * 别人不能。**没有任何一格的粒度是「部分」** —— 因此这里的角色不是「属主」，
 * 而是「这份要约的对手方 / 不是」，而且**同一份作品**在不同合约下对同一个人
 * 可能给出不同答案（Task 9 的预览套件里有一条专门的用例）。
 *
 * ## 四格必须各自有判别力
 *
 * * 匿名 ⇒ 403「需要登录」（**不是** 404：路由存在这件事本身不是秘密）；
 * * 已登录非当事人 ⇒ 403「该资源未被授权访问」（**与匿名的那一格必须可区分**，
 *   否则「守卫没跑」与「条件判否」看起来一样）；
 * * **管理员 ⇒ 403**（§9 的矩阵里**没有**给管理员开任何一格。这一格是刻意的：
 *   「角色大」不等于「拿到别人的东西」）；
 * * 当事人 ⇒ 200 / 201（**验收面**）。
 *
 * ## ★ 两条没有条件的路由，它们的「非当事人」格**不是 403**（据实记载）
 *
 * `propose` 与 `withdraw` 的声明是**无条件**的（§9 的矩阵里没有这两行，
 * 见 `exchange.controller.ts` 的类注释）。因此一个已登录的陌生人在**守卫**那一层是
 * **放行**的，拒绝发生在**服务层**，而那里的答案是 **404**（`EXCHANGE_ASSET_NOT_FOUND`
 * / `EXCHANGE_OFFER_NOT_FOUND`）——「这次引用没有指向一个你能看见的对象」。
 * 这两格与匿名的 403「需要登录」**仍然可区分**（状态码与 `code` 都不同），
 * 而它们与条件路由的 403「该资源未被授权访问」**刻意不同**：
 * 后者是「守卫判否」，前者是「资源不可见」。把它们并成一格会让
 * 「守卫没跑」与「条件判否」重新变得一样——那正是这一节要防的形状。
 *
 * ## 矩阵自身的覆盖率也是断言（「空的矩阵」是本仓库反复抓到的缺陷形状）
 *
 * 最后一条用例枚举真实 `ExchangeController` 的**全部**已注册路由，要求它们与本文件
 * 逐格断言的那六条**逐个对上**。少写一条端点（或者将来新增一条忘了加进矩阵），
 * 那条用例就会红——否则「矩阵全绿」可能只是「矩阵里没写那条端点」。
 */
const ROLES = ['anonymous', 'stranger', 'admin', 'party'] as const;
type Role = (typeof ROLES)[number];

/** 「当事人」在每一行上是**哪一方**（发要约的是发起方，接受/拒绝/读要约的是对手方）。 */
type Party = 'proposer' | 'counterparty';

interface Expectation {
  status: number;
  /** 拒绝的来源：`login` = 守卫要求身份；`denied` = 守卫的条件判否；`content` = 服务层／资源判定。 */
  kind?: 'login' | 'denied' | 'content' | 'ok';
  code?: string;
}

interface MatrixRow {
  handler: string;
  label: string;
  party: Party;
  call: (role: Role) => request.Test;
  expect: Record<Role, Expectation>;
}

describe('越权矩阵：exchange 的六条路由 × 四种角色（判据 11 / §9）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let pg: TestPg;
  let prisma: PrismaService;
  let sessions: SessionService;
  let csrf: string;

  let offerId = '';
  let withdrawableOfferId = '';
  let contractId = '';
  let offeredAssetId = '';
  let targetAssetId = '';
  const cookies = new Map<string, string>();

  const DIGEST = 'f'.repeat(64);

  beforeAll(async () => {
    redis = await startTestRedis();
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    app = await createTestApp({
      overrides: [
        (builder) => builder.overrideProvider(REDIS).useValue(redis.newClient()),
        (builder) => builder.overrideProvider(PrismaService).useValue(prisma),
        // 授权判定的矩阵：把**计数**关掉（不是把守卫拆掉），理由与 `asset` 的矩阵逐字相同。
        disableRateLimit,
      ],
    });
    sessions = app.get(SessionService);
    csrf = await fetchCsrfToken(app);

    // ── 四方当事人（真用户：审计的 `actor_id` 是 uuid 列）──
    const proposer = (await prisma.user.create({ data: {} })).id;
    const counterparty = (await prisma.user.create({ data: {} })).id;
    const stranger = (await prisma.user.create({ data: {} })).id;
    const admin = (await prisma.user.create({ data: { role: 'ADMIN' } })).id;
    const login = async (userId: string): Promise<string> => {
      const { sessionId } = await sessions.create(userId, { ip: '127.0.0.1', userAgent: 'vitest' });
      return `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`;
    };
    cookies.set('proposer', await login(proposer));
    cookies.set('counterparty', await login(counterparty));
    cookies.set('stranger', await login(stranger));
    cookies.set('admin', await login(admin));
    cookies.set('anonymous', `${CSRF_COOKIE}=${csrf}`);

    // ── 三件作品、两份要约、一份合约（**走服务**造出来：本文件判的是路由层的授权）──
    const exchange = app.get(ExchangeService);
    offeredAssetId = (await prisma.asset.create({ data: { ownerId: proposer } })).id;
    targetAssetId = (await prisma.asset.create({ data: { ownerId: counterparty } })).id;
    /** 给一件已存在的作品补一份版本 + 元数据（资格判据要求完整度 > 0 且 README 非空）。 */
    const addVersion = async (assetId: string, ownerId: string): Promise<void> => {
      const version = await prisma.assetVersion.create({
        data: {
          assetId,
          sha256: `sha256-${assetId}`,
          storageKey: `probe/${assetId}`,
          plaintextBytes: 1,
          keyId: 'k1',
          fileId: `file-${assetId}`,
          uploadedById: ownerId,
        },
      });
      await prisma.assetMetadata.create({
        data: {
          assetVersionId: version.id,
          readmeExcerpt: '# 一件作品',
          fileTree: [{ path: 'src/index.ts', bytes: 1 }],
          languages: [{ name: 'TypeScript', bytes: 1, ratio: 1 }],
          dependencies: [],
          completeness: 40,
          fileTreeTruncated: false,
          codeLines: 10,
        },
      });
    };
    await addVersion(offeredAssetId, proposer);
    await addVersion(targetAssetId, counterparty);

    offerId = (
      await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId,
        targetAssetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      })
    ).offerId;
    const offeredVersion = await prisma.assetVersion.findFirstOrThrow({ where: { assetId: offeredAssetId } });
    contractId = (
      await exchange.acceptOffer({
        offerId,
        actorId: counterparty,
        targetCommitment: { assetVersionId: offeredVersion.id, dossierDigest: DIGEST },
      })
    ).contractId;

    // ★ 第二份**仍然是 `SENT`** 的要约，专门给 `withdraw` 那一行用。
    //   为什么需要它：上面那份已经是 `ACCEPTED`（终态），而在终态上撤回会得到
    //   **409**（状态机守卫），不是 200 —— 那样 `withdraw` 那一行的验收面就没了。
    //   每一格都必须真的走到它声称的那一层，因此两行各用一份要约。
    //   （被要约作品必须是**另一件**：同一对 `(target, counterparty)` 上只允许一份活跃要约。）
    const withdrawTargetId = (await prisma.asset.create({ data: { ownerId: counterparty } })).id;
    await addVersion(withdrawTargetId, counterparty);
    withdrawableOfferId = (
      await exchange.proposeOffer({
        proposerId: proposer,
        offeredAssetId,
        targetAssetId: withdrawTargetId,
        offeredDossierDigest: DIGEST,
        claims: null,
      })
    ).offerId;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    await redis?.stop();
  });

  /** 带该角色的 cookie（写操作还要带双提交令牌的头）。 */
  function withCookie(req: request.Test, cookieName: string): request.Test {
    return req.set('Cookie', cookies.get(cookieName) as string).set(CSRF_HEADER, csrf);
  }

  function cookieNameFor(role: Role, party: Party): string {
    return role === 'party' ? party : role;
  }

  /** 失败消息里的「响应里到底说了什么」（只取非凭证字段，照 `asset` 的矩阵）。 */
  function failureDetail(res: request.Response): string {
    const body = res.body as { code?: unknown; message?: unknown } | null;
    return `status=${res.status} code=${JSON.stringify(body?.code ?? null)} message=${JSON.stringify(body?.message ?? null)}`;
  }

  /**
   * 两个请求体形状（**各自只带自己那一层的字段**）。
   *
   * 为什么刻意不共用一个「多带几个键」的体：两个 schema 都是 `strictObject`
   * （多余键一律 400），因此混着发会让「授权」那一格红在一次 **400** 上——
   * 一条红在别的机制上的断言，而它声称的是授权判定。
   * `accept` 那一格的 `assetVersionId` 刻意是一个**空串**：它到不了处理器
   * （守卫在它之前就判否了），因此这里不需要一份真实的承诺——而这也顺带说明
   * 那三格判的是**授权**，不是请求内容。
   */
  const reasonBody = (req: request.Test): request.Test => req.send({ reason: 'OTHER' });
  const acceptBody = (req: request.Test): request.Test =>
    req.send({ targetCommitment: { assetVersionId: '01920000-0000-7000-8000-000000000001', dossierDigest: DIGEST } });

  const MATRIX: MatrixRow[] = [
    {
      handler: 'propose',
      label: 'POST /exchange/offers（声明：SwapOffer.create，**无条件**＝登录即可）',
      party: 'proposer',
      call: (role) =>
        withCookie(
          request(app.getHttpServer())
            .post('/exchange/offers')
            .send({ offeredAssetId, targetAssetId, offeredDossierDigest: DIGEST }),
          cookieNameFor(role, 'proposer'),
        ),
      expect: {
        anonymous: { status: 403, kind: 'login' },
        // 已登录的陌生人过了守卫，被**服务层**的归属判定拒（`checkAccess` ⇒ false）：
        // 404 而不是 403，理由见文件头那一节。
        stranger: { status: 404, kind: 'content', code: 'EXCHANGE_ASSET_NOT_FOUND' },
        admin: { status: 404, kind: 'content', code: 'EXCHANGE_ASSET_NOT_FOUND' },
        // 验收面：这件作品是**发起方**的 —— 但这时候已经有一份**活跃**要约了
        // （beforeAll 造的那一份），于是服务**复用**它 ⇒ 201 而库里不多一行。
        party: { status: 201, kind: 'ok' },
      },
    },
    {
      handler: 'accept',
      label: 'POST /exchange/offers/:offerId/accept（声明：SwapOffer.accept + 条件 swapOfferSent）',
      party: 'counterparty',
      call: (role) =>
        acceptBody(
          withCookie(
            request(app.getHttpServer()).post(`/exchange/offers/${offerId}/accept`),
            cookieNameFor(role, 'counterparty'),
          ),
        ),
      expect: {
        anonymous: { status: 403, kind: 'login' },
        stranger: { status: 403, kind: 'denied' },
        admin: { status: 403, kind: 'denied' },
        // 验收面：**要约已经是 `ACCEPTED` 了**（beforeAll 接受过），因此条件不成立 ⇒ 403。
        // 这一格不是「放行」——它是「条件恰好判的是被要约方 + SENT」的见证：
        // 换一份**新的** `SENT` 要约时同一格是 200（下面有一条专门的用例）。
        party: { status: 403, kind: 'denied' },
      },
    },
    {
      handler: 'reject',
      label: 'POST /exchange/offers/:offerId/reject（声明：SwapOffer.reject + 条件 swapOfferSent）',
      party: 'counterparty',
      call: (role) =>
        reasonBody(
          withCookie(
            request(app.getHttpServer()).post(`/exchange/offers/${offerId}/reject`),
            cookieNameFor(role, 'counterparty'),
          ),
        ),
      expect: {
        anonymous: { status: 403, kind: 'login' },
        stranger: { status: 403, kind: 'denied' },
        admin: { status: 403, kind: 'denied' },
        party: { status: 403, kind: 'denied' },
      },
    },
    {
      handler: 'withdraw',
      label: 'POST /exchange/offers/:offerId/withdraw（声明：SwapOffer.withdraw，**无条件**）',
      party: 'proposer',
      call: (role) =>
        reasonBody(
          withCookie(
            request(app.getHttpServer()).post(`/exchange/offers/${withdrawableOfferId}/withdraw`),
            cookieNameFor(role, 'proposer'),
          ),
        ),
      expect: {
        anonymous: { status: 403, kind: 'login' },
        // 无条件的声明 ⇒ 守卫放行，服务层的「只有发起方」判否 ⇒ 404（不泄露存在性）。
        stranger: { status: 404, kind: 'content', code: 'EXCHANGE_OFFER_NOT_FOUND' },
        admin: { status: 404, kind: 'content', code: 'EXCHANGE_OFFER_NOT_FOUND' },
        // 验收面：发起方撤回**成功**（`WITHDRAWN` 是终态）。
        party: { status: 200, kind: 'ok' },
      },
    },
    {
      handler: 'readOffer',
      label: 'GET /exchange/offers/:offerId（声明：SwapOffer.read + 条件 swapOfferParty）',
      party: 'proposer',
      call: (role) =>
        withCookie(
          request(app.getHttpServer()).get(`/exchange/offers/${offerId}`),
          cookieNameFor(role, 'proposer'),
        ),
      expect: {
        anonymous: { status: 403, kind: 'login' },
        stranger: { status: 403, kind: 'denied' },
        admin: { status: 403, kind: 'denied' },
        // ★ 验收面：**双方都读得到，且不判状态**（Task 7 修掉了 Task 6 报告的那条缺陷）。
        // `offerId` 是一份**已经 `ACCEPTED`** 的要约 —— 在旧声明（`swapOfferSent`）下
        // 双方都是 403；新声明（`swapOfferParty`）下双方都是 200。
        party: { status: 200, kind: 'ok' },
      },
    },
    {
      handler: 'confirmLock',
      label: 'POST /exchange/contracts/:contractId/confirm-lock（声明：SwapContract.confirmLock + 条件 swapContractParty）',
      party: 'counterparty',
      call: (role) =>
        withCookie(
          request(app.getHttpServer()).post(`/exchange/contracts/${contractId}/confirm-lock`),
          cookieNameFor(role, 'counterparty'),
        ),
      expect: {
        anonymous: { status: 403, kind: 'login' },
        stranger: { status: 403, kind: 'denied' },
        admin: { status: 403, kind: 'denied' },
        // ★ 验收面：被要约方（`partyA`）**第一次**确认成功 ⇒ 200，合约仍在
        // `PENDING_BOTH_LOCK`（还没轮到对方）。`readContract` 那一格证明这条路对当事人是通的。
        party: { status: 200, kind: 'ok' },
      },
    },
    {
      handler: 'readContract',
      label: 'GET /exchange/contracts/:contractId（声明：SwapContract.read + 条件 swapContractParty）',
      party: 'counterparty',
      call: (role) =>
        withCookie(
          request(app.getHttpServer()).get(`/exchange/contracts/${contractId}`),
          cookieNameFor(role, 'counterparty'),
        ),
      expect: {
        anonymous: { status: 403, kind: 'login' },
        stranger: { status: 403, kind: 'denied' },
        admin: { status: 403, kind: 'denied' },
        // ★ 验收面：合约**没有状态维度**（`swapContractParty` 不判 status），
        //   因此当事人即使在合约已经 `VALIDATING` 之后也读得到。
        party: { status: 200, kind: 'ok' },
      },
    },
  ];

  for (const row of MATRIX) {
    for (const role of ROLES) {
      const expected = row.expect[role];
      it(`${row.label} × ${role} ⇒ ${String(expected.status)}`, async () => {
        const res = await row.call(role);
        const resBody = res.body as { code?: string; message?: string };
        expect(res.status, failureDetail(res)).toBe(expected.status);

        if (expected.kind === 'login') {
          // **匿名与「已登录但没被授权」必须可区分**：这里判的是「身份缺失，判定还没开始」。
          expect(resBody.message, '匿名请求拿到的不是「需要登录」').toBe('需要登录');
        }
        if (expected.kind === 'denied') {
          // 守卫的条件判否：它的消息与「需要登录」**不同**，这就是两格之间的判别力。
          expect(resBody.message, '条件判否拿到的不是「该资源未被授权访问」').toBe('该资源未被授权访问');
        }
        if (expected.kind === 'content') {
          expect(resBody.code, '服务层的拒绝没有给出可检索的 code').toBe(expected.code);
          expect(resBody.message, '这一格本该是服务层的判定，却拿到了守卫的消息').not.toBe('该资源未被授权访问');
        }
      });
    }
  }

  /**
   * ★ 条件的**验收面**：`swapOfferSent` 恰好放行「被要约方 + `SENT`」，
   * 而 `swapOfferParty`（Task 7 给**读**新增的那一条）放行**双方、不判状态**。
   *
   * 上面那张矩阵里 `accept` / `reject` 的 `party` 格全是 403，因为它们跑在一份
   * **已经 `ACCEPTED`** 的要约上。没有下面这几条用例，「条件判否」与「条件永远判否」
   * 长得一模一样 —— 那正是「一条不可能失败的断言」。
   *
   * ## 四个方向（本用例的全部内容）
   *   ① 新的 `SENT` 要约上，**对手方**读得到（200）；
   *   ② **发起方**读**自己的**要约也读得到（200）—— 这是控制器裁定「修」的那一半
   *      （Task 6 据实报告：旧声明下这里是 **403**，而那与这条路由自己的注释、
   *      以及服务层 `getOffer` 的判定都相反）；
   *   ③ **陌生人**仍然 403「该资源未被授权访问」（拒绝面，且与「需要登录」可区分）；
   *   ④ 一份**终态**（`EXPIRED`）要约：**双方都读得到**（200）—— 而**同一个**终态要约上
   *      `accept` 仍然 403：两条条件因此是**两条规则**，不是一次放宽。
   *
   * ⑤ 不存在的 id ⇒ 403（fail-closed：条件查不到那一行就判否，不泄露存在性）。
   */
  it('★ 读要约的两个条件各守各的：双方（含发起方、含终态）读得到 200，陌生人 403，而终态**接受**仍然 403', async () => {
    const exchange = app.get(ExchangeService);
    const proposerId = (await prisma.swapOffer.findUniqueOrThrow({ where: { id: offerId } })).proposerId;
    // 换一件**新的**被要约作品（同一对 `(target, counterparty)` 上的活跃要约唯一）。
    const freshTarget = (await prisma.asset.create({ data: { ownerId: (await prisma.user.create({ data: {} })).id } })).id;
    const owner = (await prisma.asset.findUniqueOrThrow({ where: { id: freshTarget } })).ownerId;
    const version = await prisma.assetVersion.create({
      data: {
        assetId: freshTarget,
        sha256: `sha256-${freshTarget}`,
        storageKey: `probe/${freshTarget}`,
        plaintextBytes: 1,
        keyId: 'k1',
        fileId: `file-${freshTarget}`,
        uploadedById: owner,
      },
    });
    await prisma.assetMetadata.create({
      data: {
        assetVersionId: version.id,
        readmeExcerpt: '# 又一件',
        fileTree: [{ path: 'src/index.ts', bytes: 1 }],
        languages: [{ name: 'TypeScript', bytes: 1, ratio: 1 }],
        dependencies: [],
        completeness: 40,
        fileTreeTruncated: false,
        codeLines: 10,
      },
    });
    const fresh = await exchange.proposeOffer({
      proposerId,
      offeredAssetId,
      targetAssetId: freshTarget,
      offeredDossierDigest: DIGEST,
      claims: null,
    });

    // 需要一个**新的**对手方会话（`freshTarget` 的所有人）。
    const { sessionId } = await sessions.create(owner, { ip: '127.0.0.1', userAgent: 'vitest' });
    const ownerCookie = `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`;
    const read = async (cookieName: string, id: string): Promise<request.Response> =>
      request(app.getHttpServer())
        .get(`/exchange/offers/${id}`)
        .set('Cookie', cookieName)
        .set(CSRF_HEADER, csrf);

    // ① 对手方读到（验收面）。
    const asOwner = await read(ownerCookie, fresh.offerId);
    expect(asOwner.status, failureDetail(asOwner)).toBe(200);
    expect((asOwner.body as { offerId: string }).offerId).toBe(fresh.offerId);

    // ② ★ 发起方读**自己的**要约 ⇒ 200（Task 7 修掉的那一半；旧声明下这里是 403）。
    const asProposer = await read(cookies.get('proposer') as string, fresh.offerId);
    expect(
      asProposer.status,
      `发起方必须能读自己的要约（控制器裁定：那是他自己的数据）。实测：${failureDetail(asProposer)}`,
    ).toBe(200);
    expect((asProposer.body as { offerId: string }).offerId).toBe(fresh.offerId);

    // ③ 陌生人仍然读不到，且理由与匿名**不同**（守卫的条件判否，不是「需要登录」）。
    const asStranger = await read(cookies.get('stranger') as string, fresh.offerId);
    expect(asStranger.status, failureDetail(asStranger)).toBe(403);
    expect((asStranger.body as { message: string }).message).toBe('该资源未被授权访问');

    // ⑤ 不存在的 id ⇒ 403（fail-closed；不给「这个 id 存在吗」这个问题一个不同的答案）。
    const missing = await read(cookies.get('proposer') as string, '01920000-0000-7000-8000-0000000000ff');
    expect(missing.status, failureDetail(missing)).toBe(403);
    expect((missing.body as { message: string }).message).toBe('该资源未被授权访问');

    // ④ 终态要约：**双方都读得到**（200），而 `accept` 仍然 403。
    await prisma.swapOffer.update({ where: { id: fresh.offerId }, data: { status: 'EXPIRED' } });
    const ownerOnTerminal = await read(ownerCookie, fresh.offerId);
    expect(ownerOnTerminal.status, `终态要约对手方必须读得到。实测：${failureDetail(ownerOnTerminal)}`).toBe(200);
    expect((ownerOnTerminal.body as { status: string }).status).toBe('EXPIRED');
    const proposerOnTerminal = await read(cookies.get('proposer') as string, fresh.offerId);
    expect(proposerOnTerminal.status, `终态要约发起方必须读得到。实测：${failureDetail(proposerOnTerminal)}`).toBe(200);

    // ★ 判别力：**同一个**终态要约上，`accept` 走的是另一条条件（`swapOfferSent`）
    // ⇒ 403。这一格证明「读放宽了」**没有**顺手把决定类动作也放宽 ——
    // 两条规则各自守着自己的那一半。
    const acceptOnTerminal = await request(app.getHttpServer())
      .post(`/exchange/offers/${fresh.offerId}/accept`)
      .set('Cookie', ownerCookie)
      .set(CSRF_HEADER, csrf)
      .send({ targetCommitment: { assetVersionId: version.id, dossierDigest: DIGEST } });
    expect(
      acceptOnTerminal.status,
      `终态要约**不能**被接受（swapOfferSent 那一半没有被放宽）。实测：${failureDetail(acceptOnTerminal)}`,
    ).toBe(403);
    expect((acceptOnTerminal.body as { message: string }).message).toBe('该资源未被授权访问');
  });

  it('矩阵自身覆盖 ExchangeController 的**全部**已注册路由（少一条端点就是一个盲区）', async () => {
    // 「空的矩阵」与「空的覆盖率门」是同一种失败：全绿可能只是「矩阵里没写那条端点」。
    const registered = app
      .get(RouteDeclarationRegistry)
      .listRoutes()
      .filter((route) => route.controller === 'ExchangeController');

    expect(registered.length, '注册表里没有 ExchangeController 的任何路由：发现层没接通').toBeGreaterThan(0);
    expect(registered.map((route) => route.handler).sort()).toEqual(MATRIX.map((row) => row.handler).sort());

    // 非空转前提的加强版：七条路由的**路径与声明**确实在注册表里，逐条。
    // 少了这一条，把七条路由**整个删掉**也能让上面的集合相等（两边都只剩空数组）——
    // 而 `AppModule` 漏掉 `ExchangeModule` 时正是那个形状（运行期 404、门照样绿）。
    expect(registered.map((route) => `${route.handler} ${route.path} ${route.isPublic ? 'public' : 'guarded'}`).sort())
      .toEqual([
        'accept /exchange/offers/:offerId/accept guarded',
        'confirmLock /exchange/contracts/:contractId/confirm-lock guarded',
        'propose /exchange/offers guarded',
        'readContract /exchange/contracts/:contractId guarded',
        'readOffer /exchange/offers/:offerId guarded',
        'reject /exchange/offers/:offerId/reject guarded',
        'withdraw /exchange/offers/:offerId/withdraw guarded',
      ]);
  });
});

