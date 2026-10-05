import { ARCHIVE_LIMITS } from './limits.js';
import { sniffArchive, type ArchiveKind } from './sniff.js';
import { inspectTarGz } from './targz-inspector.js';
import { inspectZip } from './zip-inspector.js';
import type { EncryptedArtifactReader } from '../store/random-access-reader.js';

/**
 * 归档校验的统一入口（P1 / Task 4；设计 D6/D7/D8 + C19）。
 *
 * ## 执行顺序（顺序本身是要求的一部分）
 *
 * 1. **带外长度核对**（若调用方给了）——唯一**非制品自称**的长度载体，纯数值比较、零读取；
 * 2. **`plaintextLength === 0`** ——几何允许 0 块制品，此时「认证末块」无定义，显式拒绝；
 * 3. **认证末块** ——读明文最后一个字节（见下）；
 * 4. **嗅探类型**（D7）；
 * 5. **分发**给 zip / tar.gz inspector（D6 的全部阈值与判据在 `limits.ts`）。
 *
 * ## 为什么第 3 步必须**先于**任何结论（Step 0b）
 *
 * 格式里**没有任何字段认证「制品有多长」**：总量字段在尾部，且**不在任何 AAD 里**。
 * 因此把末尾整块删掉、连索引记录一起删、再把尾部三个字段改小的「**自洽截断**」
 * 能通过读取端 open() 的全部三条完整性校验。挡住它的只有末块的 `isLast` AAD 标记，
 * 而那个标记**只在末块被真正读到时**才生效。
 *
 * Task 3 已经在读取器这一层证明「走到自称末尾却不认证末块」不可构造，
 * 于是**剩余风险全部落在本文件如何使用 `plaintextLength`**。两个决定：
 *
 * - **先认证末块，再下任何结论**：读 `plaintextLength - 1` 这一个字节。
 *   `ChunkDecipher.decryptAt` 是**急切认证**的（`setAuthTag` + `final()`），
 *   1 个字节就足以触发末块的 `isLast` 校验。选它是因为 C16：
 *   不为了一条断言去加「认证末块」的专用 API。
 * - **`totalSize` 只能来自读取器的 `plaintextLength`**，绝不从对象的字节长度或上传元数据
 *   重新推导。被物理截断的对象**自身是自洽的**，它的长度什么都说明不了。
 *   这一条在本文件里是**结构性**的：`validateArchive` 只拿到读取器，拿不到 `ArtifactStore`，
 *   因此它**没有**「对象有多少字节」这个数可用（`stat()` 不在它的入参里）。
 *
 * ## 被拒时返回什么
 *
 * 只有 `{ ok: false, kind, reason }`：**没有任何元数据**。步骤 3 之后立刻返回的拒绝
 * `kind` 一律是 `'unknown'`——没走到嗅探就不该声称知道类型。
 *
 * ## 一处据实记载：带外长度今天**没有**来源，Task 5 必须把它接上（这是一条移交要求）
 *
 * Step 0b 第 5 条要求「若上传时记录了带外长度，用它交叉核对」。实测：**今天没有任何地方
 * 记录它**——`Asset` / `AssetVersion` 模型还不存在（Task 5/6 才建），
 * `POST /assets/upload` 返回的 `bytes` 是**密文对象**的字节数（`putStream` 的返回值），
 * 与明文长度不是同一个量。
 *
 * 因此这里把入口留成**可选参数**并有正反两条用例。**但这个「可选」是过渡态，不是终态**：
 *
 * - **Task 5 建 `AssetVersion` 时，必须把明文的 `plaintextLength` 记进版本记录**，
 *   并在调用本函数时作为 `expectedPlaintextLength` 传进来。那时这条交叉核对才**真的存在**
 *   ——在此之前，「制品自称的长度」是唯一的长度载体，而它**不在任何 AAD 里**（可被攻击者改）。
 *   漏掉这一步的后果不是「少了一条保险」：整块截断检测就只剩下末块的 `isLast` 标记一条腿，
 *   而**长度对不对**这件事没有任何独立的核对源。
 * - **绝不能把密文对象长度传进来**：那会让**每一次合法上传都被拒**
 *   （变异探针 M13 就是这个形态：9 条用例变红）。两个量不是一回事。
 *
 * 这条要求同时写在 `tests/unit/asset/validate-archive.test.ts` 的 Step 0b-5 用例注释里，
 * 以及本轮报告（§F4）。
 */

