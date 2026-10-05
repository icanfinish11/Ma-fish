/**
 * 完整度评分（P1 / Task 6；设计文档 §6.2「完整度评分（默认权重，可配置）」）。
 *
 * ## 为什么单独成文件，而且只收「事实」
 *
 * 评分是**纯函数**：输入是七条已经算好的事实，输出是 0–100 的整数。它与归档格式无关，
 * 也与「怎么把内容读出来」无关——`parse-metadata.ts` 负责产生事实，这里只负责算分。
 * 这样切分的直接好处是**权重表只有一份**，而「每条权重的边界」可以脱离归档单独测
 * （§6.2 的 200 字 / 10–5000 个文件 / 200 行这三个阈值都在这里）。
 *
 * ## 七项与权重逐字来自设计文档 §6.2（合计 100）
 *
 * | 项 | 权重 |
 * |---|---|
 * | README 存在且 ≥ 200 字 | 25 |
 * | LICENSE 存在 | 10 |
 * | 依赖清单存在且可解析 | 15 |
 * | 入口 / 构建脚本存在 | 15 |
 * | 文件数在 10–5000 之间 | 10 |
 * | 有截图或录屏 | 15 |
 * | 代码行数 > 200 | 10 |
 *
 * ## 一处必须明说的语义：权重是**分值**，不是比例
 *
 * 默认权重合计恰好 100，因此默认口径下分数就是「符合质量预期的程度」。
 * 调用方可以换成任意权重（「可配置」），于是总分**可能越过 100 或变成负数**——
 * 结果因此被夹在 `[0, 100]` 并取整。夹子不是补丁：落在 0–100 之外的分值是**配置错误**，
 * 而一个越过区间的分数一旦写进库，任何按区间做的比较都会失去意义。
 */

/**
 * 评分的输入：七条**已经从归档里算出来**的事实。
 *
 * 每条都是「计数或布尔」，没有一处是原始文件内容——这也是评分能做成纯函数的前提。
 */
export interface CompletenessFacts {
  /** README 的字符数（读不到 README 时是 0）。 */
  readonly readmeChars: number;
  /** 是否存在 LICENSE（`LICENSE` / `LICENSE.txt` / `COPYING` 之类）。 */
  readonly hasLicense: boolean;
  /** **解析成功**的依赖清单个数（文件存在但解析不了的不算）。 */
  readonly manifestFilesParsed: number;
  /** 是否存在入口 / 构建脚本（清单里的 `scripts`/`main`/`bin`，或约定俗成的构建文件名）。 */
  readonly hasEntryOrBuildScript: boolean;
  /** 归档里的文件总数（不限深度，目录条目不算）。 */
  readonly fileCount: number;
  /** 是否存在截图或录屏（按扩展名判定）。 */
  readonly hasMedia: boolean;
  /** 代码行数合计（**下界**：扫描有上限，见 `parse-metadata.ts` 的常量）。 */
  readonly codeLines: number;
}

/**
 * 七项的权重（分值）。字段名与 {@link CompletenessFacts} 的七项一一对应——
 * 名字刻意不同（`readme` vs `readmeChars`），这样「权重」与「事实」在代码里不会写混。
 */
export interface CompletenessWeights {
  readonly readme: number;
  readonly license: number;
  readonly dependencyManifest: number;
  readonly entryOrBuildScript: number;
  readonly fileCount: number;
  readonly media: number;
  readonly codeLines: number;
}

/** 设计文档 §6.2 的默认权重（唯一来源；用例断言它的合计恰好 100）。 */
export const DEFAULT_COMPLETENESS_WEIGHTS: CompletenessWeights = Object.freeze({
  readme: 25,
  license: 10,
  dependencyManifest: 15,
  entryOrBuildScript: 15,
  fileCount: 10,
  media: 15,
  codeLines: 10,
});

/** README 的字数门槛（§6.2「≥ 200 字」）。 */
const README_MIN_CHARS = 200;
/** 文件数区间的两个端点（§6.2「在 10–5000 之间」——闭区间，两端都算）。 */
const FILE_COUNT_MIN = 10;
const FILE_COUNT_MAX = 5000;
/** 代码行数门槛（§6.2「> 200」——**严格大于**）。 */
const CODE_LINE_MIN = 200;

/**
 * 算分：命中哪几项就加哪几项的权重，最后夹到 `[0, 100]` 并取整。
 *
 * @param facts 七条事实（`parse-metadata.ts` 产出）。
 * @param weights 权重；省略即设计文档 §6.2 的默认值。
 */
export function scoreCompleteness(
  facts: CompletenessFacts,
  weights: CompletenessWeights = DEFAULT_COMPLETENESS_WEIGHTS,
): number {
  let total = 0;
  if (facts.readmeChars >= README_MIN_CHARS) total += weights.readme;
  if (facts.hasLicense) total += weights.license;
  // 「存在且可解析」：解析不了的清单**不算**——`manifestFilesParsed` 只数解析成功的。
  if (facts.manifestFilesParsed > 0) total += weights.dependencyManifest;
  if (facts.hasEntryOrBuildScript) total += weights.entryOrBuildScript;
  if (facts.fileCount >= FILE_COUNT_MIN && facts.fileCount <= FILE_COUNT_MAX) total += weights.fileCount;
  if (facts.hasMedia) total += weights.media;
  if (facts.codeLines > CODE_LINE_MIN) total += weights.codeLines;
  return Math.min(100, Math.max(0, Math.round(total)));
}
