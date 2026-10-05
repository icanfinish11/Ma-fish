import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { fileTypeFromBuffer } from 'file-type';
import { Parser, ReadEntry } from 'tar';
import * as yauzl from 'yauzl';
import {
  ARCHIVE_LIMITS,
  checkCompressionRatio,
  checkEntry,
  checkEntryCount,
  checkEntryPath,
  checkTarLink,
  checkTotalUncompressedBytes,
  checkZipLink,
} from '@vca/api/modules/asset/archive/limits.js';
import { SNIFF_BYTES, sniffArchive } from '@vca/api/modules/asset/archive/sniff.js';
import { inspectZip } from '@vca/api/modules/asset/archive/zip-inspector.js';
import { inspectTarGz } from '@vca/api/modules/asset/archive/targz-inspector.js';
import { validateArchive } from '@vca/api/modules/asset/archive/validate-archive.js';
import { TAG_BYTES } from '@vca/api/modules/asset/crypto/artifact-format.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
// 制品（密文外壳）的构造与观察住在 Task 3 的共享夹具里：Task 4 的输入是
// `EncryptedArtifactReader`，因此这里的「样本」是**先加密成制品、再打开读取器**。
// `truncateLastBlocks` 就是 Step 0b 要防的那件事（自洽的整块截断）的构造器。
import {
  MemoryStore,
  at,
  fakeRing,
  recordRange,
  seedArtifact,
  truncateLastBlocks,
} from '../../helpers/craft-encrypted-artifact.js';
// 样本一律**代码生成**，不入库二进制（见生成器的文件头）。
import { ARCHIVE_SAMPLES, BOMB_BYTES, buildTarGz, buildZip, gzip } from '../../fixtures/archives/generate.js';

/**
 * 归档校验器（P1 / Task 4）。
 *
 * ## 它在整条链路里的位置
 *
 * 上传的字节先被**流式加密**进制品库（Task 1/2），明文从不落盘（C21）。校验时用 Task 3 的
 * `EncryptedArtifactReader` 把制品当**明文视图**随机访问，本任务在这个视图上判定
 * 「这个归档是不是恶意的」。判定必须**在读到任何条目数据之前**完成（C19）。
 *
 * ## 本文件的几组判据
 *
 * 1. **样本判定**（brief Step 5）：六个恶意样本必须拒、**两个合法样本必须接受**。
 *    后两条是最重要的反向用例——没有它们，「全部拒绝」的实现也能全绿。
 * 2. **零落盘**（C21 / Step 6）：跑完八样本后制品库目录与临时目录里**没有新增文件**。
 * 3. **C19 零字节条目数据**：zip 侧断言 `openReadStream` 从未被调用；tar.gz 侧断言
 *    中止发生在**头几个块**内（把整份制品走一遍就等于把炸弹解完）。
 * 4. **末块认证**（Step 0b）：校验必须先认证制品的末块，再下任何结论。
 *
 * ## 一个反复出现的失效形态（本文件刻意用两种方式防它）
 *
 * 「测试全绿、生产全炸」：预检实测 `file-type` 对 gzip 化的 tar 返回 `ext: 'tar.gz'` 而**不是**
 * `'gz'`，写成 `=== 'gz'` 会拒掉 **100% 的合法 tar.gz**，还让整条 tar.gz 路径**一次都不执行**
 * （两个 tar.gz 样本都在嗅探处短路，而「期望拒绝」的用例照样绿）。
 * 因此：合法样本的接受用例 + 依赖契约用例（直接断言 `file-type` 的返回值）**两条都要有**。
 */

/**
 * 8 个样本里按名字取一个（缺失即响亮，而不是 undefined 流到后面）。
 *
 * **带缓存**：`bomb.zip` / `bomb.tar.gz` 每次生成都要 deflate/gzip 100 MiB，
 * 而同一个样本会被多条用例取用。缓存的只是**最终字节**（约 100 KB），中间的大缓冲随即释放。
 */
const sampleCache = new Map<string, Buffer>();
function sampleBytes(name: string): Buffer {
  const cached = sampleCache.get(name);
  if (cached !== undefined) return cached;
  const sample = ARCHIVE_SAMPLES.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`样本表里没有 ${name}`);
  const bytes = sample.bytes();
  sampleCache.set(name, bytes);
  return bytes;
}

/**
 * 把一个**明文归档**加密成制品并打开读取器——这就是 Task 4 的真实输入形态。
 *
 * `chunkSize` 默认 4 KiB（生产是 8 MiB）：块小才能用「请求了哪些块」的外部观测来判断
 * 「有没有把整个制品走一遍」。**这不改变被测逻辑**，只改变观测分辨率。
 */
