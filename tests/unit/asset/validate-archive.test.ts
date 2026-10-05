import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { fileTypeFromBuffer } from 'file-type';
import { Parser } from 'tar';
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
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
// 制品（密文外壳）的构造与观察住在 Task 3 的共享夹具里：Task 4 的输入是
// `EncryptedArtifactReader`，因此这里的「样本」是**先加密成制品、再打开读取器**。
import { MemoryStore, fakeRing, seedArtifact } from '../../helpers/craft-encrypted-artifact.js';
// 样本一律**代码生成**，不入库二进制（见生成器的文件头）。
import { ARCHIVE_SAMPLES, BOMB_BYTES, buildZip } from '../../fixtures/archives/generate.js';

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

/** 8 个样本里按名字取一个（缺失即响亮，而不是 undefined 流到后面）。 */
function sampleBytes(name: string): Buffer {
  const sample = ARCHIVE_SAMPLES.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`样本表里没有 ${name}`);
  return sample.bytes();
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
