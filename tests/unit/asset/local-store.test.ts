import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ArtifactTooLargeError,
  type ArtifactStore,
} from '@vca/api/modules/asset/store/artifact-store.port.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';

/**
 * `uuidv7` 的**可注入替身**：默认真实实现（其余用例不受影响），只有把
 * {@link forcedKey} 设为非空时才返回那个固定键——用来构造「键碰撞」这种
 * 概率上可忽略、但失败形态是**删掉别人对象**的形状（见「键碰撞」用例）。
 */
const forcedKey: { value?: string } = {};
vi.mock('@vca/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vca/shared')>();
  return { ...actual, uuidv7: () => forcedKey.value ?? actual.uuidv7() };
});

/**
 * 本地制品存储的行为契约（P1 / Task 1）。
 *
 * ## 这组用例在防什么
 *
 * 1. **C21「明文永不落盘」的结构性前提**：`putStream` 必须**边收边写**，
 *    不得把整份流缓冲进内存再落盘、也不得先写临时文件再改名。
 *    前者的失效形态是「大文件把内存吃光」，后者是「明文短暂地以第二个文件存在过」。
 *    两条都不是靠清理逻辑兜的，因此各有直判用例（见「写入在源流结束前已落盘」与
 *    「写入期间目录里始终只有一个文件」）。
 * 2. **超限中止必须无残留**（验收：超限上传中止后制品库中无残留对象）。
 *    这里的 `maxBytes` 是存储端自己的守卫，与 HTTP 层的 `limits.fileSize` 相互独立——
 *    两层各自必须有牙，任何一层单独失效都不该留下半个对象。
 * 3. **键是不可信输入**：`getRange` / `stat` / `delete` 直接吃字符串键，
 *    而键将来会来自 URL。非 UUIDv7 的键（`../` 之类）必须被拒绝，而不是拼进路径。
 */

/** 生成 `bytes` 字节、内容可校验的源流（按需产出，不预分配整份数据）。 */
function patternStream(bytes: number, chunkSize = 64 * 1024): Readable {
  let sent = 0;
  return new Readable({
    read(): void {
      if (sent >= bytes) {
        this.push(null);
        return;
      }
      const size = Math.min(chunkSize, bytes - sent);
      const chunk = Buffer.alloc(size);
      for (let i = 0; i < size; i++) chunk[i] = (sent + i) % 251;
      sent += size;
      this.push(chunk);
    },
  });
}

