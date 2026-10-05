import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Env } from '../../config/env.schema.js';
import { AuditService } from '../audit/index.js';
import type { ArchiveKind } from './archive/sniff.js';
import { validateArchive, type ArchiveVerdict } from './archive/validate-archive.js';
import {
  CHUNK_SIZE,
  FOOTER_BYTES,
  HEADER_FIXED_BYTES,
  INDEX_ENTRY_SIZE,
  TAG_BYTES,
  encodeHeader,
} from './crypto/artifact-format.js';
import { ChunkEncryptor } from './crypto/chunk-cipher.js';
import { createKeyRing, type KeyRing } from './crypto/key-ring.js';
import { ARTIFACT_STORE, ArtifactTooLargeError, type ArtifactStore } from './store/artifact-store.port.js';
import { EncryptedArtifactReader } from './store/random-access-reader.js';

/**
 * 「加密即入库」的接入服务（P1 / Task 5；设计决定 D1 + C19/C21）。
 *
 * ## 流程（顺序本身是要求的一部分）
 *
 * ```
 * 上传流 ──putStream──▶ 分块加密 ──▶ 制品库（密文，立即落盘）
 *                                      │
 *                        finalize ─────┴─▶ 打开解密读取器
 *                                         ├─ 认证末块（Task 4 Step 0b）
 *                                         ├─ validateArchive（带**写入侧**的明文长度交叉核对）
 *                                         ├─ 拒绝 ⇒ delete(密文对象) + ArchiveRejectedError
 *                                         └─ 通过 ⇒ IngestedVersion（待落库记录）
 * ```
 *
 * 两半为什么分开：上传流由 multer 的存储引擎接走（Task 1 的 `createStreamingStorage`），
 * 而校验必须等制品**写完**——zip 的中央目录在文件**末尾**，单趟前向流读不到（D1 的结构性理由）。
 * 中间没有任何落盘缓冲，也没有「先落盘明文再校验」的分支：那正是 C21 结构性排除的东西。
 *
 * ## 明文长度的**唯一**来源（Task 4 §9.2 的移交义务）
 *
 * 格式里没有任何字段认证「制品有多长」：`plaintextLength` 是制品**自称**的值
 * （写在尾部、不在任何 AAD 里）。因此传给 `validateArchive` 的 `expectedPlaintextLength`
 * **只能**是 `putStream` 在加密过程中数出来的**明文字节数**（{@link ArtifactWriteReceipt}）：
 *
 * - **不是**密文对象的字节数（`StoredArtifact.bytes`）——那会让每一次合法上传都被拒
 *   （Task 4 的变异探针 M13 就是这个形态：9 条用例变红）；
 * - **不是**上传元数据里的任何数（客户端说的长度不作数）。
 *
 * 两个量在用例里有正对着的断言：`receipt.plaintextBytes !== upload.bytes`。
 *
 * ## 待落库记录的**接缝**（据实记载：Task 7 的表还不存在）
 *
 * `finalize` 返回 {@link IngestedVersion}——**行形状**的版本记录，含
 * `sha256` / `plaintextBytes` / `keyId` / `fileId` / `storageKey` / `kind` / `uploadedById`。
 * 今天**没有任何地方**能把它落库：`Asset` / `AssetVersion` / `AssetMetadata` 模型还不存在
 * （`prisma/schema.prisma` 只有 `User` / `Identity` / `AuditLog` / `OutboxEvent` / `ProcessedJob`），
 * 而 `asset` schema 与迁移是 **Task 7** 的所有权（本任务明令不得自造 schema）。
 *
 * 因此这条接缝就是**返回值本身**：类型在这里、字段在这里、用例逐字段断言它。
 * **Task 7 必须**把 `plaintextBytes` 落进 `asset_versions` 的对应列（P1 计划里叫
 * `plaintextBytes`），**Task 8 必须**在下载路径上把它作为 `expectedPlaintextLength` 传回
 * `validateArchive`——那时这条交叉核对才在「制品已在盘上静止」的场景里真正生效
 * （见 `validate-archive.ts` 文件头的那段移交要求）。**不要**把 `storageKey` 漏掉：
 * P1 计划的 `AssetVersion` 字段清单里没有它，而下载路径要靠它找到对象。
 */
@Injectable()
export class AssetService {
  private readonly store: ArtifactStore;
  private readonly ring: KeyRing;
  private readonly audit: AuditService;