/** 校验结论。`ok: true` 时只给出类型；被拒时只给出类型与一句话理由（无元数据）。 */
export type ArchiveVerdict =
  | { ok: true; kind: ArchiveKind }
  | { ok: false; kind: ArchiveKind | 'unknown'; reason: string };

export interface ValidateArchiveOptions {
  /**
   * **带外**记录的明文长度（若上传时记过）。唯一非制品自称的长度载体。
   *
   * **Task 5 的义务**：建 `AssetVersion` 时把明文的 `plaintextLength` 记下来并传进这里。
   * 今天没有这个数（模型还不存在），因此它现在是可选的；但「可选」是过渡态——
   * 不接上，长度这条核对就永远是空的。
   *
   * 必须是**明文**长度。传密文对象的字节数会让每一次合法上传都被拒——那不是制品有问题，
   * 而是这个数用错了口径。
   */
  readonly expectedPlaintextLength?: number;
}

/**
 * 校验一份加密制品是不是**可接受的**归档。
 *
 * @param reader 已打开的随机访问读取器（Task 3）。它提供明文视图与**自称的**明文长度。
 * @returns 判定结果。**恶意输入不会抛异常**：解析器抛错、解压失败、认证失败一律是
 *   `{ ok: false, reason }`（D6 约束 1——一次恶意上传不该变成一次未处理异常）。
 */
export async function validateArchive(
  reader: EncryptedArtifactReader,
  options: ValidateArchiveOptions = {},
): Promise<ArchiveVerdict> {
  const plaintextLength = reader.plaintextLength;

  // ---- 步骤 1：带外长度核对（零读取、fail-fast）----
  const expected = options.expectedPlaintextLength;
  if (expected !== undefined && expected !== plaintextLength) {
    return {
      ok: false,
      kind: 'unknown',
      reason: `带外记录的明文长度与制品自称的不符：记录 ${expected} 字节，制品自称 ${plaintextLength} 字节`,
    };
  }

  // ---- 步骤 2：0 块制品的显式行为（Step 0b 第 4 条）----
  if (plaintextLength === 0) {
    return {
      ok: false,
      kind: 'unknown',
      reason: '空制品（0 字节）：没有 magic bytes 可判定类型，几何上也没有末块可认证',
    };
  }

  // ---- 步骤 3：先认证末块（Step 0b；1 个字节足够，decryptAt 是急切认证的）----
  const authFailure = await authenticateLastBlock(reader, plaintextLength);
  if (authFailure !== null) return { ok: false, kind: 'unknown', reason: authFailure };

  // ---- 步骤 4：类型（D7）----
  const sniffed = await sniffArchive(reader);
  if (sniffed.kind === 'unknown') {
    return {
      ok: false,
      kind: 'unknown',
      reason: `既不是 zip 也不是 tar.gz：file-type 认出的是 ${sniffed.detected}`,
    };
  }

  // ---- 步骤 5：分发（totalSize **只能**是 plaintextLength，见文件头）----
  const result =
    sniffed.kind === 'zip'
      ? await inspectZip(reader, plaintextLength, ARCHIVE_LIMITS)
      : await inspectTarGz(reader, plaintextLength, ARCHIVE_LIMITS);

  return result.ok ? { ok: true, kind: sniffed.kind } : { ok: false, kind: sniffed.kind, reason: result.reason };
}

/**
 * 读明文的**最后一个字节**，以此认证末块。
 *
 * @returns `null` 表示认证通过；否则是拒绝理由。
 *
 * 读 1 个字节而不是整块：`serveRange` 会解密**该字节所在的块**，而 `decryptAt` 在返回前
 * 必然完成 GCM 认证。区间取 `[plaintextLength - 1, plaintextLength)`（`end` 独占），
 * 读取器自己的短读断言会保证「拿到 1 字节」这件事为真。
 */
async function authenticateLastBlock(
  reader: EncryptedArtifactReader,
  plaintextLength: number,
): Promise<string | null> {
  try {
    let produced = 0;
    for await (const chunk of reader.createReadStream({ start: plaintextLength - 1, end: plaintextLength })) {
      produced += (chunk as Buffer).length;
    }
    if (produced !== 1) {
      return `末块认证读到的字节数不对：期望 1 字节，实际 ${produced} 字节`;
    }
    return null;
  } catch (error) {
    // 理由里只出现非机密量（C11）：这里连位置都不报——它对调用方没有诊断价值，
    // 而「末块认证失败」这一句已经指向唯一的原因类别（整块截断或末块被篡改）。
    const detail = error instanceof Error ? error.message : String(error);
    return `末块认证失败（制品被整块截断，或末块密文被篡改）：${detail}`;
  }
}
