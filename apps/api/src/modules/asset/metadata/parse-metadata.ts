import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { Parser, type ReadEntry } from 'tar';
import { fromRandomAccessReader, type Entry, type RandomAccessReader, type ZipFile } from 'yauzl';
import { checkTarLink, checkZipLink } from '../archive/limits.js';
import type { EncryptedArtifactReader } from '../store/random-access-reader.js';
import {
  scoreCompleteness,
  type CompletenessFacts,
  type CompletenessWeights,
} from './completeness.js';

/**
 * 静态元数据解析（P1 / Task 6；设计 D9）。
 *
 * ## 这个模块只做读取（C2 的落点）
 *
 * 全部输入都来自**已经通过 `validateArchive` 的**制品明文视图，取法只有三种：
 * 读中央目录 / 读 tar 头部、读**限长**的条目内容、按扩展名与名字做纯字符串判断。
 * 这里**没有**任何执行面：不 eval、不 require 条目、不跑 `npm install`、
 * 不跟随链接、不解析需要执行的格式（`.pyc` / 二进制一律只看扩展名）。
 * 「不跟随链接」不只是「不去打开它」：**链接条目在 walker 里就被排除**（与目录条目同等对待），
 * 判据与 Task 4 的校验共用 `limits.ts` 里那一份实现——否则本模块的输出会隐式依赖
 * 「Task 4 的守卫还在不在」（见 `scanZip` 的 `checkZipLink` 调用点）。
 * 「不执行」由 `tests/unit/asset/parse-metadata.test.ts` 的 Step 1 用**副作用探针**证明
 * （哨兵文件 + `node_modules` + 两条子进程打点），而不是靠这句话。
 *
 * ## 读法：zip 随机访问，tar.gz 顺序流（一处据实记载）
 *
 * zip 的中央目录在末尾，条目内容按需解压 ⇒ 只有真正要读的那几个文件所在块会被解密
 * （读取器的「最近一块」memo 让同一块的多次读只解一次；实测见报告 §「只读需要的块」）。
 * **tar.gz 没有中央目录**：条目之间就是数据，要枚举条目就必须把整条流解压一遍。
 * 因此 tar.gz 这一侧的「按需」只体现在**内存**上（只留限长的内容），
 * 不体现在「解压了多少」上——这一条写在这里，免得被读成「两种容器一样省」。
 *
 * ## 出错就抛（不伪造一份「看起来正常」的元数据）
 *
 * 归档的结构问题在 Task 4 已经判过；这里再遇到的失败只有一类：**读不出来**
 * （条目数据损坏、制品在静止状态下被改动）。这时抛错由调用方按「制品读不回来」处置
 * ——与 Task 5 对 `validateArchive` 抛错的处理同一条理由：把「不知道」写成
 * 「没有 README / 没有依赖」，会让一份不完整的资料看起来像一份完整的资料。
 *
 * ## 与 brief 的一处分歧（据实记载）
 *
 * brief 的契约写 `parseMetadata(reader: RandomAccessReader, kind)`。本仓库里那个名字有
 * **两个**所指（yauzl 的抽象类 / `random-access-reader.ts` 的 `EncryptedArtifactReader`），
 * 这里取**具体类**——tar.gz 侧需要 `plaintextLength` 作为流的上界，而那个属性只有它提供。
 * 与 Task 4 §4.1 对 `validateArchive` 的同一取舍。
 */

/** 元数据解析的结果（brief 的契约 + 一个截断标记，见下）。 */
export interface ParsedMetadata {
  /** README 的截断摘录；没有 README 时为 `null`。vendored 目录（`node_modules` 等）里的
   * README **不算**（那是依赖的 README，见 `VENDORED_DIRECTORY_NAMES`）。 */
  readmeExcerpt: string | null;
  /** 文件树摘要（**只有文件**，目录条目不计）：路径 + 未压缩字节数。深度与条目数都受限。
   * 这里**含** vendored 目录里的文件（树、文件数与语言分布都按全量统计，见
   * `VENDORED_DIRECTORY_NAMES` 的范围说明）。 */
  fileTree: { path: string; bytes: number }[];
  /**
   * 语言分布：按扩展名归类、按字节降序。
   *
   * 占比的分母是**非空文件**的字节合计（= 各语言桶的字节之和）：**0 字节文件既不进分子、
   * 也不进分母**。这一条不是修辞——写成「所有文件的字节合计」会让下一个读代码的人以为
   * 分母包含空文件，而照那个口径实现会让一份只有空文件的归档算出 `0/0`。口径的唯一
   * 来源在 `MetadataScanner.addFile` 的 `bytes > 0` 那个条件上。
   */
  languages: { name: string; bytes: number; ratio: number }[];
  /** 依赖清单（纯文本解析）：`package.json` / `requirements.txt` / `go.mod`。
   * vendored 目录里的清单**不算**——否则依赖的清单会占掉那 8 个名额。 */
  dependencies: { ecosystem: string; name: string; version: string }[];
  /** 完整度评分 0–100（设计 §6.2）。 */
  completeness: number;
  /**
   * 文件树**是否被截断**（深度或条目数上限）。
   *
   * brief 的接口里没有这个字段，而 Step 3 要求「超限时截断并**标记**」——两者只能这样调和：
   * 数组本身放不下这个事实（放个哨兵条目会污染数据），因此加一个显式布尔。
   * 判据只有在**真的丢掉了文件**时才为真（恰好等于上限不算截断）。
   */
  fileTreeTruncated: boolean;
}

