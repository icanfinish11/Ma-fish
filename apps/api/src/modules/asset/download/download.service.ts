import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Readable } from 'node:stream';
import type { Env } from '../../../config/env.schema.js';
import { REDIS } from '../../../db/redis.module.js';
import { AuditService } from '../../audit/index.js';
import { AssetAccessService, AssetVersionNotFoundError, type DownloadableVersion } from '../asset-access.service.js';
import { ArchiveRejectedError, ArtifactUnreadableError } from '../asset.service.js';
import type { ArchiveKind } from '../archive/sniff.js';
import { validateArchive } from '../archive/validate-archive.js';
import { KEY_RING, type KeyRing } from '../crypto/key-ring.js';
import { ARTIFACT_STORE, type ArtifactStore } from '../store/artifact-store.port.js';
import { EncryptedArtifactReader } from '../store/random-access-reader.js';
import { consumeNonce } from './nonce-store.js';
import {
  DOWNLOAD_TTL_SECONDS,
  buildDownloadPath,
  createNonce,
  inspectTicket,
  parseTicketQuery,
  signTicket,
  type DownloadTicket,
} from './signed-url.js';

/**
 * 签名下载（P1 / Task 8；设计决定 D10 + D11）。
 *
 * ## 两条路径，六个步骤，顺序即语义
 *
 * ```
 * ① 签发（需要会话身份）
 *    找版本 → checkAccess → 签票 → 写审计 → 返回 { url, expiresAt }
 *
 * ② 兑换（签名就是凭证，无会话）
 *    解析票据 → 验签/期限 → 找版本 → **再判一次** checkAccess
 *             → **原子消费 nonce** → 打开**本请求的**读取器
 *             → 带外长度核对 + 末块认证 + 归档校验 → 写审计 → 流
 * ```
 *
 * ### 为什么兑换时**再判一次** `checkAccess`
 *
 * 签发与兑换之间可以发生一次所有权转让。只信票据的话，前手在转让前拿到的那张票
 * 在 ≤5 分钟内仍然能下载——而「谁能下载」这件事的唯一入口是 `checkAccess`（D11），
 * 它必须在**真正给出字节**的那一刻成立，而不只是在签发时成立。
 *
 * ### 为什么 nonce 在「打开制品」之前消费
 *
 * 消费是**不可逆**的（那一张票就废了）。放在昂贵的工作（解密、校验）之前：
 * 一张重放的票不会换来一次完整的解密与校验，而一次损坏的制品也不会让票被用两次
 * ——后者是刻意的：**同一张票不允许重试**，否则「单次使用」就变成了「同一张票可以用到成功为止」。
 *
 * ## 强制义务（Task 5 / Task 7 两次移交的那一条）
 *
 * 制品格式里**没有任何字段认证「制品有多长」**：`plaintextLength` 写在尾部、不进任何 AAD。
 * 于是一份**更短、完全自洽**的制品（另一份合法归档重新加密的产物：末块标记正确、
 * 三条完整性校验全过）在只信「自称值」的路径上会被当成合法的。
 * Task 5 的探针 m6 在接入期实测过它：不传带外长度 ⇒ 接受；传 ⇒ 422。
 *
 * 因此这里把 **`AssetVersion.plaintextBytes`（写入侧计量器数出、Task 7 落的库）**
 * 作为 `expectedPlaintextLength` 传给 `validateArchive`，而它会
 * ①先做带外长度核对（零读取）②**认证末块** ③再嗅探与分发。这条核对在下载路径上
 * 与接入期**逐字相同**——同一个函数、同一个数、同一处拒绝。
 *
 * **核对必须发生在写出第一个字节之前**：`validateArchive` 先跑，结论不是 `ok` 就抛错，
 * 响应体里因此一个制品的字节都没有（判据是 422 + 零字节，见集成用例）。
 *
 * ## 每个请求一个新读取器（**禁止**池化）
 *
 * `EncryptedArtifactReader` 在内存里留**最近一块明文**（`recent`，最大 8 MiB）。
 * 一个跨请求复用的读取器因此会把「上一个请求的明文块」留在进程里，而且它的
 * 索引/几何状态是打开那一刻从**当时的对象字节**里读出来的——对象只要变过
 * （重写、轮换、清理），复用的读取器就会继续按旧几何解密，静默返回**错的内容**。
 * 因此读取器是**方法内的局部变量**：本类没有任何字段持有它，也没有缓存/池。
 * 这一条有用例：替换盘上的对象之后再下载，第二次必须给出**新的**字节。
 *
 * ## 一处据实记载：审计的**边界**
 *
 * 写审计的前提是「当事人可信」。签发路径的当事人来自会话，兑换路径的当事人来自
 * **我们自己签出来的票据**——两者都可信。而 `malformed` / `bad_signature` 这两种失败
 * **没有当事人**（票据是伪造的，里面的 `userId` 是攻击者随便填的）：
 * 给它们写审计行等于给**任何匿名请求**一个向 append-only 表里无界写入的入口
 * （那张表没有删除入口，见 `infra/db/apply-grants.sql`）。因此这两类**不写审计**，
 * 其余每一类失败都写，成功也写（D10）。
 * 代价如实记录：伪造票据的尝试只在日志/限流层可见，不在审计表里。
 */
