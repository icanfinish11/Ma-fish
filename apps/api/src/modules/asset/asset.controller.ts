import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Policy, Public } from '../../common/policy/policy.decorator.js';
import { RateLimited } from '../../common/security/throttler.js';
import { currentContext } from '../../common/context/request-context.js';
import { AssetAccessService, AssetVersionNotFoundError, type AssetMetadataView } from './asset-access.service.js';
import type { ArchiveKind } from './archive/sniff.js';
import {
  ArchiveRejectedError,
  ArtifactCleanupError,
  ArtifactUnreadableError,
  AssetPersistFailedError,
  AssetService,
  type StoredArtifact,
} from './asset.service.js';
import { DownloadForbiddenError, DownloadService, DownloadTicketRejectedError, type IssuedDownload } from './download/download.service.js';
import { UUID_IDENTIFIER } from './download/signed-url.js';
import { AssetNotFoundError, SelfTransferRejectedError } from './ownership.service.js';

/**
 * multipart 里的文件字段名。控制器**与**上传适配器必须用同一个名字，
 * 因此这里写死一处：名字不匹配的失效形态是 400 `Unexpected file field`，
 * 而报文里不会告诉你「代码里期望的是哪个字段」。
 */
const UPLOAD_FIELD = 'file';

/**
 * 上传成功的响应。
 *
 * 五个字段，各自都有一个明确的用途（**不含**任何服务端内部标识）：
 *
 * | 字段 | 谁在用 |
 * |---|---|
 * | `assetId` | 这次上传**诞生的作品**（库里那一行） |
 * | `assetVersionId` | 这份版本——**属主凭它去签发下载**（`POST /assets/versions/:id/download-url`） |
 * | `sha256` | 与上传字节一致的明文摘要（客户端可自校验） |
 * | `plaintextBytes` | 明文长度（**写入侧计量器**数出的那个数，也是库里那一列） |
 * | `kind` | 判定出来的归档类型 |
 *
 * **刻意没有** `storageKey` / `fileId` / `keyId`：存储键是服务端内部状态
 * （Task 1 的控制器注释把它写成了 Task 5 的义务）。
 *
 * **Task 9 之前这里是 `{sha256, plaintextBytes, kind}`**——一条「待落库记录」的可对外部分，
 * 而那条记录当时**没有任何落点**：调用方拿到三个数，却拿不到任何能据以行动的东西
 * （没有作品、没有版本、没有可下载的对象）。现在这两个 id 就是把那条缝合上之后的产物。
 */
export interface IngestResponse {
  assetId: string;
  assetVersionId: string;
  sha256: string;
  plaintextBytes: number;
  kind: ArchiveKind;
}

/**
 * 签发响应的形状：一条**相对**路径 + 过期时刻（Unix 秒）。
 *
 * 相对路径的理由（本进程不知道自己的对外 origin，用 `Host` 拼绝对 URL 等于把一次下载
 * 交给一个调用方可控的值）写在 `download/signed-url.ts` 的 `buildDownloadPath` 里。
 */
export type IssuedDownloadResponse = IssuedDownload;

/**
 * 下载响应的 `Content-Type`（按**推导**出来的归档类型）。
 *
 * 这里刻意没有第三种可能：`validateArchive` 的结论只有 `zip` / `tar.gz` 两种
 * （`unknown` 走的是拒绝分支，不会到这一行）。
 */
const DOWNLOAD_CONTENT_TYPE = {
  zip: 'application/zip',
  'tar.gz': 'application/gzip',
} as const;