export interface ParseMetadataOptions {
  /**
   * 完整度评分的权重（设计 §6.2 的「权重可配置」）。
   *
   * 省略即 DEFAULT_COMPLETENESS_WEIGHTS（设计 §6.2 的默认权重）。今天没有第二个调用方传它
   * ——它在这里是为了**兑现设计那句「可配置」**，并且让用例能把七项**逐项**隔离出来
   * （只给某一项权重，其余为 0）。
   */
  readonly weights?: CompletenessWeights;
}

/**
 * 解析一份（已校验的）归档的元数据。
 *
 * @param reader 明文随机访问读取器（Task 3）。**绝不写入、绝不执行**其中的任何内容。
 * @param kind 已经过嗅探确认的归档类型（D7）。本函数不重新判定类型。
 * @param options 可选：完整度评分的权重。
 */
export async function parseMetadata(
  reader: EncryptedArtifactReader,
  kind: 'zip' | 'tar.gz',
  options: ParseMetadataOptions = {},
): Promise<ParsedMetadata> {
  const scanner = new MetadataScanner();
  if (kind === 'zip') await scanZip(reader, reader.plaintextLength, scanner);
  else await scanTarGz(reader, reader.plaintextLength, scanner);
  return scanner.result(options.weights);
}

// ── 内容读取的上限（**唯一的例外**：只有下面这几类文件会被读进内存）────────────
//
// 每一条都写清「为什么是这个数」；它们都是**模块私有**的（用例里写死了同一批字面量，
// 改这里会让用例红，而不是让判据跟着漂移）。

/**
 * README 的读取上限（字节）。
 *
 * 它必须**大于** `README_EXCERPT_CHARS` 的 UTF-8 上界才不至于把摘录饿死：
 * 2000 个汉字是 6000 字节，8192 留了约 1.36 倍余量。代价：最多 8 KiB 的内存。
 */
const README_READ_BYTES = 8 * 1024;

/** README 摘录的字符上限（设计 D9「截断到上限」）。 */
const README_EXCERPT_CHARS = 2000;

/**
 * 文件树的深度上限（路径段数）。
 *
 * 8 段的来历：本仓库最深的一条路径是 `apps/api/src/modules/asset/crypto/chunk-cipher.ts`
 * （7 段），而 `node_modules/<scope>/<pkg>/dist/esm/<…>` 动辄十几段——预览资料要看的是
 * 「这个项目长什么样」，不是把 vendored 依赖的目录树也铺出来。
 */
const MAX_TREE_DEPTH = 8;

/**
 * 文件树的条目数上限。
 *
 * 500 的来历：设计 §6.2 的「文件数在 10–5000 之间」说明正常项目可以到 5000 个文件，
 * 而预览资料里逐条列出 5000 行没有可读性；500 条足以看清结构，同时把
 * `AssetMetadata` 里的这一列限制在几十 KB 量级（**与归档大小无关**）。
 * 超限只影响这棵**树**：文件总数与语言分布仍然按全量统计（它们只是计数，不是列表）。
 */
const MAX_TREE_ENTRIES = 500;

/**
 * 扩展名 → 语言名（设计 D9「按扩展名归类」；未列出的归 `other`）。
 *
 * 这张表**刻意是有限的**：它要覆盖的是本平台用户会传的项目（Web / 脚本 / 主流系统语言），
 * 不是一份完整的语言清单。多一个扩展名只影响「分布里多一行」，少一个则落到 `other`
 * ——两侧都不会让任何控制失效，因此这里**不做**完整语言学映射。
 *
 * 同名语言合并（`ts` / `tsx` / `mts` / `cts` 都是 TypeScript），因为分布是**按语言**看占比。
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  json: 'JSON',
  md: 'Markdown',
  markdown: 'Markdown',
  css: 'CSS',
  scss: 'Sass',
  sass: 'Sass',
  less: 'Less',
  html: 'HTML',
  htm: 'HTML',
  vue: 'Vue',
  svelte: 'Svelte',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  rb: 'Ruby',
  php: 'PHP',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  swift: 'Swift',
  dart: 'Dart',
  lua: 'Lua',
  r: 'R',
  scala: 'Scala',
  ex: 'Elixir',
  exs: 'Elixir',
  hs: 'Haskell',
  clj: 'Clojure',
  jl: 'Julia',
  pl: 'Perl',
  sh: 'Shell',
  bash: 'Shell',
  sql: 'SQL',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  tf: 'Terraform',
  proto: 'Protocol Buffers',
  graphql: 'GraphQL',
  gql: 'GraphQL',
});

/** 未归类语言的桶名（设计 D9：「未知归 `other`」）。 */
const OTHER_LANGUAGE = 'other';

/**
 * 会被当作**依赖清单**读进来的文件名（精确匹配最后一段）。
 *
 * 只有这三个：设计 D9 点名了 `package.json` / `requirements.txt` / `go.mod`，
 * 「等」字没有兑现成更多格式（C16：没有第二个调用方要它们，而每加一种格式就多一份解析器）。
 */
const MANIFEST_ECOSYSTEM_BY_NAME: Readonly<Record<string, string>> = Object.freeze({
  'package.json': 'npm',
  'requirements.txt': 'pypi',
  'go.mod': 'go',
});

