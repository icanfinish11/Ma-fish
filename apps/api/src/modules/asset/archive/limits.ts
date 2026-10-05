/**
 * 归档校验的阈值与纯判据（P1 / Task 4；设计文档 D6 / 威胁 #2）。
 *
 * ## 为什么阈值与判据单独成文件
 *
 * 两个 inspector（zip 读中央目录、tar.gz 流式读头部）对**同一条**控制必须给出**同一个**判定。
 * 若各自写一份「20,000」「100」「.. 段」的判据，两边迟早漂移，而漂移的方向通常是
 * 「一条路径被放宽」——那正是威胁 #2 的形状。因此阈值只在这里出现一次，
 * 两个 inspector 调用的也是同一批函数（含同一批拒绝文案）。
 *
 * ## 判据是**纯函数**：输入是「不解压任何数据就能拿到的事实」
 *
 * - zip：中央目录里的 `fileName` / `uncompressedSize` / `compressedSize` / 外部属性；
 * - tar：头部里的 `name` / `size` / `typeflag`。
 *
 * 两者都不需要读条目内容 ⇒ C19（在解压任何条目数据之前判定）在结构上成立，
 * 而不是靠「记得别去读」。
 *
 * ## 边界一律是「恰好等于上限 ⇒ 接受」
 *
 * 设计写的是「≤ 1 GiB」「≤ 20,000」「≤ 100:1」，因此判定用 `>` 而不是 `>=`。
 * 这条有专门用例（恰好 20,000 / 恰好 1 GiB / 恰好 100:1 都必须放行）——
 * 差一位的判据在正常流量上永远看不出错，只在顶格上传时误拒。
 */

/**
 * 归档校验的三条数值上限。
 *
 * 取 `interface` 而不是 `as const` 对象字面量的类型：判据函数需要一个**可注入**的上限，
 * 否则「恰好等于上限」这类边界只能用 1 GiB / 20,001 条的真实样本去测（昂贵到不会有人写）。
 * 生产路径传入的一律是下面的 {@link ARCHIVE_LIMITS}，测试可以传小值。
 */
export interface ArchiveLimits {
  readonly maxTotalUncompressedBytes: number;
  readonly maxEntries: number;
  readonly maxCompressionRatio: number;
}

/** 设计文档威胁 #2 的三个数：**唯一来源**。 */
export const ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxTotalUncompressedBytes: 1024 * 1024 * 1024, // 1 GiB
  maxEntries: 20_000,
  maxCompressionRatio: 100, // 100:1
});

/** 校验结果：通过，或「拒绝 + 一句话理由」。理由里只出现非机密量（C11）。 */
export type InspectionResult = { ok: true } | { ok: false; reason: string };

/** 一个条目在**不解压任何数据**的前提下能拿到的全部事实。 */
export interface ArchiveEntryFacts {
  /** 条目名（zip 的 `fileName` / tar 头部的 `name`），**原样**传入，不做任何规范化。 */
  name: string;
  /** zip：中央目录的 `externalFileAttributes`（**原始 32 位**，位移在本模块里做一次）。 */
  externalFileAttributes?: number;
  /** tar：ustar `typeflag`（`'0'` 文件 / `'1'` 硬链接 / `'2'` 符号链接 / `'5'` 目录…）。 */
  typeflag?: string;
}

/** `S_IFMT`：Unix mode 里「文件类型」那几位。 */
export const S_IFMT = 0o170000;
/** `S_IFLNK`：符号链接。 */
export const S_IFLNK = 0o120000;

/**
 * 条目名的一票否决：绝对路径、`..` 段、反斜杠分隔符穿越、空字节。
 *
 * 拒绝理由里带上条目名，但**经 `JSON.stringify` 转义并截断**：名字是攻击者可控的字节，
 * 直接拼进日志会带进换行与终端转义序列（C11 的另一面：不把原始归档字节写进日志）。
 */
export function checkEntryPath(name: string): string | null {
  const quoted = JSON.stringify(name.length > 120 ? `${name.slice(0, 120)}…` : name);
  if (name.length === 0) return '条目名为空';
  if (name.includes('\0')) return `条目名含空字节：${quoted}`;
  if (name.includes('\\')) return `条目名含反斜杠（Windows 分隔符可穿越到父目录）：${quoted}`;
  if (name.startsWith('/')) return `条目名是绝对路径：${quoted}`;
  if (/^[a-zA-Z]:/.test(name)) return `条目名是 Windows 盘符绝对路径：${quoted}`;
  if (name.split('/').includes('..')) return `条目名含 .. 段（目录穿越）：${quoted}`;
  return null;
}

