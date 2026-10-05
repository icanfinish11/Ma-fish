import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { validateArchive } from '@vca/api/modules/asset/archive/validate-archive.js';
import { LocalArtifactStore } from '@vca/api/modules/asset/store/local-artifact.store.js';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
// **复用** unit 那一侧同一批构造辅助（加密成制品、内存替身、观察请求），不复制夹具。
import { MemoryStore, fakeRing, seedArtifact } from '../helpers/craft-encrypted-artifact.js';
// 样本一律**代码生成**（不入库二进制）：生成器是 `tests/fixtures/archives/generate.ts` 的
// 那一份八样本表，本文件与 unit 文件 import 的是**同一个** `ARCHIVE_SAMPLES`。
import { ARCHIVE_SAMPLES } from '../fixtures/archives/generate.js';

/**
 * 归档校验器的**安全门**（P1 / Task 4 修复轮 1 / Ruling 3）。
 *
 * ## 为什么这八条判定必须住在 `security` 而不是只住在 `unit`
 *
 * 归档校验器**就是**设计文档威胁 #2 的控制面（恶意归档：目录穿越、符号链接、炸弹、条目洪水、
 * 伪装类型）。而它此前只住在 `unit`——`scripts/assert-tests-ran.mjs` 给 `security` 门登记的
 * **执行条数下限**数的是 `tests/security/` 里的用例，于是把 `validateArchive` 整个删掉、
 * 或者把六个恶意样本的判据逐条去掉，**安全门照样全绿**：它根本不知道这条控制存在。
 * 这与 Task 3 的 C20 裁定（修复轮 1 / Fix 2）是同一个形状，落点也相同。
 *
 * ## 与 `tests/unit/asset/validate-archive.test.ts` 的分工（刻意不重叠）
 *
 * | 问题 | 住哪儿 |
 * |---|---|
 * | 每一条判据的**判别力**、边界（恰好等于上限）、错误文案、C19 零字节条目数据、D6/D7 的细节 | `unit` |
 * | **六条恶意样本必须被拒（且拒在哪条控制上）+ 两条合法样本必须被接受**、零落盘 | **本文件** |
 *
 * 这不是「同一条用例写两遍」：unit 问「这条判据对不对」，security 问「这条控制还在不在」。
 * 共享的是**样本表与构造辅助**，不是断言。
 *
 * ## 每条样本的**控制归属**是断言的一部分
 *
 * 「反正拒了就行」的断言挡不住「所有样本都被同一条规则误拒」。因此下面逐条断言**理由**：
 * 路径穿越落在 yauzl 自带的 `invalid relative path` 上、符号链接落在**我们自己的**外部属性
 * 检查上、炸弹落在压缩比上、洪水落在条目数上、伪装类型落在 magic bytes 上。
 * 两个**合法**样本（`ok.zip` / `ok.tar.gz`）必须被接受——没有它们，
 * 「全部拒绝」的实现也能让这一整套全绿。
 *
 * ## 为什么走**真实** `LocalArtifactStore`
 *
 * 零落盘（C21）这条断言在内存储上**恒真**——那样的用例证明不了任何东西。真实存储会建目录、
 * 写对象，因此「跑完八样本目录里没有新增」才是可以被违反、也就可以被检测的判据。
 */