/**
 * 清单文件的读取上限（字节）与**个数**上限。
 *
 * 64 KiB：`package.json` 里塞进 500 个依赖也只有十几 KB，64 KiB 足够；而它同时挡住了
 * 「把一份 100 MB 的 package.json 当清单读进来」这一类。
 * 8 个：清单是**按归档顺序**读的，前面几个就是项目自己的那一份；一个 vendored
 * `node_modules` 里可能有上万个 `package.json`，没有个数上限就等于没有上限。
 * 超出的清单**一个字节都不读**（不是读完丢掉）。
 */
const MANIFEST_READ_BYTES = 64 * 1024;
const MAX_MANIFEST_FILES = 8;

/**
 * 依赖条数上限。
 *
 * 500：与文件树同量级（`MAX_TREE_ENTRIES`），一个正常项目的直接依赖远小于这个数；
 * 没有它，一份 20000 条 `requirements.txt` 会把元数据整份撑大（上限仍是 D6 的 20000 条）。
 */
const MAX_DEPENDENCIES = 500;

/**
 * 是不是 LICENSE（设计 §6.2 的第 2 项）。
 *
 * 三个写法覆盖了绝大多数仓库：`LICENSE` / `LICENSE.md` / `LICENSE.txt`、英式 `LICENCE`、
 * 以及 GNU 系仓库习惯的 `COPYING`。`NOTICE` 之类**不算**（那是声明文件，不是许可证）。
 */
const LICENSE_BASE_NAME = /^(license|licence|copying)(\..+)?$/i;

/**
 * 截图 / 录屏的扩展名（设计 §6.2 的第 6 项）。
 *
 * 判据是**扩展名**而不是内容：平台不解析图片 / 视频（C2：不碰需要解析的格式）。
 * 代价明说：一张 `icon.png` 也会让这一项成立——它是质量信号，不是安全控制。
 */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'mp4',
  'mov',
  'webm',
  'avi',
  'mkv',
]);

/**
 * 「入口 / 构建脚本」的**文件名**判据（设计 §6.2 的第 4 项）。
 *
 * 另一半判据在 `package.json` 里（`scripts` / `main` / `bin`，见 `parsePackageJson`）。
 * 这一半只看**最后一段名字**、不看深度——`src/main.ts` 与 `main.ts` 都算。
 */
const ENTRY_OR_BUILD_FILE_NAMES: ReadonlySet<string> = new Set([
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Justfile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'CMakeLists.txt',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Procfile',
  'index.html',
  'index.js',
  'index.ts',
  'index.tsx',
  'index.mjs',
  'main.js',
  'main.ts',
  'main.tsx',
  'main.py',
  'app.py',
  'manage.py',
  'main.go',
  'main.rs',
]);

/**
 * 「代码行数」不数的语言：标记 / 数据 / 样式（设计 §6.2 的第 7 项说的是**代码**）。
 *
 * 判据**不是**另立一张扩展名表（那会与 `LANGUAGE_BY_EXTENSION` 漂移），而是
 * 「先按扩展名归类，再看这个语言是不是上面这几类」；未归类（`other`）的一律不数——
 * 一个不认识的扩展名不该被算成代码。
 */
const NON_CODE_LANGUAGES: ReadonlySet<string> = new Set([
  'JSON',
  'Markdown',
  'CSS',
  'Sass',
  'Less',
  'HTML',
  'XML',
  'YAML',
  'TOML',
]);

/**
 * 代码行数扫描的两条上限（**下界**的来源，明说在这里与用例里）。
 *
 * 32 个文件 × 每个最多 64 KiB = 最多 2 MiB 的内容被读进内存。这两个数一起构成
 * 「元数据解析会读多少内容」的上界，而它**与归档大小无关**。
 * 代价：代码行数可能被**低估**（第 33 个代码文件之后的不数、单个文件 64 KiB 之后的不数），
 * 而 §6.2 的门槛是 `> 200` —— 有两条专门用例把这个方向钉成可判定的行为。
 */
const CODE_LINE_SCAN_MAX_FILES = 32;
const CODE_READ_BYTES_PER_FILE = 64 * 1024;

