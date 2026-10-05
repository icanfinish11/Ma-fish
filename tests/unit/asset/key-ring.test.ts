import { describe, expect, it } from 'vitest';
import { createKeyRing, parseArtifactKeys } from '@vca/api/modules/asset/crypto/key-ring.js';
import { envSchema } from '@vca/api/config/env.schema.js';

/**
 * 密钥环（P1 / Task 2，规格 D5 / C10 + 修复轮 1 的 R5）。
 *
 * ## 这组用例在防什么
 *
 * 1. **绝不回退到默认键**（本文件的核心）。缺失当前写入键、或遇到未知 keyId 时，
 *    唯一可接受的结局是**抛错**。回退的失效形态很具体：轮换之后旧 keyId 被悄悄
 *    当成新键使用 ⇒ 新写入的制品用错了密钥，而**没有任何地方会报错**——
 *    直到某天按 keyId 去解密时才发现解不开。
 * 2. **环里必须能装多个键，且活动键必须真的在环里**（R5）。上一版的入参是**单个**
 *    主密钥 ⇒ 环里恰好只有一个条目 ⇒ 轮换必然替换掉它，旧制品立刻变成「未知 keyId」
 *    ——「旧制品按其 keyId 继续可读」在格式上成立、在部署上不成立。而且上一版只校验
 *    「变量存在」，于是进程可以带着一个环里没有的活动 keyId 启动，
 *    直到第一次上传加密时才失败。这两条现在都有用例（下面「轮换」与「引导期」两组）。
 * 3. **密钥只在环里**：`keyFor` 的返回值不得是环内部那份缓冲本身（调用方一改，
 *    全进程后续加密就都用错字节），错误信息里也不得带上密钥内容（C11）。
 * 4. **keyId 的形状**：环按 keyId 分发密钥，密钥的形状（base64 → 32 字节）在这里收口，
 *    且与 `env.schema.ts` 里那份正则**逐字一致**（下面有一条用例专门比对两处）。
 *
 * 环境变量层的必填/占位拒绝在 `tests/unit/config/env.schema.test.ts`；
 * 本文件测的是「从一份已经合法的配置构造出来的环」的行为——那是加密器唯一能看到的界面。
 */
const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY_B64 = Buffer.from(KEY_HEX, 'hex').toString('base64');

/** 另一把 32 字节密钥（全 0xff），用来验证「按 keyId 取的是各自那一把」。 */
const OTHER_KEY_B64 = Buffer.alloc(32, 0xff).toString('base64');

/** 完整合法配置；每个用例只覆写它关心的字段。 */
function envWith(overrides: Partial<{ ARTIFACT_KEYS: string; ARTIFACT_ACTIVE_KEY_ID: string }> = {}) {
  return { ARTIFACT_KEYS: JSON.stringify({ v1: KEY_B64 }), ARTIFACT_ACTIVE_KEY_ID: 'v1', ...overrides };
}

/** 一套「完整合法 env」，只为构造 `envSchema.parse` 的对照（下面「两处正则一致」那条用）。 */
const FULL_ENV = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://app_user:pw@127.0.0.1:5432/vca',
  REDIS_URL: 'redis://127.0.0.1:6379',
  TRUST_PROXY: 'loopback',
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  ARTIFACT_STORE_DIR: 'C:\\Temp\\vca-artifacts-fixture',
  ARTIFACT_MAX_UPLOAD_BYTES: '4194304',
  ARTIFACT_KEYS: envWith().ARTIFACT_KEYS,
  ARTIFACT_ACTIVE_KEY_ID: 'v1',
  // P1 / Task 8 新增（见 tests/helpers/env.ts 的 K9 清单）：下载票据的 HMAC 密钥。
  // 本文件只用到密钥环，这一行是为了让这份「完整合法 env」仍然是完整的。
  DOWNLOAD_URL_SECRET: 'test-download-url-secret-0123456789abcdef',
} as unknown as NodeJS.ProcessEnv;