/**
 * 领域错误 → HTTP 的**唯一**翻译表（Task 8）。
 *
 * ## 为什么是一张表，而不是散在各处理器的 `instanceof` 分支里
 *
 * 「同一种错误只有一处出口」是本仓库反复付过代价的一条：上传路径原先在处理器里内联了
 * 三个分支，而 Task 7 又把两个领域错误（`AssetNotFoundError` / `SelfTransferRejectedError`）
 * 交给 Task 8 裁定状态码。如果下载路径再内联一份，同一种错误就会有两个出口，
 * 而它们迟早会给出不同的状态码——那时「谁对」要靠读两处代码来判断。
 *
 * 因此这里是**唯一**的映射点：四个处理器都经过它，`throw assetErrorToHttp(error) ?? error`
 * 是每个 `catch` 的全部内容。
 *
 * ## 每一行的理由（状态码要说清**责任方**，这是本仓库的既定口径）
 *
 * | 错误 | 状态码 | 责任方与理由 |
 * |---|---|---|
 * | `AssetVersionNotFoundError` / `AssetNotFoundError` | 404 | 调用方指错了对象（版本 / 作品） |
 * | `SelfTransferRejectedError` | **409** | 见下 |
 * | `DownloadForbiddenError` | 403 | 身份可信、**判定为否**（`checkAccess`） |
 * | `DownloadTicketRejectedError` | 403 | 票据不可用（伪造 / 过期 / 重放）——`code` 按理由分流 |
 * | `ArchiveRejectedError` | 422 | **制品本身**不可接受（上传路径的四种理由；下载路径的带外长度/末块/内容） |
 * | `ArtifactUnreadableError` | 500 | 服务端/存储侧读不回来（不是调用方的问题） |
 * | `ArtifactCleanupError` | 500 | 密文对象删不掉（**制品库里多了一个孤儿**） |
 * | `AssetPersistFailedError` | 500 | 制品是好的，但作品/版本/元数据写不进库（密文对象**已经删掉**，客户端应重传） |
 *
 * ## `SelfTransferRejectedError` 为什么不选 404 也不选 422（Task 7 留给 Task 8 的那条裁定）
 *
 * - **404 是错的**：作品**存在**，而且调用方通常就是它的所有人（「转给自己」的前提就是
 *   他知道当前所有人是谁）。回 404 等于用「没有这个作品」去描述一个他拥有的作品，
 *   而 Task 7 已经用 404 表示「不存在」（`AssetNotFoundError`）——两种因由共用一个码，
 *   边界上就再也分不出「指错了」与「这次转让不成立」。
 * - **422 不合适**：本仓库的 422 是**内容不可接受**（`ASSET_ARCHIVE_REJECTED`：炸弹、
 *   穿越、自洽截断……）。而这里请求的内容完全合法，冲突在于**资源的当前状态**
 *   （`toUserId` 恰好等于当前的 `ownerId`）——那正是 409 的定义，也是客户端唯一
 *   正确的下一步（重新读一次当前所有人）所对应的语义。
 * - **409 还带着「先裁决、再重试」的意思**：这不是一次参数错误（400/422），
 *   而是一次与状态冲突的、本可以成立的请求。
 *
 * 今天没有任何路由抛 `SelfTransferRejectedError`（P1 没有转让端点，转让是 P2 的事），
 * **据实记载**：这一行是为那次裁定而写的，并由
 * `tests/unit/asset/asset-error-map.test.ts` 直接钉住——把裁定留在散文里，
 * 下一个接线的人就会重新选一次。
 */