/**
 * 被排除的 **vendored 目录名**（修复轮 1 的裁定；这是一个**决定**，不是顺手加的过滤器）。
 *
 * ## 为什么必须排除（两条都是**错误输出**，不是效率问题）
 *
 * 1. `node_modules/<dep>/readme.md` 会赢走 README 槽位 ⇒ **依赖的 README 被当成项目自己的**
 *    呈现出来；
 * 2. 一个把 `node_modules` 打进包的项目，其自身的 `package.json` 会被挤出那 8 个清单名额
 *    ⇒ 依赖清单静默地读的是**依赖的**清单（读出来的每一条都是错的，而且看起来很正常）。
 *
 * 同一个出口还有第三个：`node_modules/<dep>/index.js`、`LICENSE`、`shot.png` 只按**名字**
 * 就能替项目拿到 §6.2 的「入口 / 构建脚本」「LICENSE」「有截图」三项分值。
 *
 * ## 判据的形状：**路径段**，而不是前缀
 *
 * vendored 目录也会出现在嵌套位置（`packages/app/node_modules/…`），只判前缀会漏掉它们。
 * 大小写不敏感：归档里的目录名可以是任意大小写，而大小写不敏感的文件系统（Windows / macOS）
 * 落盘时正是 `Node_Modules/` 这种形态。排除只影响「**选谁**」，不参与任何安全判定，
 * 因此大小写不敏感在这里没有代价。
 *
 * ## 排除的**范围**是刻意的（边界写在这里，免得被当成「整个归档都跳过」）
 *
 * 只在四处生效：`need()` 的三条选路（README / 清单 / 代码行数扫描）与 `addFile()` 里
 * **只看名字**的三项质量信号。**文件树、文件总数与语言分布仍按全量统计**——它们描述的是
 * 「这个归档里有什么」，而不是「这个项目自己有什么」；把 vendored 树算进文件总数正是它的
 * 真实代价（§6.2 的 10–5000 区间会把「把 node_modules 打进包」判成 0 分，这是**要**的行为）。
 *
 * ## 为什么只有这几个名字（C16：没有第二个调用方要更多）
 *
 * 列进来的每一个都对应一种**已知会把依赖铺进项目目录**的包管理器布局：
 * `node_modules`（npm / pnpm / yarn）、`bower_components`（同类的前端 vendored 树，布局相同）、
 * `vendor`（Go / PHP）、`venv` / `.venv` / `site-packages`（Python 虚拟环境：整份解释器
 * 加上每个依赖自己的 README）。**不**排除 `dist` / `build` / `out`：那是项目**自己的**产物，
 * 不是别人的东西。
 */
const VENDORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'venv',
  '.venv',
  'site-packages',
]);

