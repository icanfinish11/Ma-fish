# P1 作品与制品 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让创作者能上传 `.zip`/`.tar.gz` 项目包；平台在**不解压、不执行、明文不落盘**的前提下判定其安全性、抽出可浏览的元数据、以 AES-256-GCM 分块加密存储；只有通过访问判定的人能取得 ≤5 分钟、单次有效的签名下载链接；作品所有权以 append-only 历史流转，**制品永不复制**。P1 结束时作品**存在但不可交易**。

**Architecture:** 在 P0 已成立的安全边界内新增 `asset` 模块（独占 Postgres `asset` schema）。上传路径采用**加密即入库**：流式加密写入制品库，再用一个**按需解密**的随机访问读取器做校验与元数据抽取；校验失败则删除密文对象。归档校验在**任何数据被解压之前**凭元数据判定（zip 读中央目录、tar.gz 凭头部）。制品读取强制块序号契约（见 C20）。

**Tech Stack:** 沿用 P0 全部锁定版本（Node 22.19 · pnpm 11.24 · NestJS 12.1.2 · TypeScript 6.0.3 · Prisma 7.10.0 · PostgreSQL 16 · Redis 7 · Vitest 5.0.3 · zod 4.6.5）。**P1 新增（均已实测，见预检报告）**：`yauzl` 3.4.0 · `tar` 7.5.22 · `file-type` 22.1.1（ESM-only，需 Node ≥22）。加密用 Node 内置 `node:crypto`，**不引入第三方密码学库**。

**Spec:** `docs/superpowers/specs/2026-10-05-p1-asset-artifact-design.md`（决定 D1–D12、判据 1–13）
**上游架构:** `docs/superpowers/specs/2026-10-04-vibe-coding-auction-platform-design.md`
**验证依据:** `docs/superpowers/notes/2026-10-05-p1-preflight-verification.md` —— **本计划的每处机制论断都有实测输出。实现时若与本文冲突，以实测为准并回填该报告。**

---

## 本计划与 P0 计划的一个刻意差异

P0 的计划把每个步骤的**完整代码**都写了出来，结果其中若干处是我未经实测写下的，实现者不得不逐条反驳（不存在的包版本、签名自相矛盾的谓词、pnpm 隔离下不可解析的依赖……）。

P1 因此改为：**契约级内容写死精确代码与精确数值**（存储格式、块序号契约、nonce 推导、限制阈值、验收样本、测试断言），因为这些地方一个错误假设就是一次跨模块返工；**机械部分给精确接口签名 + 测试要求**，由实现者对着真实库写，并在每个任务里先行验证「本任务最大的未验证面」。

每个任务末尾都有一节 **「先验再做」**，列出该任务里**尚未被预检覆盖**的假设。

---

## Global Constraints

**C1–C18 全部继续有效，逐字见 P0 计划 `docs/superpowers/plans/2026-10-04-p0-security-foundation.md` 的 §Global Constraints 一节。** 每个任务的要求都隐含包含该节。P1 新增以下两条：

- **C19 归档校验必须在任何数据被解压之前完成。** 凭元数据判定（zip 中央目录 / tar.gz 头部），不得「先解压再看」。累计大小、条目数、压缩比三条限制任一超限即拒。（威胁 #2）
- **C20 制品读取强制块序号契约。** 解密时块序号**必须取自读取位置**，并显式校验 `record.index === position`；AAD 亦由位置推导。**绝不能信任记录里自称的序号**——预检实测：信任自称序号时，调换两条存储记录会使认证通过且明文被静默重排。此契约必须有专门用例（「调换两条记录必须被拒」）。
- **C21 明文永不落盘。** 上传的明文在任何时刻都不得以文件形式存在于文件系统（包括临时目录）。这是**结构性**要求，不靠清理逻辑兜底。（验收判据 2）

---

## 文件结构