/** 轮询等待条件成立（用于「落盘先于源流结束」这类时序断言，不用固定 sleep 猜时间）。 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

async function filesIn(root: string): Promise<Array<{ name: string; size: number }>> {
  const names = await readdir(root, { recursive: true, withFileTypes: false });
  const out: Array<{ name: string; size: number }> = [];
  for (const name of names) {
    const info = await stat(join(root, name)).catch(() => null);
    if (info?.isFile()) out.push({ name: name.split('\\').join('/'), size: info.size });
  }
  return out;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('LocalArtifactStore（Task 1）', () => {
  let root: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vca-artifact-store-'));
    store = new LocalArtifactStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('putStream 写入 N 字节后 stat 得到 N，且键是 UUIDv7', async () => {
    const { key, bytes } = await store.putStream(patternStream(4096), { maxBytes: 1 << 20 });

    expect(bytes).toBe(4096);
    expect(key).toMatch(UUIDV7);
    await expect(store.stat(key)).resolves.toEqual({ bytes: 4096 });
  });

  it('getRange 返回精确的闭区间字节（含两端）', async () => {
    const source = patternStream(64);
    const { key } = await store.putStream(source, { maxBytes: 1 << 20 });

    const slice = await store.getRange(key, 2, 5);

    expect(slice).toHaveLength(4);
    // 内容与源流逐字一致：patternStream 的第 i 字节是 i % 251
    expect([...slice]).toEqual([2, 3, 4, 5]);
  });

  it('getRange 可读整个对象与单字节区间（随机访问的两端）', async () => {
    const { key, bytes } = await store.putStream(patternStream(1024), { maxBytes: 1 << 20 });

    await expect(store.getRange(key, 0, bytes - 1)).resolves.toHaveLength(1024);
    await expect(store.getRange(key, 1023, 1023)).resolves.toEqual(Buffer.from([1023 % 251]));
  });

  it('delete 之后 stat 抛错', async () => {
    const { key } = await store.putStream(patternStream(16), { maxBytes: 1 << 20 });

    await store.delete(key);

    await expect(store.stat(key)).rejects.toThrow();
  });

  it('delete 对不存在的键是幂等空操作（multer 的 _removeFile 会与自身清理竞争）', async () => {
    await expect(store.delete('00000000-0000-7000-8000-000000000000')).resolves.toBeUndefined();
  });

  it('超过 maxBytes：中止写入、抛 ArtifactTooLargeError、不留残留对象', async () => {
    const promise = store.putStream(patternStream(1 << 20), { maxBytes: 4096 });

    await expect(promise).rejects.toBeInstanceOf(ArtifactTooLargeError);
    await expect(filesIn(root)).resolves.toEqual([]);
  });

  it('恰好等于 maxBytes 不算超限（边界不多不少）', async () => {
    const promise = store.putStream(patternStream(4096), { maxBytes: 4096 });

    await expect(promise).resolves.toMatchObject({ bytes: 4096 });
    await expect(filesIn(root)).resolves.toHaveLength(1);
  });

  it('源流出错：向上抛错且不留残留对象', async () => {
    const failing = new Readable({
      read(): void {
        this.push(Buffer.alloc(128));
        this.destroy(new Error('源流坏了'));
      },
    });
    const before = await filesIn(root);

    await expect(store.putStream(failing, { maxBytes: 1 << 20 })).rejects.toThrow('源流坏了');
    await expect(filesIn(root)).resolves.toEqual(before);
  });

  it('写入在源流结束前已经落盘（不是先缓冲整份再写）', async () => {
    // 源流推完第一块后**停住**，由本用例显式放行 —— 于是「盘上有没有字节」
    // 只可能是「边收边写」的结果。先缓冲整份的实现此刻盘上必然是 0 字节。
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const source = new Readable({
      read(): void {
        this.push(Buffer.alloc(4096, 7));
        this.push = () => true; // 之后不再推任何东西，直到本用例放行
        void gate.then(() => Readable.prototype.push.call(this, null));
      },
    });

    const pending = store.putStream(source, { maxBytes: 1 << 20 });
    const landed = await waitFor(async () => (await filesIn(root)).some((f) => f.size > 0));

    expect(landed, '源流还没结束，盘上却一个字节都没有——这是「先缓冲整份」的形态').toBe(true);
    release();
    await expect(pending).resolves.toMatchObject({ bytes: 4096 });
  });

  it('写入期间存储目录里始终只有对象本身：绝不先写临时文件再改名', async () => {
    // ## 确定的（不是采样撞运气）
    // 源流推完第一块后**停住**：此刻盘上必须有且只有一个文件，且名字就是那个键本身。
    // 「先写 `.tmp` 再 rename」的实现此刻盘上叫 `<键>.tmp`，名字断言当场变红。
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const source = new Readable({
      read(): void {
        this.push(Buffer.alloc(4096, 9));
        this.push = () => true;
        void gate.then(() => Readable.prototype.push.call(this, null));
      },
    });
    const pending = store.putStream(source, { maxBytes: 1 << 20 });
    await waitFor(async () => (await filesIn(root)).length === 1);
    const midFlight = await filesIn(root);

    expect(midFlight, `写入中途盘上出现了不止一个文件：${JSON.stringify(midFlight)}`).toHaveLength(1);
    expect(
      midFlight[0]?.name.split('/').pop(),
      '写入中途的落盘文件名不是键本身（临时文件名会带后缀，明文因此以第二个文件存在过，C21）',
    ).toMatch(UUIDV7);
    release();
    await pending;
    await rm(root, { recursive: true, force: true });

    // ## 采样（覆盖「临时文件一闪而过」的实现）
    const seen: number[] = [];
    const timer = setInterval(() => {
      // `.catch` 放在最后：目录被删掉时采样会 ENOENT，那不是断言失败，
      // 但未处理的 rejection 会污染套件输出（本仓库要求 pristine）。
      void filesIn(root)
        .then((files) => seen.push(files.length))
        .catch(() => undefined);
    }, 1);
    const { bytes } = await store.putStream(patternStream(8 * 1024 * 1024), { maxBytes: 1 << 30 });
    clearInterval(timer);
    const after = await filesIn(root);

    expect(bytes).toBe(8 * 1024 * 1024);
    // 非空转前提：采样器必须真的采到了东西。少了这一条，`Math.max()` 在空数组上是
    // `-Infinity`，断言会**恒真**——一个从不执行的检查比没有检查更糟。
    expect(seen.length, '采样器一次都没采到（断言会恒真）').toBeGreaterThan(0);
    expect(Math.max(...seen), `采样到的最大文件数=${Math.max(...seen)}（>1 说明出现过临时副本）`).toBeLessThanOrEqual(1);
    expect(after).toHaveLength(1);
  });

  it('未完成字节数有上界，且不随输入大小增长', async () => {
    // 验收口径是「未完成字节数」，不是 RSS：已经产出但还没落盘的字节数。
    const measure = async (size: number): Promise<number> => {
      let produced = 0;
      const source = new Readable({
        read(): void {
          if (produced >= size) {
            this.push(null);
            return;
          }
          const chunk = Buffer.alloc(Math.min(64 * 1024, size - produced), 3);
          produced += chunk.length;
          this.push(chunk);
        },
      });
      let peak = 0;
      const timer = setInterval(() => {
        void filesIn(root)
          .then((files) => {
            const onDisk = files.reduce((n, f) => n + f.size, 0);
            peak = Math.max(peak, produced - onDisk);
          })
          .catch(() => undefined);
      }, 2);
      try {
        await store.putStream(source, { maxBytes: 1 << 30 });
      } finally {
        clearInterval(timer);
      }
      await rm(root, { recursive: true, force: true });
      return peak;
    };

    const small = await measure(4 * 1024 * 1024);
    const large = await measure(16 * 1024 * 1024);

    expect(small, `4 MiB 输入的未完成字节数峰值=${small}`).toBeLessThan(2 * 1024 * 1024);
    expect(large, `16 MiB 输入的未完成字节数峰值=${large}`).toBeLessThan(2 * 1024 * 1024);
  });

  it('拒绝非 UUIDv7 的键（路径穿越不得拼进路径）', async () => {
    // 键将来来自 URL；`../` 与绝对路径都必须在**进入 fs 之前**被拒。
    //
    // 断言必须点名**拒绝的理由**（「非法的制品键」），不能只写 `rejects.toThrow()`：
    // 后者对「校验被删掉、然后 fs 报 ENOENT」同样成立——变异探针 M6 实测过，
    // 去掉校验后那四条 `toThrow()` 全部照绿。判别力全在这条正则上。
    const rejectedAsKey = /非法的制品键/;
    await expect(store.stat('../../etc/passwd')).rejects.toThrow(rejectedAsKey);
    await expect(store.getRange('../../etc/passwd', 0, 1)).rejects.toThrow(rejectedAsKey);
    await expect(store.getRange('/etc/passwd', 0, 1)).rejects.toThrow(rejectedAsKey);
    await expect(store.delete('..')).rejects.toThrow(rejectedAsKey);
    // v4 键同样不是本存储的键（版本位必须是 7）
    await expect(store.stat('9f1c2a10-1111-4000-8000-000000000000')).rejects.toThrow(rejectedAsKey);
  });

  it('getRange 参数非法时抛错，而不是返回错长度的缓冲', async () => {
    const { key } = await store.putStream(patternStream(64), { maxBytes: 1 << 20 });

    await expect(store.getRange(key, 10, 5)).rejects.toThrow();
    await expect(store.getRange(key, -1, 5)).rejects.toThrow();
    // 越界读取（含端点超出文件末尾）必须报错，不能静默回短缓冲：
    // 解密读取器按块长度计算区间，短读意味着密文被截断，静默继续会把截断读成合法数据。
    await expect(store.getRange(key, 60, 100)).rejects.toThrow();
  });

  it('键碰撞（目标已存在）：写入失败，但**绝不删掉已有的那个对象**', async () => {
    // `flags: 'wx'` 的存在意义就是「碰撞要响亮，而不是静默覆盖」。
    // 但只会响亮是不够的：putStream 的中止路径会 `rm(target)`，
    // 若不加区分，一次碰撞就会把**别人的对象**删掉——从「拒绝一次写入」升级成「丢一份制品」。
    // 概率上可忽略（UUIDv7 的 62 位随机位），但失败形态太贵，因此这里用固定键把它变成可执行用例。
    const collidingKey = '018f5b9a-1c00-7000-8000-000000000001';
    const existing = join(root, collidingKey.slice(0, 2), collidingKey.slice(2, 4), collidingKey);
    await (await import('node:fs/promises')).mkdir(join(root, collidingKey.slice(0, 2), collidingKey.slice(2, 4)), {
      recursive: true,
    });
    await writeFile(existing, Buffer.from('已有的对象'));
    forcedKey.value = collidingKey;
    try {
      await expect(store.putStream(patternStream(32), { maxBytes: 1 << 20 })).rejects.toThrow();
    } finally {
      forcedKey.value = undefined;
    }

    await expect(stat(existing).then((s) => s.size)).resolves.toBe(Buffer.from('已有的对象').length);
  });
});
