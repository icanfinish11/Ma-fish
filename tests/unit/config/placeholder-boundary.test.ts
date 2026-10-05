import { describe, it, expect } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';

/**
 * 划定 `nonPlaceholder` 的**使用边界**：占位值拒绝层只允许用于「密钥」字段。
 *
 * 为什么需要这组用例：该层的词表含 `example`、`todo` 这类通用词（为了堵住
 * `CHANGE_ME_*` 这类长占位值，见 `placeholder-rejection.test.ts`）。它们绝不能
 * 被套到非密钥字段上——`MAIL_FROM=no-reply@example.com` 就是本仓库 `.env.example`
 * 里的合法值，一旦误套，每次启动都会被自己挡住。
 *
 * 判别方式：下面的非密钥字段本身就含 `example` / `todo` 子串。若有人把占位层
 * 扩大到这些字段，用例立刻变红；而密钥字段上的占位拒绝能力仍由 `GITHUB_CLIENT_SECRET`
 * 那一条（以及本文件最后一条「同一个词在密钥侧仍被拒」）守住。
 *
 * ## 修复轮 1（R5）给这一组带来的一个新坑，已在本文件里处理
 *
 * `ARTIFACT_ACTIVE_KEY_ID` 仍然是「不是密钥」的那一类（`example-v1` / `todo` / `test-v2`
 * 都该放行），但 R5 同时加了一条**跨字段**判据：活动 keyId 必须在 `ARTIFACT_KEYS` 环里。
 * 于是「只换 keyId 不换环」会让本用例因为一句「不在环里」而红——看起来像占位层越界，
 * 实际是另一条规则。最后一条用例因此**按 keyId 现造环**，让红的含义保持唯一。
 */

/** AES-256 密钥的 base64（32 个 0xab 字节）。只为凑形状，不是任何真实密钥。 */
const KEY_B64 = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=';

/** 基线 keyId：刻意含占位家族词 `example`（本文件要证明它作为 keyId 是合法的）。 */
const KEY_ID = 'example-v1';

/** keyId → 一把合法密钥的环。 */
const ring = (entries: Record<string, string>): string => JSON.stringify(entries);

/** 合法基线；除用例显式覆写的字段外均通过校验。 */
const VALID = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://app_user:pw@127.0.0.1:5432/vca',
  REDIS_URL: 'redis://127.0.0.1:6379',
  TRUST_PROXY: 'loopback',
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'gho_realistic_oauth_secret_value',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  // P1 / Task 1 新增（见 tests/helpers/env.ts 的 K9 清单）
  ARTIFACT_STORE_DIR: 'C:\\Temp\\vca-artifacts-fixture',
  ARTIFACT_MAX_UPLOAD_BYTES: '4194304',
  // P1 / Task 2 新增（同上清单）。修复轮 1（R5）起是**密钥环** JSON；`ARTIFACT_ACTIVE_KEY_ID`
  // **不是**密钥，因此它在这一组里只负责凑出「完整 env」——它不受占位层约束，也不该受。
  //
  // 基线里的 keyId 刻意就取 `example-v1`：它是本文件要证明「合法」的那一类值。
  // 环里的键名必须与它**一致**——R5 的跨字段判据（active ∈ keys）否则会把
  // 「占位词当 keyId」误报成「不在环里」，让红的含义不再唯一。
  ARTIFACT_KEYS: ring({ [KEY_ID]: KEY_B64 }),
  ARTIFACT_ACTIVE_KEY_ID: KEY_ID,
  // P1 / Task 8 新增（同上清单）：下载票据的 HMAC 密钥（D10）。**它是一个密钥字段**，
  // 因此与 GITHUB_CLIENT_SECRET 同侧——本文件要证明的是「占位层不越界到非密钥字段」，
  // 它在这里只负责凑出「完整 env」，值本身不含占位词（否则基线自己就过不了）。
  DOWNLOAD_URL_SECRET: 'baseline-download-signing-secret-0123456789',
} as unknown as NodeJS.ProcessEnv;

