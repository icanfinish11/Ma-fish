import { BadRequestException, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Policy } from '../../common/policy/policy.decorator.js';
import { RateLimited } from '../../common/security/throttler.js';
import type { UploadedArtifact } from '../../common/upload/stream-upload.js';

/**
 * multipart 里的文件字段名。控制器**与**上传适配器必须用同一个名字，
 * 因此这里写死一处：名字不匹配的失效形态是 400 `Unexpected file field`，
 * 而报文里不会告诉你「代码里期望的是哪个字段」。
 */
const UPLOAD_FIELD = 'file';

/**
 * 制品上传（P1 / Task 1）。
 *
 * ## 这条路由今天只做一件事：把字节落到制品库
 *
 * Task 1 **不做任何内容校验**（不是归档就拒、magic bytes 嗅探、加密、元数据解析
 * 都是 Task 2–6）。这里只有两件事：
 *
 * 1. 让 multipart 的 part 流**原样**流进 `ArtifactStore`（不落临时文件、不整份进内存，C21）；
 * 2. 把结果（键 + 字节数）回给调用方。
 *
 * ## 为什么现在还返回存储键
 *
 * Task 5 会把这里换成「作品 / 版本记录」的创建（键属于服务端内部状态，不再出现在响应里）。
 * 今天返回它是**临时**的，且当前**没有任何按 key 读取的路由**，因此它不可被用来取任何东西。
 *
 * ## 策略声明：`Asset` + `create`（**登录即可**，无附加条件）
 *
 * 全局 `PolicyGuard` 默认拒绝未声明的路由，因此这里必须显式表态。**不用 `@Public()`**：
 * 匿名上传是实打实的漏洞，而「上传者身份」是 Task 5/7/8 建立作品归属的前提。
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
  @Policy({ resource: 'Asset', action: 'create' })
  @RateLimited('upload')
  @Post('upload')
  // 存储引擎与 `limits.fileSize` 都来自模块级的 multer 配置（`AssetModule` 的
  // `MulterModule.registerAsync`）——**刻意不在这里写第二份上下限**：两份数值迟早漂移，
  // 而漂移的方向通常是「HTTP 层放行了存储层不接受的大小」。
  @UseInterceptors(FileInterceptor(UPLOAD_FIELD))
  upload(@UploadedFile() file?: UploadedArtifact): UploadedArtifact {
    // 走到这里说明 multipart 已经解析完（否则拦截器已经带着 413/400 结束了）。
    // 没有文件 ⇒ 请求里压根没有那个字段，或者 Content-Type 不是 multipart。
    // 两种都是**调用方**的问题，因此 400 而不是 500。
    if (!file?.key) {
      throw new BadRequestException(`请求里没有 multipart 文件字段 ${UPLOAD_FIELD}`);
    }
    return { key: file.key, bytes: file.bytes };
  }
}

