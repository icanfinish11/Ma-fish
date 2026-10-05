import { deflateRawSync, gzipSync, crc32 } from 'node:zlib';

/**
 * 归档样本生成器（P1 / Task 4）。
 *
 * ## 为什么用代码生成，而不是入库二进制
 *
 * 恶意样本一旦以二进制入库，「它到底长什么样」就只有生成者知道；评审者要看
 * 「这个 zip 里究竟有没有 `..`」必须去解字节。生成函数把每个样本的形状写成可读的声明
 * （名字、内容、mode、声明大小），并且每次运行都重新生成 ⇒ 样本与用例永远同一份事实。
 * 顺带避免了一个 100 MiB 的炸弹进 git。
 *
 * ## 为什么手工构造 zip / tar，而不是用打包库
 *
 * 恶意样本要摆布的正是**打包库不肯产出的形状**：绝对路径、`..` 段、symlink 的 mode 位、
 * 「头部声明的 size 与实际数据不符」。zip 的中央目录与 tar 的 ustar 头都是定长且文档化的，
 * 手工写反而更短、更可控。代价是生成器本身可能写错——因此它有**独立的读取方**做自检：
 * `ok.zip` 交给 yauzl 打开、`ok.tar.gz` 交给 tar 解析、两者都交给 file-type 嗅探
 * （见 `tests/unit/asset/validate-archive.test.ts` 的「生成器自检」一节）。
 *
 * ## 三条已经踩过的坑（探针实测，见 evidence/t4-probe-*.txt）
 *
 * 1. **`unixMode` 必须移进 `externalFileAttributes` 的高 16 位**。不移位时 symlink 样本读出来的
 *    mode 是 `0`——样本根本没带 `0o120777`，而「拒绝」的用例照样绿。
 * 2. **stored（method 0）条目的 `compressedSize` 必须等于 `uncompressedSize`**，否则 yauzl 在
 *    读中央目录时就抛 `compressed/uncompressed size mismatch for stored file`：
 *    那样一来「声明超大未压缩大小」的样本会被**别的机制**拒掉，用例测的就不是聚合上限了。
 * 3. **声明大小 ≠ 实际数据时要清楚这是刻意的**：tar 的头部声明就是解析器的分帧依据
 *    （D8），因此 `declaredSize` 大于实际数据的样本只能用于「仅凭头部判定」的路径——
 *    解析器不会走到那条数据之后。生成器不阻止这种样本，但在类型上写明用途。
 */

/** 炸弹的未压缩规模：100 MiB（预检实测压缩比 ≈1029:1，远超 100:1 的上限）。 */
export const BOMB_BYTES = 100 * 1024 * 1024;

/** 全零内容（炸弹的「明文」）：deflate 后约 100 KB。 */
export function zeros(bytes: number = BOMB_BYTES): Buffer {
  return Buffer.alloc(bytes);
}

/**
 * 一个最小的真 PNG（签名 + IHDR，33 字节）。
 *
 * 用途是 `fake-mime.zip`：**内容**是 PNG、**名字**是 `.zip`。校验器按字节判定，
 * 因此它必须被当作 PNG 拒掉（D7：magic bytes 说了算，扩展名不算数）。
 */
export function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 0x0d]),
    Buffer.from('IHDR'),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]),
  ]);
}

export interface ZipEntrySpec {
  /** 中央目录里的 `fileName`（原样写入，不做任何规范化——穿越样本正是靠这一点）。 */
  name: string;
  data?: Buffer;
  /** `0` = stored（默认，小样本更好读）；`8` = deflate。 */
  method?: 0 | 8;
  /** Unix mode，默认 `0o100644`；写进外部属性的**高 16 位**（`S_IFLNK = 0o120000`）。 */
  unixMode?: number;
  /** 头部与中央目录**声明**的未压缩大小（默认 = `data.length`）。 */
  declaredUncompressedSize?: number;
  /** 头部与中央目录**声明**的压缩后大小（默认 = 实际载荷长度）。 */
  declaredCompressedSize?: number;
}

/**
 * 写一个 zip（本地头 + 中央目录 + EOCD，无 zip64、无 extra field）。
 *
 * 注释里不写「符合 ZIP 规范」这种话：它只**覆盖本任务用到的形状**，而形状的正确性由
 * 独立读取方（yauzl / file-type）的用例承担。
 */
export function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localHeaderOffset = 0;

  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(data, { level: 6 }) : data;
    const compressedSize = entry.declaredCompressedSize ?? payload.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const checksum = crc32(data);
    const externalAttributes = ((entry.unixMode ?? 0o100644) << 16) >>> 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // dos time
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    name.copy(local, 30);
    parts.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(0x031e, 4); // version made by：Unix + 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(localHeaderOffset, 42);
    name.copy(central, 46);
    centrals.push(central);

    localHeaderOffset += local.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(localHeaderOffset, 16);
  return Buffer.concat([...parts, directory, eocd]);
}

export interface TarEntrySpec {
  /** 头部 `name`（**不做**任何 `..` 过滤——穿越样本正是靠这一点）。 */
  name: string;
  data?: Buffer;
  /** 头部**声明**的 size（默认 = `data.length`）。大于实际数据时只用于「仅凭头部判定」的样本。 */
  declaredSize?: number;
  /** ustar `typeflag`：`'0'` 文件（默认）、`'1'` 硬链接、`'2'` 符号链接、`'5'` 目录。 */
  typeflag?: string;
  /** 符号链接/硬链接的 `linkname`。 */
  linkName?: string;
  mode?: number;
}