/** 路径里有没有 vendored 目录段（任意一段命中即排除，大小写不敏感）。 */
function isVendoredPath(path: string): boolean {
  return path.split('/').some((segment) => VENDORED_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

/** 一个条目需要读内容时给出的请求（`cap` 是允许读进内存的字节数）。 */
type ContentRequest =
  /** README：第一个匹配。 */
  | { readonly kind: 'readme'; readonly cap: number }
  /** 依赖清单：`ecosystem` 由文件名决定（`need` 里算一次）。 */
  | { readonly kind: 'manifest'; readonly ecosystem: string; readonly cap: number }
  /** 代码文件：只读前 `cap` 字节用来数行数（见 `CODE_LINE_SCAN_MAX_FILES`）。 */
  | { readonly kind: 'code'; readonly cap: number };

/**
 * 一趟扫描的**唯一**累加器：两个 walker 都只经它记账。
 *
 * 这样「zip 与 tar.gz 对同一个文件给出不同结果」在结构上不可能发生——
 * 与 Task 4 把两份判据收进 `limits.ts` 是同一个理由。
 */
class MetadataScanner {
  /** 受限的文件树（只有文件；深度与条目数见 `MAX_TREE_DEPTH` / `MAX_TREE_ENTRIES`）。 */
  private readonly tree: { path: string; bytes: number }[] = [];
  /** 归档里**全部**文件条目的个数（不受深度与条目数上限影响——那两条只管列表）。 */
  private fileCount = 0;
  /** 是否**真的**丢掉了文件（恰好等于上限不算截断）。 */
  private treeTruncated = false;
  /** 语言 → 字节合计（全量累计，见 `addFile`）。 */
  private readonly languageBytes = new Map<string, number>();
  /** 已经读进来的清单个数（`MAX_MANIFEST_FILES` 的账）。 */
  private manifestFiles = 0;
  /** 收集到的依赖（去重、限长都在 `addDependencies` 里）。 */
  private readonly dependencies: { ecosystem: string; name: string; version: string }[] = [];
  private readonly dependencyKeys = new Set<string>();
  /** README 的原始字节；`null` = 到扫描结束都没遇到过 README。 */
  private readme: Buffer | null = null;
  /** 完整度事实（§6.2）：这几项都只看**条目名**，一个字节内容都不读。 */
  private hasLicense = false;
  private hasMedia = false;
  private hasConventionalEntryFile = false;
  /** 清单解析成功过几次（§6.2 的「存在且可解析」——解析不了的不算，见 `take`）。 */
  private manifestFilesParsed = 0;
  /** 清单里有没有构建 / 入口信号（`package.json` 的 scripts / main / bin）。 */
  private manifestEntryOrBuildScript = false;
  /** 代码行数扫描的账：已扫描的文件数、已计入的行数（下界，见常量注释）。 */
  private codeFilesScanned = 0;
  private codeLines = 0;

  /** 遇到一个**文件**条目（walker 已排除目录）。 */
  addFile(path: string, bytes: number): void {
    this.fileCount += 1;
    const base = baseNameOf(path);
    // 三项只按名字判定（不读内容）：LICENSE / 截图录屏 / 入口构建文件。
    // 但它们问的是「**这个项目**有没有」，因此 vendored 目录（`node_modules` 等）里的同名
    // 文件不算——否则 `node_modules/<dep>/index.js` 会替项目拿到「入口 / 构建脚本」那 15 分，
    // 依赖的 `LICENSE` / `shot.png` 同理（见 `VENDORED_DIRECTORY_NAMES`）。
    if (!isVendoredPath(path)) {
      if (LICENSE_BASE_NAME.test(base)) this.hasLicense = true;
      if (MEDIA_EXTENSIONS.has(extensionOf(base))) this.hasMedia = true;
      if (ENTRY_OR_BUILD_FILE_NAMES.has(base)) this.hasConventionalEntryFile = true;
    }
    // 语言分布按**全量**累计（不受树的两条上限影响：它是聚合量，不是列表）。
    //
    // `bytes > 0` 这一个条件同时定了两件事，而它们其实是**同一件事**：
    //   1. 0 字节文件不建桶（否则分布里多一行 0 字节的噪音）；
    //   2. 0 字节文件不进 `languageDistribution` 的**分母**（分母 = 各桶字节之和）。
    // 因此「分母是所有文件的字节合计」那句话是**错的**（修复轮 1 更正）：分母是
    // **非空文件**的字节合计。空文件对按字节的占比本来就没有贡献，所以这个更正**不改变
    // 任何数值**——它改的是下一个读代码的人据以推理的那句话。
    // 反过来说，若分母真的照字面包含空文件，一份只有空文件的归档就会算 `0/0` ⇒ `NaN`
    // （用例把这一点钉成 `languages` 是空数组，而不是一行 `NaN`）。
    if (bytes > 0) {
      const language = languageOf(path);
      this.languageBytes.set(language, (this.languageBytes.get(language) ?? 0) + bytes);
    }
    if (depthOf(path) > MAX_TREE_DEPTH || this.tree.length >= MAX_TREE_ENTRIES) {
      this.treeTruncated = true;
      return;
    }
    this.tree.push({ path, bytes });
  }

  /**
   * 这个条目的内容要不要读？返回 `null` = 一个字节都不读。
   *
   * 调用时机是**条目开始处**，且两个 walker 都是**顺序**处理的（读完上一条才处理下一条），
   * 因此这里的判断与 `take` 之间不会插进别的条目。
   */
  need(path: string, bytes: number): ContentRequest | null {
    // vendored 目录（`node_modules` 等）里的东西**一个字节都不读**：这一条同时管住
    // README / 清单 / 代码扫描三条选路，因此「依赖的 README 抢走槽位」与「项目自己的清单
    // 落在 8 个名额之外」在**结构上**不可能发生（理由与范围见 VENDORED_DIRECTORY_NAMES）。
    if (isVendoredPath(path)) return null;
    // 「第一个匹配」按**归档顺序**：先到先得，后面的 README 一律不再读。
    if (this.readme === null && isReadmePath(path)) return { kind: 'readme', cap: README_READ_BYTES };
    if (bytes > 0 && this.manifestFiles < MAX_MANIFEST_FILES) {
      const ecosystem = MANIFEST_ECOSYSTEM_BY_NAME[baseNameOf(path)];
      if (ecosystem !== undefined) return { kind: 'manifest', ecosystem, cap: MANIFEST_READ_BYTES };
    }
    // 代码行数扫描：上限一到就不再读**内容**（条目名照样早就记进树与分布里了）。
    if (bytes > 0 && this.codeFilesScanned < CODE_LINE_SCAN_MAX_FILES && isCodePath(path)) {
      return { kind: 'code', cap: CODE_READ_BYTES_PER_FILE };
    }
    return null;
  }

  /** 条目内容到手（**可能被截断到 `request.cap`**）。 */
  take(request: ContentRequest, content: Buffer): void {
    if (request.kind === 'readme') {
      this.readme = content;
      return;
    }
    if (request.kind === 'code') {
      this.codeFilesScanned += 1;
      this.codeLines += countLines(content.toString('utf8'));
      return;
    }
    this.manifestFiles += 1;
    const parsed = parseManifest(request.ecosystem, content);
    if (parsed === null) return; // 解析不了就是解析不了：不产出依赖，也不让整份解析失败
    this.manifestFilesParsed += 1;
    if (parsed.entryOrBuildScript) this.manifestEntryOrBuildScript = true;
    this.addDependencies(request.ecosystem, parsed.dependencies);
  }

  /**
   * 收集依赖：**按 `ecosystem|name` 去重，先到先得**，总数封顶 `MAX_DEPENDENCIES`。
   *
   * 去重是必须的：npm 允许同一个包同时出现在 `dependencies` 与 `devDependencies`
   * （两处版本可以不同），不去重就会在列表里出现两行同名不同版本的记录。
   * 先到先得 ⇒ `dependencies` 胜过 `devDependencies`（前者是运行期真正要装的）。
   * 封顶之后**不再收集**（不是收集完再截断）——上限的意义就是别把它收进内存。
   */
  private addDependencies(ecosystem: string, items: readonly { name: string; version: string }[]): void {
    for (const item of items) {
      if (this.dependencies.length >= MAX_DEPENDENCIES) return;
      const key = `${ecosystem}\u0000${item.name}`;
      if (this.dependencyKeys.has(key)) continue;
      this.dependencyKeys.add(key);
      this.dependencies.push({ ecosystem, name: item.name, version: item.version });
    }
  }

  /** 装配结果（`weights` 省略即设计 §6.2 的默认权重）。 */
  result(weights?: CompletenessWeights): ParsedMetadata {
    return {
      readmeExcerpt: this.readme === null ? null : excerptOf(this.readme),
      fileTree: this.tree,
      languages: this.languageDistribution(),
      dependencies: this.dependencyList(),
      completeness: scoreCompleteness(this.facts(), weights),
      fileTreeTruncated: this.treeTruncated,
    };
  }

  /** 七条完整度事实（设计 §6.2）。 */
  private facts(): CompletenessFacts {
    return {
      // 用**读到的**字符数：读取上限是 8192 字节，而门槛只有 200 字，
      // 因此在门槛附近这两个数没有区别（多字节字符下 8192 字节 ≥ 2730 个汉字）。
      readmeChars: this.readme === null ? 0 : this.readme.toString('utf8').length,
      hasLicense: this.hasLicense,
      manifestFilesParsed: this.manifestFilesParsed,
      hasEntryOrBuildScript: this.manifestEntryOrBuildScript || this.hasConventionalEntryFile,
      fileCount: this.fileCount,
      hasMedia: this.hasMedia,
      codeLines: this.codeLines,
    };
  }

  /**
   * 依赖列表：按 `(ecosystem, name)` 升序——**与清单的出现顺序无关**，因此同一份归档
   * 解析两次逐字节一致（去重是「先到先得」，排序只发生在最后）。
   */
  private dependencyList(): { ecosystem: string; name: string; version: string }[] {
    return [...this.dependencies].sort((left, right) => {
      if (left.ecosystem !== right.ecosystem) return compareNames(left.ecosystem, right.ecosystem);
      return compareNames(left.name, right.name);
    });
  }

  /**
   * 语言分布：字节降序，同字节按语言名升序（**与归档顺序无关**，因此两次解析同一份归档
   * 逐字节一致）。
   *
   * **分母 = `languageBytes` 各桶之和 = 非空文件的字节合计**（0 字节文件在 `addFile` 里
   * 就被排除，见那里的说明）。两条可判定的后果：各桶 `ratio` 之和恰好是 `1`；`entries`
   * 为空时**没有任何除法发生**（返回空数组，而不是 `NaN`）。
   */
  private languageDistribution(): { name: string; bytes: number; ratio: number }[] {
    const entries = [...this.languageBytes.entries()].map(([name, bytes]) => ({ name, bytes }));
    const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    entries.sort((left, right) => (right.bytes === left.bytes ? compareNames(left.name, right.name) : right.bytes - left.bytes));
    return entries.map((entry) => ({ ...entry, ratio: entry.bytes / total }));
  }
}

/** 语言名比较（不用 `localeCompare`：分布的顺序不该随宿主 locale 变）。 */
function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 路径 → 语言名（扩展名小写后查表；没有扩展名或点开头的文件归 `other`）。 */
function languageOf(path: string): string {
  return LANGUAGE_BY_EXTENSION[extensionOf(baseNameOf(path))] ?? OTHER_LANGUAGE;
}

/** 文件名的扩展名（小写；没有扩展名或点在开头 ⇒ 空串）。 */
function extensionOf(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** 是不是**代码**文件（用于「代码行数」那一项，见 `NON_CODE_LANGUAGES`）。 */
function isCodePath(path: string): boolean {
  const language = languageOf(path);
  return language !== OTHER_LANGUAGE && !NON_CODE_LANGUAGES.has(language);
}

/**
 * 数行数：换行符个数，末尾不是换行就再加一行（`''` 是 0 行，`'a'` 是 1 行，`'a\n'` 也是 1 行）。
 *
 * 逐字符扫描而不是 `split('\n')`：一个 64 KiB 的文件用 `split` 会额外造出上万个字符串，
 * 而这个函数会在扫描预算内被反复调用。
 */
function countLines(text: string): number {
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) lines += 1;
  return lines;
}

/** 路径的最后一段（`a/b/c.md` → `c.md`）。 */
function baseNameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/** 路径的段数（`a/b/c.md` → 3；空段不计，因此 `a//b` 与 `a/b` 同深）。 */
function depthOf(path: string): number {
  return path.split('/').filter((segment) => segment.length > 0).length;
}

/**
 * 是不是 README（设计 D9 写的是 `README*`）。
 *
 * 判据是**路径最后一段**以 `readme` 开头、大小写不敏感：`README` / `README.md` /
 * `ReadMe.txt` / `readme_zh.md` 都算，`docs/Notes.md` 不算。目录条目在 walker 里已被排除。
 */
function isReadmePath(path: string): boolean {
  return /^readme/i.test(baseNameOf(path));
}

/** README 字节 → 摘录（UTF-8 解码 + 按**字符**截断，见 `README_EXCERPT_CHARS`）。 */
function excerptOf(content: Buffer): string {
  return content.toString('utf8').slice(0, README_EXCERPT_CHARS);
}

// ── 依赖清单的**纯文本**解析（C2：只做字符串/JSON 解析，绝不执行）────────────────
//
// 三个解析器都是纯函数（字符串进、数组出），因此它们可以脱离归档单独读懂、单独测。
// 「绝不执行」在这里是**结构性**的：输入是 `Buffer` 解出来的字符串，没有任何
// require / eval / import / 动态执行的位置。

/** 一个清单解析出来的东西。`null` = **解析不了**（今天只有「package.json 不是 JSON」一种）。 */
interface ManifestFacts {
  readonly dependencies: readonly { name: string; version: string }[];
  /** 清单里有没有「入口 / 构建脚本」信号（设计 §6.2 的第 4 项，只有 npm 清单有这个字段）。 */
  readonly entryOrBuildScript: boolean;
}

/** 按 ecosystem 分发到对应的纯文本解析器。 */
function parseManifest(ecosystem: string, content: Buffer): ManifestFacts | null {
  const text = content.toString('utf8');
  if (ecosystem === 'npm') return parsePackageJson(text);
  if (ecosystem === 'pypi') return { dependencies: parseRequirements(text), entryOrBuildScript: false };
  return { dependencies: parseGoMod(text), entryOrBuildScript: false };
}

/**
 * `package.json`：只取四类依赖字段，版本**原样**保留（`^5.0.0` / `>=19` 都是原文）。
 *
 * 解析用 `JSON.parse`——**这是数据解析，不是执行**（没有 `require`、没有 `eval`）。
 * 非法 JSON（或顶层不是对象）⇒ 返回 `null`，调用方据此不产出依赖：
 * 一份坏掉的清单不该变成 0 条依赖（那与「清单里确实没有依赖」不是同一件事）。
 */
function parsePackageJson(text: string): ManifestFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const dependencies: { name: string; version: string }[] = [];
  // 顺序有意如此：`dependencies` 排在前面 ⇒ 同名依赖去重时它赢（见 `addDependencies`）。
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const group = record[field];
    if (typeof group !== 'object' || group === null || Array.isArray(group)) continue;
    for (const [name, version] of Object.entries(group as Record<string, unknown>)) {
      if (typeof version === 'string') dependencies.push({ name, version });
    }
  }
  return { dependencies, entryOrBuildScript: hasEntryOrBuildSignal(record) };
}

