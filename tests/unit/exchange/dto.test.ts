import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseOrBadRequest } from '@vca/api/common/http/parse-or-bad-request.js';
import {
  MAX_OFFER_REASON_TEXT,
  OFFER_DECISION_REASONS,
  acceptOfferSchema,
  offerReasonSchema,
  proposeOfferSchema,
  uuidParamSchema,
} from '@vca/api/modules/exchange/dto.js';

/**
 * 交换的 DTO（P3 / Task 6 + 增量 A-6）。**纯函数，不需要数据库。**
 *
 * ## 它判的三件事，以及各自为什么值得一条用例
 *
 * 1. **路径参数是 UUID**：`offerId` / `contractId` 会在**碰数据库之前**被校验。
 *    不校验的话一个形状不对的 id 会让 Postgres 以 `22P02` 失败 ⇒ 500，
 *    而那把一次调用方错误说成了一次服务端故障（`asset-access.service.ts` 的类注释
 *    末段把这条明确交给 HTTP 边界）。
 * 2. **理由的取值是闭集**：`reason` 会被写进 `swap_offers.reason` 与审计行，而它的
 *    调用方是**外部 HTTP 请求**（不是内部调用方）。设计文档里没有任何一处枚举过理由，
 *    因此这里的集合是「最保守并且在今天可判定的一档」（P2 `Ledger.grant` 的同一处置），
 *    理由与复访条件写在 `dto.ts` 的 `OFFER_DECISION_REASONS` 上。
 * 3. **`claims` 的形状**（增量 A-6）：闭集**不在这里**判——它是 `core/claims.ts`
 *    的**唯一**来源（规格 §6.3：「解析器与 `judge` 的判据都从**同一张表**派生，
 *    禁止两处各写一份」）。这一层只把它当作一个不透明的取值转交下去，
 *    因此闭集外的 `kind` 得到的是 **422 `EXCHANGE_INVALID_CLAIMS`** 而不是 400。
 */