export function assetErrorToHttp(error: unknown): HttpException | null {
  if (error instanceof AssetVersionNotFoundError || error instanceof AssetNotFoundError) {
    return new NotFoundException({ code: 'ASSET_VERSION_NOT_FOUND' });
  }
  if (error instanceof SelfTransferRejectedError) {
    return new ConflictException({ code: 'ASSET_SELF_TRANSFER_REJECTED' });
  }
  if (error instanceof DownloadForbiddenError) {
    return new ForbiddenException({ code: 'ASSET_DOWNLOAD_NOT_AUTHORIZED' });
  }
  if (error instanceof DownloadTicketRejectedError) {
    // 一个状态码（403）+ 四种可区分的 `code`：`code` 是给客户端与告警规则用的，
    // 而状态码只需要说清「这件事不成立」。
    return new ForbiddenException({ code: `ASSET_DOWNLOAD_TICKET_${error.reason.toUpperCase()}` });
  }
  if (error instanceof ArchiveRejectedError) {
    // 拒绝理由只带非机密量（C11）：类型与一句话理由，没有明文、没有密钥。
    return new UnprocessableEntityException({
      code: 'ASSET_ARCHIVE_REJECTED',
      kind: error.kind,
      reason: error.reason,
    });
  }
  if (error instanceof ArtifactUnreadableError) {
    // 500 而不是 4xx：这是服务端/存储侧的问题，别把服务端故障说成「你上传的东西不行」。
    // 明细不进响应体（那是内部诊断信息），只留一个可检索的代号。
    return new InternalServerErrorException({ code: 'ASSET_ARTIFACT_UNREADABLE' });
  }
  if (error instanceof ArtifactCleanupError) {
    // 归档确实被拒了，但**密文对象没删掉**：此刻制品库里多了一个没有版本记录的孤儿。
    // 回 500 而不是 422——理由与痕迹都在 `AssetService.delete` 的注释里（含那行审计）。
    return new InternalServerErrorException({ code: 'ASSET_ARTIFACT_CLEANUP_FAILED' });
  }
  if (error instanceof AssetPersistFailedError) {
    // 制品通过了全部校验，写不进库的是**记录**（数据库侧故障）。回 500 而不是 4xx：
    // 调用方上传的东西没有任何问题。此刻密文对象已经被删掉（见 `AssetService.ingest`），
    // 因此客户端唯一正确的动作是重传——响应体里只给代号，不给库的内部明细。
    return new InternalServerErrorException({ code: 'ASSET_PERSIST_FAILED' });
  }
  return null;
}

/**
 * 策略条件的名字（**唯一**定义处；两侧引用它：本文件的声明 + `AssetModule` 的注册）。
 *
 * ## 为什么常量必须住在**这个文件的顶部**，而不是文件末尾（实测踩到的一次）
 *
 * `@Policy({…})` 的实参在**类定义期**求值，而类定义发生在 `const` 语句**之前**
 * ——`const` 有 TDZ。把常量写在文件末尾（`ledger.controller.ts` 那句「常量跟着拥有
 * 这个概念的那处代码走」被误读成「写在最后」）会让**三个 security 套件在收集阶段**红：
 *
 * ```
 * ReferenceError: Cannot access 'POLICY_CONDITIONS' before initialization
 *  ❯ apps/api/src/modules/asset/asset.controller.ts:411:59
 * ```
 *
 * 这不是循环 import，是**同一个文件内的求值顺序**：`ledger.controller.ts` 之所以没踩到，
 * 是因为它的常量在第 36 行、类在第 50 行之后。
 *
 * ## 为什么常量在**控制器**这一侧（与 `ledger.controller.ts` 同一处置）
 *
 * 若常量定义在 `asset.module.ts` 里、而模块又 import 控制器，就会**成环**
 * （`ledger.controller.ts` 的常量头注释记着那一次实测：
 * `TypeError: Cannot read properties of undefined (reading 'ledgerAdminGrant')`）。
 * **声明方**与**注册方**之间只有一条无环的方向——模块 → 控制器。
 * 写成两份字面量的代价是真实的：改名会让「声明了一个没人注册的条件」在运行期表现为
 * 一条**看不出原因**的 403（`PolicyGuard` 对未注册条件是 fail-closed）。
 *
 * ## 今天只有一个成员，为什么还是写成对象
 *
 * 与 `ledger.controller.ts` 的 `POLICY_CONDITIONS` 逐字同形：它是**命名空间**，
 * 不是「为将来预留一个空抽象」——一个模块一组条件、名字住在声明方，这条规则的一致写法
 * 本身就是它的理由（C16 指的是不为**不存在的调用方**建接口）。
 */
export const POLICY_CONDITIONS = { assetMetadataRead: 'assetMetadataRead' } as const;

