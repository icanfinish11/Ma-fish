import type { AssetMetadataView } from '../../asset/index.js';
import { InvalidClaimsError } from './errors.js';

/**
 * 承诺闭集（规格 §6.1；增量 A-6）。**这五个字符串是整个机制里唯一允许出现的声明** ——
 * 自由文本会让机器审判退化成一场关于「质量」的口水仗，而平台明确不判质量（D7 / §1.4）。
 *
 * ## 为什么需要它（规格 §6.2 逐字）
 *
 * 今天 dossier 的九项**全是平台自己解析出来的** ⇒ 天生忠实 ⇒ **不可能违约**；
 * 而**作者说的话**（README 里写「这是一个完整的 XX 系统」、截图是「本项目运行效果」）
 * 今天没有任何核对。闭集把「质量」翻译成一组**可机器核对的承诺**，于是「说得越大，
 * 押得越多」，违约变成一条**可机器认定**的事实。
 *
 * ## 每一条的判据都**只读已有的、平台自产的事实**（D16 的复访条件因此关闭）
 *
 * | 断言 | 参数 | 判据读的事实 | 今天核得动吗 |
 * |---|---|---|---|
 * | `paths_exist` | `string[]` | `asset_metadata.file_tree` | ✅ |
 * | `entry_file_exists` | `string` | `asset_metadata.file_tree` | ✅ |
 * | `dependency_manifest_parses` | `string` | `asset_metadata.dependencies` | ✅ |
 * | `min_code_lines` | `number` | `asset_metadata.code_lines`（Task 5.5 落列） | ✅（**可空**，见下） |
 * | `declared_stack` | `string[]` | `asset_metadata.languages` | ✅ |
 *
 * 因此这一版**不需要任何新的解析**，也不需要执行任何用户代码（C2 / D3）。
 *
 * ## 据实划界：这里**没有** `judge`
 *
 * 规格 §6.3 还要求「每个断言都要有『声明为真 ⇒ 通过』与『声明为假 ⇒ 违约成立』两条用例」。
 * 那两条的主语是**审判**，而 `judge` 的消费者在 P3.5（§11.2 / §7.1）。本任务交付的是
 * §6 的**声明侧**：闭集 + 解析 + 「一条核不动的声明不允许被提出」。
 * 在 `judge` 有生产消费者之前实现它，就是 C16 禁止的投机抽象。
 *
 * ## 为什么闭集的**唯一**定义处在这里（而不是 zod 与判据各一份）
 *
 * 规格 §6.3 逐字：「`claims` 的解析器（zod）与 `judge` 的判据都从**同一张表**派生，
 * 禁止两处各写一份」。因此 `dto.ts` 把 `claims` 当作一条**不透明**取值转交，
 * 闭集外的 `kind` 得到的是 **422**（`InvalidClaimsError`）而不是 400 —— 那条 400
 * 会要求 zod 里存在第二份闭集。**据实记载这处与计划字面的偏离**：计划 Step 1 的
 * Files 行写着「`claims` 字段的 zod；**闭集外一律 400**」，而同一份计划的 A-6
 * 集成用例写的是「闭集外的 kind ⇒ **422**」。两者只能取一个，取 422（§6.3 的
 * 单一来源纪律 + 集成用例的字面期望）。
 */

/** 闭集。**顺序即规格 §6.1 表格的顺序**（`dto.test.ts` 的往返用例按它比对）。 */
export const CLAIM_KINDS = [
  'paths_exist',
  'entry_file_exists',
  'dependency_manifest_parses',
  'min_code_lines',
  'declared_stack',
] as const;

export type ClaimKind = (typeof CLAIM_KINDS)[number];

/**
 * 一条**已经规范化过**的声明。
 *
 * 断言一句「五个 kind」，而不是「一个 kind + 一堆可选字段」：后者会让
 * `{ kind: 'min_code_lines', paths: [...] }` 在类型层合法，而它的语义没有定义。
 */
export type Claim =
  | { readonly kind: 'paths_exist'; readonly paths: readonly string[] }
  | { readonly kind: 'entry_file_exists'; readonly path: string }
  | { readonly kind: 'dependency_manifest_parses'; readonly ecosystem: string }
  | { readonly kind: 'min_code_lines'; readonly min: number }
  | { readonly kind: 'declared_stack'; readonly languages: readonly string[] };

/**
 * 列表类声明的条目上限。
 *
 * ## 为什么是这个数（不是从别处抄来的）
 * 它是**便宜的前置筛**，而 `asset_metadata.file_tree` 本身有上限（500 条 / 深度 8）：
 * 一条列出上千个路径的声明**永远不可能被核对完**，因此它在声明侧就已经不合格。
 * 取 200 而不是 500 的理由是声明是**作者手写**的（不是解析产物）：一份 500 项的声明
 * 不是「保守的承诺」，而是一次 DoS 的载体。**复访触发条件**：真出现一份合法的、
 * 超过 200 项的声明时，把这个数调到 `file_tree` 的上限，并把理由改成「判据的上限即声明的上限」。
 */