describe('安全门：八样本判定 + 零落盘（走真实 LocalArtifactStore）', () => {
  const storeEnvKeys = ['TMPDIR', 'TMP', 'TEMP'] as const;
  const savedEnv = new Map<string, string | undefined>();
  let storeRoot = '';
  let probeTmp = '';
  let store: LocalArtifactStore;
  let beforeRun: string[] = [];
  const keysBySample = new Map<string, string>();

  /** 制品库目录 + 临时目录的**全部条目**（相对路径，含目录），排序后便于比较。 */
  async function snapshot(): Promise<string[]> {
    const fromStore = await readdir(storeRoot, { recursive: true });
    const fromTmp = await readdir(probeTmp, { recursive: true });
    return [...fromStore.map((entry) => `store/${entry}`), ...fromTmp.map((entry) => `tmp/${entry}`)].sort();
  }

  beforeAll(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), 'vca-t4-store-'));
    probeTmp = await mkdtemp(join(tmpdir(), 'vca-t4-tmp-'));
    // 把三个临时目录变量指到我们自己的空目录：任何走 `os.tmpdir()` 的写入都会落在
    // **能被断言的**地方（否则「跑完八样本临时目录没新增」这条只是在看别的进程的噪音）。
    for (const name of storeEnvKeys) {
      savedEnv.set(name, process.env[name]);
      process.env[name] = probeTmp;
    }
    store = new LocalArtifactStore(storeRoot);
    for (const sample of ARCHIVE_SAMPLES) {
      // 明文的加密在内存里做完，再把**制品字节**写进真实存储（写入本身是 Task 1/2 的事）。
      const { artifact } = await seedArtifact(new MemoryStore(), sample.bytes(), { chunkSize: 4096 });
      const { key } = await store.putStream(Readable.from([artifact]), { maxBytes: 256 * 1024 * 1024 });
      keysBySample.set(sample.name, key);
    }
    // 快照取在**八样本开始跑之前**：制品本身已经落盘（那是预期的），校验不该再落任何东西。
    beforeRun = await snapshot();
  }, 120_000);

  afterAll(async () => {
    for (const name of storeEnvKeys) {
      const previous = savedEnv.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    await rm(storeRoot, { recursive: true, force: true });
    await rm(probeTmp, { recursive: true, force: true });
  });

  /**
   * 每条样本**期望由哪一条控制拦下**（不是「反正拒了就行」）。
   *
   * 六条恶意样本按控制分开：路径（yauzl 自带防护，D6 约束 1）、链接（我们自己的检查，
   * D6 约束 2）、压缩比（炸弹）、条目数（flood）、类型（magic bytes）。
   * 这一列是刻意留在这里而不是生成器里的：它写的是**实现给出的理由**，
   * 属于用例的知识，不属于样本的形状。
   */
  const SAMPLE_EXPECTATION: Record<string, { kind: 'zip' | 'tar.gz' } | { reason: string }> = {
    'zip-slip.zip': { reason: 'invalid relative path' },
    'symlink.zip': { reason: '符号链接' },
    'bomb.zip': { reason: '压缩比' },
    'flood.zip': { reason: '条目数' },
    'fake-mime.zip': { reason: 'png' },
    'bomb.tar.gz': { reason: '压缩比' },
    'ok.zip': { kind: 'zip' },
    'ok.tar.gz': { kind: 'tar.gz' },
  };

  for (const sample of ARCHIVE_SAMPLES) {
    const expectation = SAMPLE_EXPECTATION[sample.name];
    it(`${sample.name} ⇒ ${sample.expected === 'accept' ? '接受' : '拒绝'}（${sample.note}）`, async () => {
      const key = keysBySample.get(sample.name);
      if (key === undefined) throw new Error(`样本 ${sample.name} 没有写进制品库`);
      const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
      const verdict = await validateArchive(reader);
      if (expectation !== undefined && 'kind' in expectation) {
        expect(verdict).toEqual({ ok: true, kind: expectation.kind });
      } else {
        expect(verdict.ok).toBe(false);
        // 收窄到「被拒」之后再取理由：`reasonOf` 那个小辅助住在 unit 文件里，
        // 这里不复制它，直接用 `if (verdict.ok) throw` 让类型收窄。
        if (verdict.ok) throw new Error('上面的断言已经保证这条样本被拒');
        expect(verdict.reason).toContain(expectation?.reason ?? '');
      }
    }, 120_000);
  }

  it('跑完八样本后：制品库目录与临时目录**零新增文件**（C21 / Step 6）', async () => {
    const afterRun = await snapshot();
    expect(afterRun).toEqual(beforeRun);
    // 顺带把「快照不是空的」钉住：八份制品确实躺在制品库里，否则上面那条恒真
    for (const key of keysBySample.values()) {
      await expect(store.stat(key)).resolves.toMatchObject({ bytes: expect.any(Number) });
    }
    expect(beforeRun.length).toBeGreaterThanOrEqual(8);
    expect(beforeRun.filter((entry) => entry.startsWith('tmp/'))).toHaveLength(0);
  });
});