/**
 * 制品模块的 HTTP 边界（P1 / Task 1 建立上传，**Task 8 补下载与元数据**）。
 *
 * ## 五条路由与它们的声明（`Asset` 资源 × 动作）
 *
 * | 路由 | 策略 | 限流 | 谁 |
 * |---|---|---|---|
 * | `POST /assets/upload` | `Asset.create` | `upload` | 任何已登录用户 |
 * | `POST /assets/versions/:versionId/download-url` | `Asset.download` | `search` | 登录 + `checkAccess`（属主） |
 * | `GET /assets/download` | `@Public()` | `search` | 持有效票据者（签名即凭证） |
 * | `GET /assets/versions/:versionId/metadata` | `Asset.read` + `assetMetadataRead` | `search` | **所有已登录用户**（P3 / Task 1 裁定 ①；原为 `@Public()`） |
 *
 * ## 限流归属：三个新端点为什么都写 `@RateLimited('search')`（**据实记载**）
 *
 * 威胁 #13 点名的是五类端点（登录/注册/出价/上传/搜索），下载与元数据都不在其中，
 * 因此**表里没有为它们准备的一档**。两条路：
 *
 * 1. **在 `RATE_LIMITS` 里加一档 `download`**——但那张表是设计文档 §4.1 威胁 #13 的投影，
 *    `tests/security/rate-limit.test.ts` 逐条断言它与设计一致。**新增一个安全参数是一次
 *    设计裁定**（阈值定多少、按 IP 还是按用户，都要有依据），不是实现者可以顺手做的；
 * 2. **归入表里唯一「按 IP、短窗口」的那一档（`search`，60 次/分钟）**——不新增任何安全
 *    参数，用的仍然是 P0 那套机制（同一个装饰器、同一个守卫、同一个 Redis 存储、
 *    同一道覆盖率门）。**代价如实记录：名字叫 `search`，而挂的是下载与元数据**；
 *    若控制器裁定下载需要自己的一档，改法是一行表项 + 设计文档一行 + 这里的三个装饰器。
 *
 * 这条归属不靠自觉：策略/限流覆盖率门断言了这三条路由**各自**的声明（含层名），
 * 集成套件另有一条「打到第 61 次必须 429」的行为见证。
 *
 * ## 制品上传（P1 / Task 1 建立；**Task 5 起是「加密即入库」的入口，Task 9 起真的落库**）
 *
 * ## 这条路径今天做五件事，顺序即语义
 *
 * 1. `FileInterceptor` 解析 multipart，自定义存储引擎把 part 流交给
 *    `AssetService.putStream`——**边收边分块加密**写进制品库（明文从不落盘：C21），
 *    并在同一趟里数出明文长度、算出明文 sha256；
 * 2. `AssetService.finalize`：打开**按需解密**的随机访问读取器，**先认证末块**
 *    （Task 4 Step 0b），再用写入侧的明文长度做带外核对并校验归档；
 * 3. 校验失败 ⇒ 那一半已经把密文对象删掉了，这里把结论翻成 **422**（4xx）；
 * 4. `parseMetadata`（Task 6）：在同一个制品上抽出可浏览的元数据（绝不执行其中任何内容）；
 * 5. `persistIngested`（Task 7）：**作品 + 版本 + 元数据在同一个事务里落库**，
 *    作品的所有人是**上传者本人**（控制器裁定）。落库失败 ⇒ 密文对象被删掉 + 500。
 *
 * 中间**没有**「先落盘明文再校验」的分支：zip 的中央目录在文件末尾，单趟前向流校验不了，
 * 而加密即入库是唯一同时满足「明文不落盘」与「不把 1 GB 读进内存」的形状（D1）。
 *
 * **据实记载（Task 9 之前这里缺的是什么）**：第 4、5 步此前根本不存在——这条路径会校验、
 * 会加密、会返回三个数，却**从不创建任何作品或版本**，于是「上传一个包然后下载它」
 * 在端到端上不成立（下载路径的输入只能由测试手搓）。合上这条缝的是 `AssetService.ingest`，
 * 判据是 `tests/integration/asset/ingest-download-chain.test.ts`。
 *
 * ## 为什么 422 而不是 400 / 415
 *
 * 请求本身是**合法**的（multipart 正确、字段正确、大小在上限内），被拒的是**内容**：
 * 不是归档（415 只覆盖「类型不对」这一种理由）、构造恶意（炸弹/穿越/链接）、
 * 或者自洽截断。422 的语义正是「请求理解得了，但实体处理不了」，且它让四种拒绝理由
 * 走同一条出口——一个理由一张状态码表迟早会与 `validateArchive` 的理由漂移。
 *
 * ## 策略声明：`Asset` + `create`（**登录即可**，无附加条件）
 *
 * 全局 `PolicyGuard` 默认拒绝未声明的路由，因此这里必须显式表态。**不用 `@Public()`**：
 * 匿名上传是实打实的漏洞，而「上传者身份」是 Task 7 建立作品归属的前提。
 *
 * 设计文档 §9 的权限矩阵里**没有** `Asset.create` 这一行（矩阵只有元数据 read、制品
 * download、asset update/delete 等）——据实记载：这里取的是矩阵里最保守的一档
 * （「任何已登录用户」），Task 8 的越权矩阵把它作为「受权但仍受资源判定的路由」
 * 之外的一格照实断言（登录后 400「没有文件字段」，而不是 403）。
 *
 * `@RateLimited('upload')` 同样是必须的：C12 点名「上传 10 次/天（用户）」，
 * 而 `tests/security/rate-limit-coverage.test.ts` 会要求每条路由表态。
 */
