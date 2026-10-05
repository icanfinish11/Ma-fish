import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
import { parseMetadata, type ParsedMetadata } from '@vca/api/modules/asset/metadata/parse-metadata.js';
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
async function parseOf(bytes: Buffer, kind: 'zip' | 'tar.gz'): Promise<ParsedMetadata> {
  const { reader } = await openReader(bytes);
  return await parseMetadata(reader, kind);
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

    it('按扩展名归类，占比的分母是全部文件的字节合计', async () => {
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

    it('排序：字节降序；字节相同时按语言名升序（与归档顺序无关）', async () => {
      const bytes = buildZip([
        { name: 'z.go', data: bytesOf(50) },
        { name: 'a.json', data: bytesOf(50) },
        { name: 'm.md', data: bytesOf(50) },
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
});
