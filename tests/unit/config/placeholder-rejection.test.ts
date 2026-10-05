import { describe, it } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';

/**
 * C10 回归：`.env.example` 里那些**能通过长度类门**的占位值必须被拒绝。
 *
 * 这些值不是随便编的——它们逐字取自本仓库的 `.env.example`（模板的定义就是「运维会照抄」）。
 * 但各字段的「牙齿」并不相同，据实说明如下（变异取证见 task-2-report.md 修复轮 2）：
 *
 * - `GITHUB_CLIENT_SECRET=CHANGE_ME`（**通过** `min(1)`）**只**被占位层拦住
 *   —— **它承担本用例的回归**（变异：删掉子串层里的 `change_me` 后它被放行，本用例随即变红）。
 * - `ARTIFACT_KEYS={"v1":"CHANGE_ME_BASE64_OF_32_BYTES"}` **也不是**，而且原因是**实测出来的**、
 *   与上一版 `MASTER_ENCRYPTION_KEY` 不同：这串是**合法 JSON**，值也**通过** base64 的字母表判据
 *   （`CHANGE_ME_BASE64_OF_32_BYTES` 只用了 `[A-Za-z0-9_]`），因此拦下它的既不是 `JSON.parse`
 *   也不是形状判据，而是**占位层自己**（子串 `change_me`）。
 *   换句话说：**R5 之后，占位层在这个字段上是承重的**，不再是「只改报错文案」的那一层。
 *   本用例的牙齿因此从一颗**恢复到两颗**（`GITHUB_CLIENT_SECRET` 与 `ARTIFACT_KEYS`），
 *   下面断言里那两个字段各自都有依据。
 *
 * 修复轮 1（R6）删掉的那个字段，处境与此**恰好相反**，值得留一行记录：
 * `MASTER_ENCRYPTION_KEY=CHANGE_ME_64_HEX_CHARS` 曾是这里的第二个 64 位 hex 字段，
 * 它的牙齿同样在**下游正则**而不是占位层；该字段因「必填却全仓无读取方」被整体删除
 * （与 I-2 删 `SESSION_SECRET` 同一条理由），于是这颗「本来就不算牙」的断言随字段消失。
 *
 * ## 牙齿从三颗减到一颗（I-2 与 R6 各减一颗，据实记载）
 *
 * 上一版这里还有 `SESSION_SECRET=CHANGE_ME_AT_LEAST_32_CHARS_LONG`（32 字符，**正好通过**
 * `min(32)`）——它同样是「只有占位层能拦」的一颗牙。而 I-2 把那个字段**整个从 schema 里删掉**了
 * （它必填却无人读取：会话是随机 id + Redis 状态、CSRF 是不签名的双提交令牌，都不需要服务器密钥），
 * 于是这颗牙随字段一起消失。剩下的 `GITHUB_CLIENT_SECRET` 仍然足以让「占位层失效」这件事变红，
 * 但**覆盖面确实比之前窄**：这一点写在这里，免得后人以为这里还在守着两个字段。
 */
const ENV_EXAMPLE_PLACEHOLDERS = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://app_user:CHANGE_ME@127.0.0.1:5432/vca',
  REDIS_URL: 'redis://127.0.0.1:6379',
  // `.env.example` 里它是注释掉的一行（可选，有默认值 loopback）；这里补上以保持「完整 env」。
  TRUST_PROXY: 'loopback',
  GITHUB_CLIENT_ID: 'CHANGE_ME',
  GITHUB_CLIENT_SECRET: 'CHANGE_ME',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  // P1 / Task 1 新增（见 tests/helpers/env.ts 的 K9 清单）。
  // 这两个字段**不是**密钥，因此刻意也**不**受占位层约束——它们在这里只为凑出「完整 env」。
  ARTIFACT_STORE_DIR: 'C:\\Temp\\vca-artifacts-fixture',
  ARTIFACT_MAX_UPLOAD_BYTES: '4194304',
  // P1 / Task 2 新增（同上清单）。**逐字取自 `.env.example` 的那一行**（修复轮 1 起
  // 环境面是密钥环，R5）。`ARTIFACT_ACTIVE_KEY_ID` 是标识符，同样只为凑出「完整 env」。
  ARTIFACT_KEYS: '{"v1":"CHANGE_ME_BASE64_OF_32_BYTES"}',
  ARTIFACT_ACTIVE_KEY_ID: 'v1',
  // P1 / Task 8 新增（同上清单）：**逐字取自 `.env.example` 的那一行**。它同时给本文件
  // 补回一颗牙——`CHANGE_ME_AT_LEAST_32_CHARS_LONG_DOWNLOAD` **通过** `min(32)`，
  // 唯一拦得住它的是占位层（与 I-2 删掉 `SESSION_SECRET` 时失去的那一颗同一个形状）。
  DOWNLOAD_URL_SECRET: 'CHANGE_ME_AT_LEAST_32_CHARS_LONG_DOWNLOAD',
};

describe('占位值拒绝规则（C10 / 威胁 #15）', () => {
  it('拒绝 .env.example 中长于长度门的占位值，并在一次报错里列全字段', () => {
    const result = envSchema.safeParse(ENV_EXAMPLE_PLACEHOLDERS);

    if (result.success) {
      throw new Error(
        `占位值被放行，生产环境可带占位密钥启动：GITHUB_CLIENT_SECRET=${result.data.GITHUB_CLIENT_SECRET}`,
      );
    }
    const fields = result.error.issues.map((i) => i.path.join('.'));
    // `ARTIFACT_KEYS` 是 P1 / Task 2 的密钥字段（修复轮 1 起取代 `ARTIFACT_MASTER_KEY`）。
    // **它是这个用例的第二颗牙，且实测过**：`.env.example` 那个占位值是合法 JSON、也通过
    // base64 字母表判据，唯一拦住它的是占位层（子串 `change_me`）——删掉 `ARTIFACT_KEYS` 上的
    // 占位层，本用例立刻变红。与 `MASTER_ENCRYPTION_KEY` 当初「删了也全绿」的处境相反。
    // 变异探针：`evidence/t2-fix1-mp31-artifact-keys-without-placeholder-layer.txt`（本用例红）。
    //
    // 与「形状无关」的那一半另有一条更干净的用例：`env.schema.test.ts` 的
    // 「ARTIFACT_KEYS 上的占位层**自己承重**」——它用一个**形状合法、长度正好 32 字节**的
    // 含 `todo` 值，因此「占位层删掉就放行」这件事在那条里不含任何歧义。
    // 本条这里 `CHANGE_ME_BASE64_OF_32_BYTES` 其实解出 26 字节，所以即使占位层没了它也会
    // 因长度被拒（本用例仍会红，但红的理由不同）——这一点据实写明，不冒充证据。
    for (const field of ['ARTIFACT_KEYS', 'GITHUB_CLIENT_SECRET']) {
      if (!fields.includes(field)) {
        throw new Error(`字段 ${field} 的占位值未被拒绝；实际被拒字段=${fields.join(',')}`);
      }
    }
  });
});