@Controller('assets')
export class AssetController {
  constructor(
    private readonly assets: AssetService,
    private readonly access: AssetAccessService,
    private readonly downloads: DownloadService,
  ) {}

  @Policy({ resource: 'Asset', action: 'create' })
  @RateLimited('upload')
  @Post('upload')
  // 存储引擎与 `limits.fileSize` 都来自模块级的 multer 配置（`AssetModule` 的
  // `MulterModule.registerAsync`）——**刻意不在这里写第二份上下限**：两份数值迟早漂移，
  // 而漂移的方向通常是「HTTP 层放行了存储层不接受的大小」。
  @UseInterceptors(FileInterceptor(UPLOAD_FIELD))
  async upload(@UploadedFile() file?: StoredArtifact): Promise<IngestResponse> {
    // 走到这里说明 multipart 已经解析完（否则拦截器已经带着 413/400 结束了）。
    // 没有文件 ⇒ 请求里压根没有那个字段，或者 Content-Type 不是 multipart。
    // 两种都是**调用方**的问题，因此 400 而不是 500。
    if (!file?.key) {
      throw new BadRequestException(`请求里没有 multipart 文件字段 ${UPLOAD_FIELD}`);
    }

    try {
      /**
       * `ownerId` 来自请求上下文（`SessionMiddleware` 填的），**不是**调用方给的参数：
       * 归属只能由服务端认定。控制器的裁定是「**上传者即所有人**」——它是唯一一个不需要
       * 额外产品输入的选择，且与 D11（所有人可以下载）一致。
       *
       * 这里没有「没有身份」的分支：`@Policy({ resource: 'Asset', action: 'create' })`
       * 要求身份，`PolicyGuard` 因此保证了它存在（方案 B）。万一那条链被改坏，
       * 传下去的空串会在库里以 `22P02` 失败 ⇒ 500 + `ASSET_PERSIST_FAILED`
       * ——那是一个**服务端不变量被破坏**的正确表现，不是一次 4xx。
       */
      const ownerId = currentContext()?.userId ?? '';
      // 一条链路：加密即入库（multer 早已接走）→ 校验 → 解析元数据 → 作品/版本/元数据落库。
      const ingested = await this.assets.ingest(file, { ownerId });
      return {
        assetId: ingested.assetId,
        assetVersionId: ingested.assetVersionId,
        sha256: ingested.sha256,
        plaintextBytes: ingested.plaintextBytes,
        kind: ingested.kind,
      };
    } catch (error) {
      // 翻译只有一处（`assetErrorToHttp`）：403/404/409/422/500 的每一档都在那里说明责任方。
      throw assetErrorToHttp(error) ?? error;
    }
  }