```
vibe-coding-auction-web/
├─ apps/api/
│  ├─ prisma/
│  │  ├─ schema.prisma                 新增 asset schema（Asset/AssetVersion/AssetMetadata/OwnershipHistory）
│  │  └─ migrations/                   新增迁移（含 append-only 授权）
│  └─ src/
│     ├─ config/env.schema.ts          新增 ARTIFACT_KEYS / ARTIFACT_ACTIVE_KEY_ID / ARTIFACT_STORE_DIR
│     ├─ modules/asset/
│     │  ├─ asset.module.ts
│     │  ├─ index.ts                   对外最小接口（只导出 AssetModule + 门面）
│     │  ├─ asset.controller.ts        上传 / 元数据 / 签名下载
│     │  ├─ asset.service.ts           编排（store → validate → persist）
│     │  ├─ ownership.service.ts       所有权流转 + append-only 历史
│     │  ├─ crypto/
│     │  │  ├─ artifact-format.ts      **格式常量与头/索引的编解码（契约）**
│     │  │  ├─ chunk-cipher.ts         加密写入（流式）
│     │  │  ├─ chunk-decipher.ts       解密读取（**块序号契约在此强制**）
│     │  │  └─ key-ring.ts             keyId → 密钥（轮换）
│     │  ├─ store/
│     │  │  ├─ artifact-store.port.ts  端口：put/getRange/delete/stat
│     │  │  ├─ local-artifact.store.ts 本地加密卷实现
│     │  │  └─ random-access-reader.ts 把解密读取器适配成 yauzl 的 RandomAccessReader
│     │  ├─ archive/
│     │  │  ├─ sniff.ts                magic bytes（**注意 tar.gz 的 ext 不是 'gz'**）
│     │  │  ├─ limits.ts               威胁 #2 的阈值（单一来源）
│     │  │  ├─ zip-inspector.ts        只读中央目录
│     │  │  ├─ targz-inspector.ts      'entry' 事件 + 显式 settle + 销毁上游
│     │  │  └─ validate-archive.ts     统一入口：嗅探 → 相应 inspector → 判定
│     │  ├─ metadata/
│     │  │  ├─ parse-metadata.ts       README / 文件树 / 语言分布 / 依赖
│     │  │  └─ completeness.ts         完整度评分（权重可配）
│     │  └─ download/
│     │     ├─ signed-url.ts           HMAC 签名 + 载荷
│     │     └─ nonce-store.ts          Redis 单次使用
│     └─ db/runtime-role.ts            （P0 已有）运行期角色校验
├─ tests/
│  ├─ fixtures/archives/               **八个样本的生成器（不入库二进制）**
│  ├─ unit/asset/                      格式、契约、限制的单测
│  ├─ integration/asset/               真库 + 真 Redis
│  └─ security/asset/                  越权矩阵、签名、审计
└─ docs/superpowers/notes/2026-10-05-p1-preflight-verification.md
```

---

## 任务总览

| # | 任务 | 交付 | 最大未验证面 |
|---|---|---|---|
| 1 | 上传接入与制品存储端口 | multipart 流式 + 硬上限；`ArtifactStore` 端口与本地实现 | **Express 5 / multer 的流式接入** ← P1 最大 |
| 2 | 分块加密：格式与写入 | 格式常量、头部编解码、流式加密器、密钥环 | 8MB 真实块大小 |
| 3 | 分块解密与**块序号契约** | 解密读取器、随机访问、篡改/重排/截断检测 | — |
| 4 | 归档校验器 | 嗅探 + zip/tar.gz inspector + 八样本判定 | tar 流提前中止的边界 |
| 5 | 加密即入库流程 | store → validate → 失败删对象 → 元数据 | 「删除失败」的处置 |
| 6 | 元数据解析 | README / 文件树 / 语言 / 依赖 / 完整度 | 大归档下的内存 |
| 7 | 作品、版本、所有权历史 | `asset` schema + 迁移 + append-only 授权 | 迁移在已迁移库上的落地 |
| 8 | 访问判定、签名下载、审计、越权矩阵 | `checkAccess` / `signDownloadUrl` / 审计 / 矩阵 | — |

**任务间依赖**：2 → 3 →（4 与 5 可并行开发，但 5 依赖 3 与 4）→ 6 → 8；7 可与 4/5/6 并行。
**编号即执行顺序**，与 P0 一致：每个任务一个新实现者、控制器预审、任务审查、修复轮。

---

### Task 1: 上传接入与制品存储端口

**Files:**
- Create: `apps/api/src/modules/asset/store/artifact-store.port.ts`
- Create: `apps/api/src/modules/asset/store/local-artifact.store.ts`
- Create: `apps/api/src/modules/asset/asset.module.ts`
- Create: `apps/api/src/common/upload/stream-upload.ts`
- Modify: `apps/api/src/config/env.schema.ts`（`ARTIFACT_STORE_DIR`、`ARTIFACT_MAX_UPLOAD_BYTES`）
- Test: `tests/unit/asset/local-store.test.ts`、`tests/integration/asset/upload-stream.test.ts`

**Interfaces:**
```ts
export interface ArtifactStore {
  /** 流式写入，返回存储键与写入字节数。绝不缓冲整个流。 */
  putStream(source: Readable, opts: { maxBytes: number }): Promise<{ key: string; bytes: number }>;
  /** 按字节区间读取（解密读取器需要随机访问）。 */
  getRange(key: string, start: number, endInclusive: number): Promise<Buffer>;
  stat(key: string): Promise<{ bytes: number }>;
  delete(key: string): Promise<void>;
}
```

**先验再做（本任务最大的未验证面）：**
- [ ] 用一次性探针确认 **NestJS 12 / Express 5 下 multipart 流式接入的真实形态**：能否拿到请求流而**不**让 multer 先落盘或整份进内存。分别验证 `multer` 2.4.0 的 `memoryStorage`（会缓冲）与自定义 storage engine（可流式），记录**实测**结论。
- [ ] 确认硬性大小上限在哪一层生效（`limits.fileSize` 触发的是哪种错误、能否映射为 413），以及超限时**已写入的部分是否被清理**。
- [ ] 若结论是「必须自己解析 multipart」，就自己解析（`busboy` 1.6.0 已在候选），**不要**为了省事接受「先落盘再校验」——那会直接违反 C21。