  /**
   * 密钥环在**构造期**建立（而不是每次上传现取）：
   *
   * - `createKeyRing` 会在缺 `ARTIFACT_KEYS` / 活动 keyId 不在环里时**立刻抛错**，
   *   而本服务是应用启动期就在的提供者 ⇒ 配置错误在**引导期**暴露，而不是等一次上传
   *   走到一半才发现（D5 的 fail-fast 要求）；
   * - 它**不做**「取不到就回退到默认键」——那是 `key-ring.ts` 的硬约束。
   *
   * 刻意**没有**把密钥环单独做成一个 provider：今天只有本类一个消费者（C16 不建空抽象）。
   * 第二个消费者出现时（下载路径 Task 8）再把它提出来，那时它是被依赖逼出来的，不是猜的。
   */
  constructor(
    @Inject(ARTIFACT_STORE) store: ArtifactStore,
    config: ConfigService<Env, true>,
    audit: AuditService,
  ) {
    this.store = store;
    this.audit = audit;
    this.ring = createKeyRing({
      ARTIFACT_KEYS: config.get('ARTIFACT_KEYS', { infer: true }),
      ARTIFACT_ACTIVE_KEY_ID: config.get('ARTIFACT_ACTIVE_KEY_ID', { infer: true }),
    });
  }

  /**
   * **加密即入库**（D1 第 1 条）：把上传流分块加密写进制品库，全程不落明文、不整份进内存。
   *
   * 制品按 `header ‖ 块数据 ‖ 索引 ‖ 尾部` 单趟顺序写出（R3）：头在构造期就已确定
   * （两个总量字段在**尾部**），块数据从加密器直接流出来，索引与尾部在流结束后追加。
   *
   * 同时记两笔账交给 {@link finalize}：**明文字节数**与**明文的 sha256**——
   * 它们只能在这一次流过的过程中算出来（明文从不落盘，也没有第二次机会）。
   *
   * @param opts.maxBytes **明文**上限（不是制品字节数）。与 HTTP 层的 `limits.fileSize`
   *   取同一个配置值：超限在真实链路上先被 multer 拦下（413），这里保证的是「即使被绕过，
   *   也不留残留」。
   */
  async putStream(source: Readable, opts: { maxBytes: number }): Promise<StoredArtifact> {
    const encryptor = new ChunkEncryptor(this.ring);
    const digest = createHash('sha256');
    let plaintextBytes = 0;

    /**
     * 明文计量器：数长度 + 算摘要 + **超限即中止上游**。
     *
     * 为什么限额落在**明文**这一侧（存储层那一侧也要给，见下）：用户上传的是明文，
     * 「最多 1 GiB」说的也是明文；而制品比明文大（每块 16 字节 tag + 每块 24 字节索引 +
     * 头 + 尾部），把同一个数同时当两个限额会让**恰好顶格**的合法上传被存储层拒掉
     * （HTTP 层放行、`putStream` 却以 `ArtifactTooLargeError` 中止 ⇒ 500 而不是 201）。
     */
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        plaintextBytes += chunk.length;
        if (plaintextBytes > opts.maxBytes) {
          callback(new ArtifactTooLargeError(opts.maxBytes));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });

    const encrypting = encryptor.transform();
    // 手工接线（而不是 `pipeline(source, meter, encrypting, ...)` 收进一个 PassThrough）：
    // 加密器的**可读侧**就是制品的块数据段，直接迭代它即可，链上少一个缓冲节点。
    const pumping = pipeline(source, meter, encrypting);
    // 这个 promise 的失败会**同时**以错误的形式出现在下面那个迭代上（pipeline 出错时
    // destroy 每一段），调用方看到的是迭代抛出的那一份。这里再接一次只是不让同一份错误
    // 变成「无人处理的 rejection」——那会让一次正常的拒绝在测试里显示成进程级警告。
    void pumping.catch(() => undefined);

    const stored = await this.store.putStream(Readable.from(assembleArtifact(encryptor, encrypting)), {
      // 存储层的上限按**结构开销上界**上浮，两个数都从这个 `maxBytes` 派生（单一来源）
      maxBytes: opts.maxBytes + artifactOverheadBound(opts.maxBytes, CHUNK_SIZE, Buffer.byteLength(encryptor.header().keyId, 'utf8')),
    });