export const MAX_CLAIM_ITEMS = 200;

/**
 * 单条字符串（路径 / 生态 / 语言名）的上限。
 *
 * 取自 `ledger/dto.ts` 的 `idempotencyKey.max(200)` 同一量级：它是一条**长度**界，
 * 不是格式界——路径的合法性由归档解析器管，这里只管「别让一个字段无界」。
 */
export const MAX_CLAIM_TEXT = 200;

/** 出错的声明在哪一条上（消息里点名，排障不必靠猜）。 */
function fail(index: number, detail: string): never {
  throw new InvalidClaimsError(`第 ${String(index + 1)} 条声明不合法：${detail}`);
}

/** 一个有界的非空字符串。 */
function requireText(value: unknown, index: number, field: string): string {
  if (typeof value !== 'string') fail(index, `${field} 必须是字符串`);
  const text = value.trim();
  if (text === '') fail(index, `${field} 不能为空`);
  if (text.length > MAX_CLAIM_TEXT) fail(index, `${field} 超过 ${String(MAX_CLAIM_TEXT)} 个字符`);
  // 原文（未 trim）与 trim 后的值都必须有界：`' ' * 5000` 的 trim 结果是空串，
  // 但它在被 trim 之前已经是一个超长取值了。
  if (value.length > MAX_CLAIM_TEXT) fail(index, `${field} 超过 ${String(MAX_CLAIM_TEXT)} 个字符`);
  return text;
}

/** 一个有界、非空、**无重复**的字符串列表。 */
function requireTextList(value: unknown, index: number, field: string): readonly string[] {
  if (!Array.isArray(value)) fail(index, `${field} 必须是数组`);
  // 空数组是**恒真**的核对（「这些路径都存在」在空集上无条件成立），
  // 而规格 §6.3 明写「一条恒真的核对什么都没证明」。
  if (value.length === 0) fail(index, `${field} 不能是空数组（空集声明是一条恒真的核对）`);
  if (value.length > MAX_CLAIM_ITEMS) fail(index, `${field} 超过 ${String(MAX_CLAIM_ITEMS)} 项`);
  const items = value.map((item) => requireText(item, index, field));
  if (new Set(items).size !== items.length) fail(index, `${field} 里有重复项`);
  return items;
}

/** 闭集内的 `kind` 各自认识的键（**多余键一律被拒**：一个陌生的键进了 JSONB 就说不清它是什么）。 */
const KEYS_OF: Readonly<Record<ClaimKind, readonly string[]>> = Object.freeze({
  paths_exist: ['kind', 'paths'],
  entry_file_exists: ['kind', 'path'],
  dependency_manifest_parses: ['kind', 'ecosystem'],
  min_code_lines: ['kind', 'min'],
  declared_stack: ['kind', 'languages'],
});

function isClaimKind(value: unknown): value is ClaimKind {
  return typeof value === 'string' && (CLAIM_KINDS as readonly string[]).includes(value);
}

function parseOne(raw: unknown, index: number): Claim {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(index, '每一条声明必须是一个对象');
  const item = raw as Record<string, unknown>;

  if (!('kind' in item)) fail(index, '缺少 kind');
  const kind = item.kind;
  if (!isClaimKind(kind)) {
    // 这一句就是「闭集」在运行期的执行点：`quality_is_good` 之类的取值到此为止。
    fail(index, `闭集外的 kind：${JSON.stringify(kind)}（闭集 = ${CLAIM_KINDS.join(' / ')}）`);
  }

  const allowed = KEYS_OF[kind];
  const extra = Object.keys(item).filter((key) => !allowed.includes(key));
  if (extra.length > 0) fail(index, `${kind} 上出现了闭集外的字段：${extra.join(', ')}`);

  switch (kind) {
    case 'paths_exist':
      return { kind, paths: requireTextList(item.paths, index, 'paths') };
    case 'entry_file_exists':
      return { kind, path: requireText(item.path, index, 'path') };
    case 'dependency_manifest_parses':
      return { kind, ecosystem: requireText(item.ecosystem, index, 'ecosystem') };
    case 'min_code_lines': {
      const min = item.min;
      if (typeof min !== 'number' || !Number.isSafeInteger(min) || min <= 0) {
        // `Number.isSafeInteger` 同时排掉 `NaN` / `Infinity` / `1.5`：它们会让判据那边
        // 出现一个「永远不成立」或「永远成立」的比较，而两种都是恒真/恒假的核对。
        fail(index, `min 必须是正的安全整数（收到 ${String(min)}）`);
      }
      return { kind, min };
    }
    case 'declared_stack':
      return { kind, languages: requireTextList(item.languages, index, 'languages') };
  }
}

