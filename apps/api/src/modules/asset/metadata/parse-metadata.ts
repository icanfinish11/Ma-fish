import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { Parser, type ReadEntry } from 'tar';
import { fromRandomAccessReader, type Entry, type RandomAccessReader, type ZipFile } from 'yauzl';
import type { EncryptedArtifactReader } from '../store/random-access-reader.js';

/**
 * 静态元数据解析（P1 / Task 6；设计 D9）。
 *
 * ## 这个模块只做读取（C2 的落点）
 *
 * 全部输入都来自**已经通过 `validateArchive` 的**制品明文视图，取法只有三种：
 * 读中央目录 / 读 tar 头部、读**限长**的条目内容、按扩展名与名字做纯字符串判断。
 * 这里**没有**任何执行面：不 eval、不 require 条目、不跑 `npm install`、
 * 不跟随链接、不解析需要执行的格式（`.pyc` / 二进制一律只看扩展名）。
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
  /** README 的截断摘录；没有 README 时为 `null`。 */
  readmeExcerpt: string | null;
  /** 文件树摘要（**只有文件**，目录条目不计）：路径 + 未压缩字节数。深度与条目数都受限。 */
  fileTree: { path: string; bytes: number }[];
  /** 语言分布：按扩展名归类、按字节降序；占比的分母是**所有文件**的字节合计。 */
  languages: { name: string; bytes: number; ratio: number }[];
  /** 依赖清单（纯文本解析）：`package.json` / `requirements.txt` / `go.mod`。 */
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

/**
 * 解析一份（已校验的）归档的元数据。
 *
 * @param reader 明文随机访问读取器（Task 3）。**绝不写入、绝不执行**其中的任何内容。
 * @param kind 已经过嗅探确认的归档类型（D7）。本函数不重新判定类型。
 */
export async function parseMetadata(
  reader: EncryptedArtifactReader,
  kind: 'zip' | 'tar.gz',
): Promise<ParsedMetadata> {
  const scanner = new MetadataScanner();
  if (kind === 'zip') await scanZip(reader, reader.plaintextLength, scanner);
  else await scanTarGz(reader, reader.plaintextLength, scanner);
  return scanner.result();
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

/** 一个条目需要读内容时给出的请求（`cap` 是允许读进内存的字节数）。 */
type ContentRequest =
  /** README：第一个匹配。 */
  | { readonly kind: 'readme'; readonly cap: number }
  /** 依赖清单：`ecosystem` 由文件名决定（`need` 里算一次）。 */
  | { readonly kind: 'manifest'; readonly ecosystem: string; readonly cap: number };

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

  /** 遇到一个**文件**条目（walker 已排除目录）。 */
  addFile(path: string, bytes: number): void {
    this.fileCount += 1;
    // 语言分布按**全量**累计（不受树的两条上限影响：它是聚合量，不是列表）。
    // 0 字节文件不进分布：它对「按字节的占比」没有任何贡献，建一个 0 字节的桶只会多一行噪音。
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
    // 「第一个匹配」按**归档顺序**：先到先得，后面的 README 一律不再读。
    if (this.readme === null && isReadmePath(path)) return { kind: 'readme', cap: README_READ_BYTES };
    if (bytes > 0 && this.manifestFiles < MAX_MANIFEST_FILES) {
      const ecosystem = MANIFEST_ECOSYSTEM_BY_NAME[baseNameOf(path)];
      if (ecosystem !== undefined) return { kind: 'manifest', ecosystem, cap: MANIFEST_READ_BYTES };
    }
    return null;
  }

  /** 条目内容到手（**可能被截断到 `request.cap`**）。 */
  take(request: ContentRequest, content: Buffer): void {
    if (request.kind === 'readme') {
      this.readme = content;
      return;
    }
    this.manifestFiles += 1;
    const parsed = parseManifest(request.ecosystem, content);
    if (parsed === null) return; // 解析不了就是解析不了：不产出依赖，也不让整份解析失败
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

  /** 装配结果。 */
  result(): ParsedMetadata {
    return {
      readmeExcerpt: this.readme === null ? null : excerptOf(this.readme),
      fileTree: this.tree,
      languages: this.languageDistribution(),
      dependencies: this.dependencyList(),
      completeness: 0,
      fileTreeTruncated: this.treeTruncated,
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
   * 逐字节一致）。占比的分母是**全部文件**的字节合计。
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
  const base = baseNameOf(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return OTHER_LANGUAGE; // `Makefile`（无点）与 `.gitignore`（点在开头）都归 other
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? OTHER_LANGUAGE;
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
}

/** 按 ecosystem 分发到对应的纯文本解析器。 */
function parseManifest(ecosystem: string, content: Buffer): ManifestFacts | null {
  const text = content.toString('utf8');
  if (ecosystem === 'npm') return parsePackageJson(text);
  if (ecosystem === 'pypi') return { dependencies: parseRequirements(text) };
  return { dependencies: parseGoMod(text) };
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
  return { dependencies };
}

/**
 * `requirements.txt`：逐行文本解析（PEP 508 的**常用子集**）。
 *
 * 处理：`#` 注释、空行、以 `-` 开头的选项行（`-r` / `-e` / `--index-url`）、
 * `name[extras]` 的 extras、环境标记（`;` 之后的部分丢弃）、版本符原样保留。
 * **不处理**：行继续符（末尾 `\`）、`--hash`、`-e <vcs url>` 里的包名——
 * 这几类在产物里都落到「跳过」或「版本为空」，不会让解析失败（据实记载）。
 */
function parseRequirements(text: string): { name: string; version: string }[] {
  const dependencies: { name: string; version: string }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (line.length === 0 || line.startsWith('-')) continue;
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
        // 目录条目（名字以 `/` 结尾）不是文件：不进文件树、不参与语言分布与文件数。
        if (entry.fileName.endsWith('/')) {
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
      const isDirectory = entry.header.typeKey === '5' || entry.path.endsWith('/');
      // 不 resume 解析器就不前进（D8 的背压形态）；目录也要 drain 掉。
      if (isDirectory) {
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