    return {
      key: stored.key,
      bytes: stored.bytes,
      receipt: {
        plaintextBytes,
        sha256: digest.digest('hex'),
        keyId: encryptor.header().keyId,
        fileId: encryptor.header().fileId.toString('hex'),
      },
    };
  }

  /**
   * 上传完成之后：打开解密读取器 → 认证末块 + 归档校验 → 通过则给出待落库记录，
   * 不通过则**删掉密文对象**并抛 {@link ArchiveRejectedError}（D1 第 3 条 + brief Step 2）。
   *
   * 读取器是**本请求局部**的，用完即弃：它最多在内存里留一块明文（生产 8 MiB，
   * 见 `random-access-reader.ts` 的 `recent`），**绝不**放进任何跨请求的共享或池化结构
   * （Task 4 的移交要求第 2 条）。
   *
   * @param upload `putStream` 的返回值（multer 会把它原样交给控制器）。
   */
  async finalize(
    upload: Pick<StoredArtifact, 'key' | 'receipt'>,
    opts: { uploadedById?: string | null } = {},
  ): Promise<IngestedVersion> {
    let reader: EncryptedArtifactReader;
    try {
      reader = await EncryptedArtifactReader.open(this.store, upload.key, this.ring);
    } catch (error) {
      /**
       * 自己刚写下的制品读不回来：磁盘损坏、落盘后被改动，或写入端有 bug。
       * 那个对象已经没有任何用途（读不出内容 ⇒ 永远下不来），因此**先删掉**再抛错
       * ——不删会在制品库里留下一个谁都不会再碰的孤儿。
       *
       * 判据是 500 而不是 4xx：这不是调用方的问题，别把服务端故障说成「你上传的东西不行」。
       */
      await this.delete(upload.key);
      throw new ArtifactUnreadableError(upload.key, error instanceof Error ? error.message : String(error));
    }

    /**
     * 带外长度核对 + 末块认证 + 嗅探 + 分发，全在 `validateArchive` 里（Task 4）。
     * 这里只做两件事：把**写入侧数的明文长度**交给它，以及按结论决定删不删对象。
     *
     * **它也可能抛错**：`sniffArchive` 在读制品失败时会把错误抛出来（它自己的注释写明了
     * 「读制品本身失败属于存储/解密层的问题」，不吞）。典型形态是**非末块**被篡改：
     * 末块认证会放行（末块没被动过），而嗅探一读第一块就认证失败。处置与 `open` 失败相同
     * ——读不出来的制品没有任何用途 ⇒ 删掉 + 归成「制品读不回来」。
     * **不许**让它冒到框架层：那是一个没有代号的 500，外加一条无上下文的堆栈日志
     * （变异探针 `m7` 实测过这个形态）。
     */
    let verdict: ArchiveVerdict;
    try {
      verdict = await validateArchive(reader, { expectedPlaintextLength: upload.receipt.plaintextBytes });
    } catch (error) {
      await this.delete(upload.key);
      throw new ArtifactUnreadableError(upload.key, error instanceof Error ? error.message : String(error));
    }

    if (!verdict.ok) {
      await this.delete(upload.key);
      throw new ArchiveRejectedError(verdict.kind, verdict.reason);
    }

    return {
      storageKey: upload.key,
      sha256: upload.receipt.sha256,
      plaintextBytes: upload.receipt.plaintextBytes,
      keyId: upload.receipt.keyId,
      fileId: upload.receipt.fileId,
      kind: verdict.kind,
      uploadedById: opts.uploadedById ?? null,
    };
  }

  /**
   * 删除密文对象。
   *
   * 它同时是 `UploadSink` 的出口（multer 的 `_removeFile`：上传被中止时清掉已写入的对象）
   * 与拒绝路径的清理出口——**只有一条**删除路径，否则「删干净了没有」要按最弱的那条判断。
   *
   * 幂等：对象不存在时静默返回（`ArtifactStore.delete` 的契约）。
   *
   * ## 删除失败时的处置（规格 §5 第 3 条：**必须明确选一个**，这就是选定的那个）
   *
   * **同步重试 {@link CLEANUP_ATTEMPTS} 次 → 写一行审计 → 抛 {@link ArtifactCleanupError}（控制器回 500）。**
   *
   * 三个候选里「同步重试 + 审计」与「留待清理标记 + worker 兜底」在本仓库里**是同一件事**：
   * 新建一张清理表是 **Task 7** 的 schema 所有权（本任务明令不得自造 schema），
   * 而 `audit_logs` 是现成的、**append-only**（写进去就删不掉）、可查询的持久落点——
   * 于是那一行 `asset.artifact.cleanup_failed` **同时就是待清理标记**：
   * `resource_id` = 被留下的对象键，将来任何 worker/运维都能按 `action` 扫出来清掉。
   * 这就是两个候选的结合，且没有自造任何表。
   *
   * 为什么最后还要**抛错**：清理失败意味着制品库里多了一个没有版本记录的孤儿密文。
   * 这时回 4xx（「你的归档不行」）会把服务端的清理故障说成调用方的问题，而**静默吞掉**
   * 更糟——孤儿会无声地累积，没有任何东西会注意到。500 + 审计行让它在当下（请求）
   * 与事后（append-only 行）**两个地方**都看得见。
   */
  async delete(key: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt++) {
      try {
        await this.store.delete(key);
        return;
      } catch (error) {
        lastError = error;
        // 退避一点点再试：瞬时失败（卷忙 / 杀软短暂占用 / fd 还没释放）是这一层的
        // 主要失败形态。总代价有界：最多 (1+2) × 25ms，不会把一次请求拖成秒级。
        if (attempt < CLEANUP_ATTEMPTS) await delay(CLEANUP_RETRY_DELAY_MS * attempt);
      }
    }

    const failure = lastError instanceof Error ? lastError : new Error(String(lastError));
    // 审计里只放**结构化、可检索**的三样：尝试次数、错误名、错误码。
    // **不**放原始消息：它可能带着制品卷的文件系统路径，而审计行是 append-only 的
    // （写进去就删不掉），路径不该因此永久留档（C11 的精神：只记非机密、必要的量）。
    let auditFailure: string | null = null;
    try {
      await this.audit.record({
        action: ARTIFACT_CLEANUP_FAILED_ACTION,
        resource: 'AssetArtifact',
        resourceId: key,
        metadata: {
          attempts: CLEANUP_ATTEMPTS,
          errorName: failure.name,
          errorCode: (failure as { code?: unknown }).code ?? null,
        },
      });
    } catch (error) {
      // 审计也写不进去：仍要抛（绝不静默），并把这件事写进错误消息里——这是唯一还能
      // 留下痕迹的地方（两个持久化落点同时不可用，已经不是本层能兜住的故障）。
      auditFailure = error instanceof Error ? error.message : String(error);
    }
    throw new ArtifactCleanupError(key, CLEANUP_ATTEMPTS, failure.message, auditFailure);
  }
}

