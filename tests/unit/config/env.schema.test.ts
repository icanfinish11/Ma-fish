import { describe, it, expect } from 'vitest';
import { parseEnv } from '@vca/api/config/env.schema.js';

/**
 * 密钥环字面量的**构造器**（不是又一份硬编码副本）：只在一处写清「这些字节长什么样」，
 * 下面的夹具与断言都从它派生。密钥环的键是 base64 文本，手写 base64 极易写错一位而
 * 得到一把**长度仍然合法**的错密钥——那种错误在用例里只会表现为「校验通过」，
 * 于是夹具从此与它自称的字节无关。派生比硬编码更安全（上一层是 hex，肉眼可读；
 * 这一层是 base64，不可读）。
 */
const base64Key = (byte: string): string => Buffer.from(byte.repeat(32), 'hex').toString('base64');
/** 一个 keyId → 一把密钥的环。 */
const ring = (entries: Record<string, string>): string => JSON.stringify(entries);

const VALID = {
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
  // P1 / Task 1 新增（见 tests/helpers/env.ts 的 K9 清单）
  ARTIFACT_STORE_DIR: 'C:\\Temp\\vca-artifacts-fixture',
  ARTIFACT_MAX_UPLOAD_BYTES: '4194304',
  // P1 / Task 2 新增（同上清单）。修复轮 1 起是**密钥环**（R5），不再是单个主密钥。
  ARTIFACT_KEYS: ring({ v1: base64Key('cb') }),
  ARTIFACT_ACTIVE_KEY_ID: 'v1',
  // P1 / Task 8 新增（见 tests/helpers/env.ts 的 K9 清单）：下载票据的 HMAC 密钥（D10）。
  // 这里只是**一次性测试值**，不是密钥。
  DOWNLOAD_URL_SECRET: 'test-download-url-secret-0123456789abcdef',
} as unknown as NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('接受完整合法配置并做类型转换', () => {
    const env = parseEnv(VALID);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('缺少必填密钥时抛错并指出字段名', () => {
    // 与计划逐字版的差异：计划用 `const { X, ...rest }` 解构剔除，
    // 那会留下未使用的绑定，被 @typescript-eslint/no-unused-vars 判错（本仓库 lint 门为 error）。
    // 改为解构后显式 delete，语义相同且不产生死绑定。
    //
    // 被剔除的字段从 `SESSION_SECRET` 换成了 `GITHUB_CLIENT_SECRET`（最终评审 I-2 删掉了前者：
    // 它必填却无人读取）。**「缺一个必填变量就拒绝启动」这条性质本身不变**。
    const rest = { ...VALID };
    delete rest.GITHUB_CLIENT_SECRET;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrowError(/GITHUB_CLIENT_SECRET/);
  });

  it('拒绝占位默认值（生产环境）', () => {
    expect(() =>
      parseEnv({ ...VALID, NODE_ENV: 'production', GITHUB_CLIENT_SECRET: 'changeme' } as NodeJS.ProcessEnv),
    ).toThrowError(/GITHUB_CLIENT_SECRET/);
  });

  it('拒绝未知的 NODE_ENV', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'staging' } as NodeJS.ProcessEnv)).toThrowError(/NODE_ENV/);
  });

  it('拒绝非 32 字节的主密钥（AES-256 需要 32 字节）', () => {
    // 上一版这条断言的对象是 `MASTER_ENCRYPTION_KEY`（64 位 hex）。该变量已删除（R6），
    // 断言搬到它的替代者 `ARTIFACT_KEYS` 身上：**同一个性质**（密钥必须正好 32 字节）
    // 仍然有看守者，只是换了一个字段名与一种编码。
    expect(() =>
      parseEnv({ ...VALID, ARTIFACT_KEYS: ring({ v1: base64Key('cb') + 'AAAA' }) } as NodeJS.ProcessEnv),
    ).toThrowError(/ARTIFACT_KEYS/);
  });
});

/**
 * 制品密钥环（P1 / Task 2，C10 / 规格 D5 + 修复轮 1 的 R5/R6）。
 *
 * `ARTIFACT_KEYS` 是**密钥材料**：必填、JSON 映射、每把 base64 解出正好 32 字节、
 * 占位值拒绝，且绝不入库不入 git；**环本身必须非空**。
 * `ARTIFACT_ACTIVE_KEY_ID` 是**标识符**而非密钥（它会逐字写进每份制品的头部），
 * 因此它**不**受占位层约束（见 `placeholder-boundary.test.ts` 的边界说明），
 * 但形状必须受限：它要按 1 字节长度写进文件头，且会出现在错误信息里。
 *
 * **本组最重要的一条是「活动 keyId 必须在环里」**（修复轮 1 的 R5 fail-fast）：
 * 上一版只校验两个变量各自存在，于是进程可以带着一个环里根本没有的活动 keyId 正常启动，
 * 直到某次上传走到 `new ChunkEncryptor(...)` 才失败——运行期、且在一次上传已经开始之后。
 */