describe('createKeyRing（keyId → 密钥）', () => {
  it('activeKeyId() 原样回报配置里的 keyId', () => {
    expect(createKeyRing(envWith()).activeKeyId()).toBe('v1');
    expect(
      createKeyRing(envWith({ ARTIFACT_KEYS: JSON.stringify({ '2026-q4': KEY_B64 }), ARTIFACT_ACTIVE_KEY_ID: '2026-q4' }))
        .activeKeyId(),
    ).toBe('2026-q4');
  });

  it('keyFor(activeKeyId) 返回那把密钥的 32 字节（逐字节，不是只看长度）', () => {
    const key = createKeyRing(envWith()).keyFor('v1');

    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
  });

  it('按 keyId 取的是**各自那一把**：环里两把键不会串位', () => {
    const ring = createKeyRing(
      envWith({ ARTIFACT_KEYS: JSON.stringify({ v1: KEY_B64, v2: OTHER_KEY_B64 }), ARTIFACT_ACTIVE_KEY_ID: 'v2' }),
    );

    expect(ring.keyFor('v1').equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
    expect(ring.keyFor('v2').equals(Buffer.alloc(32, 0xff))).toBe(true);
    expect(ring.keyFor('v1').equals(ring.keyFor('v2'))).toBe(false);
  });

  it('base64 的大小写与 URL-safe 形态解出相同字节', () => {
    // 同一个 32 字节缓冲的三种合法写法：标准、URL-safe、带填充
    const standard = Buffer.from(KEY_HEX, 'hex').toString('base64');
    const urlSafe = Buffer.from(KEY_HEX, 'hex').toString('base64url');
    const variants = [standard, urlSafe, `${urlSafe}=`];

    for (const variant of variants) {
      const key = createKeyRing(envWith({ ARTIFACT_KEYS: JSON.stringify({ v1: variant }) })).keyFor('v1');
      expect(key.equals(Buffer.from(KEY_HEX, 'hex')), `变体 ${variant} 解出的字节不对`).toBe(true);
    }
  });

  it('缺少 ARTIFACT_KEYS ⇒ 抛错（不回退）', () => {
    expect(() => createKeyRing(envWith({ ARTIFACT_KEYS: '' }))).toThrow(/ARTIFACT_KEYS/);
    // 运行时可能拿到 undefined（JS 调用方 / 测试替身），一并 fail-closed
    expect(() => createKeyRing({ ARTIFACT_ACTIVE_KEY_ID: 'v1' })).toThrow(/ARTIFACT_KEYS/);
    expect(() => createKeyRing(undefined as unknown as { ARTIFACT_KEYS?: string })).toThrow(/ARTIFACT_KEYS/);
  });

  it('环不是合法 JSON / 不是对象 / 是空环 ⇒ 抛错', () => {
    for (const [why, keys] of [
      ['不是 JSON', 'v1:AAAA'],
      ['JSON 数组', '["v1"]'],
      ['JSON 标量', '"v1"'],
      ['空环', '{}'],
    ] as Array<[string, string]>) {
      expect(() => createKeyRing(envWith({ ARTIFACT_KEYS: keys })), why).toThrow(/ARTIFACT_KEYS/);
    }
  });

  it('密钥不是 32 字节 / 不是 base64 ⇒ 抛错（静默丢一个键等于悄悄把它退役）', () => {
    const good = Buffer.from(KEY_HEX, 'hex').toString('base64');
    for (const [why, value] of [
      ['31 字节', good.slice(0, 42)],
      ['33 字节', `${Buffer.alloc(33, 1).toString('base64')}`],
      ['非法字符', `${'A'.repeat(44)}!!!`],
      ['空串', ''],
    ] as Array<[string, string]>) {
      expect(
        () => createKeyRing(envWith({ ARTIFACT_KEYS: JSON.stringify({ v1: value }) })),
        `应当拒绝「${why}」`,
      ).toThrow(/ARTIFACT_KEYS/);
    }
  });

  it('keyId 形状非法 ⇒ 抛错', () => {
    for (const bad of ['', ' ', '-v1', 'v1:x', 'v 1', 'k'.repeat(65)]) {
      expect(
        () => createKeyRing(envWith({ ARTIFACT_KEYS: JSON.stringify({ [bad]: KEY_B64 }) })),
        `keyId ${JSON.stringify(bad)} 不该被接受`,
      ).toThrow(/ARTIFACT_KEYS/);
    }
  });

  it('缺少 ARTIFACT_ACTIVE_KEY_ID ⇒ 抛错（没有「悄悄用某个默认 keyId」这条路）', () => {
    expect(() => createKeyRing(envWith({ ARTIFACT_ACTIVE_KEY_ID: '' }))).toThrow(/ARTIFACT_ACTIVE_KEY_ID/);
    expect(() => createKeyRing({ ARTIFACT_KEYS: JSON.stringify({ v1: KEY_B64 }) })).toThrow(
      /ARTIFACT_ACTIVE_KEY_ID/,
    );
  });

  it('未知 keyId ⇒ 抛错，**绝不回退到活动键**', () => {
    const ring = createKeyRing(envWith());

    // 判别式：回退实现会在这里回一个 32 字节的 Buffer（即活动键），于是本断言变红。
    expect(() => ring.keyFor('v0')).toThrow(/v0/);
    expect(() => ring.keyFor('V1')).toThrow(/V1/); // keyId 区分大小写，不做归一化
    expect(() => ring.keyFor('')).toThrow();
    expect(() => ring.keyFor('v1 ')).toThrow();
  });

  /**
   * ## R5 的核心：轮换在部署层真的可达了
   *
   * 上一版这条用例的标题是「活动键是 v2 时，v1 不在环中 ⇒ 抛错（环里只有一个 keyId）」
   * ——它当时钉住的是「别为了能解 v1 而偷偷回退到活动键」，而**原因**是环里根本装不下
   * 第二个键。R5 把环境面改成映射之后，这条用例的**方向也变了**：现在 v1 与 v2 可以
   * 同时在环里，读取端解旧制品走的是「已知但非活动」的正路，而不是回退。
   */
  it('轮换：v1 与 v2 同时在环里 ⇒ 活动键是 v2，而 v1 **仍然可读**（已知但非活动）', () => {
    const ring = createKeyRing(
      envWith({
        ARTIFACT_KEYS: JSON.stringify({ v1: KEY_B64, v2: OTHER_KEY_B64 }),
        ARTIFACT_ACTIVE_KEY_ID: 'v2',
      }),
    );

    expect(ring.activeKeyId()).toBe('v2');
    expect(ring.keyFor('v2').equals(Buffer.alloc(32, 0xff))).toBe(true);
    // 已退役的 keyId：取得到、且取的是**它自己**那把键（不是活动键）
    expect(ring.keyFor('v1').equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
    expect(ring.keyFor('v1').equals(ring.keyFor('v2'))).toBe(false);
    // 而真正不在环里的 keyId 照旧拒绝
    expect(() => ring.keyFor('v3')).toThrow(/v3/);
  });

  it('**活动 keyId 不在环里 ⇒ 构造期就抛错**，并说清「环里有什么」', () => {
    // 这是 R5 的 fail-fast：上一版只查存在性，进程可以带着这种配置启动，
    // 直到 `new ChunkEncryptor(...)` 才失败——那时一次上传已经开始。
    const keys = JSON.stringify({ v1: KEY_B64, v2: OTHER_KEY_B64 });

    expect(() => createKeyRing(envWith({ ARTIFACT_KEYS: keys, ARTIFACT_ACTIVE_KEY_ID: 'v9' }))).toThrow(
      /ARTIFACT_ACTIVE_KEY_ID/,
    );

    let message = '';
    try {
      createKeyRing(envWith({ ARTIFACT_KEYS: keys, ARTIFACT_ACTIVE_KEY_ID: 'v9' }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // 报错要能直接指导运维：点名不在环里的那个 keyId，并列出环里有哪些（keyId 不是密钥）
    expect(message).toContain('不在 ARTIFACT_KEYS 的环里');
    expect(message).toContain('"v9"');
    expect(message).toContain('"v1"');
    expect(message).toContain('"v2"');
  });

  it('环不因调用方改写返回值而损坏（keyFor 必须回拷贝）', () => {
    const ring = createKeyRing(envWith());
    const first = ring.keyFor('v1');
    first.fill(0);

    expect(ring.keyFor('v1').equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
  });

  it('错误信息里不出现密钥内容（C11）', () => {
    // 用一段「一眼能认出来」的密钥去构造，断言它没有出现在任何报错文本里。
    // 注意密钥材料在这里是 **base64 文本**，所以两种形态都要断言：base64 与它解出的 hex。
    const secretB64 = Buffer.from('deadbeef'.repeat(8), 'hex').toString('base64');

    try {
      createKeyRing(envWith({ ARTIFACT_KEYS: JSON.stringify({ v1: secretB64 }) })).keyFor('nope');
      throw new Error('未知 keyId 未抛错');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretB64);
      expect(message).not.toContain('deadbeef');
    }

    // 连「不是合法 JSON」这条路径也不许回显原文——原文里就是密钥材料
    try {
      createKeyRing(envWith({ ARTIFACT_KEYS: `{"v1":"${secretB64}"` }));
      throw new Error('非法 JSON 未抛错');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretB64);
      expect(message).not.toContain('deadbeef');
    }

    // 占位值那条路径同样只点名 keyId
    try {
      createKeyRing(envWith({ ARTIFACT_KEYS: JSON.stringify({ v1: 'A'.repeat(43) + 'example' }) }));
      throw new Error('占位值未抛错');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('"v1"');
      expect(message).not.toContain('example');
    }
  });
});

/**
 * 环的解析与 `env.schema.ts` 里那份**必须一致**：两处存在是刻意的（一处是引导期 schema、
 * 一处是模块自己的构造期判据，模块可被非 NestJS 调用方直接使用），
 * 但要防的是「两处各自漂移」——那会表现为「schema 放过的配置，构造环时才炸」。
 *
 * 判据用 `parseArtifactKeys`（本模块导出的纯函数，就是 `createKeyRing` 内部用的那一个）
 * 与 `envSchema` 的**行为**逐条比对，而不是去比对两边的正则字面量：
 * 行为一致才是要的性质。
 */
describe('模块判据与引导期 schema 一致（行为比对，不是字面量比对）', () => {
  const keyIdCases = ['v1', 'V1', 'a', '0', '2026-q4', 'a.b_c-d', 'k'.repeat(64), '', '-v1', 'v1:x', 'v 1', '轮换', 'k'.repeat(65)];
  const keyValueCases = [
    KEY_B64,
    OTHER_KEY_B64,
    'A'.repeat(43) + 'x',
    'A'.repeat(44) + '!!!',
    'CHANGE_ME_BASE64_OF_32_BYTES',
    'example',
    '',
  ];

  it('同一个 keyId / 密钥值的接受-拒绝结论，模块侧与 schema 侧逐条相同', () => {
    for (const keyId of keyIdCases) {
      for (const value of keyValueCases) {
        const raw = JSON.stringify({ [keyId]: value });
        const moduleSide = parseArtifactKeys(raw).ok;
        const schemaSide = envSchema.safeParse({ ...FULL_ENV, ARTIFACT_KEYS: raw, ARTIFACT_ACTIVE_KEY_ID: keyId }).success;

        expect(
          schemaSide,
          `keyId=${JSON.stringify(keyId)} value=${JSON.stringify(value)}：` +
            `模块侧=${moduleSide ? '接受' : '拒绝'}，schema 侧=${schemaSide ? '接受' : '拒绝'}——两处判据漂移了`,
        ).toBe(moduleSide);
      }
    }
  });
});