/**
 * `package.json` 里有没有「入口 / 构建脚本」（设计 §6.2 的第 4 项）。
 *
 * 三类信号：`scripts` 里的 `build` / `start` / `dev` / `serve` 之一非空，
 * 或 `main` 非空，或 `bin` 非空（`bin` 可以是字符串，也可以是「名字 → 路径」的对象）。
 * 只看这几项，**不执行**任何一个脚本（C2）。
 */
function hasEntryOrBuildSignal(record: Record<string, unknown>): boolean {
  const scripts = record['scripts'];
  if (typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)) {
    const table = scripts as Record<string, unknown>;
    for (const key of ['build', 'start', 'dev', 'serve']) {
      const value = table[key];
      if (typeof value === 'string' && value.trim().length > 0) return true;
    }
  }
  for (const key of ['main', 'bin']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return true;
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * `requirements.txt`：逐行文本解析（PEP 508 的**常用子集**）。
 *
 * 处理：`#` 注释、空行、`name[extras]` 的 extras、环境标记（`;` 之后的部分丢弃）、
 * 版本符原样保留。选项行（`-r` / `-e` / `--index-url`）**由正则天然排除**：正则要求第一个
 * 字符是字母或数字，因此 `-` 开头的行一律不匹配。这里**没有**再写一条 `startsWith('-')`
 * ——探针实测那两行改与不改行为完全一致，是一行证明不了的死代码（C16）。
 *
 * **这一条与下面正则的首字符类绑在一起**：`^([A-Za-z0-9]…)` 里的 `[A-Za-z0-9]` 就是
 * 「选项行被排除」的**唯一**依据。谁把它放宽（例如为了顺便收下 `-e <vcs url>` 后面的包名），
 * `-r base.txt` 与 `--index-url …` 立刻会变成「依赖」——那时必须把显式的选项行排除**加回来**，
 * 并补一条用例；不要以为删掉的那行死代码可以不管。
 * **不处理**：行继续符（末尾 `\`）、`--hash`、`-e <vcs url>` 里的包名——
 * 这几类在产物里都落到「跳过」或「版本为空」，不会让解析失败（据实记载）。
 */
function parseRequirements(text: string): { name: string; version: string }[] {
  const dependencies: { name: string; version: string }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (line.length === 0) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (match === null) continue;
    const name = match[1];
    if (name === undefined || name.length === 0) continue;
    const specifier = (match[3] ?? '').split(';')[0] ?? '';
    dependencies.push({ name, version: specifier.trim() });
  }
  return dependencies;
}

/**
 * `go.mod`：只认 `require`（块形式与单行形式）。
 *
 * `// indirect` 的条目**跳过**：它们是间接依赖，在 `go.mod` 里由这一行注释自己标出来；
 * 预览资料要的是「这个项目用了什么」，把传递闭包铺进去只会淹掉它（据实记载的一条取舍）。
 * `module` / `go` / `toolchain` / `replace` 等行一概不算依赖。
 */
function parseGoMod(text: string): { name: string; version: string }[] {
  const dependencies: { name: string; version: string }[] = [];
  let inRequireBlock = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('//')) continue;
    if (line === 'require (') {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    const body = inRequireBlock
      ? line
      : line.startsWith('require ')
        ? line.slice('require '.length).trim()
        : null;
    if (body === null || body.includes('// indirect')) continue;
    const [name, version] = body.split(/\s+/);
    if (name === undefined || name.length === 0) continue;
    dependencies.push({ name, version: version ?? '' });
  }
  return dependencies;
}