/**
 * zip 外部属性高 16 位里的 Unix mode。
 *
 * **位移只在这里做一次**。探针实测过它的失效形态：生成器忘了移位时，symlink 样本读出来的
 * mode 是 `0`——样本压根没带 `0o120777`，而「必须拒绝」的用例照样绿。
 */
export function unixModeOf(externalFileAttributes: number): number {
  return (externalFileAttributes >>> 16) & 0xffff;
}

/** zip 的符号链接：`externalFileAttributes` 高 16 位的文件类型位是 `0o120000`。 */
export function checkZipLink(externalFileAttributes: number): string | null {
  const mode = unixModeOf(externalFileAttributes);
  if ((mode & S_IFMT) !== S_IFLNK) return null;
  return `符号链接条目（外部属性的 Unix mode 是 0o${mode.toString(8)}）`;
}

/** tar 的符号链接 / 硬链接（typeflag `'2'` / `'1'`）。文件与目录放行。 */
export function checkTarLink(typeflag: string): string | null {
  if (typeflag === '2') return '符号链接条目（tar typeflag "2"）';
  if (typeflag === '1') return '硬链接条目（tar typeflag "1"）';
  return null;
}

/** 路径与链接：两种格式共用的**逐条目**判据（顺序与文案只有这一份）。 */
export function checkEntry(facts: ArchiveEntryFacts): string | null {
  return (
    checkEntryPath(facts.name) ??
    (facts.externalFileAttributes === undefined ? null : checkZipLink(facts.externalFileAttributes)) ??
    (facts.typeflag === undefined ? null : checkTarLink(facts.typeflag))
  );
}

/**
 * 把一段**来自解析器**的错误信息里的控制字符转义掉。
 *
 * 为什么要这一步：yauzl / tar 抛出的消息里会带上**条目名**（例如
 * `invalid characters in fileName: <名字>`），而条目名是攻击者可控字节。
 * 一个含换行的名字能把一行日志拆成两行（日志伪造），含 ESC 的名字能在终端里改显示。
 * 本模块的判据自己拼名字时用 `JSON.stringify`，但解析器的消息只能在这里收口——
 * 两个 inspector 的「解析失败」分支共用它，规则因此只有一处。
 */
export function sanitizeReason(text: string): string {
  return text.replaceAll(/[\u0000-\u001f\u007f]/g, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\x${code.toString(16).padStart(2, '0')}`;
  });
}

/** 条目数上限（恰好 `maxEntries` 放行）。 */
export function checkEntryCount(count: number, limits: ArchiveLimits = ARCHIVE_LIMITS): string | null {
  if (count <= limits.maxEntries) return null;
  return `条目数超限：${count} 个条目，上限是 ${limits.maxEntries}`;
}

/** 累计未压缩大小上限（恰好 `maxTotalUncompressedBytes` 放行）。 */
export function checkTotalUncompressedBytes(total: number, limits: ArchiveLimits = ARCHIVE_LIMITS): string | null {
  if (total <= limits.maxTotalUncompressedBytes) return null;
  return `累计未压缩大小超限：${total} 字节，上限是 ${limits.maxTotalUncompressedBytes} 字节`;
}

/**
 * 压缩比上限（恰好 `maxCompressionRatio`:1 放行）。
 *
 * 两个分母口径都要显式处理：
 * - `compressed === 0` 而声明了内容 ⇒ 比值是无穷大，直接拒（顺带避免拿 0 当除数）；
 * - 两者都是 0（空归档）⇒ 放行。
 *
 * 用乘法而不是除法比较：整数运算不会在边界上因浮点舍入把「恰好 100:1」判成超限。
 */
export function checkCompressionRatio(
  uncompressed: number,
  compressed: number,
  limits: ArchiveLimits = ARCHIVE_LIMITS,
): string | null {
  if (uncompressed === 0 && compressed === 0) return null;
  if (compressed === 0) return `压缩比超限：声明 ${uncompressed} 字节未压缩，但压缩后是 0 字节`;
  if (uncompressed <= compressed * limits.maxCompressionRatio) return null;
  return (
    `压缩比超限：${uncompressed} 字节未压缩 / ${compressed} 字节压缩 ` +
    `≈ ${Math.round(uncompressed / compressed)}:1，上限是 ${limits.maxCompressionRatio}:1`
  );
}