**Steps:**
- [ ] **Step 1:** 写失败测试：`putStream` 写入 N 字节后 `stat` 得到 N；`getRange(key, 2, 5)` 返回精确 4 字节；`delete` 后 `stat` 抛错。
- [ ] **Step 2:** 实现端口与本地实现（`ARTIFACT_STORE_DIR` 下的分片目录，键用 UUIDv7，避免单目录十万文件）。
- [ ] **Step 3:** `putStream` 的 `maxBytes` 超限必须在中途中止并**删除已写入的部分**，测试覆盖。
- [ ] **Step 4:** 接入上传路由（**先不做任何校验**，只落地字节），集成测试用真实请求流。
- [ ] **Step 5:** 跑 `pnpm typecheck && pnpm lint && pnpm test`。

**Acceptance:**
- 上传 1GB 流式数据时进程内存**不随文件大小增长**（用未完成字节数断言，不用 RSS）。
- 超限上传中止后，制品库中**无残留对象**。

---

### Task 2: 分块加密 —— 格式与写入

**Files:**
- Create: `apps/api/src/modules/asset/crypto/artifact-format.ts`
- Create: `apps/api/src/modules/asset/crypto/key-ring.ts`
- Create: `apps/api/src/modules/asset/crypto/chunk-cipher.ts`
- Modify: `apps/api/src/config/env.schema.ts`（`ARTIFACT_KEYS`、`ARTIFACT_ACTIVE_KEY_ID`）
- Test: `tests/unit/asset/artifact-format.test.ts`、`tests/unit/asset/chunk-cipher.test.ts`

**契约（写死，不得改动）：**

```
块大小          8 MiB（8388608）——设计文档威胁 #3
密文块布局      ciphertext || tag(16)     tag 追加在每块密文尾部
nonce           12 字节 = noncePrefix(4, 每文件随机) || 块序号(8, 大端)
                **禁止**「固定前缀 + 从 0 开始计数器」跨文件复用（GCM 下 nonce 重用泄露明文异或）
AAD             `${fileId}:${position}:${isLast ? 'last' : 'more'}`（UTF-8）
                fileId 为 16 字节随机，十六进制表示

物理排布（**必须可单趟顺序写出**，Task 1 的 putStream 只能从 0 追加）
  [ 文件头 31+N 字节 ]  只放流结束**之前**就已知的字段：
                       magic(4)="VCA1" | formatVersion(2)=1 | keyIdLen(1) | keyId(N) |
                       fileId(16) | chunkSize(4) | noncePrefix(4)
  [ 块数据 ... ]       逐块 ciphertext||tag(16)，顺序追加
  [ 块索引 ... ]       每块 24 字节：
                       offset(8, **文件绝对偏移**) | ciphertextLength(4, **不含 tag**) |
                       记录自称序号(8, 大端) | 保留(4, 全零)
  [ 尾部 24 字节 ]     indexOffset(8) | chunkCount(8) | plaintextLength(8)  ← 恒为文件最后 24 字节
```

> **R3 裁定（2026-10-05）**：原计划的 `[头][索引][数据]` **物理上不可产出**——头里含流结束后才知道的总量，而索引排在数据之前。故 `plaintextLength`/`chunkCount` 移入尾部，索引移到数据之后，读取端先读最后 24 字节定位索引。这同时让「只解密尾部若干块」（Task 3）与 zip 中央目录读取（Task 4）更自然。
>
> **R2 裁定**：索引里的**记录自称序号**仅供**比对**，**绝不用于推导 nonce 或 AAD**（那正是预检发现的重排漏洞）。没有这个字段，C20 的校验、Task 3 的错误信息与变异探针都没有数据来源。
>
> **R1**：旧稿写的「头部定长 48」是**算术错误**（`4+2+1+16+4+8+8+4 = 47`）。**R3 之后头部为 `31+N` 字节**（`4+2+1+N+16+4+4`：magic/version/keyIdLen/keyId/fileId/chunkSize/noncePrefix），因为 `plaintextLength` 与 `chunkCount` 已移入尾部。**代码已按 31+N 实现并复审通过**；本计划下文若再出现 47/48 均为陈旧文本。
> **R4**：0 字节输入 ⇒ `chunkCount = 0`、`plaintextLength = 0`。
> **R5**：环境面为**键环** `ARTIFACT_KEYS`（JSON `{keyId: base64(32B)}`）+ `ARTIFACT_ACTIVE_KEY_ID`，且引导期校验 active ∈ keys。**R6**：删除无读取方的 `MASTER_ENCRYPTION_KEY`。