/**
 * 「密文对象没删掉」的审计动作名（append-only 表里的可检索键，**同时也是待清理标记**）。
 *
 * 稳定字符串，按 `audit.service.ts` 的 `<域>.<动作>` 命名约定：运维的告警规则与将来的清理
 * worker 都按它匹配。**刻意不导出**：今天只有 `delete` 一个写入方（C16），
 * 而用例里写的是**字面量**——那样改掉这个名字会让用例变红，而不是跟着一起漂移。
 */
const ARTIFACT_CLEANUP_FAILED_ACTION = 'asset.artifact.cleanup_failed';

/** 删除的同步尝试次数（含第一次）。 */
const CLEANUP_ATTEMPTS = 3;

/** 每次重试之间的基准退避（毫秒），按尝试序号线性放大。 */
const CLEANUP_RETRY_DELAY_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 写入回执：`putStream` 在加密过程中**自己记下的**那两笔账。
 *
 * 它们**只能**在这一趟里算出来（明文从不落盘，也没有第二次机会），因此必须随上传结果
 * 一起交到 {@link AssetService.finalize} 手里。
 */
export interface ArtifactWriteReceipt {
  /** 明文字节数。**不是**密文对象的字节数，也不是上传元数据里的任何数（见文件头）。 */
  readonly plaintextBytes: number;
  /** 明文的 sha256（hex）。验收口径：它与上传的字节一致（不是密文的摘要）。 */
  readonly sha256: string;
  /** 写入时用的 keyId（= 制品头里的那个，轮换靠它选键）。 */
  readonly keyId: string;
  /** 制品头里的 fileId（hex）。 */
  readonly fileId: string;
}

/**
 * `putStream` 的结果。
 *
 * `key` / `bytes` 是 `UploadSink` 的契约字段（`bytes` 是**制品对象**的字节数，
 * 于是 `AssetService` 在结构上直接满足 `UploadSink`，不需要任何适配器）；
 * `receipt` 是上面那两笔明文账。**三个数里只有一个能当明文长度用**，见文件头。
 */
export interface StoredArtifact {
  readonly key: string;
  readonly bytes: number;
  readonly receipt: ArtifactWriteReceipt;
}