/** zip：只读中央目录 + 按需解压**限长**的条目内容。 */
function scanZip(reader: RandomAccessReader, totalSize: number, scanner: MetadataScanner): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let zipfile: ZipFile | null = null;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      zipfile?.close();
      if (error === undefined) resolve();
      else reject(error);
    };

    fromRandomAccessReader(reader, totalSize, { lazyEntries: true, strictFileNames: true }, (error, opened) => {
      if (error !== null || opened === undefined) {
        finish(error ?? new Error('yauzl 回调既没有错误也没有 ZipFile'));
        return;
      }
      zipfile = opened;
      opened.on('entry', (entry: Entry) => {
        /**
         * 目录条目（名字以 `/` 结尾）与**链接**条目都不是文件：不进文件树、不参与语言分布与
         * 文件数、也不会有任何内容被读。
         *
         * 链接这一条是**刻意加在这里**的（修复轮 1）。D6 在写入侧（Task 4 的校验）就拒链接，
         * 因此到达本函数的归档里本来不该有链接——但那样一来「本模块的输出」就依赖 Task 4 的
         * 守卫还在不在：把那条守卫删掉，一份带 `escape -> ../../etc/passwd` 的归档会在这里
         * 多出 `{ path, bytes }` 一行、把 `fileCount` 抬高一格，并把链接目标的**路径字符串**
         * 当成「代码」读进来数行数，而**没有一条用例会变红**。
         * 判据与 Task 4 **共用同一份实现**（不是在这里再抄一遍位运算）：两边对「什么是链接」
         * 只有一个定义。
         */
        if (entry.fileName.endsWith('/') || checkZipLink(entry.externalFileAttributes) !== null) {
          advance(opened);
          return;
        }
        scanner.addFile(entry.fileName, entry.uncompressedSize);
        const request = scanner.need(entry.fileName, entry.uncompressedSize);
        if (request === null) {
          advance(opened);
          return;
        }
        opened.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            finish(streamError ?? new Error(`zip 条目 ${entry.fileName} 打不开`));
            return;
          }
          void collectUpTo(stream, request.cap).then(
            (content) => {
              scanner.take(request, content);
              advance(opened);
            },
            (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
          );
        });
      });
      opened.on('end', () => finish());
      opened.on('error', (zipError: Error) => finish(zipError));
      advance(opened);
    });
  });
}