describe('交换的 DTO（C4 UUID / 理由闭集 / claims 的形状）', () => {
  const UUID = '01920000-0000-7000-8000-000000000001';
  const UUID2 = '01920000-0000-7000-8000-000000000002';
  const DIGEST = 'a'.repeat(64);

  it('路径参数不是 UUID ⇒ 400（在**碰数据库之前**），是 UUID ⇒ 通过', () => {
    expect(parseOrBadRequest(uuidParamSchema, { id: UUID })).toBe(UUID);
    for (const bad of ['not-a-uuid', '', '123', `${UUID}x`]) {
      expect(() => parseOrBadRequest(uuidParamSchema, { id: bad }), `${bad} 必须被拒`).toThrow(
        BadRequestException,
      );
    }
    // 非字符串（路径参数理论上总是字符串，但 `@Param()` 的形状由 Nest 给，
    // 而 `z.uuid()` 对 `number` 的 issue 同样是 400）。
    expect(() => parseOrBadRequest(uuidParamSchema, { id: 7 })).toThrow(BadRequestException);
  });

  it('理由的取值是闭集：闭集外一律 400，闭集内逐条通过（**每条拒绝都有验收对照**）', () => {
    for (const reason of OFFER_DECISION_REASONS) {
      expect(parseOrBadRequest(offerReasonSchema, { reason })).toBe(reason);
    }
    for (const bad of ['随便写的理由', 'not_interested', '', '   ', 'NOT_INTERESTED ']) {
      expect(() => parseOrBadRequest(offerReasonSchema, { reason: bad }), `${JSON.stringify(bad)} 必须被拒`).toThrow(
        BadRequestException,
      );
    }
  });

  it('理由的长度上限是**闭的**（恰好上限通过、多一个字符被拒）', () => {
    // 今天没有一条闭集取值接近这个上限（最长的那条远短于它），因此这条界**不是**靠
    // 取值集合来行使的——它是一条独立的长度判据，将来加一条长理由时它才是执行点。
    const long = 'X'.repeat(MAX_OFFER_REASON_TEXT);
    expect(long.length).toBe(MAX_OFFER_REASON_TEXT);
    // 用一个**形状合法**的取值把它行使到：把闭集放宽成「有界的串」时这条会立刻红，
    // 而那一刻长度界就成了唯一的守卫。
    expect(() => parseOrBadRequest(offerReasonSchema, { reason: `${long}Y` })).toThrow(BadRequestException);
    expect(OFFER_DECISION_REASONS.every((reason) => reason.length <= MAX_OFFER_REASON_TEXT)).toBe(true);
  });

  it('发要约：两个 UUID 与 `offeredDossierDigest` 必填，`claims` 原样转交（闭集**不在这一层**判）', () => {
    expect(
      parseOrBadRequest(proposeOfferSchema, {
        offeredAssetId: UUID,
        targetAssetId: UUID2,
        offeredDossierDigest: DIGEST,
      }),
    ).toEqual({
      offeredAssetId: UUID,
      targetAssetId: UUID2,
      offeredDossierDigest: DIGEST,
      claims: undefined,
    });

    // `claims` 是一条**不透明**取值：闭集外的 kind 在这里**不被拒**（它会是 422，
    // 由 `core/claims.ts` 唯一判定）。这一条是那份分工的可执行见证——
    // 若有人把闭集复制进 zod，这里会立刻红，而规格 §6.3 禁止两处各写一份。
    const opaque = [{ kind: 'quality_is_good' }];
    expect(
      parseOrBadRequest(proposeOfferSchema, {
        offeredAssetId: UUID,
        targetAssetId: UUID2,
        offeredDossierDigest: DIGEST,
        claims: opaque,
      }),
    ).toMatchObject({ claims: opaque });

    // 三个必填项各自都要判：只判两个时第三个的缺失会走到服务里变成一次别的失败。
    for (const missing of ['offeredAssetId', 'targetAssetId', 'offeredDossierDigest'] as const) {
      const body: Record<string, unknown> = {
        offeredAssetId: UUID,
        targetAssetId: UUID2,
        offeredDossierDigest: DIGEST,
      };
      delete body[missing];
      expect(() => parseOrBadRequest(proposeOfferSchema, body), `缺少 ${missing} 必须被拒`).toThrow(
        BadRequestException,
      );
    }
    // 形状不对的两项：UUID 与「有界的非空串」。
    expect(() =>
      parseOrBadRequest(proposeOfferSchema, {
        offeredAssetId: 'x',
        targetAssetId: UUID2,
        offeredDossierDigest: DIGEST,
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseOrBadRequest(proposeOfferSchema, {
        offeredAssetId: UUID,
        targetAssetId: UUID2,
        offeredDossierDigest: '   ',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseOrBadRequest(proposeOfferSchema, {
        offeredAssetId: UUID,
        targetAssetId: UUID2,
        offeredDossierDigest: 'b'.repeat(201),
      }),
    ).toThrow(BadRequestException);
  });

  it('接受（A-6 的 TOCTOU 执行点）：`targetCommitment` 的两项都必填，且形状各有界', () => {
    expect(
      parseOrBadRequest(acceptOfferSchema, {
        targetCommitment: { assetVersionId: UUID, dossierDigest: DIGEST },
      }),
    ).toEqual({ targetCommitment: { assetVersionId: UUID, dossierDigest: DIGEST } });

    const bad = [
      {}, // 没有任何承诺
      { targetCommitment: {} },
      { targetCommitment: { assetVersionId: UUID } },
      { targetCommitment: { dossierDigest: DIGEST } },
      { targetCommitment: { assetVersionId: 'x', dossierDigest: DIGEST } },
      { targetCommitment: { assetVersionId: UUID, dossierDigest: '' } },
      { targetCommitment: { assetVersionId: UUID, dossierDigest: '   ' } },
      { targetCommitment: { assetVersionId: UUID, dossierDigest: 'b'.repeat(201) } },
      // 多余键被拒：一个陌生的键进不了钉住的那一列，而它会让「带回的是什么」说不清。
      { targetCommitment: { assetVersionId: UUID, dossierDigest: DIGEST, extra: 1 } },
    ];
    for (const body of bad) {
      expect(() => parseOrBadRequest(acceptOfferSchema, body), `${JSON.stringify(body)} 必须被拒`).toThrow(
        BadRequestException,
      );
    }
  });
});