@Injectable()
export class DownloadService {
  private readonly secret: string;

  /**
   * `secret` 在**构造期**取（而不是每次签发现取）：`DOWNLOAD_URL_SECRET` 是必填项
   * （引导期 schema 已经拒绝缺失），这里再读一次只是把它固定下来——配置错误的表现
   * 因此是启动期失败，而不是某一次下载签出一张「用空密钥签的票」。
   */
  constructor(
    private readonly access: AssetAccessService,
    private readonly audit: AuditService,
    @Inject(ARTIFACT_STORE) private readonly store: ArtifactStore,
    @Inject(KEY_RING) private readonly ring: KeyRing,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('DOWNLOAD_URL_SECRET', { infer: true });
  }

  /**
   * ① 签发一张下载票据（D11 的 `signDownloadUrl`）。
   *
   * @throws {AssetVersionNotFoundError} 版本不存在（404；**不写审计**——给任意 UUID 都
   *   写一行 append-only 的表就是一个无界写入放大器，理由见类注释的审计边界一段）。
   * @throws {DownloadForbiddenError} `checkAccess` 判否（403；**写审计**，当事人来自会话）。
   */
  async issueDownloadUrl(assetVersionId: string, userId: string): Promise<IssuedDownload> {
    const version = await this.access.findDownloadableVersion(assetVersionId);
    if (version === null) throw new AssetVersionNotFoundError(assetVersionId);

    if (!(await this.access.checkAccess(version.assetId, userId))) {
      await this.record('asset.download_denied', assetVersionId, userId, { reason: 'not_authorized' });
      throw new DownloadForbiddenError(assetVersionId, userId);
    }

    // 秒级时间戳：TTL 的口径就是秒（见 signed-url.ts 的 expiresAt 注释）。
    const now = Math.floor(Date.now() / 1000);
    const unsigned = { assetVersionId, userId, expiresAt: now + DOWNLOAD_TTL_SECONDS, nonce: createNonce() };
    const ticket: DownloadTicket = { ...unsigned, signature: signTicket(unsigned, this.secret) };

    await this.record('asset.download_url_issued', assetVersionId, userId, { expiresAt: ticket.expiresAt });
    // 返回**相对**路径（理由见 signed-url.ts 的 buildDownloadPath）；票据本身只在
    // 这条 URL 里，不进日志、不进审计（C11）。
    return { url: buildDownloadPath(ticket), expiresAt: ticket.expiresAt };
  }

  /**
   * ② 兑换一张票据：判定 → 授权 → 消费 nonce → **完整性核对** → 返回可读的流。
   *
   * 返回的 `stream` 由控制器直接接到响应上；本方法返回之前，**所有**判定都已经做完，
   * 因此「被拒的请求不会发出任何字节」是结构性的（不是靠控制器记得别写）。
   */
  async openDownload(rawQuery: unknown): Promise<OpenedDownload> {
    const parsed = parseTicketQuery(rawQuery);
    if (parsed === null) {
      // 无当事人 ⇒ 不写审计（见类注释）；理由分类仍然回给调用方，便于排障与测试。
      throw new DownloadTicketRejectedError('malformed');
    }

    const verdict = inspectTicket(parsed, this.secret, Math.floor(Date.now() / 1000));
    if (verdict === 'malformed' || verdict === 'bad_signature') {
      // 同上：伪造的载荷里那个 `userId` 不是当事人，写进审计只会是一条攻击者编的内容。
      throw new DownloadTicketRejectedError(verdict);
    }
    if (verdict !== 'ok') {
      await this.record(`asset.download_failed`, parsed.assetVersionId, parsed.userId, { reason: verdict });
      throw new DownloadTicketRejectedError(verdict);
    }

    const version = await this.access.findDownloadableVersion(parsed.assetVersionId);
    if (version === null) throw new AssetVersionNotFoundError(parsed.assetVersionId);

    // 兑换时**再判一次**（理由见类注释）：票据的当事人是可信的（它就在签名里）。
    if (!(await this.access.checkAccess(version.assetId, parsed.userId))) {
      await this.record('asset.download_failed', parsed.assetVersionId, parsed.userId, { reason: 'not_authorized' });
      throw new DownloadForbiddenError(parsed.assetVersionId, parsed.userId);
    }

    // TTL 取**这张票剩下的寿命**：台账里的键不会比它保护的那张票活得更久
    // （`consumeNonce` 自己会把上下界夹住）。
    const remaining = parsed.expiresAt - Math.floor(Date.now() / 1000);
    if (!(await consumeNonce(this.redis, parsed.nonce, remaining))) {
      await this.record('asset.download_failed', parsed.assetVersionId, parsed.userId, { reason: 'replayed' });
      throw new DownloadTicketRejectedError('replayed');
    }

    return this.readVerified(version, parsed);
  }