**Interfaces（已按 R2/R3/R5 更新；以 `artifact-format.ts` 的实际导出为准）:**
```ts
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const ARTIFACT_MAGIC = 'VCA1';
export const HEADER_FIXED_BYTES = 31;   // 不含 keyId
export const FOOTER_BYTES = 24;

/** 只含流结束**之前**就已知的字段——总量在尾部。 */
export interface ArtifactHeader {
  formatVersion: number; keyId: string; fileId: Buffer;
  chunkSize: number; noncePrefix: Buffer;
}
/** 流结束后才知道的总量。恒为制品最后 24 字节。 */
export interface ArtifactFooter {
  indexOffset: bigint; chunkCount: bigint; plaintextLength: bigint;
}
export function encodeHeader(h: ArtifactHeader): Buffer;
export function decodeHeader(buf: Buffer): { header: ArtifactHeader; keyIdLength: number };
export function headerByteLength(keyIdLength: number): number;
export function blockDataOffset(keyIdLength: number): number;
export function encodeFooter(f: ArtifactFooter): Buffer;
export function decodeFooter(buf: Buffer): ArtifactFooter;   // 必须恰好 24 字节

/** 索引每条 24 字节：offset(8) | ciphertextLength(4, 不含 tag) | 记录自称序号(8) | 保留(4, 全零) */
export interface IndexEntry {
  offset: bigint; ciphertextLength: number;
  /** **仅供读取端与位置比对，绝不用来推导 nonce/AAD**（R2）。 */
  index: bigint;
}
export function encodeIndex(entries: IndexEntry[]): Buffer;
/** 写入端编解码**有意不校验**顺序/边界/`index === position`——那些属于读取端（Task 3）。 */
export function decodeIndex(buf: Buffer): IndexEntry[];

export interface KeyRing { activeKeyId(): string; keyFor(keyId: string): Buffer; }
/** 未知 keyId 或活动键不在环中 ⇒ 抛错，**绝不回退到默认键**。 */
export function createKeyRing(env: { ARTIFACT_KEYS: string; ARTIFACT_ACTIVE_KEY_ID: string }): KeyRing;
export function deriveNonce(prefix: Buffer, position: number): Buffer;
export function buildAad(fileId: Buffer, position: number, isLast: boolean): Buffer;

export class ChunkEncryptor {
  constructor(keyRing: KeyRing, opts?: { chunkSize?: number });
  /** 流式：**只产出块数据**，不缓冲整个输入。 */
  transform(): Transform;
  /** 流成功结束后才可调用；返回组装制品所需的四段（尾部最后写）。 */
  result(): {
    header: Buffer; index: Buffer; footer: Buffer;
    footerFields: ArtifactFooter; blockDataOffset: number;
  };
}
```

**Steps:**
- [ ] **Step 1:** 失败测试：头编解码往返；`deriveNonce` 前 4 字节等于前缀、后 8 字节为大端序号；同文件不同 position 的 nonce 互不相同；两文件 noncePrefix 不同时 nonce 不碰撞。
- [ ] **Step 2:** 实现 `artifact-format.ts`（纯函数，无 I/O）。
- [ ] **Step 3:** 失败测试：加密器对 0 字节 / 恰好 1 块 / 1 块+1 字节 / 3 块+1234 字节 分别产出正确的 `chunkCount` 与 `plaintextLength`。
- [ ] **Step 4:** 实现 `ChunkEncryptor`。
- [ ] **Step 5:** `createKeyRing` 的失败测试：`ARTIFACT_KEYS` 非法 JSON / 非法 base64 / 单键非 32 字节 ⇒ 抛；`ARTIFACT_ACTIVE_KEY_ID` 不在环中 ⇒ 抛（引导期与构造期**两处**都抛）。（C10）
- [ ] **Step 6:** 跑三项门禁。

**Acceptance:**
- 加密 64 MiB 输入时，峰值未完成字节数 **≤ 3 × CHUNK_SIZE**（不随输入增长）。
- 相同明文两次加密的密文不同（noncePrefix 随机）。

**先验再做：** 预检用 64 KiB 块，**8 MiB 真实块大小下的 AAD/nonce 逻辑必须在实现时用真实值重跑一次**预检的对应断言。

---

### Task 3: 分块解密与**块序号契约**（C20）

**Files:**
- Create: `apps/api/src/modules/asset/crypto/chunk-decipher.ts`
- Create: `apps/api/src/modules/asset/store/random-access-reader.ts`
- Test: `tests/unit/asset/chunk-decipher.test.ts`（**本题的核心用例在这里**）

**Interfaces:**
```ts
export class ChunkDecipher {
  constructor(keyRing: KeyRing, header: ArtifactHeader, index: IndexEntry[]);
  /** position 由**调用方按读取顺序**给出，绝不取自记录。 */
  decryptAt(position: number, ciphertext: Buffer): Buffer;
  /** 顺序读取全量；逐块校验 record.index === position。 */
  decryptAll(readCiphertext: (position: number) => Promise<Buffer>): Promise<Buffer>;
}
```

**Steps:**
- [ ] **Step 1:** 失败测试（往返）：0 字节 / 跨块 / 末块不满 各往返一致。
- [ ] **Step 2:** 实现 `decryptAt`。
- [ ] **Step 3: 契约用例（必须有，否则 C20 会悄悄退化）**
  - [ ] 篡改第 N 块密文 → 抛错且**点名 chunk N**。
  - [ ] **调换两条记录（含各自的 nonce 与 tag）→ 必须被拒**，错误信息点出「位置 P 处的记录自称序号 Q」。
  - [ ] 截断末块 → 被拒（末块 `isLast` 标记使然）。
  - [ ] 未知 `keyId` → 抛错且**不回退**；**已退役但仍在环中的 keyId → 能正常解密**（R5 的轮换路径）。