  /**
   * 签发一张 ≤5 分钟、单次有效的下载票据（D10 / D11 的 `signDownloadUrl`）。
   *
   * ## 声明里**没有** condition（这处刻意，不是漏写）
   *
   * `Asset` + `download` 的声明只表达「登录即可进入这条路由」，资源级判定由
   * `DownloadService` 里的 `checkAccess` 做——D11 要求它是**唯一**的授权入口。
   * 把它做成策略条件（`condition: 'assetDownload'`）看起来更「声明式」，代价是：
   * ①判定要在守卫里再解析一次路径参数、再查一次库；②**判定结果没有地方写审计**
   * （守卫拒绝时处理器根本没跑），而 D10 要求成功与失败都留下审计行。
   * 于是判定留在处理器里、由那一个入口做，声明只负责「这条路由属于谁」。
   *
   * ## 为什么是 POST 而不是 GET
   *
   * 签发会写一行审计（有副作用），而且 GET 语义意味着「可以被浏览器/中间层预取与缓存」
   * ——一个可以被预取的「签发凭证」不是好东西。POST 还顺带落在 CSRF 双提交令牌的
   * 保护范围内（C13：全部写操作校验令牌）。
   *
   * 状态码取 **200** 而不是 POST 默认的 201：这条路径没有创建任何**可寻址的资源**
   * （票据就是那串 URL，它没有 id、不占任何表，且 5 分钟后就不存在了）。
   * 与 `auth/login` 的处置同一条理由。
   */
  @Policy({ resource: 'Asset', action: 'download' })
  // 归属 `search` 那一层（60 次/分钟，按 IP）——理由见类注释末尾的限流一节。
  @RateLimited('search')
  @HttpCode(HttpStatus.OK)
  @Post('versions/:versionId/download-url')
  async issueDownloadUrl(@Param('versionId') versionId: string): Promise<IssuedDownloadResponse> {
    try {
      // 形状不对的路径参数在**碰数据库之前**回 404：非 UUID 打到 Postgres 会以
      // `22P02` 失败，那会把一次调用方错误变成一次 500（Task 7 把参数校验移交给了本任务）。
      if (!UUID_IDENTIFIER.test(versionId)) throw new AssetVersionNotFoundError(versionId);
      // 身份来自会话上下文（`SessionMiddleware`）：`PolicyGuard` 已经保证它存在
      // （无 condition 的声明仍然要求身份，方案 B）。
      return await this.downloads.issueDownloadUrl(versionId, currentContext()?.userId ?? '');
    } catch (error) {
      throw assetErrorToHttp(error) ?? error;
    }
  }

  /**
   * 兑换票据并**流出**制品明文（D10 的「单次有效签名 URL」那一半）。
   *
   * ## 为什么这条路由是 `@Public()`
   *
   * 凭证就是那串签名，不是 cookie：签名 URL 的意义正是「把它交给下载工具或浏览器直开」。
   * 要求会话会把它退化成一条普通鉴权接口，而威胁 #3 指名的三条控制是
   * **≤5 分钟 + 单次使用 + 每次写审计**——它们都在 `DownloadService` 里，与会话无关。
   * 票据里的 `userId` 仍然是当事人（签名保护它不被改），并会在兑换时**再判一次**
   * `checkAccess`（转让之后前手那张票立刻失效）。
   *
   * ## 「被拒就不发字节」是**结构性**的，不是这条处理器记得别写
   *
   * `openDownload` 返回之前所有判定都已完成（验签、期限、授权、nonce 消费、
   * 带外长度核对、末块认证、归档校验），被拒时它抛出——`StreamableFile` 因此
   * 一个字节都没构造出来。集成用例断言的正是这件事：422 + 响应体里没有制品的字节。
   */
  @Public()
  // 同 `search` 层：这条路由是**公开**的，没有限流时它是一个任何人都能打的解密入口
  // （伪造票据在验签处就被挡掉，但请求本身仍然会走到验签）。
  @RateLimited('search')
  @Get('download')
  async download(@Query() query: Record<string, unknown>): Promise<StreamableFile> {
    try {
      const opened = await this.downloads.openDownload(query);
      return new StreamableFile(opened.stream, {
        type: DOWNLOAD_CONTENT_TYPE[opened.kind],
        // 声明长度让客户端能判断「读到的是不是全部」——下载路径上这一点尤其重要：
        // 中途某个非末块被篡改时响应会被中断，而有了 Content-Length，截断是可检测的。
        length: opened.length,
        disposition: `attachment; filename="asset-${opened.assetVersionId}.${opened.kind === 'zip' ? 'zip' : 'tar.gz'}"`,
      });
    } catch (error) {
      throw assetErrorToHttp(error) ?? error;
    }
  }

