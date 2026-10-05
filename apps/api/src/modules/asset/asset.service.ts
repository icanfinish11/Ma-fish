import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AuditService } from '../audit/index.js';
import type { ArchiveKind } from './archive/sniff.js';
import { validateArchive, type ArchiveVerdict } from './archive/validate-archive.js';
// **必须是值导入，不能写 `import type`**（与 `auth/session.middleware.ts` 里那条实测记载同源）：
// 构造参数的类型元数据（`design:paramtypes`）只有在参数类型是**值**导入时才写进产物；
// 写成 `import type` 后 tsc 会把它 emit 成 `[Function]`，Nest 于是拿 `Function` 去查找
// 提供者、失败并抛「Nest can't resolve dependencies of the AssetService (?, ?, ?, ?)」。
import { AssetVersionService } from './asset-version.service.js';
import {
  CHUNK_SIZE,
  FOOTER_BYTES,
  HEADER_FIXED_BYTES,
  INDEX_ENTRY_SIZE,
  TAG_BYTES,
  encodeHeader,
} from './crypto/artifact-format.js';
import { ChunkEncryptor } from './crypto/chunk-cipher.js';
import { KEY_RING, type KeyRing } from './crypto/key-ring.js';
// 待落库记录的**形状**住在它自己的文件里（Task 9）：它与 `AssetVersionService` 共享，
// 而两边直接互相 import 会构成一个环（`no-circular` 实测抓到过）。理由在那个文件的头部。
import type { IngestedVersion } from './ingested-version.js';
import { parseMetadata, type ParsedMetadata } from './metadata/parse-metadata.js';
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
 *
 *                        ingest ─────────▶ finalize（上面那一半）
 *                                         ├─ parseMetadata（Task 6）
 *                                         └─ persistIngested（Task 7）⇒ 作品 + 版本 + 元数据
 * ```
 *
 * 两半为什么分开：上传流由 multer 的存储引擎接走（Task 1 的 `createStreamingStorage`），
 * 而校验必须等制品**写完**——zip 的中央目录在文件**末尾**，单趟前向流读不到（D1 的结构性理由）。
 * 中间没有任何落盘缓冲，也没有「先落盘明文再校验」的分支：那正是 C21 结构性排除的东西。
 *
 * ## 两半的名字为什么是两个方法（Task 9）
 *
 * {@link AssetService.finalize} 是**校验那一半**，契约从 Task 5 起**一个字节都没变**：
 * 它只回答「这份制品能不能收」，返回待落库的记录。{@link AssetService.ingest} 是**整条链路**：
 * 它在 `finalize` 之后解析元数据并落库，把「上传一个包」变成「库里真的有一份作品」。
 * 分开保留了既有那批用例的边界（拒绝路径、限额边界、并发都在 `finalize` 上测），
 * 而「接线」这件事有它自己的端到端用例（`ingest-download-chain.test.ts`）。
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
 * 同一个数还是 `asset_versions.plaintext_bytes` 那一列的来源，而下载路径会把它作为
 * `expectedPlaintextLength` 传回同一个校验器——**同一条核对在接入期与下载期各成立一次**
 * （Task 7 与 Task 8 的移交义务；Task 9 起这条链路是通的，见 `ingest`）。
 */
@Injectable()
export class AssetService {
  private readonly store: ArtifactStore;
  private readonly ring: KeyRing;
  private readonly audit: AuditService;
  private readonly versions: AssetVersionService;

  /**
   * 密钥环来自 `KEY_RING` 提供者（**Task 8 提取**，原先是本类构造期自己建的）。
   *
   * Task 5 的注释把这条移交写得很清楚：「今天只有本类一个消费者（C16 不建空抽象）。
   * 第二个消费者出现时（下载路径 Task 8）再把它提出来，那时它是被依赖逼出来的，
   * 不是猜的。」下载路径必须按制品头里的 keyId 选键，于是它就是那个消费者。
   *
   * **fail-fast 没有丢**：`createKeyRing` 缺 `ARTIFACT_KEYS` / 活动 keyId 不在环里时
   * 立刻抛错，而那个提供者的工厂在**模块装配期**执行（`AssetStoreModule` 的
   * `useFactory`）——配置错误照样在引导期暴露，而不是等一次上传走到一半。
   *
   * 刻意**没有**把 `ConfigService` 从构造参数里删掉：本类不再需要它（环的输入只有
   * 那两个环境变量），把不用的依赖留在签名里正是「看起来还需要」的那类噪音。
   *
   * **Task 9 加了第四个依赖**（`AssetVersionService`）：{@link AssetService.ingest} 的第三步
   * 就是它。它是**值导入**（不是 `import type`），理由见文件顶部那段实测记载——
   * 构造参数的类型元数据只能由值导入 emit 出来。
   */
  constructor(
    @Inject(ARTIFACT_STORE) store: ArtifactStore,
    @Inject(KEY_RING) ring: KeyRing,
    audit: AuditService,
    versions: AssetVersionService,
  ) {
    this.store = store;
    this.audit = audit;
    this.ring = ring;
    this.versions = versions;
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
   * **把这次上传接入成一份作品**（Task 9 合上的那条缝）：校验 → 解析元数据 → 落库。
   *
   * ## 三步，顺序即语义（每一步的失败处置都不一样）
   *
   * ```
   * putStream（multer 的存储引擎接走：加密即入库）
   *    │
   *    ├─ ① finalize        校验（带外长度核对 + 末块认证 + 嗅探）
   *    │                     失败 ⇒ 密文对象已被删掉 + ArchiveRejectedError（422）
   *    ├─ ② parseMetadata   Task 6 的静态解析（同一个刚写下的制品，重新打开一个读取器）
   *    │                     失败 ⇒ 密文对象被删掉 + ArtifactUnreadableError（500）
   *    └─ ③ persistIngested Task 7 的落库（作品 + 版本 + 元数据，**一个事务**）
   *                          失败 ⇒ 密文对象被删掉 + AssetPersistFailedError（500）
   * ```
   *
   * ## 为什么作品必须在**校验之后**才诞生
   *
   * `Asset` 是**永久实体**（有版本史与所有权史，库里没有删除它的入口）。为一个后来被判定
   * 为恶意/损坏的包留下一个空作品，比干净地拒绝一次上传难收拾得多。这里的顺序是结构性的：
   * 落库那一句在 `finalize` 之后，而 `finalize` 不通过就直接抛错。
   *
   * ## 落库失败时为什么**删掉密文对象**（规格 §5 第 3 条要求的那个明确决定）
   *
   * 三个候选是：①删掉重来、②留着不管、③留着并记一个「待清理」标记。选 **①**，理由：
   *
   * - 制品库里唯一的合法状态是「每一个对象都有一行 `asset_versions` 指向它」。③ 的「待清理
   *   标记」在本仓库里就是 `audit_logs` 的一行（Task 5 的 `asset.artifact.cleanup_failed`
   *   已经建立了这个形状），而它的语义是「**该删的没删掉**」——用它去表达「这份制品也许
   *   还有用」会让两种完全不同的运维动作挤进同一个 `action`；
   * - ② 留下的对象**任何人都不可能再取到**：没有版本记录就没有 `storageKey` 的读者
   *   （下载路径按 `AssetVersion` 找对象），它只会无声地攒下去；
   * - 删除走的是**唯一**的那个出口 {@link AssetService.delete}：它自带同步重试、
   *   失败时的 append-only 审计（`asset.artifact.cleanup_failed`，同时就是待清理标记）
   *   与 500。也就是说「删不掉」这一支**已经被处置过**，不需要在这里再发明一层。
   *
   * 代价如实记录：一次**瞬时**的数据库故障会让用户重传整个包（而不是稍后自动重试）。
   * 这是刻意的取舍——另一种选法是留一个没有任何读者、也没有任何标记的孤儿对象，
   * 而「孤儿会无声地累积」正是 Task 5 的删除失败处置要防的形态。
   *
   * ## 双重故障（据实记载的边界）
   *
   * 落库失败**且**删除也失败时，抛出去的是 `ArtifactCleanupError`（更严重的那一件：
   * 制品库里真的多了一个孤儿，而它自己已经在审计里留了一行）。**这一次落库失败的原因
   * 不落任何持久介质**——排障要看的是那行审计，不是被顶掉的那条消息。
   *
   * @param upload `putStream` 的返回值（multer 会把它原样交给控制器）。
   * @param opts.ownerId **上传者本人**（控制器裁定：上传者即所有人）。它同时是
   *   `uploadedById`：一次刚发生的上传里，「上传人」与「所有人」就是同一个人
   *   （转让之后才会分叉，那正是两列都存在的原因）。
   */
  async ingest(upload: StoredArtifact, opts: { ownerId: string }): Promise<IngestedAsset> {
    // ① 校验。不通过时 `finalize` 已经删掉密文对象并抛错，这里不做任何补救。
    const ingested = await this.finalize(upload, { uploadedById: opts.ownerId });

    /**
     * ② 元数据（Task 6 的静态解析）。
     *
     * 读取器是**新开的**：`finalize` 里那个是它自己的局部变量，用完即弃（绝不池化，
     * 见 `finalize` 的注释）。代价是头部与索引会被再读一次（一块之内，且不重复解压）；
     * 换来的是 `finalize` 的契约**一个字节都没变**——它仍然只负责「校验并给出待落库记录」，
     * 于是既有的那批用例（含拒绝路径、限额边界、并发）继续测着同一条边界。
     *
     * 失败与「`validateArchive` 抛错」同一处置：**读不出来的制品没有任何用途**
     * ⇒ 删掉 + 归成「制品读不回来」（500）。Task 6 的文件头把这条移交写得明确：
     * 「这时抛错由调用方按『制品读不回来』处置」。
     */
    let metadata: ParsedMetadata;
    try {
      const reader = await EncryptedArtifactReader.open(this.store, ingested.storageKey, this.ring);
      metadata = await parseMetadata(reader, ingested.kind);
    } catch (error) {
      await this.delete(ingested.storageKey);
      throw new ArtifactUnreadableError(ingested.storageKey, error instanceof Error ? error.message : String(error));
    }

    // ③ 落库：作品（所有人 = 上传者）+ 版本 + 元数据，同一个事务。
    try {
      const persisted = await this.versions.persistIngested({
        ownerId: opts.ownerId,
        ingested,
        metadata,
      });
      return {
        assetId: persisted.assetId,
        assetVersionId: persisted.assetVersionId,
        sha256: ingested.sha256,
        plaintextBytes: ingested.plaintextBytes,
        kind: ingested.kind,
      };
    } catch (error) {
      // **密文对象不能留成孤儿**（见上面那段）：落库失败 = 这份制品没有任何行指向它，
      // 因此与「校验不通过」同一条处置——走**唯一**的删除出口（它自带重试、审计与 500）。
      await this.delete(upload.key);
      throw new AssetPersistFailedError(ingested.storageKey, error instanceof Error ? error.message : String(error));
    }
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
    // 审计里只放**结构化、可检索**的量：尝试次数、错误名、错误码，以及一个**有界的**
    // 理由分类。**不**放原始消息：它可能带着制品卷的文件系统路径，而审计行是 append-only 的
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
          // 失败的**类别**（有界取值，见 `cleanupFailureClass`）。`errorCode` 只覆盖
          // 带 `code` 的错误，而「为什么删不掉」正是运维与将来那个清理 worker 要分流的东西。
          reasonClass: cleanupFailureClass(failure),
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

/**
 * 「这个对象为什么删不掉」的**有界分类**（写进审计行的 `reasonClass`）。
 *
 * ## 为什么不是「把错误名记下来就够了」
 *
 * 审计行是 append-only 的：写进去就删不掉（`infra/db/apply-grants.sql`）。因此那一列**不能**
 * 是原始消息（可能带制品卷路径），也不能是**无界**的取值空间——否则「按理由分流」这件事
 * 会在数据层退化成「一行一个值」。取值只有两种：
 *
 * - 错误对象上的 `code`（`EACCES` / `EBUSY` / `ENOSPC` / `EIO`…）：`node:fs` 的错误都带它，
 *   而这正是本地卷上「删不掉」的全部现实理由；
 * - 其余一律 `Error`。**刻意不返回 `error.name`**：那可以是任何自定义名字，取值空间无界，
 *   而 `errorName` 那一列已经如实地记着它了。也**刻意不**按 HTTP 状态码再分一档：
 *   今天没有任何存储实现会抛带状态码的错误（本地卷不会），那会是一段**不可达也测不到**的
 *   分支（C16）。网络型存储落地时，那个实现要么带 `code`（多数 SDK 都带），
 *   要么那时再按它的错误形状加一档——**那时它才是被依赖逼出来的**。
 *
 * 今天唯一的调用点是 {@link AssetService.delete} 的失败分支（C16：不提前抽象），
 * 用例通过「注入带 `code` 的失败」把它钉住（`ingest.test.ts` 的删除失败处置组）。
 */
function cleanupFailureClass(error: Error): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(code)) return code;
  return 'Error';
}

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
 * 一次上传**落库之后**的结果（{@link AssetService.ingest} 的返回值）。
 *
 * 它是「这次上传诞生的东西」的可操作标识：`assetId` 是作品（库里那一行）、
 * `assetVersionId` 是版本（签发下载要用的就是它）。存储键**刻意不在**这里——
 * 那是服务端的内部定位量，对外的形状由控制器决定（`IngestResponse`）。
 */
export interface IngestedAsset {
  readonly assetId: string;
  readonly assetVersionId: string;
  /** 明文的 sha256（hex）：与上传的字节一致，不是密文的摘要。 */
  readonly sha256: string;
  /** 明文字节数（**写入侧计量器**数出的那个数，也是库里 `plaintext_bytes` 那一列）。 */
  readonly plaintextBytes: number;
  /** 判定出来的归档类型（下载响应的 `Content-Type` 也由它推导）。 */
  readonly kind: ArchiveKind;
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
 * **落库失败**：归档通过了全部校验、元数据也解析出来了，但作品/版本/元数据写不进库
 * （{@link AssetService.ingest} 的第三步）。
 *
 * 责任方**只可能是服务端**（库不可用、约束被撤、连接耗尽），因此走 500 而不是 4xx：
 * 调用方上传的东西没有任何问题，把它说成「你的文件不行」是撒谎。
 *
 * 它**不是** {@link ArtifactUnreadableError} 的兄弟：那一个说的是「制品读不回来」，
 * 这一个说的是「制品是好的，但记录写不下去」。两者的排障方向完全不同（前者看存储/解密，
 * 后者看数据库），因此分成两个类型、两个 `code`——本仓库「状态码与代号要说清责任方」的
 * 同一条口径。
 *
 * **此刻密文对象已经被删掉了**（见 `ingest` 里为什么这么选）：也就是说这个错误的
 * 出现意味着「本次上传的全部痕迹都已清空」，客户端唯一正确的动作是重传。
 */
export class AssetPersistFailedError extends Error {
  constructor(
    /** 被删掉的那个对象键。只出现在错误消息里（**不进响应体**，C11）。 */
    readonly key: string,
    readonly detail: string,
  ) {
    super(`上传已通过校验，但版本记录写不进库（制品 ${key} 已删除）：${detail}`);
    this.name = 'AssetPersistFailedError';
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