- [ ] **Step 3b: 三条完整性校验（**Task 2 复审认定的必要充分条件，缺一不可**）**
  头部的总量字段**不在任何 AAD 里**，因此「改小 `chunkCount` + 删掉末尾整块」这类截断只能靠读取端校验发现。`isLast` 只挡「不满的末块」那一类。
  - [ ] `chunkCount === 索引中实际存在的记录数`
  - [ ] `chunkCount === ceil(plaintextLength / chunkSize)`
  - [ ] `Σ ciphertextLength === plaintextLength`

  > ⚠️ **前两条合起来仍不充分**：3 块的制品截成 2 块、并把 `chunkCount` 改成 2、`plaintextLength` 改成 16 MiB，前两条都满足。**充分性来自第三条**（对实际存在的记录求和）。三条都要有用例。
- [ ] **Step 4:** 变异探针：把序号改回「取自记录自称」（即去掉位置校验）⇒ **「调换记录」用例必须变红**。若不变红，说明用例没有真正覆盖 C20。
- [ ] **Step 5:** `random-access-reader.ts` 适配 `yauzl.RandomAccessReader` 的抽象接口（`_readStreamForRange`/`read`/`ref`/`unref`/`close`），只解密所需块。**读取尾部 24 字节定位索引时，只应解密最后一块**（`getRange(key, size-24, size-1)`）。
- [ ] **Step 6:** **读取端必须校验索引自身**：`offset` 单调递增、各区间落在 `[0, indexOffset)` 内、且与文件长度自洽（写入端的 `decodeIndex` 有意不做这些检查，它们属于读取端）。
- [ ] **Step 7:** 跑三项门禁。

**Acceptance:**
- 四个契约用例全部通过，且 Step 4 的变异能让「调换记录」用例变红。
- 读取尾部 N 字节时解密的块数 ≤ 2（不是全文件）。

---

### Task 4: 归档校验器

**Files:**
- Create: `apps/api/src/modules/asset/archive/limits.ts`
- Create: `apps/api/src/modules/asset/archive/sniff.ts`
- Create: `apps/api/src/modules/asset/archive/zip-inspector.ts`
- Create: `apps/api/src/modules/asset/archive/targz-inspector.ts`
- Create: `apps/api/src/modules/asset/archive/validate-archive.ts`
- Create: `tests/fixtures/archives/generate.ts`（**样本用代码生成，不入库二进制**）
- Test: `tests/unit/asset/validate-archive.test.ts`

**契约（阈值单一来源，逐字取自设计文档威胁 #2）：**
```ts
export const ARCHIVE_LIMITS = {
  maxTotalUncompressedBytes: 1024 * 1024 * 1024, // 1 GiB
  maxEntries: 20_000,
  maxCompressionRatio: 100,                       // 100:1
} as const;

export type ArchiveVerdict =
  | { ok: true; kind: 'zip' | 'tar.gz' }
  | { ok: false; kind: 'zip' | 'tar.gz' | 'unknown'; reason: string };

export function validateArchive(reader: RandomAccessReader): Promise<ArchiveVerdict>;
```

**七个必须覆盖的样本（生成器代码化，验证它们的**存在**而不是内容）：**

| 样本 | 期望 | 说明 |
|---|---|---|
| `zip-slip.zip` | 拒绝 | 含 `../../../../etc/evil.txt` 与绝对路径；**yauzl 会在 open 阶段抛错 ⇒ 抛错即拒绝，不得让进程崩** |
| `symlink.zip` | 拒绝 | 外部属性 Unix mode `0o120777`；**yauzl 自带防护不覆盖这个** |
| `bomb.zip` | 拒绝 | 100 MiB 零字节，实测比 1029:1 |
| `flood.zip` | 拒绝 | 20,001 个条目 |
| `fake-mime.zip` | 拒绝 | PNG magic + `.zip` 后缀 |
| `bomb.tar.gz` | 拒绝 | 同炸弹，实测比 1028:1 |
| `ok.zip` / `ok.tar.gz` | **接受** | **必须有用例**，否则「全部拒绝」的实现也能通过 |

