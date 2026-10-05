import { describe, expect, it } from 'vitest';
import { EncryptedArtifactReader } from '@vca/api/modules/asset/store/random-access-reader.js';
// **复用** unit 那个文件用的同一批夹具（构造 / 伪造 / 观察），不复制夹具、也不复制用例。
// 见 `tests/helpers/craft-encrypted-artifact.ts` 的文件头：两个 project 各自的断言**不重叠**。
import {
  MemoryStore,
  at,
  collect,
  entriesOf,
  fakeRing,
  openForged,
  openForgedReader,
  pattern,
  readRange,
  recordRange,
  seedArtifact,
  swapRecords,
  truncateLastBlocks,
  withChunkSize,
  withFooter,
  withIndexEntry,
} from '../helpers/craft-encrypted-artifact.js';

/**
 * 加密制品（P1）的**安全门**：制品是被攻击者控制的输入，而它的**头与尾部都不在任何 AAD 里**。
 *
 * ## 为什么这一组必须住在 `security` 而不是只住在 `unit`（修复轮 1 / Fix 2）
 *
 * `scripts/assert-tests-ran.mjs` 给 `security` 门登记了一个**执行条数下限**：门的覆盖面缩小
 * 必须是一次有意识的改动。而 Task 3 新增的 40 条用例此前**全部**在 `unit`——于是
 * 「制品完整性判据」这条控制**不在这道门的账上**：把 `validateIndexContents` 整个删掉，
 * `security` 门照样绿（它只数 `tests/security/` 里的条数）。
 * 这不是「多写一遍测试」，而是**让这条控制进入被计数的门**。
 *
 * ## 与 `tests/unit/asset/random-access-reader.test.ts` 的分工
 *
 * | 问题 | 住哪儿 |
 * |---|---|
 * | 每条判据的**判别力**（变异探针下只有它自己变红）与精确错误信息 | `unit` |
 * | 三类伪造**必须被拒**、且拒绝落在安全控制上 | **本文件** |
 *
 * 夹具同一份（`tests/helpers/craft-encrypted-artifact.ts`），用例不重复。
 *
 * ## 这一类伪造的形状（全部是「制品被改过」而不是「代码有 bug」）
 *
 * 1. **整体调换两条记录**（连各自的 nonce、tag、自称序号一起换）：索引在「信任自称序号」的
 *    解读下完全自洽 ⇒ 必须由 C20 的位置比对拒绝。**这是本任务的核心控制**。
 * 2. **三条完整性校验各自的孤立违反**：条数、块数公式、密文长度合计。
 *    `chunkSize` 与尾部总量都在**未认证区**，因此它们是攻击者可以直接改的字段。
 * 3. **完全自洽的整块截断**：三条校验全部满足、`open()` 成功，唯一挡住它的是末块的
 *    `isLast` AAD 标记 —— 前提是读取**走到自称的末尾**。这条前提由本文件的最后一条用例
 *    机械地钉住（修复轮 1 / Fix 1 + Fix 3）：走到自称末尾的那次读**必须**认证最后一块。
 */