describe('制品密钥环与 keyId（C10 / D5 / R5）', () => {
  it('缺少 ARTIFACT_KEYS 时拒绝启动', () => {
    const rest = { ...VALID };
    delete rest.ARTIFACT_KEYS;

    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrowError(/ARTIFACT_KEYS/);
  });

  it('拒绝占位值与畸形的 ARTIFACT_KEYS（逐字取自 .env.example 的那个占位值也在内）', () => {
    // 逐字取自 .env.example。**它的牙齿在哪一层是实测出来的**：这串是**合法 JSON**，
    // 其值也**通过** base64 字母表判据（`CHANGE_ME_BASE64_OF_32_BYTES` 只用了 `[A-Za-z0-9_]`），
    // 因此拦下它的是占位层（子串 `change_me`）——去掉占位层，它会掉到「解出 26 字节 ≠ 32 字节」
    // 那一层被拒，报错从「这是占位值」变成「长度不对」。这一点与上一版 `ARTIFACT_MASTER_KEY`
    // 的实测结论**相反**（那里下游 hex 正则自己就拦住了每一个占位词，占位层只改文案）。
    expect(() =>
      parseEnv({ ...VALID, ARTIFACT_KEYS: '{"v1":"CHANGE_ME_BASE64_OF_32_BYTES"}' } as NodeJS.ProcessEnv),
    ).toThrowError(/ARTIFACT_KEYS/);

    const bad: Array<[string, string]> = [
      ['不是 JSON', 'v1:AAAA'],
      ['JSON 数组', '["v1"]'],
      ['JSON 标量', '"v1"'],
      ['空对象（空环）', '{}'],
      ['值是数字', '{"v1":123}'],
      ['值不是 base64', '{"v1":"!!!"}'],
      ['base64 但只有 31 字节', ring({ v1: base64Key('cb').slice(0, 42) })],
      ['base64 但多出 4 字节', ring({ v1: base64Key('cb') + 'AAAA' })],
      ['keyId 形状非法（冒号）', ring({ 'v1:x': base64Key('cb') })],
      ['keyId 形状非法（以 - 开头）', ring({ '-v1': base64Key('cb') })],
      // Node 的 base64 解码器会**静默忽略**非法字符：`'A'.repeat(44) + '!!!'` 也能解出 32 字节。
      // 这一条钉住「严格字母表校验」是承重的——去掉它，本值会被放行。
      ['base64 里混入非法字符（解码器会静默忽略）', ring({ v1: 'A'.repeat(44) + '!!!' })],
    ];
    for (const [why, value] of bad) {
      expect(
        () => parseEnv({ ...VALID, ARTIFACT_KEYS: value } as NodeJS.ProcessEnv),
        `ARTIFACT_KEYS 应当拒绝「${why}」，实际放行：${value}`,
      ).toThrowError(/ARTIFACT_KEYS/);
    }
  });

  it('接受 URL-safe base64 与无填充形态（docker/k8s 传递时的常见变体）', () => {
    // 直接构造一个含 `-` / `_` 的 URL-safe 串，而不是从某个已知 base64 转出来：
    // 上面那些 `0xab` / `0xcd` 模式的 base64 **恰好不含**这两个字符（实测），
    // 于是「从它转 URL-safe」得到的仍是不含 `-`/`_` 的串——用例看起来在测字母表，
    // 实际什么都没测。这里让输入自己带上那两个字符。
    const urlSafeWithSymbols = '-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_x';
    expect(Buffer.from(urlSafeWithSymbols, 'base64')).toHaveLength(32);

    for (const [why, value] of [
      ['URL-safe 字母表（无填充）', ring({ v1: urlSafeWithSymbols })],
      ['URL-safe 字母表（带填充）', ring({ v1: `${urlSafeWithSymbols}=` })],
      ['标准字母表（含 + 与填充）', ring({ v1: Buffer.alloc(32, 0xfb).toString('base64') })],
    ] as Array<[string, string]>) {
      expect(() => parseEnv({ ...VALID, ARTIFACT_KEYS: value } as NodeJS.ProcessEnv), why).not.toThrow();
    }
  });

  it('ARTIFACT_KEYS 上的占位层**自己承重**：形状与长度都合法、只有占位词能拦住它', () => {
    /**
     * 这条是**唯一**把「占位层」与「形状判据」分开的用例，因此它必须用一个
     * **形状合法、长度也对**的值——否则拦住它的是 base64 长度判据，这条就变成了
     * 「同义反复」（上一版 `ARTIFACT_MASTER_KEY` 上就是那种形态，实测占位层删掉也全绿，MP13）。
     *
     * 值：43 个字符、全在 base64 字母表内、解出正好 32 字节，但 `todo` 藏在中间。
     * **实测**（MP31，把 `isPlaceholderValue` 的 `||` 改成 `&&` 等价于关掉这一层）：
     * 删掉占位层，本值会被**放行**到「解出 32 字节」那一步并成功，于是这条用例变红。
     * 证据：`evidence/t2-fix1-mp31-artifact-keys-without-placeholder-layer.txt`
     * ——同一次变异里还有两条红，但**只有这一条是孤立的**：另两条用的占位值解出 26 字节，
     * 占位层没了也会因长度被拒（那一点在 `placeholder-rejection.test.ts` 里据实写明了）。
     */
    const value = `${'x'.repeat(35)}todo${'x'.repeat(4)}`;
    expect(value).toHaveLength(43);
    expect(Buffer.from(value, 'base64')).toHaveLength(32); // 形状与长度都不是拦下它的原因

    expect(() =>
      parseEnv({ ...VALID, ARTIFACT_KEYS: ring({ v1: value }) } as NodeJS.ProcessEnv),
    ).toThrowError(/ARTIFACT_KEYS/);

    // 报错必须说清是「占位值」，而不是含糊的「不是合法 base64」
    let message = '';
    try {
      parseEnv({ ...VALID, ARTIFACT_KEYS: ring({ v1: value }) } as NodeJS.ProcessEnv);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('占位');
  });

  it('缺少 ARTIFACT_ACTIVE_KEY_ID 时拒绝启动（没有「悄悄用某个默认 keyId」这条路）', () => {
    const rest = { ...VALID };
    delete rest.ARTIFACT_ACTIVE_KEY_ID;

    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrowError(/ARTIFACT_ACTIVE_KEY_ID/);
  });

  it('ARTIFACT_ACTIVE_KEY_ID 的形状受限（空串 / 空格 / 超长 / 控制字符）', () => {
    const bad = ['', '   ', 'v 1', 'v1\n', 'k'.repeat(65), '轮换', '-v1', 'v1:'];
    for (const value of bad) {
      expect(
        () => parseEnv({ ...VALID, ARTIFACT_ACTIVE_KEY_ID: value } as NodeJS.ProcessEnv),
        `ARTIFACT_ACTIVE_KEY_ID=${JSON.stringify(value)} 不该被接受`,
      ).toThrowError(/ARTIFACT_ACTIVE_KEY_ID/);
    }
  });

  it('**活动 keyId 不在环里 ⇒ 引导期拒绝启动**（R5 的 fail-fast，本组最重要的一条）', () => {
    // 判别式：上一版只查两个变量「存在」，因此这个配置**可以启动**，直到第一次上传
    // 走到 `new ChunkEncryptor(...)` 才抛错——那时的代价是一次已经开始的上传。
    // 把这条去掉（或退回「只查存在性」），本用例立刻变红。
    const twoKeys = ring({ v1: base64Key('cb'), v2: base64Key('cd') });

    // 环里只有 v1/v2，活动却指着 v9
    expect(() =>
      parseEnv({ ...VALID, ARTIFACT_KEYS: twoKeys, ARTIFACT_ACTIVE_KEY_ID: 'v9' } as NodeJS.ProcessEnv),
    ).toThrowError(/ARTIFACT_ACTIVE_KEY_ID/);

    // 报错必须**说清是什么事**，而不是只说「校验失败」：运维要能一眼看出是「不在环里」，
    // 并且看得到环里有哪些 keyId（keyId 不是密钥，可以出现在报错里）。
    let message = '';
    try {
      parseEnv({ ...VALID, ARTIFACT_KEYS: twoKeys, ARTIFACT_ACTIVE_KEY_ID: 'v9' } as NodeJS.ProcessEnv);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('不在 ARTIFACT_KEYS 的环里');
    expect(message).toContain('"v9"');
    expect(message).toContain('"v1"');
    expect(message).toContain('"v2"');

    // 反过来：活动 keyId 换成环里另一个已退役的条目 ⇒ 接受（这就是轮换后的目标状态）
    const rotated = parseEnv({ ...VALID, ARTIFACT_KEYS: twoKeys, ARTIFACT_ACTIVE_KEY_ID: 'v2' });
    expect(rotated.ARTIFACT_ACTIVE_KEY_ID).toBe('v2');
  });

  it('接受合法的制品密钥环与 keyId，并在一次报错里同时点名两者', () => {
    const env = parseEnv(VALID);
    expect(env.ARTIFACT_KEYS).toBe(VALID.ARTIFACT_KEYS);
    expect(env.ARTIFACT_ACTIVE_KEY_ID).toBe('v1');

    const rest = { ...VALID };
    delete rest.ARTIFACT_KEYS;
    delete rest.ARTIFACT_ACTIVE_KEY_ID;
    try {
      parseEnv(rest as NodeJS.ProcessEnv);
      throw new Error('缺少两个制品变量却启动了');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('ARTIFACT_KEYS');
      expect(message).toContain('ARTIFACT_ACTIVE_KEY_ID');
    }
  });

  it('报错里不出现密钥材料（C11）：连「不是合法 JSON」也不回显原文', () => {
    // 一段一眼能认出来的密钥材料（base64），把它写坏成非法 JSON，断言它没有出现在报错里。
    // 为什么这条重要：`JSON.parse` 的原始报错会把**输入片段**贴出来，而这里输入的就是密钥。
    const secret = base64Key('de');
    let message = '';
    try {
      parseEnv({ ...VALID, ARTIFACT_KEYS: `{"v1":"${secret}"` } as NodeJS.ProcessEnv);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('ARTIFACT_KEYS');
    expect(message).not.toContain(secret);
  });
});