**Steps:**
- [ ] **Step 0（依赖登记 + 复验）:** 把 `file-type@22.1.1` 与 `tar@7.5.22` **精确版本**登记进 `apps/api`（是 `tar`，**不是** `tar-stream`）。登记后跑 `pnpm install`，再用 **`require.resolve`（从 `apps/api/src` 出发）** 确认两者真的可解析——**不要**以 `node_modules/` 下存在同名目录为准（Task 3 发现：控制器预检探针的残留 `.pnpm` 目录会让「已安装」看起来为真，见预检 §8）。
- [ ] **Step 0b（末块认证 —— Task 3 复审新增的**强制**要求）:** 归档校验**必须先认证末块**，再下任何结论。五条要点，逐条都要有对应用例：
  1. **机制**：Task 3 **没有**导出「认证末块」的专用 API（C16 不允许为了一条断言加抽象）。可用形式是**读一段覆盖 `plaintextLength - 1` 的区间**——`ChunkDecipher.decryptAt` 是**急切认证**的，**1 个字节就足够**触发末块的 `isLast` 校验。
  2. **用例必须是 Task 4 边界上的端到端**：一个**自洽的截断制品**必须被拒**且不返回任何元数据**——而不是只断言「读取会抛」。
  3. **口径（provenance）比数值更重要**：`totalSize` **必须**取自读取器的 `plaintextLength`，**绝不能**从对象的字节长度或上传元数据重新推导。因为被物理截断的对象**自身是自洽的**，它的长度什么都说明不了。
  4. **定义 `plaintextLength === 0`**：几何上允许 0 块制品，此时「认证末块」无定义——必须有明确行为与用例。
  5. **若上传时记录了带外长度**（非制品自称），用它交叉核对——那是**唯一**非自称的长度载体。

  > **为什么这是强制的**：格式里**没有任何字段认证「制品有多长」**（总量字段在尾部，且不在任何 AAD 里）。整块截断只能靠末块的 `isLast` 标记发现，而它**只在末块被真正读取时才生效**。Task 3 已用两条变异探针证明**读取器这一层**无法构造「走到自称末尾却没认证末块」的路径 ⇒ **剩余风险全部转移到 Task 4 如何使用 `plaintextLength`**。
- [ ] **Step 1:** `limits.ts` + `sniff.ts`。嗅探判定条件必须是 `ext === 'tar.gz' || mime === 'application/gzip'`。
  - **必有用例（预检实测的缺陷）**：断言**合法 tar.gz 被识别为 tar.gz**。写成 `=== 'gz'` 会把 100% 的合法 tar.gz 误拒——这是「测试全绿、生产全炸」型错误，且会让整条 tar.gz 路径不被执行。
- [ ] **Step 2:** `zip-inspector.ts`：`lazyEntries` 只读中央目录，收集 `fileName` / `uncompressedSize` / `compressedSize` / `externalFileAttributes`。**Open/parse 抛错 ⇒ 返回拒绝**（不是崩）。
- [ ] **Step 3:** `targz-inspector.ts`：用 tar 包的 **`'entry'` 事件**（用 `onentry` 回调会**静默挂住**）。累计大小与压缩比**仅凭头部**判定。提前中止 = 销毁 `source`/`gunzip` + **立刻 settle 自己的 promise**（`tar.Parser` 没有 `destroy()`；`pipeline` 在目标流于条目回调内被销毁时不 settle）。
- [ ] **Step 4:** `validate-archive.ts` 统一入口，按序执行：嗅探 → inspector → 路径/链接 → 条目数 → 累计大小 → 压缩比。**在读到任何条目数据之前**完成（C19）。
- [ ] **Step 5:** 八样本用例全绿（六个拒绝 + 两个接受）。
- [ ] **Step 6:** 落盘断言：跑完八样本后，比对制品库目录与临时目录，断言**无新增文件**（C21 / 判据 2）。
- [ ] **Step 7:** 跑三项门禁。

**Acceptance:**
- 八样本判定 100% 正确。
- **两个合法样本必须被接受**——这是本题最重要的反向用例。
- 校验过程中**零字节条目数据被读取**（zip 用计数 spy 断言 `openReadStream` 从未被调用）。
- 进程在遇到 `zip-slip.zip` 时不崩溃。

**先验再做：** tar 提前中止在**超大真实炸弹**（>1 GiB 声明）下的行为未验；确认中止发生在解压出几百字节之后，而不是整份解完。

---

### Task 5: 加密即入库流程

**Files:**
- Create: `apps/api/src/modules/asset/asset.service.ts`
- Create: `apps/api/src/modules/asset/store/random-access-reader.ts`（Task 3 建立，此处接入存储端口）
- Test: `tests/integration/asset/ingest.test.ts`

**流程（决定 D1，不得改成「先落盘明文再校验」）：**
```
上传流 → putStream（立即加密写入制品库）
       → 打开解密读取器
       → validateArchive
       → 失败：delete(密文对象)，返回 4xx；确保删除失败也有明确处置
       → 成功：parseMetadata → 写 Asset/AssetVersion/AssetMetadata
```

**先验再做：**
- [ ] 决定并实现**「删除密文对象失败」的处置**（规格 §5 第 3 条）。三种可选：同步重试 N 次后抛 500 并记审计；写入一个待清理标记由 worker 兜底；两者结合。**必须明确选一个并写进代码注释**，不能留空。

**Steps:**
- [ ] **Step 1:** 失败测试：合法 zip 走完流程 ⇒ 制品库有一个对象、DB 有一行、元数据非空。
- [ ] **Step 2:** 失败测试：恶意样本 ⇒ **制品库无对象残留**且 DB 无行。
- [ ] **Step 3:** 实现流程。
- [ ] **Step 4:** 删除失败的用例：注入一个会抛错的 store ⇒ 断言走了选定的处置路径且留下可观测痕迹（审计或标记）。
- [ ] **Step 5:** 集成测试断言全流程中**明文不落盘**（校验前后比对文件系统，含系统临时目录）。
- [ ] **Step 6:** 跑三项门禁 + 集成 project。

**Acceptance:**
- 判据 2 成立：恶意样本零落盘、零残留。
- 合法样本端到端成功，`sha256` 与上传字节一致。

