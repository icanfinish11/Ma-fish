import {
  BadRequestException,
  Controller,
  InternalServerErrorException,
  Post,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Policy } from '../../common/policy/policy.decorator.js';
import { RateLimited } from '../../common/security/throttler.js';
import { currentContext } from '../../common/context/request-context.js';
import { ArchiveRejectedError, ArtifactCleanupError, ArtifactUnreadableError, AssetService, type StoredArtifact } from './asset.service.js';

/**
 * multipart 里的文件字段名。控制器**与**上传适配器必须用同一个名字，
 * 因此这里写死一处：名字不匹配的失效形态是 400 `Unexpected file field`，
 * 而报文里不会告诉你「代码里期望的是哪个字段」。
 */
const UPLOAD_FIELD = 'file';

/**
 * 上传成功的响应（**不含**任何服务端内部标识）。
 *
 * 今天是「版本记录」里可以对外的那部分：`sha256`（与上传字节一致）、`plaintextBytes`
 * （明文长度）、`kind`（判定出来的归档类型）。**刻意没有** `storageKey` / `fileId` / `keyId`：
 * 存储键是服务端内部状态（Task 1 的控制器注释把它写成了 Task 5 的义务），
 * 而版本 id 要等 Task 7 把记录落库之后才有——那时这里会换成真正的资源标识。
 */
export interface IngestResponse {
  sha256: string;
  plaintextBytes: number;
  kind: 'zip' | 'tar.gz';
}

/**
 * 制品上传（P1 / Task 1 建立；**Task 5 起是「加密即入库」的入口**）。
 *
 * ## 这条路径今天做四件事，顺序即语义
 *
 * 1. `FileInterceptor` 解析 multipart，自定义存储引擎把 part 流交给
 *    `AssetService.putStream`——**边收边分块加密**写进制品库（明文从不落盘：C21），
 *    并在同一趟里数出明文长度、算出明文 sha256；
 * 2. 处理器拿到写入回执之后调 `AssetService.finalize`：打开**按需解密**的随机访问读取器，
 *    **先认证末块**（Task 4 Step 0b），再用写入侧的明文长度做带外核对并校验归档；
 * 3. 校验失败 ⇒ 那一半已经把密文对象删掉了，这里把结论翻成 **422**（4xx）；
 * 4. 校验通过 ⇒ 返回待落库的版本记录里可对外的那三个字段。
 *
 * 中间**没有**「先落盘明文再校验」的分支：zip 的中央目录在文件末尾，单趟前向流校验不了，
 * 而加密即入库是唯一同时满足「明文不落盘」与「不把 1 GB 读进内存」的形状（D1）。
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
 * （「任何已登录用户」），Task 8 会带着访问判定矩阵回来收口这条声明。
 *
 * `@RateLimited('upload')` 同样是必须的：C12 点名「上传 10 次/天（用户）」，
 * 而 `tests/security/rate-limit-coverage.test.ts` 会要求每条路由表态。
 */
@Controller('assets')
export class AssetController {
  constructor(private readonly assets: AssetService) {}

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
      // `uploadedById` 来自请求上下文（`SessionMiddleware` 填的），不是调用方给的参数：
      // 归属只能由服务端认定。Task 7 落库时用它填 `uploadedById`。
      const version = await this.assets.finalize(file, { uploadedById: currentContext()?.userId ?? null });
      return { sha256: version.sha256, plaintextBytes: version.plaintextBytes, kind: version.kind };
    } catch (error) {
      if (error instanceof ArchiveRejectedError) {
        // 拒绝理由只带非机密量（C11）：类型与一句话理由，没有明文、没有密钥。
        throw new UnprocessableEntityException({
          code: 'ASSET_ARCHIVE_REJECTED',
          kind: error.kind,
          reason: error.reason,
        });
      }
      if (error instanceof ArtifactUnreadableError) {
        // 500 而不是 4xx：这是服务端/存储侧的问题，别把服务端故障说成「你上传的东西不行」。
        // 明细不进响应体（那是内部诊断信息），只留一个可检索的代号。
        throw new InternalServerErrorException({ code: 'ASSET_ARTIFACT_UNREADABLE' });
      }
      if (error instanceof ArtifactCleanupError) {
        // 归档确实被拒了，但**密文对象没删掉**：此刻制品库里多了一个没有版本记录的孤儿。
        // 回 500 而不是 422——理由与痕迹都在 `AssetService.delete` 的注释里（含那行审计）。
        throw new InternalServerErrorException({ code: 'ASSET_ARTIFACT_CLEANUP_FAILED' });
      }
      throw error;
    }
  }
}