/**
 * 收一个 zip 条目流的前 `cap` 字节，**读够就销毁**（剩下的字节连解压都不必做）。
 *
 * 一处据实记载：zlib 是按块吐的（实测 16 KiB 一块），因此实际收进内存的是
 * `cap` 向上取整到下一个块边界的量——上界是 `cap + 16 KiB`，不是 `cap`。
 */
async function collectUpTo(stream: Readable, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    const done = (): void => resolve(Buffer.concat(chunks));
    stream.on('data', (chunk: Buffer) => {
      const remaining = cap - total;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      total += slice.length;
      if (total >= cap) stream.destroy();
    });
    stream.on('end', done);
    stream.on('close', done); // 提前 destroy 之后走的是这一条
    stream.on('error', reject);
  });
}

/**
 * 推进一次中央目录读取。**必须异步**：`readEntry → emit('entry') → readEntry` 在读取器的
 * `read` 回调同步时是一段真递归（Task 4 探针实测 20,001 条样本会 `RangeError`）。
 * Task 3 的读取器天然异步，这里是第二道保险——与 `zip-inspector` 同款。
 */
function advance(zipfile: ZipFile): void {
  queueMicrotask(() => zipfile.readEntry());
}

/** tar.gz：一条前向流（没有中央目录 ⇒ 枚举条目必须把整条流解压一遍）。 */
function scanTarGz(reader: RandomAccessReader, archiveBytes: number, scanner: MetadataScanner): Promise<void> {
  const source = reader.createReadStream({ start: 0, end: archiveBytes });
  const gunzip = createGunzip();
  const parser = new Parser();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      source.destroy();
      gunzip.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };

    parser.on('entry', (entry: ReadEntry) => {
      const typeKey = entry.header.typeKey;
      const isDirectory = typeKey === '5' || entry.path.endsWith('/');
      // 链接条目（符号链接 `'2'` / 硬链接 `'1'`）与目录一样不是文件：理由与 zip 那一侧的
      // 同一条判据逐字相同（判据本身也共用 `limits.ts` 里那一份）。
      const isLink = checkTarLink(typeKey) !== null;
      // 不 resume 解析器就不前进（D8 的背压形态）；目录与链接也要 drain 掉。
      if (isDirectory || isLink) {
        entry.resume();
        return;
      }
      const bytes = entry.size ?? 0;
      scanner.addFile(entry.path, bytes);
      const request = scanner.need(entry.path, bytes);
      if (request === null) {
        entry.resume();
        return;
      }
      void collectEntry(entry, request.cap).then(
        (content) => scanner.take(request, content),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
    parser.on('end', () => finish());
    parser.on('error', (error: Error) => finish(error));
    parser.on('warn', (code: string, message: string) =>
      finish(new Error(`tar.gz 解析失败（${code}）：${message}`)),
    );
    // 销毁上游会派发错误事件；没有监听就是未处理异常（与 targz-inspector 同一条）。
    gunzip.on('error', (error: Error) => finish(error));
    source.on('error', (error: Error) => finish(error));

    source.pipe(gunzip).pipe(parser);
  });
}

/**
 * 收一个 tar 条目的前 `cap` 字节。
 *
 * **不能像 zip 那样 `destroy()` 早退**：tar 是一条前向流，条目流被销毁会让解析器卡住
 * （D8 的背压形态）。因此这里收够 `cap` 之后**继续排水但不再留存**——
 * 内存有界，而解压量与归档本身同阶（这一条在文件头写着，不假装两种容器一样省）。
 */
async function collectEntry(entry: ReadEntry, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    entry.on('data', (chunk: Buffer) => {
      const remaining = cap - total;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      total += slice.length;
    });
    entry.on('end', () => resolve(Buffer.concat(chunks)));
    entry.on('error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    entry.resume();
  });
}