---

### Task 6: 元数据解析

**Files:**
- Create: `apps/api/src/modules/asset/metadata/parse-metadata.ts`
- Create: `apps/api/src/modules/asset/metadata/completeness.ts`
- Test: `tests/unit/asset/parse-metadata.test.ts`

**Interfaces:**
```ts
export interface ParsedMetadata {
  readmeExcerpt: string | null;
  fileTree: { path: string; bytes: number }[];   // 深度与条目数受限
  languages: { name: string; bytes: number; ratio: number }[];
  dependencies: { ecosystem: string; name: string; version: string }[];
  completeness: number;                           // 0–100
}
export function parseMetadata(reader: RandomAccessReader, kind: 'zip' | 'tar.gz'): Promise<ParsedMetadata>;
```

**Step 1 必须是这个（C2 的正向证据）：**
- [ ] 造一个**含可执行脚本**的样本（如 `package.json` 里带 `postinstall`、再放一个 `evil.sh` 与一个会被写入的哨兵路径）。断言解析完成后：哨兵文件**不存在**、`node_modules` **不存在**、没有任何子进程被启动（用 spy 计数）。
  **这条用例是判据 12 的全部内容**——「不执行」必须被证明，而不是被声称。

**Steps:**
- [ ] **Step 1:** 上面那条「绝不执行」的用例。
- [ ] **Step 2:** README 抽取（大小写不敏感、取第一个匹配、截断到上限）。
- [ ] **Step 3:** 文件树摘要（深度上限、条目数上限、超限时截断并标记）。
- [ ] **Step 4:** 语言分布（按扩展名归类，按字节占比；未知归 `other`）。
- [ ] **Step 5:** 依赖清单（`package.json` / `requirements.txt` / `go.mod`，**纯文本解析**）。
- [ ] **Step 6:** 完整度评分，权重可配（设计文档 §6.2），默认权重写死并有用例。
- [ ] **Step 7:** 跑三项门禁。

**Acceptance:**
- 「绝不执行」用例通过，且有副作用探针为证。
- 超大归档下解析内存受控（用未完成字节数断言）。

---

### Task 7: 作品、版本、所有权历史

**Files:**
- Modify: `apps/api/prisma/schema.prisma`（新增 `asset` schema）
- Create: `apps/api/prisma/migrations/<ts>_p1_asset/migration.sql`
- Modify: `infra/db/apply-grants.sql`（`OwnershipHistory` 纳入 append-only）
- Create: `apps/api/src/modules/asset/ownership.service.ts`
- Test: `tests/integration/asset/ownership.test.ts`、`tests/integration/db/append-only.test.ts`（扩展）

**数据模型（沿用设计文档 §5.1/§5.3）：**
- `Asset`（永久实体）：`id` UUIDv7、`ownerId`、`createdAt`
- `AssetVersion`：`assetId`、`sha256`、**`storageKey`（制品对象键——下载路径必须靠它取对象；原字段清单漏了它，Task 5 指出）**、`plaintextBytes`、`keyId`、`fileId`、`uploadedById`、`createdAt`
  - **`plaintextBytes` 是强制列，不是可选元数据。** 格式里**没有任何字段认证「制品有多长」**，它是制品**自称**值；接入期由 Task 5 用写入侧计量器数出并核对。**Task 7 必须把它落库；Task 8 必须在下载路径把它作为 `expectedPlaintextLength` 传回读取器** —— 否则这条核对**只在接入期有效**，下载路径上「更短、完全自洽」的制品会被当成合法的。Task 5 的探针 m6 实测：不传带外长度 ⇒ 一份更短的合法形状制品被**接受（201）**；带上 ⇒ 422。
- `AssetMetadata`：`assetVersionId`、上面 `ParsedMetadata` 各字段
- `OwnershipHistory`：`assetId`、`fromUserId`、`toUserId`、`reason`、`createdAt` — **append-only**

全部时间戳 `@db.Timestamptz(3)`（C6）。主键 `@default(uuid(7))`（C4）。

**Steps:**
- [ ] **Step 1:** schema + 迁移。**迁移必须能在已迁移的库上干净落地**（P0 期间踩过一次：迁移再生成会与已迁移的本地卷冲突）——在全新库与已有库上各验一次。
- [ ] **Step 1b（Task 5 移交的强制义务）:** `AssetVersion` 必须含 **`storageKey`**（下载路径取对象用）与 **`plaintextBytes`**，且 `plaintextBytes` **由 Task 5 的写入侧计量器数出**、不是从密文长度或上传元数据推导。两者都要有用例断言其确实落库。
- [ ] **Step 2:** `infra/db/apply-grants.sql` 增加 `asset.ownership_history` 的 `REVOKE UPDATE, DELETE`（C7）。
- [ ] **Step 3:** 扩展 append-only 集成测试覆盖 `OwnershipHistory`：**运行时角色**下 `UPDATE`/`DELETE` 被真实拒绝（沿用 P0 的双角色断言方式）。
- [ ] **Step 4:** `ownership.service.ts`：转让 = `Asset.ownerId` 变更 + `OwnershipHistory` 追加一行，**不解密、不复制制品**（§5.2 第 2 条）。在同一事务内。
- [ ] **Step 5:** 用例：转让后制品对象的**字节完全未变**（比对 sha256 与存储键），只有指针与历史变了。
- [ ] **Step 6:** 跑三项门禁 + 集成 project。

