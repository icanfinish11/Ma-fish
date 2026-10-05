import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
import { parseMetadata, type ParsedMetadata, type ParseMetadataOptions } from '@vca/api/modules/asset/metadata/parse-metadata.js';
import {
  DEFAULT_COMPLETENESS_WEIGHTS,
  scoreCompleteness,
  type CompletenessFacts,
  type CompletenessWeights,
} from '@vca/api/modules/asset/metadata/completeness.js';
import { MemoryStore, fakeRing, seedArtifact } from '../../helpers/craft-encrypted-artifact.js';
import { buildTarGz, buildZip } from '../../fixtures/archives/generate.js';

/**
 * 元数据解析（P1 / Task 6；设计 D9；约束 C2）。
 *
 * 分节按 brief 的步骤走：**Step 1 是「绝不执行」的正向证据**（判据 12），
 * 其余各节对应 README / 文件树 / 语言分布 / 依赖清单 / 完整度评分。
 *
 * 判据里的阈值一律**写成字面量**（500 / 8 / 2000 / 200 / …），不从被测模块 import：
 * 从实现 import 会让「上限被改小」时用例跟着一起变——那是判据漂移，不是判据
 * （与 Task 5 §13.1 对 `2 × CHUNK_SIZE` 的处理同一理由）。
 */

// ── 子进程计数（两条打点；覆盖面见 §Step 1 的用例注释）─────────────────────

const probes = vi.hoisted(() => ({ mocked: 0, prototype: 0 }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const wrap = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => {
    return (...args: A): R => {
      probes.mocked += 1;
      return fn(...args);
    };
  };
  return {
    ...actual,
    default: actual,
    spawn: wrap(actual.spawn),
    spawnSync: wrap(actual.spawnSync),
    exec: wrap(actual.exec),
    execSync: wrap(actual.execSync),
    execFile: wrap(actual.execFile),
    execFileSync: wrap(actual.execFileSync),
    fork: wrap(actual.fork),
  };
});

/**
 * 第二道打点：`ChildProcess.prototype.spawn`（**进程内任何模块**的异步启动都会经过它，
 * 包括不进 vite-node 变换的外部化依赖——这是 `vi.mock` 盖不到的那一侧）。
 * 同步族（`spawnSync` 等）**不经过**它，因此两条打点互补，而不是重复。
 *
 * 它**不在 `@types/node` 的公开声明里**（与 Task 3 的 `ref`/`unref` 同一种缺口），
 * 因此这里显式断言形状——探针实测过它存在且可替换（`evidence/t6-probe-spy.txt` 的 D 行）。
 */
interface PrototypeSpawnHost {
  spawn: (options: unknown) => void;
}
const prototypeSpawnHost = ChildProcess.prototype as unknown as PrototypeSpawnHost;
const originalPrototypeSpawn = prototypeSpawnHost.spawn;
prototypeSpawnHost.spawn = function countedPrototypeSpawn(this: ChildProcess, options: unknown): void {
  probes.prototype += 1;
  originalPrototypeSpawn.call(this, options);
};

afterAll(() => {
  prototypeSpawnHost.spawn = originalPrototypeSpawn;
});

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 打开一份制品（已按 Task 4 的契约「加密 → 打开读取器」），并清掉 open 阶段的读计数。 */
async function openReader(bytes: Buffer): Promise<{ store: MemoryStore; reader: EncryptedArtifactReader }> {
  const store = new MemoryStore();
  const { key } = await seedArtifact(store, bytes, { chunkSize: 64 * 1024 });
  const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
  store.reset(); // open 阶段读的是头/索引/尾部，不是「解析读了多少内容」
  return { store, reader };
}

/** 解析一份制品，返回元数据。 */
async function parseOf(
  bytes: Buffer,
  kind: 'zip' | 'tar.gz',
  options?: ParseMetadataOptions,
): Promise<ParsedMetadata> {
  const { reader } = await openReader(bytes);
  return await parseMetadata(reader, kind, options);
}

/**
 * 只给某一项 100 分、其余 0 的权重：这样解析出来的分数就是「**这一项**算出来了没有」的
 * 0/100 信号，与其余六项无关。
 *
 * 放在模块作用域（而不是某一个 `describe` 里）：Step 5b / 6b / 7 三节都要用它做隔离断言，
 * 而三份各写一遍正是判据漂移的入口。
 */
function weightsOnly(key: keyof CompletenessWeights): CompletenessWeights {
  return {
    readme: key === 'readme' ? 100 : 0,
    license: key === 'license' ? 100 : 0,
    dependencyManifest: key === 'dependencyManifest' ? 100 : 0,
    entryOrBuildScript: key === 'entryOrBuildScript' ? 100 : 0,
    fileCount: key === 'fileCount' ? 100 : 0,
    media: key === 'media' ? 100 : 0,
    codeLines: key === 'codeLines' ? 100 : 0,
  };
}

// ── Step 1：绝不执行（C2 / 判据 12）的样本 ─────────────────────────────────

/** 归档里 `package.json` 的 postinstall 命令。 */
const PAYLOAD_COMMAND = 'node evil.cjs';

/**
 * 可执行载荷的源码（**同一份字符串**同时进归档、并作为自检时故意执行的副本，
 * 因此两者逐字节相同）。
 *
 * 它做两件事，都是**从归档之外可断言**的外部副作用：写哨兵文件、造出 `node_modules`。
 */