/** 一个 ustar 头（512 字节）。校验和按标准算法：先把 chksum 字段当 8 个空格求和。 */
function tarHeader(entry: TarEntrySpec, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, 'utf8');
  header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii'); // uid
  header.write('0000000\0', 116, 8, 'ascii'); // gid
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii'); // mtime
  header.write('        ', 148, 8, 'ascii'); // chksum 占位
  header.write(entry.typeflag ?? '0', 156, 1, 'ascii');
  header.write(entry.linkName ?? '', 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii'); // magic：file-type 正是靠它把 gzip 认成 tar.gz
  header.write('00', 263, 2, 'ascii'); // version
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

/** 写一份 ustar tar（结尾两个全零块）。未知 typeflag 一律按「无数据块」处理。 */
export function buildTar(entries: readonly TarEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(tarHeader(entry, entry.declaredSize ?? data.length));
    parts.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024)); // 两个全零块 = 归档结束
  return Buffer.concat(parts);
}

/** gzip 一层（默认 level 6；与预检探针同档）。 */
export function gzip(bytes: Buffer, level = 6): Buffer {
  return gzipSync(bytes, { level });
}

/** tar + gzip。 */
export function buildTarGz(entries: readonly TarEntrySpec[], level = 6): Buffer {
  return gzip(buildTar(entries), level);
}

/** 一个样本的期望判定。 */
export type SampleExpectation = 'accept' | 'reject';

export interface ArchiveSample {
  /** 样本名（`.zip` / `.tar.gz` 后缀是**给人看的**：校验器只看字节，不看扩展名）。 */
  readonly name: string;
  readonly expected: SampleExpectation;
  /** 它测的是哪一条控制——八样本表就靠这一行与设计 D6 对齐。 */
  readonly note: string;
  /** **惰性**生成：炸弹是 100 MiB，八条样本不该在收集阶段就全部展开。 */
  readonly bytes: () => Buffer;
}

/**
 * 八样本表（brief「七个必须覆盖的样本」+ 两个合法样本 = 8 条）。
 *
 * **两个合法样本是最重要的一条反向用例**：没有它们，「全部拒绝」的实现也能通过全部用例。
 * 六个恶意样本按**控制**分开，不是按「长得像」分开：路径、链接、压缩比、条目数、类型、
 * 以及「解析器抛错必须计为拒绝而不是崩溃」。
 */
export const ARCHIVE_SAMPLES: readonly ArchiveSample[] = [
  {
    name: 'zip-slip.zip',
    expected: 'reject',
    note: '目录穿越（../../../../etc/evil.txt）+ 绝对路径；yauzl 在中央目录阶段抛 invalid relative path ⇒ 抛错计为拒绝',
    bytes: () =>
      buildZip([
        { name: '../../../../etc/evil.txt', data: Buffer.from('pwned\n') },
        { name: '/etc/passwd', data: Buffer.from('pwned\n') },
      ]),
  },
  {
    name: 'symlink.zip',
    expected: 'reject',
    note: '外部属性 Unix mode 0o120777（符号链接）——yauzl 自带的 zip-slip 防护**不覆盖**这一条',
    bytes: () =>
      buildZip([
        { name: 'notes.txt', data: Buffer.from('看起来人畜无害\n') },
        { name: 'escape', unixMode: 0o120777, data: Buffer.from('../../../../etc/passwd') },
      ]),
  },
  {
    name: 'bomb.zip',
    expected: 'reject',
    note: '100 MiB 零字节，实测压缩比 ≈1029:1 ⇒ 压缩比上限；只读中央目录，未解压一个字节',
    bytes: () => buildZip([{ name: 'zero.bin', data: zeros(), method: 8 }]),
  },
  {
    name: 'flood.zip',
    expected: 'reject',
    note: '20,001 个条目 ⇒ 条目数上限（20,000）',
    bytes: () =>
      buildZip(Array.from({ length: 20_001 }, (_unused, index) => ({ name: `f${index}.txt` }))),
  },
  {
    name: 'fake-mime.zip',
    expected: 'reject',
    note: 'PNG 字节、.zip 名字 ⇒ 类型必须以 magic bytes 为准',
    bytes: () => pngBytes(),
  },
  {
    name: 'bomb.tar.gz',
    expected: 'reject',
    note: '同一个炸弹，tar 头部自称 100 MiB ⇒ 仅凭头部即中止，实测解压出 16 KiB 就停',
    bytes: () => buildTarGz([{ name: 'zero.bin', data: zeros() }]),
  },
  {
    name: 'ok.zip',
    expected: 'accept',
    note: '合法 zip（反向用例：没有它，「全部拒绝」的实现也能全绿）',
    bytes: () =>
      buildZip([
        { name: 'README.md', data: Buffer.from('# demo\n\n一个正常的归档。\n') },
        { name: 'src/index.ts', data: Buffer.from('export const answer = 42;\n'.repeat(8)), method: 8 },
      ]),
  },
  {
    name: 'ok.tar.gz',
    expected: 'accept',
    note: '合法 tar.gz（反向用例；同时钉住「file-type 对 gzip 化的 tar 返回 tar.gz 而不是 gz」）',
    bytes: () =>
      buildTarGz([
        { name: 'README.md', data: Buffer.from('# demo\n\n一个正常的归档。\n') },
        { name: 'src/index.ts', data: Buffer.from('export const answer = 42;\n'.repeat(8)) },
      ]),
  },
];