**Acceptance:**
- 判据 10 成立：`OwnershipHistory` 在运行时角色下不可改写。
- 转让**不触碰制品字节**（有断言）。

---

### Task 8: 访问判定、签名下载、审计、越权矩阵

**Files:**
- Create: `apps/api/src/modules/asset/download/signed-url.ts`
- Create: `apps/api/src/modules/asset/download/nonce-store.ts`
- Create: `apps/api/src/modules/asset/asset.controller.ts`（补下载与元数据端点）
- Create: `apps/api/src/modules/asset/index.ts`
- Test: `tests/security/asset/authz-matrix.test.ts`、`tests/integration/asset/signed-download.test.ts`

**契约：**
```ts
export interface DownloadTicket {
  assetVersionId: string; userId: string; expiresAt: number; nonce: string; signature: string;
}
export function signTicket(t: Omit<DownloadTicket,'signature'>, secret: string): string; // HMAC-SHA256
export function verifyTicket(t: DownloadTicket, secret: string, now: number): boolean;    // 定时安全比较
export async function consumeNonce(nonce: string, ttlSeconds: number): Promise<boolean>;  // Redis SET NX
```
TTL **≤ 300 秒**（威胁 #3）。`nonce` 首次使用即消费；重复使用 ⇒ 拒绝。

> **Task 5 移交的强制义务（下载路径）**：下载时必须把 `AssetVersion.plaintextBytes` 作为 **`expectedPlaintextLength`** 传给读取器并**认证末块**。理由同 Task 5：格式里没有字段认证制品总长，不传带外长度 ⇒ **「更短、完全自洽」的截断制品会被当成合法的**（Task 5 探针 m6 实测：不传 ⇒ 201 接受，传 ⇒ 422）。**这条核对若只在接入期成立、下载期失效，等于没有。**

**Steps:**
- [ ] **Step 1:** 签名单元测试：正确签名通过；**篡改任一字段**（载荷、过期时间、用户）⇒ 拒绝；过期 ⇒ 拒绝；签名长度或编码畸形 ⇒ 拒绝（不抛未捕获异常）。
- [ ] **Step 2:** 单次使用集成测试（真 Redis）：首次成功，**第二次同一 nonce 被拒**；两个并发请求只有一个成功。
- [ ] **Step 3:** `checkAccess` 作为**唯一**授权入口；未授权用户请求签名 URL ⇒ 403。
- [ ] **Step 4:** 审计：下载**成功与失败都写** `AuditLog`。用例分别断言两种行。
- [ ] **Step 5:** **越权矩阵**（判据 11，沿用 P0 的安全测试骨架）：遍历 `asset` 模块全部端点 × 全部角色（匿名 / 已登录非属主 / 属主 / 管理员），断言默认拒绝。
- [ ] **Step 6:** 更新策略声明覆盖门（P0 已有）使其包含新路由——**新路由漏声明策略必须让测试失败**。
- [ ] **Step 7:** `modules/asset/index.ts` 只导出 `AssetModule` 与门面（**不 `export *`**）。
- [ ] **Step 8:** 扩展架构守护规则使 `asset` 模块受同一条 `no-cross-module-internals` 约束。
- [ ] **Step 9:** 跑全部门禁。

**Acceptance:**
- 判据 8、9、11 成立。
- `pnpm arch` 通过，且 `asset` 模块被规则覆盖。

---

## 完成判据表（P1）

在 `main` 合并前由**控制器本人**逐条实跑，不接受实现者转述。

| # | 判据 | 命令 |
|---|---|---|
| 1 | 类型检查 | `pnpm typecheck` |
| 2 | lint（含 C9 安全门） | `pnpm lint` |
| 3 | 架构守护（`asset` 模块受约束） | `pnpm arch` |
| 4 | 零测试门（security/architecture 下限上调） | `node scripts/assert-tests-ran.mjs` |
| 5 | 全量测试 | `pnpm test` |
| 6 | 八样本判定（六拒两收） | `pnpm vitest run --project unit -t 归档` |
| 7 | 块序号契约（调换记录必须被拒） | `pnpm vitest run --project unit -t 序号契约` |
| 8 | 恶意样本零落盘零残留 | `pnpm vitest run --project integration -t 零落盘` |
| 9 | append-only 覆盖 `OwnershipHistory` | `pnpm vitest run --project integration -t append-only` |
| 10 | 越权矩阵 | `pnpm vitest run --project security -t 越权` |
| 11 | 签名 URL 超时/篡改/重放 | `pnpm vitest run --project integration -t 签名下载` |
| 12 | 绝不执行用户代码（副作用探针） | `pnpm vitest run --project unit -t 绝不执行` |
| 13 | 依赖无 high/critical 或书面豁免 | `pnpm audit --audit-level high` |

**输出必须 pristine。** 每个任务的验收以「用例能失败」为前提——首次即绿的断言一律要求变异探针。