function payloadSource(sentinelPath: string, nodeModulesPath: string): string {
  return [
    '// 一旦被任何机制执行：写哨兵 + 造出 node_modules。',
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(sentinelPath)}, 'executed');`,
    `fs.mkdirSync(${JSON.stringify(nodeModulesPath)}, { recursive: true });`,
    '',
  ].join('\n');
}

/** 第二个形状（brief 点名的 `evil.sh`）。Windows 上没有可依赖的 `sh`，因此它**只作为样本形状**存在。 */
function shellPayload(sentinelPath: string, nodeModulesPath: string): string {
  return ['#!/bin/sh', `: > ${JSON.stringify(sentinelPath)}`, `mkdir -p ${JSON.stringify(nodeModulesPath)}`, ''].join(
    '\n',
  );
}

interface ExecutableSample {
  readonly kind: 'zip' | 'tar.gz';
  readonly bytes: Buffer;
  /** 归档里 `package.json` 的内容（用于「样本真的装着陷阱」的独立断言）。 */
  readonly manifest: string;
}

interface Sandbox {
  readonly dir: string;
  readonly sentinelPath: string;
  readonly nodeModulesPath: string;
  readonly payloadPath: string;
  readonly payload: string;
  readonly shell: string;
}

function sampleEntries(sandbox: Sandbox): { packageJson: string; evilCjs: string; evilSh: string } {
  return {
    packageJson: JSON.stringify(
      {
        name: 'vca-t6-execution-probe',
        version: '1.0.0',
        scripts: { postinstall: PAYLOAD_COMMAND, build: 'sh evil.sh' },
        dependencies: { 'left-pad': '^1.3.0' },
      },
      null,
      2,
    ),
    evilCjs: payloadSource(sandbox.sentinelPath, sandbox.nodeModulesPath),
    evilSh: shellPayload(sandbox.sentinelPath, sandbox.nodeModulesPath),
  };
}

function buildSamples(sandbox: Sandbox): ExecutableSample[] {
  const { packageJson, evilCjs, evilSh } = sampleEntries(sandbox);
  const zipEntries = [
    { name: 'README.md', data: Buffer.from('# 探针项目\n') },
    { name: 'package.json', data: Buffer.from(packageJson) },
    { name: 'evil.cjs', data: Buffer.from(evilCjs) },
    { name: 'evil.sh', data: Buffer.from(evilSh) },
    { name: 'src/index.ts', data: Buffer.from('export const answer = 42;\n') },
  ];
  const tarEntries = zipEntries.map((entry) => ({ name: entry.name, data: entry.data }));
  return [
    { kind: 'zip', bytes: buildZip(zipEntries), manifest: packageJson },
    { kind: 'tar.gz', bytes: buildTarGz(tarEntries), manifest: packageJson },
  ];
}

describe('Task 6 · 元数据解析', () => {
  describe('Step 1：绝不执行归档里的脚本（C2 / 判据 12）', () => {
    let sandbox: Sandbox;
    let samples: ExecutableSample[] = [];
    /** 探针是否已自证「活着」。未武装时下面两条用例**直接失败**，而不是安静地通过。 */
    let armed = false;

    beforeAll(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vca-t6-c2-'));
      sandbox = {
        dir,
        sentinelPath: join(dir, 'sentinel-would-be-written.txt'),
        nodeModulesPath: join(dir, 'node_modules'),
        payloadPath: join(dir, 'evil.cjs'),
        payload: '',
        shell: '',
      };
      const entries = sampleEntries(sandbox);
      sandbox = { ...sandbox, payload: entries.evilCjs, shell: entries.evilSh };
      // 自检用的副本：与归档里的 `evil.cjs` **同一份字符串**。
      await writeFile(sandbox.payloadPath, entries.evilCjs);
      samples = buildSamples(sandbox);
    });

    afterAll(async () => {
      await rm(sandbox.dir, { recursive: true, force: true });
    });

    it('探针自检：样本真的装着陷阱，且两条打点与哨兵路径都是活的', async () => {
      // ---- 第一半：陷阱字节确实在归档里（不经过被测代码）----
      for (const sample of samples) {
        // tar.gz 是压缩流，按字节搜文本会落空 ⇒ 先解开再搜。
        const raw = sample.kind === 'zip' ? sample.bytes : gunzipSync(sample.bytes);
        expect(raw.includes(Buffer.from(PAYLOAD_COMMAND))).toBe(true);
        // 载荷里写的是 `JSON.stringify(路径)`（反斜杠转义过），因此按**同一种写法**搜。
        expect(raw.includes(Buffer.from(JSON.stringify(sandbox.sentinelPath)))).toBe(true);
        expect(raw.includes(Buffer.from(sandbox.payload))).toBe(true);
      }

      // ---- 第二半甲：故意执行一次载荷（同步族 ⇒ 走 vi.mock 那条打点）----
      const beforeSync = { mocked: probes.mocked, prototype: probes.prototype };
      const executed = spawnSync(process.execPath, [sandbox.payloadPath], { cwd: sandbox.dir });
      expect(executed.status).toBe(0);
      expect(existsSync(sandbox.sentinelPath)).toBe(true);
      expect(existsSync(sandbox.nodeModulesPath)).toBe(true);
      expect(probes.mocked - beforeSync.mocked).toBe(1);
      // 同步族**不经过**原型方法：这一条是「哪条打点覆盖哪一侧」的实测证据，不是冗余断言。
      expect(probes.prototype - beforeSync.prototype).toBe(0);

      // ---- 第二半乙：故意执行一次异步 spawn（走原型那条打点）----
      await rm(sandbox.sentinelPath, { force: true });
      await rm(sandbox.nodeModulesPath, { recursive: true, force: true });
      const beforeAsync = { mocked: probes.mocked, prototype: probes.prototype };
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      await once(child, 'exit');
      expect(probes.prototype - beforeAsync.prototype).toBe(1);

      // ---- 清场 + 复位：从这里开始数的是**解析期间**有没有子进程 ----
      expect(existsSync(sandbox.sentinelPath)).toBe(false);
      expect(existsSync(sandbox.nodeModulesPath)).toBe(false);
      probes.mocked = 0;
      probes.prototype = 0;
      armed = true;
    });

    for (const index of [0, 1]) {
      it(`解析含可执行脚本的样本（${index === 0 ? 'zip' : 'tar.gz'}）：解析正常返回，且哨兵 / node_modules / 子进程一个都没有`, async () => {
        // 自检的**第二半**：这条断言只有在探针被证明活着之后才有意义。
        expect(armed, '探针未武装（自检用例没跑或失败）——这条断言不能自证，直接判红').toBe(true);
        const sample = samples[index];
        expect(sample).toBeDefined();
        if (sample === undefined) return;

        probes.mocked = 0;
        probes.prototype = 0;

        const metadata = await parseOf(sample.bytes, sample.kind);

        // 解析**确实碰过**这个归档（否则「什么都没发生」是恒真的）。
        const paths = metadata.fileTree.map((file) => file.path);
        expect(paths).toEqual(expect.arrayContaining(['README.md', 'package.json', 'evil.cjs', 'evil.sh']));

        // 三条副作用断言。
        expect(existsSync(sandbox.sentinelPath)).toBe(false);
        expect(existsSync(sandbox.nodeModulesPath)).toBe(false);
        expect(probes.mocked, '解析期间有子进程被启动（vi.mock 打点）').toBe(0);
        expect(probes.prototype, '解析期间有子进程被启动（原型打点）').toBe(0);
      });
    }
  });

  describe('Step 2：README 抽取', () => {
    it('大小写不敏感，且取归档顺序里的**第一个**匹配', async () => {
      const bytes = buildZip([
        { name: 'docs/Notes.md', data: Buffer.from('不是 README\n') },
        { name: 'src/ReadMe.MD', data: Buffer.from('# 第一个匹配（大小写不同）\n') },
        { name: 'README.md', data: Buffer.from('# 后面那个不该赢\n') },
      ]);
      expect((await parseOf(bytes, 'zip')).readmeExcerpt).toBe('# 第一个匹配（大小写不同）\n');
    });

    it('截断到 2000 字符的上限（源文件 5000 字符）', async () => {
      const bytes = buildZip([{ name: 'README.md', data: Buffer.from('x'.repeat(5000)) }]);
      const excerpt = (await parseOf(bytes, 'zip')).readmeExcerpt;
      expect(excerpt).toHaveLength(2000);
      expect(excerpt).toBe('x'.repeat(2000));
    });

    it('比读取上限还大的 README（源文件 200 KiB）：摘录仍然只有 2000 字符', async () => {
      const bytes = buildZip([{ name: 'README', data: Buffer.from('y'.repeat(200 * 1024)) }]);
      const excerpt = (await parseOf(bytes, 'zip')).readmeExcerpt;
      expect(excerpt).toHaveLength(2000);
      expect(excerpt).toBe('y'.repeat(2000));
    });

    it('没有 README ⇒ null；README 是 0 字节 ⇒ 空串（两者不是同一件事）', async () => {
      const none = buildZip([{ name: 'src/index.ts', data: Buffer.from('export const x = 1;\n') }]);
      expect((await parseOf(none, 'zip')).readmeExcerpt).toBeNull();

      const empty = buildZip([{ name: 'README.md', data: Buffer.alloc(0) }]);
      expect((await parseOf(empty, 'zip')).readmeExcerpt).toBe('');
    });

    it('tar.gz 侧走同一批判据（大小写不敏感 + 截断）', async () => {
      const bytes = buildTarGz([
        { name: 'docs/OTHER.md', data: Buffer.from('不是 README\n') },
        { name: 'ReadMe.txt', data: Buffer.from('z'.repeat(3000)) },
      ]);
      const excerpt = (await parseOf(bytes, 'tar.gz')).readmeExcerpt;
      expect(excerpt).toHaveLength(2000);
      expect(excerpt).toBe('z'.repeat(2000));
    });

    it('目录条目不算 README（`readme/` 不是文件）', async () => {
      const bytes = buildZip([
        { name: 'readme/', data: Buffer.alloc(0) },
        { name: 'src/index.ts', data: Buffer.from('export const x = 1;\n') },
      ]);
      expect((await parseOf(bytes, 'zip')).readmeExcerpt).toBeNull();
    });
  });

  describe('Step 3：文件树摘要（深度与条目数都受限，超限要**标记**）', () => {
    /** 第 `segments` 段路径：`d0/d1/…/f.txt`。段数就是深度。 */
    const deepPath = (segments: number): string =>
      [...Array.from({ length: segments - 1 }, (_unused, index) => `d${index}`), 'f.txt'].join('/');

    it('深度上限 8：恰好 8 段进树，9 段不进，且标记为截断', async () => {
      const bytes = buildZip([
        { name: deepPath(8), data: Buffer.from('ok\n') },
        { name: deepPath(9), data: Buffer.from('too deep\n') },
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.fileTree.map((file) => file.path)).toEqual([deepPath(8)]);
      expect(metadata.fileTreeTruncated).toBe(true);
    });

    it('深度恰好等于上限、条目数也恰好等于上限 ⇒ **不**标记截断', async () => {
      const bytes = buildZip([{ name: deepPath(8), data: Buffer.from('ok\n') }]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.fileTreeTruncated).toBe(false);
    });

    it('恰好 500 个文件 ⇒ 全部进树且不标记截断', async () => {
      const bytes = buildZip(
        Array.from({ length: 500 }, (_unused, index) => ({ name: `f${index}.txt`, data: Buffer.from('x') })),
      );
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.fileTree).toHaveLength(500);
      expect(metadata.fileTreeTruncated).toBe(false);
    });

    it('501 个文件 ⇒ 只留**归档顺序**的前 500 个，并标记截断', async () => {
      const bytes = buildZip(
        Array.from({ length: 501 }, (_unused, index) => ({ name: `f${index}.txt`, data: Buffer.from('x') })),
      );
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.fileTree).toHaveLength(500);
      expect(metadata.fileTree[0]?.path).toBe('f0.txt');
      expect(metadata.fileTree[499]?.path).toBe('f499.txt');
      expect(metadata.fileTreeTruncated).toBe(true);
    });

    it('字节数取自中央目录声明的未压缩大小（不是压缩后大小）', async () => {
      const body = 'q'.repeat(4096);
      const bytes = buildZip([{ name: 'src/index.ts', data: Buffer.from(body), method: 8 }]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.fileTree).toEqual([{ path: 'src/index.ts', bytes: 4096 }]);
    });

    it('目录条目不进文件树', async () => {
      const bytes = buildZip([
        { name: 'src/', data: Buffer.alloc(0) },
        { name: 'src/index.ts', data: Buffer.from('export const x = 1;\n') },
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.fileTree.map((file) => file.path)).toEqual(['src/index.ts']);
    });

    it('tar.gz 侧同一判据：9 段不进树、标记截断、目录条目不算文件', async () => {
      const bytes = buildTarGz([
        { name: 'src/', typeflag: '5' },
        { name: deepPath(8), data: Buffer.from('ok\n') },
        { name: deepPath(9), data: Buffer.from('too deep\n') },
      ]);
      const metadata = await parseOf(bytes, 'tar.gz');
      expect(metadata.fileTree.map((file) => file.path)).toEqual([deepPath(8)]);
      expect(metadata.fileTreeTruncated).toBe(true);
    });
  });

  describe('Step 4：语言分布（按扩展名归类、按字节占比）', () => {
    const bytesOf = (size: number): Buffer => Buffer.alloc(size, 0x61);

    it('按扩展名归类，占比的分母是**非空文件**的字节合计（0 字节文件不参与，见下一条）', async () => {
      const bytes = buildZip([
        { name: 'src/a.ts', data: bytesOf(100) },
        { name: 'src/b.js', data: bytesOf(300) },
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.languages).toEqual([
        { name: 'JavaScript', bytes: 300, ratio: 0.75 },
        { name: 'TypeScript', bytes: 100, ratio: 0.25 },
      ]);
    });

    it('未知扩展名归 other；没有扩展名与点开头的文件也归 other', async () => {
      const bytes = buildZip([
        { name: 'Makefile', data: bytesOf(10) },
        { name: '.gitignore', data: bytesOf(20) },
        { name: 'data.weird', data: bytesOf(30) },
        { name: 'src/a.ts', data: bytesOf(40) },
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.languages).toEqual([
        { name: 'other', bytes: 60, ratio: 0.6 },
        { name: 'TypeScript', bytes: 40, ratio: 0.4 },
      ]);
    });

    it('扩展名大小写不敏感（`.TS` 与 `.ts` 同一个桶）', async () => {
      const bytes = buildZip([
        { name: 'a.TS', data: bytesOf(10) },
        { name: 'b.ts', data: bytesOf(30) },
      ]);
      expect((await parseOf(bytes, 'zip')).languages).toEqual([{ name: 'TypeScript', bytes: 40, ratio: 1 }]);
    });

    it('0 字节文件不进分布（不建 0 字节的桶）；全是 0 字节时分布是空的', async () => {
      const bytes = buildZip([
        { name: 'a.ts', data: Buffer.alloc(0) },
        { name: 'b.js', data: bytesOf(20) },
      ]);
      expect((await parseOf(bytes, 'zip')).languages).toEqual([{ name: 'JavaScript', bytes: 20, ratio: 1 }]);

      const allEmpty = buildZip([{ name: 'a.ts', data: Buffer.alloc(0) }]);
      expect((await parseOf(allEmpty, 'zip')).languages).toEqual([]);
    });

    it('分母是**非空文件**的字节合计（口径写成可判定的行为，不是注释里的一句话）', async () => {
      // 修复轮 1 的更正：实现一直是 `bytes > 0` 才累计（值不变），错的是**契约的表述**
      // ——「分母是所有文件的字节合计」会让下一个读者以为空文件也在分母里。
      // 这条用例把正确口径的三条后果钉住：
      //   ⓐ 空文件不建桶 ⇒ 分布里不会多出一行 0 字节的记录；
      //   ⓑ 分母只由非空文件构成 ⇒ 各桶 `ratio` 之和**恰好**是 1；
      //   ⓒ 一份**只有**空文件的归档 ⇒ 空数组：若真把空文件算进分母，这里会是 0/0 = NaN。
      const mixed = buildZip([
        { name: 'a.ts', data: Buffer.alloc(0) },
        { name: 'b.js', data: bytesOf(20) },
        { name: 'c.ts', data: Buffer.alloc(0) },
      ]);
      const languages = (await parseOf(mixed, 'zip')).languages;
      expect(languages).toEqual([{ name: 'JavaScript', bytes: 20, ratio: 1 }]);
      expect(languages.reduce((sum, entry) => sum + entry.ratio, 0)).toBe(1);
      expect(languages.every((entry) => Number.isFinite(entry.ratio))).toBe(true);

      const allEmpty = buildZip([
        { name: 'a.ts', data: Buffer.alloc(0) },
        { name: 'b.js', data: Buffer.alloc(0) },
      ]);
      const empty = (await parseOf(allEmpty, 'zip')).languages;
      expect(empty).toEqual([]); // 不是 [{ name: 'JavaScript', bytes: 0, ratio: NaN }]
      expect(empty.every((entry) => Number.isFinite(entry.ratio))).toBe(true);
    });

    it('排序：字节降序；字节相同时按语言名升序（与归档顺序无关）', async () => {
      // 归档顺序刻意**不是**字母序：三个 50 字节的桶按出现顺序是 Markdown / Go / JSON，
      // 期望的顺序是 Go / JSON / Markdown —— 不按名字做次级排序就会红（探针 m32 验过）。
      const bytes = buildZip([
        { name: 'm.md', data: bytesOf(50) },
        { name: 'z.go', data: bytesOf(50) },
        { name: 'a.json', data: bytesOf(50) },
        { name: 'big.py', data: bytesOf(200) },
      ]);
      expect((await parseOf(bytes, 'zip')).languages.map((language) => language.name)).toEqual([
        'Python',
        'Go',
        'JSON',
        'Markdown',
      ]);
    });

    it('超出树深度的文件仍然计入语言分布（**树受限、聚合不受限**）', async () => {
      const deep = `${Array.from({ length: 12 }, (_unused, index) => `d${index}`).join('/')}/deep.ts`;
      const bytes = buildZip([
        { name: 'shallow.js', data: bytesOf(100) },
        { name: deep, data: bytesOf(300) },
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.fileTreeTruncated).toBe(true); // 深的那份没进树
      expect(metadata.languages).toEqual([
        { name: 'TypeScript', bytes: 300, ratio: 0.75 },
        { name: 'JavaScript', bytes: 100, ratio: 0.25 },
      ]);
    });

    it('tar.gz 侧同一判据', async () => {
      const bytes = buildTarGz([
        { name: 'main.go', data: bytesOf(300) },
        { name: 'README.md', data: bytesOf(100) },
      ]);
      expect((await parseOf(bytes, 'tar.gz')).languages).toEqual([
        { name: 'Go', bytes: 300, ratio: 0.75 },
        { name: 'Markdown', bytes: 100, ratio: 0.25 },
      ]);
    });
  });

  describe('Step 5：依赖清单（纯文本解析）', () => {
    const text = (value: string): Buffer => Buffer.from(value, 'utf8');

    it('package.json：四类依赖都收，版本原样保留', async () => {
      const bytes = buildZip([
        {
          name: 'package.json',
          data: text(
            JSON.stringify({
              name: 'demo',
              dependencies: { express: '^5.0.0' },
              devDependencies: { vitest: '5.0.3' },
              peerDependencies: { react: '>=19' },
              optionalDependencies: { fsevents: '~2.3.2' },
            }),
          ),
        },
      ]);
      expect((await parseOf(bytes, 'zip')).dependencies).toEqual([
        { ecosystem: 'npm', name: 'express', version: '^5.0.0' },
        { ecosystem: 'npm', name: 'fsevents', version: '~2.3.2' },
        { ecosystem: 'npm', name: 'react', version: '>=19' },
        { ecosystem: 'npm', name: 'vitest', version: '5.0.3' },
      ]);
    });

    it('package.json 同名依赖出现在两处 ⇒ 只留第一条（dependencies 胜过 devDependencies）', async () => {
      const bytes = buildZip([
        {
          name: 'package.json',
          data: text(
            JSON.stringify({
              dependencies: { 'left-pad': '^1.3.0' },
              devDependencies: { 'left-pad': '^1.2.0' },
            }),
          ),
        },
      ]);
      expect((await parseOf(bytes, 'zip')).dependencies).toEqual([
        { ecosystem: 'npm', name: 'left-pad', version: '^1.3.0' },
      ]);
    });

    it('package.json 不是合法 JSON ⇒ 不产出依赖，但**整份解析照常成功**', async () => {
      const bytes = buildZip([
        { name: 'package.json', data: text('{ 这不是 JSON') },
        { name: 'src/index.ts', data: text('export const x = 1;\n') },
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.dependencies).toEqual([]);
      expect(metadata.fileTree.map((file) => file.path)).toContain('package.json');
    });

    it('requirements.txt：注释、-r 行、extras、环境标记、各种版本符', async () => {
      const bytes = buildZip([
        {
          name: 'requirements.txt',
          data: text(
            [
              '# 注释行',
              '',
              '-r base.txt',
              '--index-url https://example.invalid/simple',
              'flask==2.0.1',
              'requests[security]>=2.0 ; python_version < "3.8"',
              'numpy',
              '  django~=4.2  ',
            ].join('\n'),
          ),
        },
      ]);
      expect((await parseOf(bytes, 'zip')).dependencies).toEqual([
        { ecosystem: 'pypi', name: 'django', version: '~=4.2' },
        { ecosystem: 'pypi', name: 'flask', version: '==2.0.1' },
        { ecosystem: 'pypi', name: 'numpy', version: '' },
        { ecosystem: 'pypi', name: 'requests', version: '>=2.0' },
      ]);
    });

    it('go.mod：require 块与单行都收，`// indirect` 跳过，module/go 行不算依赖', async () => {
      const bytes = buildZip([
        {
          name: 'go.mod',
          data: text(
            [
              'module example.com/demo',
              '',
              'go 1.22',
              '',
              'require github.com/single/pkg v1.0.0',
              '',
              'require (',
              '\tgithub.com/foo/bar v1.2.3',
              '\tgithub.com/baz/qux v0.9.0 // indirect',
              ')',
              '',
            ].join('\n'),
          ),
        },
      ]);
      expect((await parseOf(bytes, 'zip')).dependencies).toEqual([
        { ecosystem: 'go', name: 'github.com/foo/bar', version: 'v1.2.3' },
        { ecosystem: 'go', name: 'github.com/single/pkg', version: 'v1.0.0' },
      ]);
    });

    it('三个清单同时存在 ⇒ 三个 ecosystem 都在；嵌套路径的清单也认', async () => {
      const bytes = buildZip([
        { name: 'package.json', data: text(JSON.stringify({ dependencies: { a: '1' } })) },
        { name: 'backend/requirements.txt', data: text('b==2') },
        { name: 'tools/go.mod', data: text('module m\n\nrequire c v3\n') },
      ]);
      expect((await parseOf(bytes, 'zip')).dependencies).toEqual([
        { ecosystem: 'go', name: 'c', version: 'v3' },
        { ecosystem: 'npm', name: 'a', version: '1' },
        { ecosystem: 'pypi', name: 'b', version: '==2' },
      ]);
    });

    it('名字不是清单的文件不会被当成清单（`my-package.json` / `requirements.txt.bak`）', async () => {
      const bytes = buildZip([
        { name: 'my-package.json', data: text(JSON.stringify({ dependencies: { x: '1' } })) },
        { name: 'requirements.txt.bak', data: text('y==1') },
      ]);
      expect((await parseOf(bytes, 'zip')).dependencies).toEqual([]);
    });

    it('清单文件数上限 8：第 9 个之后的清单一个字节都不读', async () => {
      const bytes = buildZip(
        Array.from({ length: 10 }, (_unused, index) => ({
          name: `p${index}/package.json`,
          data: text(JSON.stringify({ dependencies: { [`dep${index}`]: '1.0.0' } })),
        })),
      );
      const names = (await parseOf(bytes, 'zip')).dependencies.map((dependency) => dependency.name);
      expect(names).toEqual(['dep0', 'dep1', 'dep2', 'dep3', 'dep4', 'dep5', 'dep6', 'dep7']);
    });

    it('依赖条数上限 500（超出部分丢弃）', async () => {
      const many: Record<string, string> = {};
      for (let index = 0; index < 600; index++) many[`pkg${String(index).padStart(4, '0')}`] = '1.0.0';
      const bytes = buildZip([{ name: 'package.json', data: text(JSON.stringify({ dependencies: many })) }]);
      const dependencies = (await parseOf(bytes, 'zip')).dependencies;
      expect(dependencies).toHaveLength(500);
      expect(dependencies[0]?.name).toBe('pkg0000');
      expect(dependencies[499]?.name).toBe('pkg0499');
    });

    it('tar.gz 侧同一判据', async () => {
      const bytes = buildTarGz([
        { name: 'package.json', data: text(JSON.stringify({ dependencies: { only: '1.0.0' } })) },
      ]);
      expect((await parseOf(bytes, 'tar.gz')).dependencies).toEqual([
        { ecosystem: 'npm', name: 'only', version: '1.0.0' },
      ]);
    });
  });

  describe('Step 5b：vendored 目录（`node_modules` 等）不参与 README / 清单 / 代码扫描', () => {
    /**
     * 控制器的裁定（修复轮 1）：排除 `node_modules/` 及其同类。这不是「顺手加的过滤器」，
     * 而是两处**错误输出**的修法：
     * ⓐ `node_modules/**\/readme.md` 会赢走 README 槽位 ⇒ 依赖的 README 被当成项目自己的；
     * ⓑ 一个把 `node_modules` 打进包的项目，其自身清单会被挤出那 8 个名额 ⇒ 依赖清单静默地
     *    读的是依赖的清单。
     * 本节把这两个后果写成「不可能」，并把排除的**范围**也钉住（文件树 / 文件数 / 语言分布
     * 仍按全量统计——那是「归档里有什么」，不是「项目自己有什么」）。
     */
    const text = (value: string): Buffer => Buffer.from(value, 'utf8');

    /** 只给「代码行数」100 分、其余 0：分数就是「数到的代码行数 > 200」的 0/100 信号。 */
    const codeLinesOnly = weightsOnly('codeLines');

    it('依赖的 README 抢不走槽位；项目自己没有 README ⇒ null（不是「把依赖的顶上来」）', async () => {
      const stolen = buildZip([
        { name: 'node_modules/left-pad/readme.md', data: text('# 依赖的 README（不该赢）\n') },
        { name: 'node_modules/left-pad/docs/README.md', data: text('# 同上的第二个形状\n') },
        { name: 'README.md', data: text('# 项目自己的 README\n') },
      ]);
      expect((await parseOf(stolen, 'zip')).readmeExcerpt).toBe('# 项目自己的 README\n');

      // 项目自己没有 README：依赖那一份**不能**顶上来
      // （「没有 README」与「依赖的 README」不是同一件事）。
      const onlyDependency = buildZip([
        { name: 'node_modules/left-pad/readme.md', data: text('# 依赖的 README\n') },
        { name: 'src/index.ts', data: text('export const x = 1;\n') },
      ]);
      expect((await parseOf(onlyDependency, 'zip')).readmeExcerpt).toBeNull();
    });

    it('依赖的 package.json 不占那 8 个清单名额 ⇒ 项目自己的清单照样被读', async () => {
      const bytes = buildZip([
        // 12 个 vendored 清单排在包内**最前面**：不排除的话，项目自己那一份落在第 13 位
        // ⇒ 那 8 个名额全被吃掉，项目自己的依赖一条都读不到。
        ...Array.from({ length: 12 }, (_unused, index) => ({
          name: `node_modules/dep${index}/package.json`,
          data: text(JSON.stringify({ dependencies: { [`dep${index}`]: '1.0.0' } })),
        })),
        { name: 'package.json', data: text(JSON.stringify({ dependencies: { mine: '9.9.9' } })) },
      ]);
      expect((await parseOf(bytes, 'zip')).dependencies).toEqual([
        { ecosystem: 'npm', name: 'mine', version: '9.9.9' },
      ]);
    });

    it('依赖的代码不数行数（32 个扫描名额也不被 vendored 目录吃掉）', async () => {
      const bytes = buildZip([
        // 40 个 vendored 代码文件、每个 400 行：不排除的话前 32 个就把名额与 12800 行用光。
        ...Array.from({ length: 40 }, (_unused, index) => ({
          name: `node_modules/dep${index}/index.js`,
          data: text('const x = 1;\n'.repeat(400)),
        })),
        { name: 'src/util.ts', data: text('const x = 1;\n') },
      ]);
      const metadata = await parseOf(bytes, 'zip', { weights: codeLinesOnly });
      expect(metadata.completeness).toBe(0); // 项目自己只有 1 行代码
    });

    it('等效的 vendored 目录同样排除，且目录名大小写不敏感', async () => {
      const vendoredReadmes = [
        'bower_components/jq/readme.md',
        'vendor/github.com/x/readme.md',
        '.venv/lib/site-packages/dep/readme.md',
        'app/site-packages/dep/readme.md',
        'NODE_MODULES/dep/readme.md', // 大小写不敏感的文件系统上就是这个形状
      ];
      for (const path of vendoredReadmes) {
        const bytes = buildZip([
          { name: path, data: text('# 依赖的 README\n') },
          { name: 'README.md', data: text('# 项目自己的 README\n') },
        ]);
        expect((await parseOf(bytes, 'zip')).readmeExcerpt, path).toBe('# 项目自己的 README\n');
      }
    });

    it('排除的**范围**只在选路那几处：文件树 / 文件总数 / 语言分布仍按全量统计', async () => {
      const bytes = buildZip([
        { name: 'node_modules/dep/big.js', data: Buffer.from('x'.repeat(100)) },
        { name: 'src/a.ts', data: Buffer.from('y'.repeat(300)) },
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.fileTree.map((file) => file.path)).toEqual(['node_modules/dep/big.js', 'src/a.ts']);
      expect(metadata.languages).toEqual([
        { name: 'TypeScript', bytes: 300, ratio: 0.75 },
        { name: 'JavaScript', bytes: 100, ratio: 0.25 },
      ]);
    });

    it('tar.gz 侧同一判据（两个 walker 共用同一条排除）', async () => {
      const bytes = buildTarGz([
        { name: 'node_modules/dep/readme.md', data: text('# 依赖的 README\n') },
        { name: 'node_modules/dep/package.json', data: text(JSON.stringify({ dependencies: { dep: '1.0.0' } })) },
        { name: 'README.md', data: text('# 项目自己的 README\n') },
        { name: 'package.json', data: text(JSON.stringify({ dependencies: { mine: '1.0.0' } })) },
      ]);
      const metadata = await parseOf(bytes, 'tar.gz');
      expect(metadata.readmeExcerpt).toBe('# 项目自己的 README\n');
      expect(metadata.dependencies).toEqual([{ ecosystem: 'npm', name: 'mine', version: '1.0.0' }]);
    });
  });

  describe('Step 6：完整度评分（设计 §6.2 的七项默认权重，可配）', () => {
    /** 七项全部命中的事实。 */
    const FULL: CompletenessFacts = {
      readmeChars: 200,
      hasLicense: true,
      manifestFilesParsed: 1,
      hasEntryOrBuildScript: true,
      fileCount: 10,
      hasMedia: true,
      codeLines: 201,
    };
    /** 七项全部不命中的事实。 */
    const NONE: CompletenessFacts = {
      readmeChars: 0,
      hasLicense: false,
      manifestFilesParsed: 0,
      hasEntryOrBuildScript: false,
      fileCount: 0,
      hasMedia: false,
      codeLines: 0,
    };

    it('默认权重合计**恰好** 100（否则「0–100 分」这句话是假的）', () => {
      const total = Object.values(DEFAULT_COMPLETENESS_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
      expect(total).toBe(100);
    });

    it('七项全中 ⇒ 100；一项不中 ⇒ 0', () => {
      expect(scoreCompleteness(FULL)).toBe(100);
      expect(scoreCompleteness(NONE)).toBe(0);
    });

    it('每一项各自的边界（README 200 字 / 文件数 10 与 5000 / 代码 201 行）', () => {
      const drop = (patch: Partial<CompletenessFacts>): number => scoreCompleteness({ ...FULL, ...patch });
      // README：≥ 200 字才算（199 不算）
      expect(drop({ readmeChars: 199 })).toBe(75);
      expect(drop({ readmeChars: 200 })).toBe(100);
      // 文件数：闭区间 10–5000
      expect(drop({ fileCount: 9 })).toBe(90);
      expect(drop({ fileCount: 10 })).toBe(100);
      expect(drop({ fileCount: 5000 })).toBe(100);
      expect(drop({ fileCount: 5001 })).toBe(90);
      // 代码行数：**严格大于** 200
      expect(drop({ codeLines: 200 })).toBe(90);
      expect(drop({ codeLines: 201 })).toBe(100);
      // 布尔三项
      expect(drop({ hasLicense: false })).toBe(90);
      expect(drop({ manifestFilesParsed: 0 })).toBe(85);
      expect(drop({ hasEntryOrBuildScript: false })).toBe(85);
      expect(drop({ hasMedia: false })).toBe(85);
    });

    it('自定义权重**真的**被用上（默认权重下 0 分的样本，换权重后是 100）', () => {
      const onlyReadme: CompletenessWeights = {
        readme: 100,
        license: 0,
        dependencyManifest: 0,
        entryOrBuildScript: 0,
        fileCount: 0,
        media: 0,
        codeLines: 0,
      };
      const readmeOnly: CompletenessFacts = { ...NONE, readmeChars: 500 };
      expect(scoreCompleteness(readmeOnly)).toBe(25);
      expect(scoreCompleteness(readmeOnly, onlyReadme)).toBe(100);
    });

    it('权重可配 ⇒ 总分可能越过 100 或变成负数：必须被夹在 0–100 且取整', () => {
      const allBig: CompletenessWeights = {
        readme: 50,
        license: 50,
        dependencyManifest: 50,
        entryOrBuildScript: 50,
        fileCount: 50,
        media: 50,
        codeLines: 50,
      };
      const allNegative: CompletenessWeights = {
        readme: -50,
        license: -50,
        dependencyManifest: -50,
        entryOrBuildScript: -50,
        fileCount: -50,
        media: -50,
        codeLines: -50,
      };
      expect(scoreCompleteness(FULL, allBig)).toBe(100);
      expect(scoreCompleteness(FULL, allNegative)).toBe(0);
      // 分数是整数：小数权重不会漏到结果里（DB 那一列是整数）
      const half: CompletenessWeights = { ...DEFAULT_COMPLETENESS_WEIGHTS, readme: 25.4 };
      expect(Number.isInteger(scoreCompleteness({ ...NONE, readmeChars: 500 }, half))).toBe(true);
    });
  });

  describe('Step 6b：完整度评分接在真实解析上（每一项都真的被算出来，权重可配）', () => {
    const scoreFor = async (bytes: Buffer, key: keyof CompletenessWeights): Promise<number> =>
      (await parseOf(bytes, 'zip', { weights: weightsOnly(key) })).completeness;

    it('README：199 字 ⇒ 0 分；200 字 ⇒ 100 分', async () => {
      const short = buildZip([{ name: 'README.md', data: Buffer.from('a'.repeat(199)) }]);
      const exact = buildZip([{ name: 'README.md', data: Buffer.from('a'.repeat(200)) }]);
      expect(await scoreFor(short, 'readme')).toBe(0);
      expect(await scoreFor(exact, 'readme')).toBe(100);
    });

    it('LICENSE：`LICENSE` / `LICENSE.txt` / `COPYING` 都算，`NOTICE` 不算', async () => {
      const withLicense = buildZip([{ name: 'LICENSE.txt', data: Buffer.from('MIT\n') }]);
      const copying = buildZip([{ name: 'COPYING', data: Buffer.from('GPL\n') }]);
      const notice = buildZip([{ name: 'NOTICE', data: Buffer.from('hi\n') }]);
      expect(await scoreFor(withLicense, 'license')).toBe(100);
      expect(await scoreFor(copying, 'license')).toBe(100);
      expect(await scoreFor(notice, 'license')).toBe(0);
    });

    it('依赖清单：可解析的 package.json ⇒ 100；**不是 JSON** 的 package.json ⇒ 0', async () => {
      const good = buildZip([{ name: 'package.json', data: Buffer.from('{"dependencies":{"a":"1"}}') }]);
      const bad = buildZip([{ name: 'package.json', data: Buffer.from('{ 坏掉的 JSON') }]);
      expect(await scoreFor(good, 'dependencyManifest')).toBe(100);
      expect(await scoreFor(bad, 'dependencyManifest')).toBe(0);
    });

    it('入口 / 构建脚本：`Makefile` 或 `package.json` 的 scripts.build 都算，两者都没有 ⇒ 0', async () => {
      const makefile = buildZip([{ name: 'Makefile', data: Buffer.from('all:\n\techo hi\n') }]);
      const script = buildZip([
        { name: 'package.json', data: Buffer.from('{"scripts":{"build":"tsc -p ."}}') },
      ]);
      const neither = buildZip([{ name: 'src/util.ts', data: Buffer.from('export const x = 1;\n') }]);
      expect(await scoreFor(makefile, 'entryOrBuildScript')).toBe(100);
      expect(await scoreFor(script, 'entryOrBuildScript')).toBe(100);
      expect(await scoreFor(neither, 'entryOrBuildScript')).toBe(0);
    });

    it('文件数：9 ⇒ 0 分；10 ⇒ 100 分；5000 ⇒ 100 分；5001 ⇒ 0 分', async () => {
      const zipOf = (count: number): Buffer =>
        buildZip(Array.from({ length: count }, (_unused, index) => ({ name: `f${index}.txt` })));
      expect(await scoreFor(zipOf(9), 'fileCount')).toBe(0);
      expect(await scoreFor(zipOf(10), 'fileCount')).toBe(100);
      expect(await scoreFor(zipOf(5000), 'fileCount')).toBe(100);
      expect(await scoreFor(zipOf(5001), 'fileCount')).toBe(0);
    });

    it('文件数按**全量**统计（深度超过树上限的文件也算进去）', async () => {
      const deep = `${Array.from({ length: 12 }, (_unused, index) => `d${index}`).join('/')}/deep.txt`;
      const bytes = buildZip([
        ...Array.from({ length: 9 }, (_unused, index) => ({ name: `f${index}.txt` })),
        { name: deep },
      ]);
      const metadata = await parseOf(bytes, 'zip', { weights: weightsOnly('fileCount') });
      expect(metadata.fileTreeTruncated).toBe(true); // 树被截断了……
      expect(metadata.completeness).toBe(100); // ……但文件数照样数到 10
    });

    it('截图 / 录屏：`.png` 算，`.txt` 不算', async () => {
      const shot = buildZip([{ name: 'docs/shot.PNG', data: Buffer.from('x') }]);
      const text = buildZip([{ name: 'docs/notes.txt', data: Buffer.from('x') }]);
      expect(await scoreFor(shot, 'media')).toBe(100);
      expect(await scoreFor(text, 'media')).toBe(0);
    });

    it('vendored 目录里的 LICENSE / 截图 / `index.js` 不给项目加分（那是依赖的东西）', async () => {
      // 这三项只按**名字**判定，因此它们是同一类错误的第三个出口：
      // 依赖的 LICENSE / 截图 / index.js 会让项目看起来有许可证、有截图、有入口。
      const vendored = buildZip([
        { name: 'node_modules/dep/LICENSE', data: Buffer.from('MIT\n') },
        { name: 'node_modules/dep/docs/shot.png', data: Buffer.from('png') },
        { name: 'node_modules/dep/index.js', data: Buffer.from('module.exports = 1;\n') },
        { name: 'src/util.ts', data: Buffer.from('const x = 1;\n') },
      ]);
      expect(await scoreFor(vendored, 'license')).toBe(0);
      expect(await scoreFor(vendored, 'media')).toBe(0);
      expect(await scoreFor(vendored, 'entryOrBuildScript')).toBe(0);

      // 反面对照：同样三个文件放在**项目自己**的位置上 ⇒ 三项照旧成立
      // （没有这一半，上面三条「0 分」可以被一个「这三项怎么都算不出来」的实现骗过去）。
      const own = buildZip([
        { name: 'LICENSE', data: Buffer.from('MIT\n') },
        { name: 'docs/shot.png', data: Buffer.from('png') },
        { name: 'src/index.js', data: Buffer.from('module.exports = 1;\n') },
      ]);
      expect(await scoreFor(own, 'license')).toBe(100);
      expect(await scoreFor(own, 'media')).toBe(100);
      expect(await scoreFor(own, 'entryOrBuildScript')).toBe(100);
    });

    it('代码行数：200 行 ⇒ 0 分；201 行 ⇒ 100 分（只有代码扩展名被数）', async () => {
      const code = (lines: number): Buffer =>
        buildZip([
          { name: 'src/main.ts', data: Buffer.from('const x = 1;\n'.repeat(lines)) },
          { name: 'notes.md', data: Buffer.from('# t\n'.repeat(5000)) }, // Markdown 不是代码
        ]);
      expect(await scoreFor(code(200), 'codeLines')).toBe(0);
      expect(await scoreFor(code(201), 'codeLines')).toBe(100);
    });

    it('代码行数扫描有界（最多 32 个文件）：第 33 个之后的代码文件不数——**低估**而不是高估', async () => {
      // 前 32 个文件各 1 行（它们把预算用光），真正的 800 行在第 33、34 个文件里。
      const bytes = buildZip([
        ...Array.from({ length: 32 }, (_unused, index) => ({
          name: `src/small${index}.ts`,
          data: Buffer.from('const x = 1;\n'),
        })),
        { name: 'src/late1.ts', data: Buffer.from('const x = 1;\n'.repeat(400)) },
        { name: 'src/late2.ts', data: Buffer.from('const x = 1;\n'.repeat(400)) },
      ]);
      // 32 行 ≤ 200 ⇒ 不得分；若不设上限则会数到 832 行 ⇒ 得分。这条差值就是上限的判别力。
      expect(await scoreFor(bytes, 'codeLines')).toBe(0);
    });

    it('每个代码文件最多数前 64 KiB 的行——同样是**低估**', async () => {
      // 第一个 64 KiB 是一整行（没有换行符），剩下的 1000 行在 64 KiB 之后。
      const oneLongLine = `${'a'.repeat(64 * 1024 - 1)}\n`;
      const rest = 'const x = 1;\n'.repeat(1000);
      const bytes = buildZip([{ name: 'src/huge.ts', data: Buffer.from(oneLongLine + rest) }]);
      expect(await scoreFor(bytes, 'codeLines')).toBe(0);
    });

    it('默认权重下的满分样本 ⇒ 恰好 100（七项同时成立）', async () => {
      const bytes = buildZip([
        { name: 'README.md', data: Buffer.from('r'.repeat(200)) },
        { name: 'LICENSE', data: Buffer.from('MIT\n') },
        { name: 'package.json', data: Buffer.from('{"dependencies":{"a":"1"},"scripts":{"build":"tsc"}}') },
        { name: 'shot.png', data: Buffer.from('png') },
        { name: 'src/main.ts', data: Buffer.from('const x = 1;\n'.repeat(201)) },
        { name: 'docs/d0.txt', data: Buffer.from('x') },
        { name: 'docs/d1.txt', data: Buffer.from('x') },
        { name: 'docs/d2.txt', data: Buffer.from('x') },
        { name: 'docs/d3.txt', data: Buffer.from('x') },
        { name: 'docs/d4.txt', data: Buffer.from('x') },
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.dependencies).toHaveLength(1);
      expect(metadata.fileTree).toHaveLength(10); // 七项里的「文件数在 10–5000 之间」靠它
      expect(metadata.completeness).toBe(100);
    });

    it('要什么没什么的样本 ⇒ 0（默认权重）', async () => {
      const bytes = buildZip([{ name: 'src/util.ts', data: Buffer.from('const x = 1;\n') }]);
      expect((await parseOf(bytes, 'zip')).completeness).toBe(0);
    });

    it('tar.gz 侧同一判据（满分样本）', async () => {
      const entries = [
        { name: 'README.md', data: Buffer.from('r'.repeat(200)) },
        { name: 'LICENSE', data: Buffer.from('MIT\n') },
        { name: 'package.json', data: Buffer.from('{"dependencies":{"a":"1"},"scripts":{"build":"tsc"}}') },
        { name: 'shot.png', data: Buffer.from('png') },
        { name: 'src/main.ts', data: Buffer.from('const x = 1;\n'.repeat(201)) },
        ...Array.from({ length: 5 }, (_unused, index) => ({ name: `docs/d${index}.txt`, data: Buffer.from('x') })),
      ];
      expect((await parseOf(buildTarGz(entries), 'tar.gz')).completeness).toBe(100);
    });
  });

  describe('Step 7：只读需要的块 / 结果有界（验收判据 13 在元数据这一侧的见证）', () => {
    /**
     * 判据 13 说的是「内存上界与文件大小无关」，而 Task 5 给的量是
     * **未完成字节数**（客户端已交出的明文 − 已落盘的制品字节）。那个量在本任务里
     * **没有定义**：解析的输入是一份**已经完整落盘**的制品，链路里没有任何「边收边写」，
     * 因此不存在「未完成」的字节。这里能观测、且与判据 13 同义的量是
     * **从制品库读回了多少字节**——它就是「这次解析把多少块解密进了内存」。
     */
    const CHUNK_BYTES = 64 * 1024; // 与 openReader 的 chunkSize 一致
    const PAYLOAD_BYTES = 24 * 1024 * 1024;

    /** 24 MiB 不可压缩负载（stored 条目，压缩比 1:1）。 */
    function incompressible(size: number, seed = 5): Buffer {
      const buffer = Buffer.alloc(size);
      for (let index = 0; index < size; index += 1) buffer[index] = (seed + index * 31) % 251;
      return buffer;
    }

    it('zip：24 MiB 归档里，解析只读回与归档大小**无关**的少数几块', async () => {
      const big = incompressible(PAYLOAD_BYTES);
      const bytes = buildZip([
        { name: 'README.md', data: Buffer.from('# 大项目\n' + 'r'.repeat(1500)) },
        { name: 'package.json', data: Buffer.from('{"dependencies":{"only":"1.0.0"}}') },
        { name: 'src/index.ts', data: Buffer.from('export const x = 1;\n') },
        { name: 'data/dump.bin', data: big },
      ]);
      const { store, reader } = await openReader(bytes);

      const metadata = await parseMetadata(reader, 'zip');

      // 解析确实读到了东西（否则下面的上界是恒真的）。
      expect(metadata.readmeExcerpt).toContain('# 大项目');
      expect(metadata.dependencies).toEqual([{ ecosystem: 'npm', name: 'only', version: '1.0.0' }]);

      /**
       * 上界**从制品几何推出来**，不是照着实测值写的：中央目录（1 块）+ 被读内容的
       * 那几个小文件（README / package.json / src/index.ts 各 1 块，可能并块）
       * + yauzl 逐个 `openReadStream` 时的本地头，再留一倍余量 ⇒ 16 块。
       * 制品本身是 `24 MiB / 64 KiB = 384` 块 ⇒ 这条上界比「全读一遍」低两个数量级。
       */
      const TOUCHED_BLOCKS_BOUND = 16;
      expect(store.bytesRequested()).toBeLessThan(TOUCHED_BLOCKS_BOUND * (CHUNK_BYTES + 16));
      // 同一件事的相对口径：读回的字节不到归档的 1/16。
      expect(store.bytesRequested() * 16).toBeLessThan(reader.plaintextLength);
    });

    /**
     * **稠密归档**：判据 13 在元数据侧的另一半见证（修复轮 1 补）。
     *
     * 上一条用例的归档只有 4 个条目，它能证明「那 24 MiB 没被读」，但证明不了**条目数**受
     * 选路规则约束：一个「把每个条目的前 64 KiB 都读一遍」的实现在那种形状下只多读一块，
     * 照样绿。这里因此造一份候选数**超过结构上界**的稠密归档——
     * 50 个内容候选（README 1 + 清单 9 + 代码 40），被 400 个**非候选**条目
     * （每个 60 KiB，`.bin` ⇒ `other` ⇒ 既不是代码也不是清单）隔开：
     * 候选的两簇各自很小（读它们花不了几块），而「每个条目都读一点」的代价随**条目数**增长。
     *
     * 结构性事实（不是照抄实测）：`need()` 至多放行 1 个 README + 8 个清单 + 32 个代码文件
     * ⇒ **至多 41 个条目**的内容会被读，而这份归档里 400 个非候选条目一个都不该被读。
     */
    it('zip：**稠密**归档（450 条、50 个内容候选）里读回量仍然有界——「只读需要的」不是靠「归档里只有一条大文件」', async () => {
      const CODE_FILES = 40; // 代码候选：扫描上限 32 ⇒ 后 8 个（`c32`…）刻意读不到
      const FILLER_FILES = 400; // 非候选条目：每个 60 KiB ⇒ 各自跨 64 KiB 的块边界
      const FILLER_BYTES = 60 * 1024;
      const CODE_LINES_PER_FILE = 10;

      const codeEntry = (index: number, dir: string): { name: string; data: Buffer } => ({
        name: `${dir}/c${String(index).padStart(2, '0')}.ts`,
        data: Buffer.from(`// c${index}\n${'const x = 1;\n'.repeat(CODE_LINES_PER_FILE - 1)}`),
      });
      const fillerEntry = (index: number): { name: string; data: Buffer } => ({
        name: `assets/blob-${String(index).padStart(3, '0')}.bin`,
        data: Buffer.alloc(FILLER_BYTES, index % 251),
      });
      const manifestEntry = (dir: string, dependency: string): { name: string; data: Buffer } => ({
        name: `${dir}package.json`,
        data: Buffer.from(JSON.stringify({ dependencies: { [dependency]: '1.0.0' } })),
      });

      // 两簇候选（像 monorepo 的 `src/` 与 `packages/app/`），簇外与簇间是那 400 个条目。
      const entries = [
        { name: 'README.md', data: Buffer.from(`# 稠密样本\n${'r'.repeat(300)}\n`) },
        manifestEntry('', 'mine'),
        ...Array.from({ length: CODE_FILES / 2 }, (_unused, index) => codeEntry(index, 'src')),
        ...Array.from({ length: FILLER_FILES / 2 }, (_unused, index) => fillerEntry(index)),
        ...Array.from({ length: 8 }, (_unused, index) => manifestEntry(`packages/app/pkg${index}/`, `pkg${index}`)),
        ...Array.from({ length: CODE_FILES / 2 }, (_unused, index) => codeEntry(index + CODE_FILES / 2, 'packages/app/src')),
        ...Array.from({ length: FILLER_FILES / 2 }, (_unused, index) => fillerEntry(index + FILLER_FILES / 2)),
      ];

      // 样本自检（从**名字**数，不经过被测代码）：候选数必须超过结构上界，否则这条用例退化。
      const candidatePaths = entries
        .map((entry) => entry.name)
        .filter((name) => name === 'README.md' || name.endsWith('package.json') || name.endsWith('.ts'));
      expect(entries).toHaveLength(1 + 1 + CODE_FILES + FILLER_FILES + 8);
      expect(candidatePaths).toHaveLength(1 + 9 + CODE_FILES);
      expect(candidatePaths.length).toBeGreaterThan(41); // 1 README + 8 清单 + 32 代码 = 结构上界

      const { store, reader } = await openReader(buildZip(entries));
      const metadata = await parseMetadata(reader, 'zip', { weights: weightsOnly('codeLines') });

      // 解析确实读到了**内容**（否则下面的上界是恒真的）：README、前 8 个清单、32 个代码文件。
      expect(metadata.readmeExcerpt).toContain('# 稠密样本');
      expect(metadata.dependencies).toEqual(
        ['mine', 'pkg0', 'pkg1', 'pkg2', 'pkg3', 'pkg4', 'pkg5', 'pkg6'].map((name) => ({
          ecosystem: 'npm',
          name,
          version: '1.0.0',
        })),
      );
      expect(metadata.completeness).toBe(100); // 32 个候选 × 10 行 = 320 行 > 门槛 200
      expect(metadata.fileTree).toHaveLength(entries.length); // 450 条全部进树（500 的上限没到）
      expect(metadata.fileTreeTruncated).toBe(false);

      /**
       * 上界**从制品几何与结构上界推出来**，不是照抄实测值（与上一条用例同一条纪律）：
       * - 内容读至多 `MAX_CONTENT_READS = 1 + 8 + 32 = 41` 次（README / 清单 / 代码三条选路
       *   各自的上限之和）；
       * - 每次内容读至多碰 2 块（条目的本地头与数据可能落在不同的块里）；
       * - **每一次内容读都会让「最近一块」的 memo 失效**：yauzl 是逐条目扫中央目录的，
       *   两次中央目录读之间插进一次内容读 ⇒ 下一次中央目录读要重新取回它那一块。因此每次
       *   内容读再记 1 块（这条是本轮实测到的形状：84 次请求 / **只有 4 个不同的块**）。
       * ⇒ `3 × (41 + 2) = 129` 块。制品本身 376 块。
       * 与上一条用例（4 个条目的稀疏归档）的 16 块上界**不是同一个数**：那种形状里中央目录
       * 只被扫 4 次，memo 几乎不失效。两条上界各自从**自己那份 fixture 的几何**推出来。
       */
      const MAX_CONTENT_READS = 1 + 8 + 32;
      expect(store.bytesRequested()).toBeLessThan(3 * (MAX_CONTENT_READS + 2) * (CHUNK_BYTES + 16));

      // 同一件事的**形状无关**口径：真正被解密进内存的**不同**块数（memo 的重取不算新块）。
      // 几何：两簇候选（各 ≤ 6 KiB，各至多跨 2 块）+ 中央目录区（约 30 KB，至多 2 块）
      // + 尾部 EOCD（与中央目录同一范围内）⇒ 至多 6 块，取 8 留一倍余量（实测 4 块）。
      const blocksTouched = new Set(store.requests.map((request) => request.start)).size;
      expect(blocksTouched).toBeLessThanOrEqual(8);

      // 这条上界不是空的（纯几何，不含任何实测值）：只算**非候选**条目，这份归档也有 400 块
      // 的内容需要读——「把每个条目的内容都读一点」的实现必然越过上面的上界，而它一块都不该读。
      expect(FILLER_FILES).toBeGreaterThan(3 * (MAX_CONTENT_READS + 2));
      // 归档确实是大归档（比那 400 个条目的内容还大），而它们一块都没被读。
      expect(reader.plaintextLength).toBeGreaterThan(FILLER_FILES * FILLER_BYTES);
      expect(FILLER_FILES * FILLER_BYTES).toBeGreaterThan(3 * (MAX_CONTENT_READS + 2) * (CHUNK_BYTES + 16));
    });

    it('zip：结果本身的规模有界（摘录 ≤ 2000 字符、文件树 ≤ 500 条），与归档大小无关', async () => {
      const bytes = buildZip([
        { name: 'README.md', data: Buffer.from('r'.repeat(200 * 1024)) },
        ...Array.from({ length: 600 }, (_unused, index) => ({
          name: `src/f${String(index).padStart(3, '0')}.txt`,
          data: Buffer.from('x'),
        })),
      ]);
      const metadata = await parseOf(bytes, 'zip');
      expect(metadata.readmeExcerpt).toHaveLength(2000);
      expect(metadata.fileTree).toHaveLength(500);
      expect(metadata.fileTreeTruncated).toBe(true);
    });

    it('tar.gz：**顺序流**下解压量与归档同阶（据实记载），有界的是**结果**与内容留存', async () => {
      const bytes = buildTarGz([
        { name: 'README.md', data: Buffer.from('r'.repeat(200 * 1024)) },
        { name: 'data/dump.bin', data: incompressible(4 * 1024 * 1024) },
      ]);
      const { store, reader } = await openReader(bytes);
      const metadata = await parseMetadata(reader, 'tar.gz');

      // 据实记载：tar.gz 没有中央目录，枚举条目必须把整条流解压一遍
      // ⇒ 读回的字节与制品同阶（这里只断言「确实读满了」，不假装它是省的那一侧）。
      expect(store.bytesRequested()).toBeGreaterThanOrEqual(reader.plaintextLength);
      // 有界的是结果：摘录截断、内容不累积。
      expect(metadata.readmeExcerpt).toHaveLength(2000);
      expect(metadata.fileTree.map((file) => file.path)).toEqual(['README.md', 'data/dump.bin']);
    });

    it('条目内容读不出来 ⇒ **抛错**，而不是伪造一份「看起来正常」的元数据', async () => {
      const data = Buffer.from('x'.repeat(5000));
      // 声明的压缩长度比真实载荷少 10 字节 ⇒ 解压输入被截断 ⇒ 读这个条目必然失败。
      const truncated = deflateRawSync(data).length - 10;
      const bytes = buildZip([
        { name: 'README.md', data, method: 8, declaredCompressedSize: truncated },
      ]);
      await expect(parseOf(bytes, 'zip')).rejects.toThrow();
    });

    it('tar.gz 侧同一处置：流在中途被截断 ⇒ 抛错（不是崩掉，也不是空元数据）', async () => {
      const full = buildTarGz([
        { name: 'README.md', data: Buffer.from('r'.repeat(5000)) },
        { name: 'src/main.ts', data: Buffer.from('const x = 1;\n'.repeat(50)) },
      ]);
      // 砍掉后半段：解压流在条目中间断掉，'end' 永远不会到。
      const cut = Buffer.from(full.subarray(0, Math.floor(full.length / 2)));
      await expect(parseOf(cut, 'tar.gz')).rejects.toThrow();
    });
  });
});