/**
 * 解析一份声明。
 *
 * @returns `null` 表示**没有声明**（字段缺失 / `null`）；`[]` 表示**声明了一个空集**。
 *   两者是**不同的事实**，与 `swap_offers.claims` 的可空性同一条纪律（Task 5.5 的列注释：
 *   「这份要约什么都没承诺」与「它承诺了零条」不是同一件事）。
 * @throws {InvalidClaimsError} 闭集外的 `kind`、多余字段、空数组、空字符串、非正数、
 *   超长列表 / 超长字符串、重复项 —— 一律 422（`exchange-error-map.ts` 的唯一出口）。
 */
export function parseClaims(raw: unknown): readonly Claim[] | null {
  if (raw === undefined || raw === null) return null;
  // 非数组：**不能**悄悄当成「没有声明」（那会把一次调用方错误变成一次静默的降级）。
  if (!Array.isArray(raw)) throw new InvalidClaimsError('claims 必须是一个数组（或者整个字段不出现）');
  return raw.map((item, index) => parseOne(item, index));
}

/**
 * 判据要读的**事实**（规格 §6 表格的「判据读的事实」那一列）。
 *
 * ## 一处取值
 * 由 {@link claimFactsFrom} 从读回来的那一行抽取，**判据函数不自己去查库、不自己挑字段**。
 * 理由逐字来自 `eligibility.ts` 的类注释：「三个参数会在调用点散成三处取值来源」——
 * 那是同一族缺陷上一次的形态。加第六个 `kind` 时改的是**这一处**签名与所有调用点，
 * 那正是我们想要的摩擦。
 */
export interface ClaimFacts {
  /** `asset_metadata.file_tree`（`paths_exist` / `entry_file_exists` 的判据）。 */
  readonly fileTree: readonly { readonly path: string; readonly bytes: number }[];
  /** `asset_metadata.dependencies`（`dependency_manifest_parses` 的判据）。 */
  readonly dependencies: readonly { readonly ecosystem: string }[];
  /** `asset_metadata.languages`（`declared_stack` 的判据）。 */
  readonly languages: readonly { readonly name: string }[];
  /** Task 5.5 的列。**可空** ⇒ `min_code_lines` 在这种数据上**不允许被声明**。 */
  readonly codeLines: number | null;
}

/**
 * 从**读回来的那一行**抽取四个事实（**唯一**的取值处）。
 *
 * 它收的是 `AssetMetadataView`（读侧类型，`codeLines: number | null`）而不是
 * `ParsedMetadata`（写侧类型，`codeLines: number`）：声明是在**读路径**上被核对的，
 * 而读侧的那一列可能是 NULL（迁移之前的旧行）。
 */
export function claimFactsFrom(metadata: AssetMetadataView): ClaimFacts {
  return {
    fileTree: metadata.fileTree.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    dependencies: metadata.dependencies.map((entry) => ({ ecosystem: entry.ecosystem })),
    languages: metadata.languages.map((entry) => ({ name: entry.name })),
    // 原样透传（`number | null`）：旧行是 `null`，**不是** `0`。
    codeLines: metadata.codeLines,
  };
}

/**
 * **声明侧 fail-closed**：一条**核不动**的声明不允许被提出。
 *
 * ## 今天唯一的例子：`min_code_lines` 而 `codeLines` 为 `null`
 *
 * `asset_metadata.code_lines` 在**迁移之前的旧行**上是 NULL（Task 5.5 的列注释逐字：
 * 「编造一个 `0` 会让『这一列之前不存在』与『这份制品真的 0 行代码』变成同一个值」）。
 * 一条 `min_code_lines(n)` 落在这种数据上时，判据**没有事实可读**。
 *
 * ## 为什么必须在这里拒绝，而不是留到审判时才失败
 *
 * 让它在审判时才失败，等于**把一次数据缺失变成一次错误的裁决**：缺列的那一侧会
 * 被判成「违约成立」，而作者其实什么都没做错。声明的责任方是作者，数据的责任方是平台，
 * 两者不能混成一条判据。
 *
 * ## 为什么半径恰好是这一条（`claims.test.ts` 有一条用例钉住）
 *
 * 另外四条的事实来源（`file_tree` / `dependencies` / `languages`）都是**非空列**，
 * 不存在「旧行没有这个值」这一说。把 fail-closed 扩大到它们会拒掉合法声明。
 *
 * @throws {InvalidClaimsError} 有一条声明核不动。
 */
export function assertClaimsVerifiable(claims: readonly Claim[], facts: ClaimFacts): void {
  for (const [index, claim] of claims.entries()) {
    if (claim.kind === 'min_code_lines' && facts.codeLines === null) {
      throw new InvalidClaimsError(
        `第 ${String(index + 1)} 条声明核不动：min_code_lines(${String(claim.min)}) 的判据要读 ` +
          'asset_metadata.code_lines，而这一行是 NULL（迁移之前的旧行）。' +
          '缺列是平台的数据事实，不能变成一次「违约成立」的裁决。',
      );
    }
  }
}