describe('加密制品的完整性控制（C20 + 三条校验 + 整块截断）', () => {
  it('整体调换两条记录（含 nonce 与 tag）⇒ 读取时被 C20 拒绝，而不是静默重排明文', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 40), { chunkSize: 64 });
    // 调换**完全自洽**：offset / 长度 / 条数 / 合计一个字节都没变
    const key = store.seed(swapRecords(seeded.artifact, 0, 1));

    // open 必须成功——静态校验看不出这种调换，这正是它危险的地方
    const reader = await EncryptedArtifactReader.open(store, key, fakeRing());
    expect(reader.plaintextLength).toBe(192);

    // 但读第 0 块时**必须**报「记录自称的序号与位置不符」，而不是返回第 1 块的明文
    const first = await readRange(reader, 0, 64);
    expect(first.bytes, '调换被静默接受：明文被重排且认证通过').toBeNull();
    expect(first.message).toMatch(/位置 0 处的记录自称序号 1/);
    // 且这条拒绝**不是** GCM 认证恰好也失败——消息里必须不含认证措辞
    expect(first.message).not.toMatch(/认证失败|authenticate|Unsupported state/);
    // 第 1 块同样被拒（换回去的另一半）
    expect((await readRange(reader, 64, 128)).message).toMatch(/位置 1 处的记录自称序号 0/);
    // 没被调换的第 2 块照常可读 ⇒ 拒绝来自位置比对，不是读取器整体坏掉
    expect((await collect(reader._readStreamForRange(128, 192))).equals(seeded.plaintext.subarray(128, 192))).toBe(
      true,
    );
  });

  it('尾部自称的块数大于索引区实际记录数 ⇒ 拒绝（事实来源是文件几何，不是自称值）', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 41), { chunkSize: 64 });
    // chunkSize 一并改成 96，好让块数公式那条仍然满足 ⇒ 判别力孤立在「实际记录数」上
    const forged = withChunkSize(withFooter(seeded.artifact, { chunkCount: 2n }), 96);

    const message = await openForged(forged);
    expect(message).toMatch(/索引记录数不符/);
    expect(message).toMatch(/自称 2 块/);
    expect(message).toMatch(/实际存在 3 条记录/);
  });

  it('`chunkCount !== ceil(plaintextLength / chunkSize)` ⇒ 拒绝（chunkSize 在未认证的头部里）', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 42), { chunkSize: 64 });
    // 只改头部：条数与合计都没动 ⇒ 只有块数公式这条会响
    const forged = withChunkSize(seeded.artifact, 96);

    const message = await openForged(forged);
    // 与 unit 那条的差别：这里要的是「这条控制还在，且拒绝理由落在块数公式上」，
    // 判别力（探针下只有它自己变红）由 unit 的用例负责。
    expect(message).toMatch(/块数公式不符/);
    expect(message).toMatch(/chunkSize=96/);
  });

  it('`Σ ciphertextLength !== plaintextLength` ⇒ 拒绝（唯一约束索引内容的一条）', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 43), { chunkSize: 64 });
    const entries = entriesOf(seeded.artifact);
    // 只改第 2 条记录声明的长度：offset 不动 ⇒ 递增、连续性、区间上界、条数、公式全都仍然成立
    const forged = withIndexEntry(seeded.artifact, 2, { ...at(entries, 2), ciphertextLength: 40 });

    const message = await openForged(forged);
    expect(message).toMatch(/密文长度合计不符/);
    expect(message).toMatch(/合计 168/);
  });

  it('索引坐标不连续（中段记录被往前挪）⇒ 拒绝，且理由指向坐标而不是「密文被篡改」', async () => {
    const store = new MemoryStore();
    const seeded = await seedArtifact(store, pattern(192, 44), { chunkSize: 64 });
    const entries = entriesOf(seeded.artifact);
    // 往前挪 8 字节 ⇒ 与上一块**重叠** 8 字节；递增（相对上一条的起点）与区间上界都仍然成立
    const forged = withIndexEntry(seeded.artifact, 1, { ...at(entries, 1), offset: at(entries, 1).offset - 8n });

    const message = await openForged(forged);
    expect(message).toMatch(/索引记录不连续/);
    // 并且这一条的判别力是**坐标级**的：错误信息里出现的是 offset，不是认证失败
    expect(message).not.toMatch(/认证失败/);
  });

  /**
   * **整块截断**这条边界（本任务发现的、最值得记下来的一件事）。
   *
   * 攻击者删掉末尾整块**连同它的索引记录**，并把尾部的三个字段改得完全自洽。三条校验
   * 全部满足 ⇒ `open()` **成功**，而且自称的明文长度也自洽。唯一挡住它的是末块的
   * `isLast` AAD 标记：留下的最后一块当初是用 `more` 建的，读取端却按 `last` 去认证。
   *
   * 这个防线是**完整**的（复审的精确化）：截断到 n 块必然逼着读取端把真实的第 n-1 块
   * 当末块去认证，而那块的标记是 `more` ⇒ 必拒。唯一的前提是**读取走到自称的末尾**
   * ——本用例把这条前提也机械地断言了（Fix 1）：那次读解密的块**恰好是索引最后一条记录**。
   * 把末块从读取路径里去掉（`serveRange` 提前 return），这条断言立刻变红。
   */
  it('完全自洽的整块截断：`open()` 通过，但**走到自称末尾**的那次读必须认证末块并失败', async () => {
    const seeded = await seedArtifact(new MemoryStore(), pattern(192, 45), { chunkSize: 64 });
    const forged = truncateLastBlocks(seeded.artifact);

    // 自洽性复核：索引区 2 * 24 = 48 ⇒ 自称 2 块 ✓；ceil(128/64) = 2 ✓；64 + 64 = 128 ✓
    const opened = await openForgedReader(forged);
    expect(opened.message, '这种伪造在 open 阶段是看不出来的——它必须靠末块认证').toBe('');
    const reader = opened.reader;
    if (reader === null) throw new Error('上面的断言已经保证 reader 存在');
    expect(reader.plaintextLength).toBe(128);

    // 走到**自称的末尾**去读：这次读会认证真实的第 1 块（它的标记是 more）⇒ 必拒。
    // **注意用 `opened.store`**：制品是 `openForgedReader` 自己放进那个替身里的，
    // 另起一个 MemoryStore 记不到这次读（第一版就是这么拿到 undefined 的）。
    opened.store.reset();
    const full = await readRange(reader, 0, reader.plaintextLength);
    expect(full.bytes, '自洽的整块截断被当成了合法制品').toBeNull();
    expect(full.message).toMatch(/第 1 块认证失败/);

    // **Fix 1 的机械判据**：**任何走到自称末尾的读**都会请求并解密索引的最后一条记录。
    // 少了这一条，「末块认证」这项 Task 4 的义务就只存在于注释里：把末块从读取路径里
    // 去掉（探针 `last-block-not-read`），上面那句 /第 1 块认证失败/ 会变成
    // 「成功返回 128 字节」——而如果没有下面的断言，那条用例仍然是绿的。
    const expectedLastRead = { key: opened.key, ...recordRange(at(entriesOf(forged), 1)) };
    expect(opened.store.requests.at(-1)).toEqual(expectedLastRead);
    expect(opened.store.requests.filter((request) => request.start === expectedLastRead.start)).toHaveLength(1);

    // 截断之前的那一块照常可读（拒绝来自末块标记，不是读取器坏掉）
    expect((await collect(reader._readStreamForRange(0, 64))).equals(seeded.plaintext.subarray(0, 64))).toBe(true);
  });
});