describe('nonPlaceholder 的使用边界（只作用于密钥字段）', () => {
  it('放行含 example 的 MAIL_FROM —— 与 .env.example 逐字一致', () => {
    const result = envSchema.safeParse({ ...VALID, MAIL_FROM: 'no-reply@example.com' });

    if (!result.success) {
      throw new Error(
        `MAIL_FROM 是非密钥字段，不应受占位规则约束；实际报错=${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' | ')}`,
      );
    }
    expect(result.data.MAIL_FROM).toBe('no-reply@example.com');
  });

  it('放行 URL 里含 todo / example 的 DATABASE_URL —— 这类通用词在非密钥配置里合法', () => {
    const url = 'postgresql://app_user:pw@127.0.0.1:5432/todo_example_db';
    const result = envSchema.safeParse({ ...VALID, DATABASE_URL: url });

    if (!result.success) {
      throw new Error(
        `DATABASE_URL 是非密钥字段，不应受占位规则约束；实际报错=${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' | ')}`,
      );
    }
    expect(result.data.DATABASE_URL).toBe(url);
  });

  it('密钥字段上仍然拒绝含占位词的「长」值（边界不得以放松密钥为代价）', () => {
    // 被覆写的字段从 `SESSION_SECRET` 换成了 `GITHUB_CLIENT_SECRET`（最终评审 I-2 删掉了前者：
    // 它必填却无人读取）。`min(1)` 的下游**拦不住**这个 86 字符的值，
    // 因此这里仍然是「占位层自己在承重」的判别式。
    const result = envSchema.safeParse({
      ...VALID,
      GITHUB_CLIENT_SECRET: `${'x'.repeat(40)}-changeme-${'y'.repeat(40)}`,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('GITHUB_CLIENT_SECRET');
    }
  });

  it('放行含 example / todo 的 ARTIFACT_ACTIVE_KEY_ID —— 它是标识符，不是密钥', () => {
    // 判别式：把 nonPlaceholder 套到 ARTIFACT_ACTIVE_KEY_ID 上，这三条立刻变红。
    // 它会逐字写进每份制品的文件头、也会出现在日志里，
    // 因此拿 `test` / `example` 这类词当 keyId 是**合法**的运维选择。
    //
    // 注意本用例与 ARTIFACT_KEYS 的关系：keyId 换了名，环里的键名也要跟着换，
    // 否则会撞上修复轮 1（R5）新加的跨字段判据「active ∈ keys」——
    // 那时本用例会因为一句「不在环里」而红，看起来像占位层的锅，实际不是。
    // 所以这里的环是按 keyId 现造的。
    for (const keyId of ['example-v1', 'todo', 'test-v2']) {
      const result = envSchema.safeParse({ ...VALID, ARTIFACT_KEYS: ring({ [keyId]: KEY_B64 }), ARTIFACT_ACTIVE_KEY_ID: keyId });

      if (!result.success) {
        throw new Error(
          `ARTIFACT_ACTIVE_KEY_ID 不是密钥字段，不应受占位规则约束；keyId=${keyId}，实际报错=${result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join(' | ')}`,
        );
      }
      expect(result.data.ARTIFACT_ACTIVE_KEY_ID).toBe(keyId);
    }
  });

  it('ARTIFACT_KEYS 是密钥字段，占位词在那里依然被拒（边界不得以放松密钥为代价）', () => {
    // 与上一条成对：同一个词 `example` 放在 **keyId** 上合法、放在**密钥**上非法。
    // 判据是「它出现在哪一侧」，不是「这个词本身」——这正是占位层使用边界的定义。
    const result = envSchema.safeParse({ ...VALID, ARTIFACT_KEYS: ring({ v1: 'example' }) });

    expect(result.success).toBe(false);
  });
});