  /**
   * 元数据读取（设计文档 §9 矩阵：`Asset` 元数据 read = **所有人**）。
   *
   * ## ★ 为什么它今天**要求登录**（P3 / Task 1；控制器裁定 ①）
   *
   * §9 的第 1 行写「所有人」，第 4 行写 `Preview Dossier read = 交换要约的对手方`——
   * **同一份文档对同一种对象给出两个不同的「谁」**。控制器裁定收紧本路由，理由：
   * 一个**匿名可枚举**创作者**文件树、语言分布、依赖清单**的端点，正是威胁 #9
   * （受限预览资料）要防的侦察面；而 §9 第 1 行的「所有人」若读成「含匿名」，
   * 与第 4 行的存在本身矛盾。P2 的 M1 处理币种列时用的是同一条标准：**把决定写进规格**，
   * 而不是留一句与实现不符的话。**这是一处刻意的行为变更**，控制器已标给人类过目。
   *
   * 被替换掉的旧注释原文是「元数据读取（设计文档 §9 矩阵：`Asset` 元数据 read = **所有人**，
   * 因此 `@Public()`）」+「## 「所有人可读」是矩阵里的**一行**，不是默认 … 这条路由公开的是
   * 「项目是什么」，不是「制品是什么」」。**授权范围那一段依然成立**（见下），变的只有「谁」。
   *
   * ## 「登录即可」由**具名条件**表达，而**不是**靠省略 `condition`
   *
   * `PolicyGuard` 的判定顺序第 4 步对**任何**非 `@Public()` 的声明都先要求身份（方案 B），
   * 因此省略 `condition` 也挡得住匿名——但那会把这条规则藏在「装饰器少写一个字段」里。
   * 这里显式注册条件 `assetMetadataRead`（`AssetModule.onModuleInit`）：它今天只判
   * 「有没有当事人」（守卫已经拒过匿名，那一句是纵深防御），作用是**留一个具名的判定点**，
   * 让「元数据该给谁看」这条规则有一个可被找到、可被 grep、可被注册表看见的位置。
   *
   * ## 它授权的范围**没有**变
   *
   * 存储键、`fileId`、`keyId`、`sha256` 一列都不在 `AssetAccessService.readMetadata` 的
   * `select` 里（取不到，不是过滤掉）。**公开的是「项目是什么」，不是「制品是什么」**——
   * 这句话在收紧之后依然逐字成立。
   *
   * ## 限流归属
   *
   * 仍是 `search` 层（表里唯一按 IP 的短窗口档，60 次/分钟）。**行为见证跟着改了形状**：
   * `tests/integration/asset/signed-download.test.ts` 的「第 60 次仍然 200，第 61 次 429」
   * 那一节现在**带会话**打这 61 次——不带的话它们会全部停在 403，限流层一次都没被行使。
   */
  @Policy({ resource: 'Asset', action: 'read', condition: POLICY_CONDITIONS.assetMetadataRead })
  @RateLimited('search')
  @Get('versions/:versionId/metadata')
  async readMetadata(@Param('versionId') versionId: string): Promise<AssetMetadataView> {
    try {
      if (!UUID_IDENTIFIER.test(versionId)) throw new AssetVersionNotFoundError(versionId);
      const view = await this.access.readMetadata(versionId);
      // 版本不存在、或该版本还没有元数据行：两者都是 404（**「没有」与「空」不是同一件事**，
      // Task 6 §3.1 为 README 写过同一条；这里也一样——不返回一个「全是 null 的元数据」）。
      if (view === null) throw new AssetVersionNotFoundError(versionId);
      return view;
    } catch (error) {
      throw assetErrorToHttp(error) ?? error;
    }
  }
}