  /** 打开制品并**先**跑完整套完整性判据，再返回流。 */
  private async readVerified(version: DownloadableVersion, ticket: DownloadTicket): Promise<OpenedDownload> {
    let reader: EncryptedArtifactReader;
    try {
      // **本请求局部**的读取器（见类注释：不池化、不缓存、不留字段）。
      reader = await EncryptedArtifactReader.open(this.store, version.storageKey, this.ring);
      /**
       * **承重的一行（I1）**：盘上那份制品必须是**这条版本记录指向的那一份**。
       *
       * 删掉它 ⇒ 任何能往制品卷里写一个文件的人（正是本地加密卷设计所针对的那个不可信角色）
       * 可以把对象换成**另一份明文长度完全相同的、合法加密的制品**（zip 让「等长」很容易：
       * 条目名与内容同长即可），而它会通过嗅探、归档校验、末块认证与下面的带外长度核对，
       * 最后**以那位创作者的作品之名被发出去**。长度**不是身份**。
       *
       * 身份的事实来源是 `fileId`：它出现在**每一个块的 AAD** 里（`artifact-format.ts`
       * 的 `buildAad`），因此读取器报出来的这个值只能等于这份制品真实的身份——头虽然不在
       * AAD 里，但改头里的 `fileId` 会让所有块认证失败。
       *
       * 拒绝走 `ArtifactUnreadableError`（500 + 审计 `unreadable`）而不是 422：盘上那份
       * 不是这条记录指向的那一份，**责任方在服务端/存储侧**，不是调用方的制品内容不可接受。
       */
      if (reader.fileId !== version.fileId) {
        throw new Error(
          `制品的身份与版本记录不符：对象头里的 fileId=${reader.fileId}，而 asset_versions.file_id=${version.fileId}`,
        );
      }
      // `keyId` 不在 AAD 里，因此它不是新的安全边界（改了就选错密钥、解密直接失败）；
      // 它挡的是「记录与对象对不上」这一类运维错误，成本是一行。
      if (reader.keyId !== version.keyId) {
        throw new Error(
          `制品的密钥 id 与版本记录不符：对象头里的 keyId=${reader.keyId}，而 asset_versions.key_id=${version.keyId}`,
        );
      }
    } catch (error) {
      await this.recordFailure(ticket, 'unreadable');
      // 与接入路径**同一个**错误类型 ⇒ HTTP 边界上**同一处**翻译（500）。
      throw new ArtifactUnreadableError(
        version.storageKey,
        error instanceof Error ? error.message : String(error),
      );
    }

    /**
     * 承重的一行：把**库里那个明文长度**作为带外核对值传进去。
     *
     * 删掉这个参数 ⇒ 一份更短、完全自洽的制品会被当成合法的并发出去
     * （Task 5 的探针 m6 就是这个形态；本任务的变异探针 p1 在**下载路径上**实测同一件事）。
     * 它也是「先认证末块、再下任何结论」那条顺序的入口——两者都在 `validateArchive` 里。
     */
    let verdict: Awaited<ReturnType<typeof validateArchive>>;
    try {
      verdict = await validateArchive(reader, { expectedPlaintextLength: version.plaintextBytes });
    } catch (error) {
      // 读制品本身失败（非末块被篡改时，嗅探一读就认证失败）：与 `open` 失败同一条出口。
      await this.recordFailure(ticket, 'unreadable');
      throw new ArtifactUnreadableError(
        version.storageKey,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!verdict.ok) {
      await this.recordFailure(ticket, 'artifact_rejected');
      // 与上传路径**同一个**错误类型 ⇒ 同一个状态码与同一个 `code`（422 / ASSET_ARCHIVE_REJECTED）。
      // 责任方在这里其实是存储侧（调用方并没有上传什么），但两处「制品不可接受」用同一个
      // 出口是刻意的：一个理由一张状态码表迟早会与 validator 的理由漂移。
      // **注意：这里不删对象。** 上传路径拒绝时会删（那是刚写进去、注定没人要的孤儿），
      // 而下载路径遇到的是一份**已经在库里、被别的记录引用**的制品：在签名请求里顺手删除
      // 它，等于把一次「拒绝服务它」升级成一次「销毁证据」（也可能是主动的破坏）。
      throw new ArchiveRejectedError(verdict.kind, verdict.reason);
    }

    await this.record('asset.download', ticket.assetVersionId, ticket.userId, {
      bytes: reader.plaintextLength,
      kind: verdict.kind,
    });

    return {
      assetVersionId: ticket.assetVersionId,
      // `kind` 是**推导**出来的（`validateArchive` 的嗅探结论），不是库里的列：
      // Task 7 刻意没有持久化 `IngestedVersion.kind`（C16），而这里刚好免费拿到它。
      kind: verdict.kind,
      length: reader.plaintextLength,
      stream: reader.createReadStream({ start: 0, end: reader.plaintextLength }),
    };
  }

  /** 失败审计（当事人来自票据，因此可信；理由是有界取值）。 */
  private async recordFailure(ticket: DownloadTicket, reason: DownloadFailureReason): Promise<void> {
    await this.record('asset.download_failed', ticket.assetVersionId, ticket.userId, { reason });
  }

  /**
   * 写一行审计。
   *
   * `metadata` 里只有**有界的理由分类**与两个非机密量（字节数、类型）：
   * 签名、nonce、整条 URL、存储键一律不进这张 append-only 的表（C11）——
   * 写进去就删不掉。
   *
   * 审计写失败**不吞**（沿用 `AuditService` 的裁定：审计不可用就让操作失败）：
   * 一次「下载成功但没有留下任何痕迹」比一次 500 更难发现。
   */
  private async record(
    action: string,
    assetVersionId: string,
    actorId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({ actorId, action, resource: 'AssetVersion', resourceId: assetVersionId, metadata });
  }
}

/** 签发成功的结果。`url` 是**相对**路径（见 `buildDownloadPath`）。 */
export interface IssuedDownload {
  readonly url: string;
  readonly expiresAt: number;
}

/** 兑换成功的结果：控制器据此写响应头与响应体。 */
export interface OpenedDownload {
  readonly assetVersionId: string;
  /** 归档类型（**推导**而来，不是库里的列）。它决定响应的 `Content-Type`。 */
  readonly kind: ArchiveKind;
  /** 明文总字节数（= 写入侧数出的那个数，两者必须相等才走到这里）。 */
  readonly length: number;
  readonly stream: Readable;
}

/**
 * 兑换失败的理由（**有界取值**：进审计的 `metadata.reason` 与响应体的 `code`）。
 *
 * `malformed` / `bad_signature` 来自 `inspectTicket`，`replayed` 来自 nonce 台账，
 * `not_authorized` 来自 `checkAccess`，`unreadable` / `artifact_rejected` 来自制品侧。
 */
export type DownloadFailureReason =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'ttl_too_long'
  | 'replayed'
  | 'not_authorized'
  | 'unreadable'
  | 'artifact_rejected';

/**
 * 票据本身不可用（形状、签名、期限、TTL 上界、已被用过）。HTTP 上是 **403**。
 *
 * 为什么这些理由共用一个错误类型而不是各一个类：它们的**责任方**完全相同
 * （调用方拿着一张不能用的票），而 HTTP 边界只需要一处翻译；理由仍然逐字保留在
 * `reason` 里（响应体的 `code` 与审计行都按它分流），因此「分不开」这件事没有发生
 * ——分开的是**类型**，不是**信息**。
 */
export class DownloadTicketRejectedError extends Error {
  constructor(readonly reason: Exclude<DownloadFailureReason, 'not_authorized' | 'unreadable' | 'artifact_rejected'>) {
    super(`下载票据不可用：${reason}`);
    this.name = 'DownloadTicketRejectedError';
  }
}

/**
 * `checkAccess` 判否（403）。
 *
 * 与 {@link DownloadTicketRejectedError} 分开是刻意的：**这张票是好的、这个人不行**，
 * 与「这张票不行」是两类事件——运维看到的告警与排障方向完全不同
 * （前者可能是转让/权限问题，后者是伪造或重放）。
 */
export class DownloadForbiddenError extends Error {
  constructor(
    readonly assetVersionId: string,
    readonly userId: string,
  ) {
    super(`用户 ${userId} 无权下载版本 ${assetVersionId}`);
    this.name = 'DownloadForbiddenError';
  }
}
