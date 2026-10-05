import { describe, expect, it } from 'vitest';
import { assetErrorToHttp } from '@vca/api/modules/asset/asset.controller.js';
import { AssetVersionNotFoundError } from '@vca/api/modules/asset/asset-access.service.js';
import {
  ArchiveRejectedError,
  ArtifactCleanupError,
  ArtifactUnreadableError,
} from '@vca/api/modules/asset/asset.service.js';
import { DownloadForbiddenError, DownloadTicketRejectedError } from '@vca/api/modules/asset/download/download.service.js';
import { AssetNotFoundError, SelfTransferRejectedError } from '@vca/api/modules/asset/ownership.service.js';

/**
 * 领域错误 → HTTP 的**翻译表**（P1 / Task 8）。
 *
 * ## 这个文件为什么必须存在：一条裁定不能只活在散文里
 *
 * Task 7 把 `SelfTransferRejectedError` 的状态码**明确留给** Task 8（它的报告 §9 第 2 条：
 * 「设计没有规定这个情形……若裁定为拒绝，改法是一行判断 + 一个错误类型 + 两条用例」，
 * 而状态码那一问同样被留下来了）。裁定写在报告里、而代码里没有落点的话，
 * 下一个接线转让端点的人（P2）会**再选一次**——本仓库反复吃过的「声明了但没有执行」。
 *
 * 因此这里把整张表逐行钉住：每一条**状态码 + `code`**都是断言，其中
 * `SelfTransferRejectedError ⇒ 409` 是本任务做出、并在这里固定的那一条。
 *
 * ## 409 的理由（与 404 / 422 的对照写在控制器那张表里，这里是它的判别式）
 *
 * - **404 是错的**：作品存在，而且调用方通常就是它的所有人。404 在本仓库已经表示
 *   「不存在」（`AssetNotFoundError`）——两种因由共用一个码，边界上就分不出
 *   「你指错了对象」与「这次转让不成立」。下面**逐条断言两者都映射到 404 的同一个 code**
 *   （它们确实是同一类），同时断言 409 **不是** 404——即「自转」不混进那一类。
 * - **422 不合适**：本仓库的 422 是「内容不可接受」（`ASSET_ARCHIVE_REJECTED`）。
 *   自转的请求内容完全合法，冲突在**资源当前状态**上，那是 409 的定义。
 *
 * ## 判别力
 *
 * 整张表在实现写成的那一刻就是绿的，因此它需要变异探针（见报告）：
 * 把 409 改成 404 / 把 `ASSET_DOWNLOAD_TICKET_*` 的 `code` 去掉理由后缀 / 让未知错误
 * 也映射成 500，都会让**恰好**对应的那条断言变红。
 */

/** 一条映射的判据：拿状态码与响应体里的 `code`。 */
function mapped(error: unknown): { status: number; code: unknown; body: unknown } | null {
  const http = assetErrorToHttp(error);
  if (http === null) return null;
  return { status: http.getStatus(), code: (http.getResponse() as { code?: unknown }).code, body: http.getResponse() };
}

describe('asset 边界的领域错误 → HTTP 映射（Task 8 的裁定落点）', () => {
  it('「转给自己」⇒ 409（冲突的是**资源当前状态**，不是「不存在」也不是「内容不合法」）', () => {
    const result = mapped(new SelfTransferRejectedError('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'));

    expect(result).not.toBeNull();
    expect(result?.status).toBe(409);
    expect(result?.code).toBe('ASSET_SELF_TRANSFER_REJECTED');
    // 反面对照：它**不许**落进 404 / 422 这两档（那正是裁定被推翻时会走到的两处）。
    expect(result?.status, '自转被当成了「作品不存在」').not.toBe(404);
    expect(result?.status, '自转被当成了「内容不可接受」').not.toBe(422);
  });

  it('作品不存在与版本不存在 ⇒ 404，且共用同一个 code（两者都是「你指错了对象」）', () => {
    expect(mapped(new AssetNotFoundError('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'))).toMatchObject({
      status: 404,
      code: 'ASSET_VERSION_NOT_FOUND',
    });
    expect(mapped(new AssetVersionNotFoundError('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'))).toMatchObject({
      status: 404,
      code: 'ASSET_VERSION_NOT_FOUND',
    });
  });

  it('`checkAccess` 判否 ⇒ 403，且与「票据不可用」的 code 分得开', () => {
    const forbidden = mapped(new DownloadForbiddenError('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'));
    expect(forbidden).toMatchObject({ status: 403, code: 'ASSET_DOWNLOAD_NOT_AUTHORIZED' });
    // 「这张票是好的、这个人不行」与「这张票不行」是两类事件：状态码同为 403（责任方相同），
    // 但 code 必须不同（告警规则与排障方向不同）。
    expect(forbidden?.code).not.toBe('ASSET_DOWNLOAD_TICKET_EXPIRED');
  });

  it('票据不可用：四种理由各自一个 code，状态码统一 403', () => {
    for (const reason of ['malformed', 'bad_signature', 'expired', 'ttl_too_long', 'replayed'] as const) {
      expect(mapped(new DownloadTicketRejectedError(reason))).toMatchObject({
        status: 403,
        code: `ASSET_DOWNLOAD_TICKET_${reason.toUpperCase()}`,
      });
    }
  });

  it('归档被拒 ⇒ 422，且**类型与理由原样带出**（拒绝理由只带非机密量）', () => {
    const result = mapped(new ArchiveRejectedError('zip', '累计解压后超过上限'));
    expect(result?.status).toBe(422);
    expect(result?.body).toEqual({ code: 'ASSET_ARCHIVE_REJECTED', kind: 'zip', reason: '累计解压后超过上限' });
  });

  it('服务端侧的两个错误 ⇒ 500，且都不带内部明细', () => {
    expect(mapped(new ArtifactUnreadableError('objects/ab/cd/key', '末块认证失败'))).toMatchObject({
      status: 500,
      code: 'ASSET_ARTIFACT_UNREADABLE',
    });
    expect(mapped(new ArtifactCleanupError('objects/ab/cd/key', 3, 'EPERM', null))).toMatchObject({
      status: 500,
      code: 'ASSET_ARTIFACT_CLEANUP_FAILED',
    });
    // 明细（存储键、错误文本）不进响应体：那是内部诊断信息。
    expect(JSON.stringify(mapped(new ArtifactUnreadableError('objects/ab/cd/key', '末块认证失败'))?.body)).not.toContain(
      'objects/ab/cd/key',
    );
  });

  it('不是领域错误 ⇒ `null`（处理器原样重抛，绝不被翻译成一个假的 5xx）', () => {
    // 这条是「翻译表只认识它认识的东西」的判据：一个 TypeError（代码缺陷）被吞成 500
    // 的 `code` 会让真正的缺陷在监控里看起来像一次业务拒绝。
    for (const junk of [new Error('boom'), new TypeError('bad'), null, undefined, 'boom', 42, {}]) {
      expect(assetErrorToHttp(junk as Error), `${String(junk)} 被翻译了`).toBeNull();
    }
  });
});