async function openPlaintext(
  plaintext: Buffer,
  opts: { chunkSize?: number } = {},
): Promise<{ store: MemoryStore; key: string; reader: EncryptedArtifactReader }> {
  const store = new MemoryStore();
  const { key } = await seedArtifact(store, plaintext, { chunkSize: opts.chunkSize ?? 4096 });
  const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
  // `open()` 自己会读头 / 索引 / 尾部；把它清掉，后面的观测就只属于「校验阶段」。
  store.reset();
  return { store, key, reader };
}

/** 把一段流收成 Buffer。 */
async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** 用 tar 解一份 tar.gz（**只**在自检里解；生产代码绝不读条目内容）。 */
async function tarEntriesOf(archive: Buffer): Promise<Array<{ path: string; body: string }>> {
  const parser = new Parser();
  const found: Array<{ path: string; body: string }> = [];
  const bodies: Array<Promise<void>> = [];
  parser.on('entry', (entry) => {
    bodies.push(
      (async () => {
        const body = await collect(entry);
        found.push({ path: entry.path, body: body.toString('utf8') });
      })(),
    );
  });
  const done = new Promise<void>((resolve, reject) => {
    parser.on('end', () => resolve());
    parser.on('error', reject);
  });
  Readable.from([archive]).pipe(createGunzip()).pipe(parser);
  await done;
  await Promise.all(bodies);
  return found;
}

