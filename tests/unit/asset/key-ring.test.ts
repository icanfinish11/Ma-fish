import { describe, expect, it } from 'vitest';
import { createKeyRing } from '@vca/api/modules/asset/crypto/key-ring.js';

/**
 * 密钥环（P1 / Task 2，规格 D5 / C10）。
 *
 * ## 这组用例在防什么
 *
 * 1. **绝不回退到默认键**（本文件的核心）。缺失当前写入键、或遇到未知 keyId 时，
 *    唯一可接受的结局是**抛错**。回退的失效形态很具体：轮换之后旧 keyId 被悄悄
 *    当成新键使用 ⇒ 新写入的制品用错了密钥，而**没有任何地方会报错**——
 *    直到某天按 keyId 去解密时才发现解不开。
 * 2. **密钥只在环里**：`keyFor` 的返回值不得是环内部那份缓冲本身（调用方一改，
 *    全进程后续加密就都用错字节），错误信息里也不得带上密钥内容（C11）。
 * 3. **keyId 的语义**：环按 keyId 分发密钥，键的形状（64 位 hex = 32 字节）在这里收口。
 *
 * 环境变量层的必填/占位拒绝在 `tests/unit/config/env.schema.test.ts`；
 * 本文件只测「从一份已经合法的配置构造出来的环」的行为——那是加密器唯一能看到的界面。
 */
const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

/** 完整合法配置；每个用例只覆写它关心的字段。 */
function envWith(overrides: Partial<{ ARTIFACT_MASTER_KEY: string; ARTIFACT_ACTIVE_KEY_ID: string }> = {}) {
  return { ARTIFACT_MASTER_KEY: KEY_HEX, ARTIFACT_ACTIVE_KEY_ID: 'v1', ...overrides };
}

describe('createKeyRing（keyId → 密钥）', () => {
  it('activeKeyId() 原样回报配置里的 keyId', () => {
    expect(createKeyRing(envWith()).activeKeyId()).toBe('v1');
    expect(createKeyRing(envWith({ ARTIFACT_ACTIVE_KEY_ID: '2026-q4' })).activeKeyId()).toBe('2026-q4');
  });

  it('keyFor(activeKeyId) 返回主密钥的 32 字节（逐字节，不是只看长度）', () => {
    const key = createKeyRing(envWith()).keyFor('v1');

    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
  });

  it('十六进制大小写不敏感，解出的字节相同', () => {
    const lower = createKeyRing(envWith({ ARTIFACT_MASTER_KEY: KEY_HEX })).keyFor('v1');
    const upper = createKeyRing(envWith({ ARTIFACT_MASTER_KEY: KEY_HEX.toUpperCase() })).keyFor('v1');

    expect(upper.equals(lower)).toBe(true);
  });

  it('缺少 ARTIFACT_MASTER_KEY ⇒ 抛错（不回退）', () => {
    expect(() => createKeyRing(envWith({ ARTIFACT_MASTER_KEY: '' }))).toThrow(/ARTIFACT_MASTER_KEY/);
    // 运行时可能拿到 undefined（JS 调用方 / 测试替身），一并 fail-closed
    expect(() =>
      createKeyRing({ ARTIFACT_ACTIVE_KEY_ID: 'v1' } as unknown as { ARTIFACT_MASTER_KEY: string; ARTIFACT_ACTIVE_KEY_ID: string }),
    ).toThrow(/ARTIFACT_MASTER_KEY/);
  });

  it('密钥不是 32 字节 / 不是 hex ⇒ 抛错', () => {
    expect(() => createKeyRing(envWith({ ARTIFACT_MASTER_KEY: 'ab'.repeat(31) }))).toThrow(/ARTIFACT_MASTER_KEY/);
    expect(() => createKeyRing(envWith({ ARTIFACT_MASTER_KEY: 'ab'.repeat(33) }))).toThrow(/ARTIFACT_MASTER_KEY/);
    expect(() => createKeyRing(envWith({ ARTIFACT_MASTER_KEY: 'zz'.repeat(32) }))).toThrow(/ARTIFACT_MASTER_KEY/);
  });

  it('缺少 ARTIFACT_ACTIVE_KEY_ID ⇒ 抛错（没有「悄悄用某个默认 keyId」这条路）', () => {
    expect(() => createKeyRing(envWith({ ARTIFACT_ACTIVE_KEY_ID: '' }))).toThrow(/ARTIFACT_ACTIVE_KEY_ID/);
  });

  it('未知 keyId ⇒ 抛错，**绝不回退到活动键**', () => {
    const ring = createKeyRing(envWith());

    // 判别式：回退实现会在这里回一个 32 字节的 Buffer（即活动键），于是本断言变红。
    expect(() => ring.keyFor('v0')).toThrow(/v0/);
    expect(() => ring.keyFor('V1')).toThrow(/V1/); // keyId 区分大小写，不做归一化
    expect(() => ring.keyFor('')).toThrow();
    expect(() => ring.keyFor('v1 ')).toThrow();
  });

  it('轮换：活动键是 v2 时，v1 不在环中 ⇒ 抛错（环里只有一个 keyId）', () => {
    // 据实记载：`createKeyRing(env)` 的入参只有**一个**主密钥，因此今天的环里恰好只有
    // 「活动 keyId」这一个键。轮换到 v2 之后旧制品仍可按 v1 读，靠的是**读取端**能构造出
    // 含 v1 的环——那需要在环境里表达多个密钥，是 D5 尚未落地的部分（见 task-2-report 的
    // Concerns）。本用例钉住的是「别为了让 v1 能解而偷偷回退到活动键」这条底线。
    const ring = createKeyRing(envWith({ ARTIFACT_ACTIVE_KEY_ID: 'v2' }));

    expect(ring.activeKeyId()).toBe('v2');
    expect(ring.keyFor('v2').equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
    expect(() => ring.keyFor('v1')).toThrow(/v1/);
  });

  it('环不因调用方改写返回值而损坏（keyFor 必须回拷贝）', () => {
    const ring = createKeyRing(envWith());
    const first = ring.keyFor('v1');
    first.fill(0);

    expect(ring.keyFor('v1').equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
  });

  it('错误信息里不出现密钥内容（C11）', () => {
    // 用一段「一眼能认出来」的密钥去构造，断言它没有出现在任何报错文本里。
    const secret = 'deadbeef'.repeat(8);
    try {
      // 合法构造 + 一次非法查询：两条报错路径都不能把密钥打出来
      createKeyRing(envWith({ ARTIFACT_MASTER_KEY: secret })).keyFor('nope');
      throw new Error('未知 keyId 未抛错');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain('deadbeef');
    }

    for (const bad of ['', 'zz'.repeat(32), 'ab'.repeat(31)]) {
      try {
        createKeyRing(envWith({ ARTIFACT_MASTER_KEY: bad }));
        throw new Error(`非法密钥未被拒绝：${bad}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(bad === '' ? '@@@' : bad);
      }
    }
  });
});