/**
 * 待落库的版本记录（**Task 7 的对象**，见类注释里的接缝说明）。
 *
 * 字段刻意用「行」的粒度：Task 7 把它铺成 `Asset` / `AssetVersion` / `AssetMetadata` 时
 * 不需要再回到这里补任何东西——特别是 `plaintextBytes`，它是**唯一**那条带外长度的载体。
 */
export interface IngestedVersion {
  /** 制品库对象键（下载路径靠它取对象；**不**出现在 HTTP 响应里）。 */
  readonly storageKey: string;
  readonly sha256: string;
  readonly plaintextBytes: number;
  readonly keyId: string;
  readonly fileId: string;
  readonly kind: ArchiveKind;
  readonly uploadedById: string | null;
}

/**
 * 归档被拒（`validateArchive` 给出的判定）。
 *
 * **没有任何元数据**：被拒的上传不该有任何东西进入后续流程（D1）。
 * 理由与类型都是**非机密量**（C11）：它们来自 Task 4 的判定，用于回 4xx 与排障。
 */
export class ArchiveRejectedError extends Error {
  constructor(
    readonly kind: ArchiveKind | 'unknown',
    readonly reason: string,
  ) {
    super(`归档未通过校验：${reason}`);
    this.name = 'ArchiveRejectedError';
  }
}

/**
 * 自己刚写下的制品读不回来（`EncryptedArtifactReader.open` 失败）。
 *
 * 与 {@link ArchiveRejectedError} 的区别是**责任方**：这一类是服务端/存储的问题，
 * 因此回 500，不假装成「你的文件不行」。
 */
export class ArtifactUnreadableError extends Error {
  constructor(
    readonly key: string,
    readonly detail: string,
  ) {
    super(`制品无法读取（键 ${key}）：${detail}`);
    this.name = 'ArtifactUnreadableError';
  }
}

/**
 * 密文对象删不掉（{@link AssetService.delete} 重试之后仍失败）。
 *
 * 与 {@link ArtifactUnreadableError} 一样属于**服务端**故障，因此走 500：调用方的归档
 * 是不是合法与被留下的那个对象无关。审计行（`asset.artifact.cleanup_failed`）是它的
 * 持久痕迹，见 `delete` 的注释。
 */
export class ArtifactCleanupError extends Error {
  constructor(
    readonly key: string,
    readonly attempts: number,
    readonly reason: string,
    /** 审计也写失败时的原因；正常为 `null`（那时审计行就是痕迹本身）。 */
    readonly auditFailure: string | null,
  ) {
    super(
      `密文对象删除失败（键 ${key}，已尝试 ${attempts} 次）：${reason}` +
        (auditFailure === null ? '' : `；审计写入同样失败：${auditFailure}`),
    );
    this.name = 'ArtifactCleanupError';
  }
}

/**
 * 组装制品的字节流：`header ‖ 块数据 ‖ 索引 ‖ 尾部`（R3）。
 *
 * 头用 `encryptor.header()`——它在**流结束之前**就能给出（总量字段在尾部，不在头里），
 * 这正是单趟前向写出成立的前提。索引与尾部必须等流结束（`result()`），因此排在最后。
 *
 * 迭代顺序同时给出了**背压**：`encrypting` 的可读侧被这个生成器消费，而它由 `pipeline`
 * 从上传流喂入——任何一端落后都会自然回压到源流，链上没有一个「先攒起来」的节点。
 */
async function* assembleArtifact(encryptor: ChunkEncryptor, encrypting: Transform): AsyncGenerator<Buffer> {
  yield encodeHeader(encryptor.header());
  for await (const chunk of encrypting) yield chunk as Buffer;
  const { index, footer } = encryptor.result();
  yield index;
  yield footer;
}

/**
 * 制品相对明文的**结构开销上界**（字节）：定长头 + keyId + 尾部 + 每块的 tag 与索引记录。
 *
 * 用途只有一个：把**明文**限额换算成存储层能用的**制品**限额（见 `putStream`）。
 * 取上界而不是精确值：`ceil(maxBytes / chunkSize)` 已经覆盖了「顶格」那一块，
 * 而多算几十字节只会让存储层少拦一点点——它本来就不是状态码的来源（413 由 HTTP 层负责）。
 */
function artifactOverheadBound(maxPlaintextBytes: number, chunkSize: number, keyIdBytes: number): number {
  const chunks = Math.ceil(maxPlaintextBytes / chunkSize);
  return HEADER_FIXED_BYTES + keyIdBytes + FOOTER_BYTES + chunks * (TAG_BYTES + INDEX_ENTRY_SIZE);
}