describe('样本生成器自检：生成器的正确性由**独立读取方**验，不是自称', () => {
  it('样本表就是八条（六个恶意 + 两个合法）', () => {
    expect(ARCHIVE_SAMPLES.map((sample) => sample.name)).toEqual([
      'zip-slip.zip',
      'symlink.zip',
      'bomb.zip',
      'flood.zip',
      'fake-mime.zip',
      'bomb.tar.gz',
      'ok.zip',
      'ok.tar.gz',
    ]);
    expect(ARCHIVE_SAMPLES.filter((sample) => sample.expected === 'accept')).toHaveLength(2);
  });

  it('ok.zip 是一个**真的** zip：yauzl 能打开并列出预期条目', async () => {
    const entries = await new Promise<string[]>((resolve, reject) => {
      yauzl.fromBuffer(sampleBytes('ok.zip'), { lazyEntries: true }, (error, zipfile) => {
        if (error) return reject(error);
        const names: string[] = [];
        zipfile.on('entry', (entry) => {
          names.push(entry.fileName);
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolve(names));
        zipfile.on('error', reject);
        zipfile.readEntry();
      });
    });
    expect(entries).toEqual(['README.md', 'src/index.ts']);
  });

  it('ok.tar.gz 是一个**真的** tar.gz：tar 能解出预期条目与内容', async () => {
    const entries = await tarEntriesOf(sampleBytes('ok.tar.gz'));
    expect(entries).toEqual([
      { path: 'README.md', body: '# demo\n\n一个正常的归档。\n' },
      { path: 'src/index.ts', body: 'export const answer = 42;\n'.repeat(8) },
    ]);
  });

  it('五个 zip 样本与两个 tar.gz 样本都能被 file-type 嗅出容器类型（说明样本本身是它自称的格式）', async () => {
    const expectedExt: Record<string, string> = {
      'zip-slip.zip': 'zip',
      'symlink.zip': 'zip',
      'bomb.zip': 'zip',
      'flood.zip': 'zip',
      'fake-mime.zip': 'png',
      'bomb.tar.gz': 'tar.gz',
      'ok.zip': 'zip',
      'ok.tar.gz': 'tar.gz',
    };
    for (const [name, ext] of Object.entries(expectedExt)) {
      const sniffed = await fileTypeFromBuffer(sampleBytes(name).subarray(0, SNIFF_BYTES));
      expect(sniffed?.ext, `${name} 的容器类型`).toBe(ext);
    }
  });

  it('炸弹样本本身够格触发上限：声明 100 MiB、压缩比 > 100:1', () => {
    const bombZipRatio = BOMB_BYTES / sampleBytes('bomb.zip').length;
    const bombTarGzRatio = BOMB_BYTES / sampleBytes('bomb.tar.gz').length;
    expect(bombZipRatio).toBeGreaterThan(ARCHIVE_LIMITS.maxCompressionRatio);
    expect(bombTarGzRatio).toBeGreaterThan(ARCHIVE_LIMITS.maxCompressionRatio);
  });
});

describe('D7 类型嗅探：判定条件必须是 ext === "tar.gz" || mime === "application/gzip"', () => {
  it('依赖契约：file-type 对 gzip 化的 tar 返回 tar.gz / application/gzip，**不是** gz', async () => {
    const sniffed = await fileTypeFromBuffer(sampleBytes('ok.tar.gz').subarray(0, SNIFF_BYTES));
    expect(sniffed?.ext).toBe('tar.gz');
    expect(sniffed?.mime).toBe('application/gzip');
    // 这一条是整个任务里最贵的坑：写成 `=== 'gz'` 会拒掉 100% 的合法 tar.gz，
    // 而且会让 tar.gz 那条代码路径**一次都不执行**。
    expect(sniffed?.ext).not.toBe('gz');
  });

  it('合法 tar.gz 被识别为 tar.gz（正向用例：没有它，整条 tar.gz 路径可以从未被执行）', async () => {
    const { reader } = await openPlaintext(sampleBytes('ok.tar.gz'));
    const result = await sniffArchive(reader);
    expect(result.kind).toBe('tar.gz');
    expect(result.detected).toContain('tar.gz');
  });

  it('合法 zip 被识别为 zip', async () => {
    const { reader } = await openPlaintext(sampleBytes('ok.zip'));
    const result = await sniffArchive(reader);
    expect(result.kind).toBe('zip');
    expect(result.detected).toContain('zip');
  });

  it('PNG 字节（文件名叫 .zip）⇒ unknown，并带出 file-type 认出的类型（C11：只带类型名）', async () => {
    const { reader } = await openPlaintext(sampleBytes('fake-mime.zip'));
    const result = await sniffArchive(reader);
    expect(result.kind).toBe('unknown');
    expect(result.detected).toContain('png');
  });

  it('空制品（0 字节）⇒ unknown，且**一个字节都不读**', async () => {
    const { store, reader } = await openPlaintext(Buffer.alloc(0));
    const result = await sniffArchive(reader);
    expect(result.kind).toBe('unknown');
    expect(result.detected).toContain('空制品');
    expect(store.requests).toHaveLength(0);
  });

  it('只读前 4100 字节：200 KiB 的明文只请求前两块，不把整份制品走一遍', async () => {
    const plaintext = buildZip([{ name: 'a.txt', data: Buffer.alloc(200 * 1024, 0x41) }]);
    const { store, reader } = await openPlaintext(plaintext);
    expect(SNIFF_BYTES).toBe(4100);
    expect(await sniffArchive(reader)).toMatchObject({ kind: 'zip' });
    // 4100 字节跨两块（4 KiB 块）⇒ 两次请求，且都落在前两块里
    // （制品是 [头][块数据][索引][尾部]，所以明文偏移 = 制品偏移 - 头部长度）
    expect(store.requests).toHaveLength(2);
  });
});

describe('D6 阈值：单一来源 + 边界（恰好等于上限必须**接受**）', () => {
  it('ARCHIVE_LIMITS 就是设计文档威胁 #2 里那三个数', () => {
    expect(ARCHIVE_LIMITS).toEqual({
      maxTotalUncompressedBytes: 1024 * 1024 * 1024,
      maxEntries: 20_000,
      maxCompressionRatio: 100,
    });
  });

  it('条目数：恰好 20,000 接受，20,001 拒绝', () => {
    expect(checkEntryCount(ARCHIVE_LIMITS.maxEntries, ARCHIVE_LIMITS)).toBeNull();
    expect(checkEntryCount(ARCHIVE_LIMITS.maxEntries + 1, ARCHIVE_LIMITS)).not.toBeNull();
  });

  it('累计未压缩大小：恰好 1 GiB 接受，多 1 字节拒绝', () => {
    expect(checkTotalUncompressedBytes(ARCHIVE_LIMITS.maxTotalUncompressedBytes, ARCHIVE_LIMITS)).toBeNull();
    expect(
      checkTotalUncompressedBytes(ARCHIVE_LIMITS.maxTotalUncompressedBytes + 1, ARCHIVE_LIMITS),
    ).not.toBeNull();
  });

  it('压缩比：恰好 100:1 接受，再多 1 字节拒绝', () => {
    expect(checkCompressionRatio(1000, 10, ARCHIVE_LIMITS)).toBeNull();
    expect(checkCompressionRatio(1001, 10, ARCHIVE_LIMITS)).not.toBeNull();
  });

  it('压缩后 0 字节却声明了内容 ⇒ 拒绝（也顺带避免拿 0 当除数）', () => {
    expect(checkCompressionRatio(0, 0, ARCHIVE_LIMITS)).toBeNull();
    expect(checkCompressionRatio(1, 0, ARCHIVE_LIMITS)).not.toBeNull();
  });

  it('拒绝理由里带上实际值与上限（排查时不必再猜是哪一条）', () => {
    const reason = checkCompressionRatio(1028 * 1000, 1000, ARCHIVE_LIMITS);
    expect(reason).toContain('1028');
    expect(reason).toContain('100');
  });
});

describe('D6 路径与链接：绝对路径 / .. 段 / 反斜杠穿越 / symlink / hardlink', () => {
  it('拒绝穿越与绝对路径的各种拼写', () => {
    for (const name of [
      '../evil.txt',
      '../../../../etc/evil.txt',
      'a/../../b',
      '/etc/passwd',
      'C:/Windows/system32',
      'c:/windows',
      'a\\..\\b',
      '..\\..\\evil.txt',
      'a/b\\c',
      '',
    ]) {
      expect(checkEntryPath(name), `应拒绝 ${JSON.stringify(name)}`).not.toBeNull();
    }
  });

  it('合法路径照常放行（这一条防「路径检查一律拒绝」）', () => {
    for (const name of ['README.md', 'src/index.ts', 'a/b/c.txt', 'a/./b', '..hidden', 'a..b/c']) {
      expect(checkEntryPath(name), `应放行 ${JSON.stringify(name)}`).toBeNull();
    }
  });

  it('拒绝理由用 JSON.stringify 转义条目名（C11：不把原始字节直接写进日志）', () => {
    const reason = checkEntryPath('a\nb\\c');
    expect(reason).not.toBeNull();
    expect(reason).not.toContain('\n');
  });

  it('zip 的 symlink：外部属性高 16 位的 Unix mode 是 0o120xxx', () => {
    expect(checkZipLink((0o120777 << 16) >>> 0)).not.toBeNull();
    expect(checkZipLink((0o120777 << 16) >>> 0)).toContain('120777');
    // 普通文件（0o100644）与「没有 Unix mode」（Windows 工具写的 zip 常见 0）都要放行
    expect(checkZipLink((0o100644 << 16) >>> 0)).toBeNull();
    expect(checkZipLink(0)).toBeNull();
  });

  it('tar 的 symlink / hardlink：typeflag "2" 与 "1" 拒绝，文件与目录放行', () => {
    expect(checkTarLink('2')).not.toBeNull();
    expect(checkTarLink('1')).not.toBeNull();
    expect(checkTarLink('0')).toBeNull();
    expect(checkTarLink('5')).toBeNull();
  });

  it('checkEntry 把路径与链接合成一条判据（两个 inspector 共用同一份顺序与文案）', () => {
    expect(checkEntry({ name: 'a.txt' })).toBeNull();
    expect(checkEntry({ name: '../a.txt' })).not.toBeNull();
    expect(checkEntry({ name: 'a.txt', typeflag: '2' })).not.toBeNull();
    expect(checkEntry({ name: 'a.txt', externalFileAttributes: (0o120777 << 16) >>> 0 })).not.toBeNull();
    expect(checkEntry({ name: 'a.txt', externalFileAttributes: (0o100644 << 16) >>> 0 })).toBeNull();
  });
});

/** 用例里的拒绝理由（`ok: true` 时为空串）——不这么收窄就得每个断言里写一遍 as。 */
function reasonOf(result: { ok: true } | { ok: false; reason: string }): string {
  return result.ok ? '' : result.reason;
}

describe('zip：只读中央目录 + 解析器抛错计为拒绝（D6 的两条实现约束、C19）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 直接调 inspector（不做嗅探）：这些用例问的是「zip 这一条 inspector 的判别力」。
   * 块大小取 64 KiB——100 MiB 的炸弹只有 1600 块，索引不会喧宾夺主。
   */
  async function inspectZipOf(
    plaintext: Buffer,
    limits = ARCHIVE_LIMITS,
  ): Promise<{ result: { ok: true } | { ok: false; reason: string }; store: MemoryStore }> {
    const { store, reader } = await openPlaintext(plaintext, { chunkSize: 64 * 1024 });
    return { result: await inspectZip(reader, reader.plaintextLength, limits), store };
  }

  it('合法 zip 放行（反向用例）', async () => {
    const { result } = await inspectZipOf(sampleBytes('ok.zip'));
    expect(result).toEqual({ ok: true });
  });

  it('zip-slip：yauzl 在中央目录阶段抛错 ⇒ **返回拒绝**，不是异常、不是崩溃', async () => {
    const { result } = await inspectZipOf(sampleBytes('zip-slip.zip'));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('invalid relative path');
  });

  it('symlink：由**我们自己的**外部属性检查拒掉（yauzl 自带的 zip-slip 防护不覆盖它）', async () => {
    const { result } = await inspectZipOf(sampleBytes('symlink.zip'));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('符号链接');
    expect(reasonOf(result)).toContain('120777');
  });

  it('炸弹：仅凭中央目录就拒（压缩比），且**一个条目数据字节都没解压**', async () => {
    const openReadStream = vi.spyOn(yauzl.ZipFile.prototype, 'openReadStream');
    const { result } = await inspectZipOf(sampleBytes('bomb.zip'));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('压缩比');
    expect(openReadStream).not.toHaveBeenCalled();
  });

  it('flood：第 20,001 条触发条目数上限（并且不会把调用栈打爆）', async () => {
    const { result } = await inspectZipOf(sampleBytes('flood.zip'));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('条目数');
    expect(reasonOf(result)).toContain('20001');
  });

  it('C19 验收：所有**真的 zip** 样本走完，`openReadStream` **一次都没被调用**', async () => {
    const openReadStream = vi.spyOn(yauzl.ZipFile.prototype, 'openReadStream');
    // `fake-mime.zip` 的内容是 PNG（名字里带 .zip 而已），它根本走不到 zip 解析器，
    // 因此在「zip 解析器不解压数据」这条断言里不属于样本集。
    const zipSamples = ARCHIVE_SAMPLES.filter(
      (sample) => sample.name.endsWith('.zip') && sample.name !== 'fake-mime.zip',
    );
    expect(zipSamples).toHaveLength(5);
    for (const sample of zipSamples) {
      await inspectZipOf(sample.bytes());
    }
    expect(openReadStream).not.toHaveBeenCalled();
  });

  it('累计未压缩大小：中心目录自称 1.1 GiB ⇒ 用**真实阈值**拒绝（而压缩比那条并不超限）', async () => {
    const zip = buildZip([
      {
        name: 'huge.bin',
        data: Buffer.from('tiny'),
        method: 8,
        declaredUncompressedSize: 1_100_000_000,
        declaredCompressedSize: 12_000_000,
      },
    ]);
    const { result } = await inspectZipOf(zip);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('累计未压缩大小');
    // 判别力必须落在大小的那一条上：这条样本的压缩比是 91.7:1，远低于 100:1 的上限
    expect(1_100_000_000 / 12_000_000).toBeLessThan(ARCHIVE_LIMITS.maxCompressionRatio);
  });

  it('条目数边界（注入小上限）：恰好上限放行，多一条拒绝', async () => {
    const three = buildZip([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect((await inspectZipOf(three, { ...ARCHIVE_LIMITS, maxEntries: 3 })).result).toEqual({ ok: true });
    expect((await inspectZipOf(three, { ...ARCHIVE_LIMITS, maxEntries: 2 })).result.ok).toBe(false);
  });

  it('累计大小边界（注入小上限）：恰好上限放行，多 1 字节拒绝', async () => {
    const zip = buildZip([{ name: 'a', data: Buffer.alloc(100) }]);
    expect((await inspectZipOf(zip, { ...ARCHIVE_LIMITS, maxTotalUncompressedBytes: 100 })).result).toEqual({
      ok: true,
    });
    expect((await inspectZipOf(zip, { ...ARCHIVE_LIMITS, maxTotalUncompressedBytes: 99 })).result.ok).toBe(false);
  });

  it('压缩比边界（真实阈值）：恰好 100:1 放行，多 1 字节拒绝', async () => {
    const atLimit = buildZip([
      { name: 'a', method: 8, declaredUncompressedSize: 1000, declaredCompressedSize: 10 },
    ]);
    const overLimit = buildZip([
      { name: 'a', method: 8, declaredUncompressedSize: 1001, declaredCompressedSize: 10 },
    ]);
    expect((await inspectZipOf(atLimit)).result).toEqual({ ok: true });
    const over = (await inspectZipOf(overLimit)).result;
    expect(over.ok).toBe(false);
    expect(reasonOf(over)).toContain('压缩比');
  });

  it('反斜杠条目名：解析器**拒绝**而不是悄悄规范化（默认 strictFileNames 会改成 `a/b`）', async () => {
    const zip = buildZip([{ name: 'dir\\file.txt', data: Buffer.from('x') }]);
    const { result } = await inspectZipOf(zip);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('invalid characters');
  });

  it('解析器吐回的条目名会被转义：拒绝理由里不出现裸控制字符', async () => {
    // 反斜杠会让 yauzl 抛 `invalid characters in fileName: <名字>`。
    // 名字里塞换行需要一个前提：必须置「文件名是 UTF-8」标志位，否则 yauzl 按 CP437
    // 解码，字节 0x0A 会变成 `◙` 而不是换行（探针实测）——那样这条用例就测了个寂寞。
    const zip = buildZip([{ name: 'a\nb\\c.txt', utf8: true, data: Buffer.from('x') }]);
    const { result } = await inspectZipOf(zip);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('invalid characters');
    expect(reasonOf(result)).toContain('\\x0a');
    expect(reasonOf(result)).not.toContain('\n');
  });
});

describe('tar.gz：仅凭头部判定 + 提前中止（D8、C19）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 直接调 inspector。默认块大小取 4 KiB（生产 8 MiB）：块小，才能用「请求了哪些块」
   * 判断中止发生在**头几个块**内，而不是「读完了整份制品」。
   */
  async function inspectTarGzOf(
    plaintext: Buffer,
    limits = ARCHIVE_LIMITS,
    chunkSize = 4096,
  ): Promise<{ result: { ok: true } | { ok: false; reason: string }; store: MemoryStore }> {
    const { store, reader } = await openPlaintext(plaintext, { chunkSize });
    return { result: await inspectTarGz(reader, reader.plaintextLength, limits), store };
  }

  it('合法 tar.gz 放行（反向用例）', async () => {
    const { result } = await inspectTarGzOf(sampleBytes('ok.tar.gz'));
    expect(result).toEqual({ ok: true });
  });

  it('炸弹：**仅凭第一个条目的头部**就拒（压缩比）', async () => {
    const { result } = await inspectTarGzOf(sampleBytes('bomb.tar.gz'));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('压缩比');
  });

  it('C19 验收：炸弹在**第一个条目头**上就被判掉，且从未消费任何条目数据', async () => {
    // 结构性判据，而不是字节数：tar 是前向流，不 `resume()` 条目解析器就不前进
    // ⇒「从未 resume」同时证明了「一个条目数据字节都没被消费」与「没有把炸弹走完」。
    // （探针实测：只停止消费而不销毁上游会死锁，因此能 settle 本身也是一条证据。）
    const resume = vi.spyOn(ReadEntry.prototype, 'resume');
    const bomb = sampleBytes('bomb.tar.gz');
    const { result, store } = await inspectTarGzOf(bomb);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('压缩比');
    expect(resume).not.toHaveBeenCalled();
    // 读到的**压缩**字节数同样是有界的：制品共 25 块，而这里只请求了头几个。
    // 注意口径——它由 Node 流的预读窗口（16 KiB）决定，**与归档大小无关**；
    // 不能拿它当「解压了多少明文」的证据（零字节压缩流里能解出几 MB）。
    expect(store.requests.length).toBeGreaterThan(0);
    expect(store.requests.length).toBeLessThanOrEqual(8);
  });

  it('提前中止 = **销毁上游**：读取器给的流在判定之后处于 destroyed 状态', async () => {
    const { reader } = await openPlaintext(sampleBytes('bomb.tar.gz'));
    const streams: Readable[] = [];
    const original = reader.createReadStream.bind(reader);
    vi.spyOn(reader, 'createReadStream').mockImplementation((options: { start: number; end: number }) => {
      const stream = original(options);
      streams.push(stream);
      return stream;
    });
    expect((await inspectTarGz(reader, reader.plaintextLength, ARCHIVE_LIMITS)).ok).toBe(false);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.destroyed).toBe(true);
    // 再放一轮事件循环：销毁产生的 'error'（ERR_STREAM_PREMATURE_CLOSE 之类）若无人接住，
    // 这里会以未处理错误的形式炸出来——那正是「一次恶意上传变成一次崩溃」的形态。
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('头部自称 1.1 GiB 而实际不含数据 ⇒ 用**真实阈值**拒（累计未压缩大小）', async () => {
    // 这就是 D8 说的「头部声明的 size 就是分帧依据」：不需要真的提供 1.1 GiB 数据，
    // 判定发生在解析器的第一个 entry 事件里，比它去读那块数据早得多。
    const archive = buildTarGz([{ name: 'huge.bin', declaredSize: 1_100_000_000 }]);
    const { result } = await inspectTarGzOf(archive);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('累计未压缩大小');
  });

  it('tar 侧的路径穿越由**我们自己**拒（tar 没有 yauzl 那种自带防护）', async () => {
    const archive = buildTarGz([{ name: '../../../../etc/evil.txt', data: Buffer.from('pwned') }]);
    const { result } = await inspectTarGzOf(archive);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('.. 段');
  });

  it('tar 的符号链接与硬链接（typeflag 2 / 1）被拒', async () => {
    const symlink = buildTarGz([{ name: 'escape', typeflag: '2', linkName: '../../etc/passwd' }]);
    const symlinkResult = await inspectTarGzOf(symlink);
    expect(reasonOf(symlinkResult.result)).toContain('符号链接');

    const hardlink = buildTarGz([{ name: 'hard', typeflag: '1', linkName: 'a.txt' }]);
    const hardlinkResult = await inspectTarGzOf(hardlink);
    expect(reasonOf(hardlinkResult.result)).toContain('硬链接');
  });

  it('20,001 个条目的 tar.gz ⇒ 条目数上限（真实阈值）', async () => {
    const archive = buildTarGz(
      Array.from({ length: 20_001 }, (_unused, index) => ({ name: `f${index}.txt` })),
    );
    const { result } = await inspectTarGzOf(archive);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('条目数');
  });

  it('空 tar.gz（0 个条目）**拒绝**：tar 的「没有任何有效条目」与「不是 tar」是同一条信号', async () => {
    // 这是刻意 fail-closed 的一侧。理由：`tar` 的 Parser 在 DONE 时用
    // `SAW_VALID_ENTRY === false` 同时覆盖「空归档」与「压根不是 tar」，
    // 而放行前者就等于放行后者（任何 .gz 都能冒充 tar.gz）。
    const { result } = await inspectTarGzOf(buildTarGz([]));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('不合法');
    expect(reasonOf(result)).toContain('TAR_BAD_ARCHIVE');
  });

  it('损坏的 gzip（尾部 CRC 被改）⇒ 拒绝而不是崩溃：解压层的错误也是一次判定', async () => {
    const broken = Buffer.from(sampleBytes('ok.tar.gz'));
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 0xff;
    const { result } = await inspectTarGzOf(broken);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('解压失败');
  });

  it('合法 gzip 但内容不是 tar ⇒ 在**第一个块**上就被拒（不是把整条流走完才发现）', async () => {
    // 载荷取 8 MiB 伪随机字节：它**不可压缩**，所以 .gz 本身就有 8 MB。
    // 「走完整条流才发现」要请求整份制品（约 2000 个块）；「第一个块就拒」只请求预读窗口内
    // 的那几个块。两者相差两个数量级——这就是这条用例的判别力所在。
    const notATar = gzip(randomBytes(8 * 1024 * 1024));
    const { result, store } = await inspectTarGzOf(notATar);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('不合法');
    const blocks = Math.ceil(notATar.length / 4096);
    expect(blocks).toBeGreaterThan(500);
    expect(store.requests.length).toBeLessThanOrEqual(16);
  });
});

describe('validateArchive：末块认证 → 嗅探 → 分发（Step 0b 五条 + Step 4）', () => {
  it('合法 zip 与合法 tar.gz 分别返回 ok + kind', async () => {
    const zipOpened = await openPlaintext(sampleBytes('ok.zip'));
    expect(await validateArchive(zipOpened.reader)).toEqual({ ok: true, kind: 'zip' });
    const tarOpened = await openPlaintext(sampleBytes('ok.tar.gz'));
    expect(await validateArchive(tarOpened.reader)).toEqual({ ok: true, kind: 'tar.gz' });
  });

  it('PNG 字节（名字叫 .zip）⇒ kind 为 unknown 的拒绝，理由里带上认出的类型', async () => {
    const { reader } = await openPlaintext(sampleBytes('fake-mime.zip'));
    const verdict = await validateArchive(reader);
    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe('unknown');
    expect(reasonOf(verdict)).toContain('png');
  });

  it('Step 0b-4：`plaintextLength === 0` 有明确定义的行为——拒绝「空制品」，且**一个字节都不读**', async () => {
    // 几何允许 0 块制品（Task 3 的 R4），此时「认证末块」无定义：没有末块。
    // 明确的处理是先于读任何字节给出结论（空制品不可能带 magic bytes）。
    const { store, reader } = await openPlaintext(Buffer.alloc(0));
    const verdict = await validateArchive(reader);
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toContain('空制品');
    expect(store.requests).toHaveLength(0);
  });

  it('Step 0b-1（机制）：**第一个**存储请求就落在末块的记录上——1 个字节足以触发 isLast 认证', async () => {
    // 块取 64 字节 ⇒ ok.zip（319 字节）有 5 块，末块与首块相隔很远，不可能混淆。
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, sampleBytes('ok.zip'), { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());
    store.reset();
    expect(await validateArchive(reader)).toEqual({ ok: true, kind: 'zip' });
    const lastEntry = at(seeded.entries, seeded.entries.length - 1);
    // 逐字断言：**第一次**读就是末块那条记录（密文 + 16 字节 tag）的闭区间。
    const first = store.requests[0];
    expect(first).toEqual({ key: seeded.key, ...recordRange(lastEntry) });
    // 而且那一次只取回**一条记录**的字节（读 1 个明文字节就够；不是把末块端出来做别的判断）
    expect((first?.endInclusive ?? 0) - (first?.start ?? 0) + 1).toBe(lastEntry.ciphertextLength + TAG_BYTES);
  });

  it('Step 0b-2（端到端）：自洽的整块截断制品 ⇒ 拒绝、不返回任何元数据，且**在读到别处之前就停**', async () => {
    // 构造：合法 zip 后面接 32 KiB 零字节填充，然后删掉末尾整块（连同索引记录、把尾部改小）
    // ——这是**完全自洽**的截断，读取端 open() 的三条完整性校验全部满足。
    //
    // 一处据实记载（本用例的判别力到底在哪）：这份制品若**不**先认证末块，仍然会被拒——
    // 嗅探读的是前 4100 字节（放行 zip），而 zip 校验要读明文**尾部**的 EOCD，
    // 那正好落在被删块之后留下的那一块上 ⇒ 报「第 4 块认证失败」。
    // 也就是说，判别力**不在**「拒还是放」上，而在**结论的形状**与**停在哪里**上：
    // 先认证末块 ⇒ kind 是 unknown、理由指向末块、且只读了 1 次；
    // 不认证 ⇒ kind 变成 zip、理由指向「第 4 块」、并且白读了嗅探与解析的若干次。
    const padded = Buffer.concat([sampleBytes('ok.zip'), Buffer.alloc(32 * 1024)]);
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, padded, { chunkSize: 4096 });
    const key = store.seed(truncateLastBlocks(seeded.artifact, 4));
    const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
    store.reset();

    const verdict = await validateArchive(reader);
    expect(verdict.ok).toBe(false);
    // ① 结论里**没有元数据**：连类型都不给（没走到嗅探，就不该声称知道类型）
    expect(Object.keys(verdict).sort()).toEqual(['kind', 'ok', 'reason']);
    expect(verdict.kind).toBe('unknown');
    // ② 理由指向**末块认证**，而不是走到 zip 解析之后才撞上的「第 N 块认证失败」
    expect(reasonOf(verdict)).toContain('末块认证失败');
    // ③ 只读了 1 次：认证末块那一次。后面两层压根没开始读
    expect(store.requests).toHaveLength(1);
  });

  it('Step 0b-3（口径）：totalSize 取自读取器自称的 `plaintextLength`，不是对象的字节长度', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, sampleBytes('ok.zip'), { chunkSize: 64 });
    const reader = await EncryptedArtifactReader.open(store, seeded.key, fakeRing());
    store.reset();
    const objectBytes = (await store.stat(seeded.key)).bytes;
    // 两个数**确实不同**（密文外壳有头 + tag + 索引 + 尾部），因此「拿错一个」会立刻显现：
    // 用对象长度当 totalSize 时 yauzl 找不到 EOCD，合法 zip 会被误拒。
    expect(reader.plaintextLength).toBe(sampleBytes('ok.zip').length);
    expect(reader.plaintextLength).toBeLessThan(objectBytes);
    expect(await validateArchive(reader)).toEqual({ ok: true, kind: 'zip' });
  });

  it('Step 0b-5：带外长度与制品自称不符 ⇒ 拒绝（唯一非自称的长度载体）', async () => {
    const { reader } = await openPlaintext(sampleBytes('ok.zip'));
    const verdict = await validateArchive(reader, {
      expectedPlaintextLength: reader.plaintextLength + 1,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe('unknown');
    expect(reasonOf(verdict)).toContain('带外');
  });

  it('Step 0b-5：带外长度相符 ⇒ 照常放行（这条防「带外一律拒绝」的实现）', async () => {
    const { reader } = await openPlaintext(sampleBytes('ok.zip'));
    expect(await validateArchive(reader, { expectedPlaintextLength: reader.plaintextLength })).toEqual({
      ok: true,
      kind: 'zip',
    });
  });

  it('带外长度在**读任何字节之前**就被核对（不符时零读取）', async () => {
    const { store, reader } = await openPlaintext(sampleBytes('ok.zip'));
    await validateArchive(reader, { expectedPlaintextLength: 1 });
    expect(store.requests).toHaveLength(0);
  });
});
