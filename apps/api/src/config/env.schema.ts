import { z } from 'zod';
import { DEFAULT_TRUST_PROXY } from '../common/security/trust-proxy.js';

/**
 * 一律拒绝的占位值（威胁 #15）。两层判定：
 *
 * 1. `PLACEHOLDERS` —— 逐字相等。
 * 2. `PLACEHOLDER_SUBSTRINGS` —— 子串包含。真实占位值几乎总带后缀或前缀
 *    （`CHANGE_ME_AT_LEAST_32_CHARS_LONG`、`please-changeme`），逐字相等匹配不到，
 *    而它们**又长于**长度门，所以能一路通过生产校验。下面这份清单专门堵这个缺口，
 *    只收「一旦出现就绝无可能属于真实密钥」的占位家族词。
 *
 * **两层的分工（判据是「结果」而非「先后」）**：`nonPlaceholder` 是 `.pipe` 的**左侧**，
 * 因此它先执行，一旦命中就短路掉下游，报错文案也由它给出。但对今天的两个密钥字段
 * （`ARTIFACT_KEYS`、`GITHUB_CLIENT_SECRET` 之外的 64 位 hex 早已不存在）而言，
 * **只有 `GITHUB_CLIENT_SECRET` 真正靠本层拦下东西**——它的下游只有 `min(1)`。
 *
 * **第 1 层不覆盖 `.env.example` 的 `GITHUB_CLIENT_SECRET=CHANGE_ME`。** `CHANGE_ME`
 * 归一化后是 `change_me`——它在 `PLACEHOLDER_SUBSTRINGS` 里，却**不在** `PLACEHOLDERS` 里
 * （那里只有 `changeme` 与 `change-me`）。拦住模板自身这个值的是**子串层**：
 * 删掉子串层就会重新放行它，切勿因为「有逐字相等层」而删。
 *
 * ## `SESSION_SECRET` 与 `MASTER_ENCRYPTION_KEY` 都曾经在这里，现已删除
 *
 * `SESSION_SECRET`（最终评审 I-2）：会话是「服务端随机 id + Redis 状态」的形态
 * （`modules/auth/session.service.ts` 说明了为什么刻意不自包含签名令牌），CSRF 是
 * **不签名**的双提交令牌——两者都不需要服务器密钥。
 *
 * `MASTER_ENCRYPTION_KEY`（P1 Task 2 修复轮 1，裁定 R6）：**它被校验、却从未被任何一行
 * 代码读取**，而 `.env.example` 把它写成「用于制品 AES-256-GCM 加密」。那是一句**错误的
 * 运维保证**：按它去轮换密钥不会有任何效果。制品密钥今天走 `ARTIFACT_KEYS` 这一个环。
 * 复现它当初的处境只需一句 `grep -rn MASTER_ENCRYPTION_KEY apps packages`。
 *
 * 两者的删除理由是**同一条**：一个「必填、且什么都不保护」的密钥既是 C16 说的空抽象，
 * 又给运维一个错误的保证。因此删除而不是给它找一个用途（那属于另一个决定，不是一次修复）。
 * 上面清单里那些通用占位词仍然有活的看守者：`GITHUB_CLIENT_SECRET` 只有 `min(1)`，
 * 逐字相等层与子串层都在它身上承重（回归见 `placeholder-rejection.test.ts`）。
 *
 * 刻意**不**把 `secret` / `password` / `test` 这类通用标识词放进 PLACEHOLDER_SUBSTRINGS：
 * 它们会命中 `GITHUB_CLIENT_SECRET`、`X_TEST_TOKEN` 等合法密钥，造成误拒。
 * 代价：真实密钥若恰好含上述占位家族词会被误拒（fail-closed，可接受）。
 */
const PLACEHOLDERS = new Set([
  'changeme', 'change-me', 'secret', 'password', 'placeholder',
  'test', 'todo', 'xxx', 'your-secret-here', 'example',
]);

const PLACEHOLDER_SUBSTRINGS = [
  'changeme',
  'change-me',
  'change_me',
  'change me',
  'placeholder',
  'your-secret-here', 'your_key_here', 'your-key-here',
  'example',
  'todo',
];

/**
 * 占位值拒绝层。**使用边界（硬性约定，不可扩大）：只允许用于「密钥」字段。**
 *
 * 当前恰好用在两个字段上：`ARTIFACT_KEYS`、`GITHUB_CLIENT_SECRET`。
 *
 * 两者的「牙齿」不同，据实说明（**实测过，不是推断**）：**只有 `GITHUB_CLIENT_SECRET`
 * 是「长度类门拦不住、只有本层能拦」的那一颗**（它的下游只有 `min(1)`）。
 * `ARTIFACT_KEYS` 上本层**也承重**，但承的是另一段：`.env.example` 的占位值
 * `{"v1":"CHANGE_ME_BASE64_OF_32_BYTES"}` 是**合法 JSON**，其值也**通过** base64 的字母表判据
 * （只用了 `[A-Za-z0-9_]`），因此拦下它的是本层（子串 `change_me`）——去掉本层，那个值会被
 * 放行到「解出 26 字节 ≠ 32 字节」那一层，仍然被拒、但报的是长度而不是「这是占位值」。
 * **注意**：正因为下游还有一道长度判据，本层在 `ARTIFACT_KEYS` 上「是否改变最终结果」
 * 取决于占位值本身；`placeholder-rejection.test.ts` 那条用例钉的是
 * 「`.env.example` 的那个值必须被拒」，变异探针另见修复轮 1 的 evidence。
 *
 * 上一版在已被删除的 `ARTIFACT_MASTER_KEY`（64 位 hex）上则是**另一种**处境，也据实记着：
 * 词表里没有任何一个占位词是合法 hex（`change_me` 含 `g`/`_`、`example` 含 `x`/`m`/`p`/`l`），
 * 于是下游正则自己就会拒掉每一个占位值，本层在**那个**字段上只改变报错文案。
 * 那条实测留了变异探针为证
 * （`evidence/t2-mutation-mp13-artifact-master-key-without-placeholder-layer.txt`）。
 *
 * 为什么不能用于非密钥字段：上面的清单含 `example`、`todo` 这类**通用词**，
 * 而合法配置里出现它们完全正常，例如 `MAIL_FROM=no-reply@example.com`、
 * 部署地址里的 `/todo`。一旦把本层套到 `MAIL_FROM` / `DATABASE_URL` 之类字段上，
 * 就会误拒合法配置、把服务挡在启动之外。
 *
 * 误拒密钥是 fail-closed（方向安全），误拒非密钥配置则纯属故障——这就是边界所在。
 * 该边界由 `tests/unit/config/placeholder-boundary.test.ts` 守：一旦把本层套到
 * 非密钥字段上，那些用例会立刻变红，而不是悄悄通过。
 */

/**
 * 占位值的**纯判据**（`nonPlaceholder` 与 `ARTIFACT_KEYS` 的逐值检查共用同一份词表）。
 *
 * 抽成函数而不是内联两次：词表只有一份，两条路径不可能漂移。
 */
function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return PLACEHOLDERS.has(normalized) || PLACEHOLDER_SUBSTRINGS.some((p) => normalized.includes(p));
}

const nonPlaceholder = (label: string) =>
  z.string().refine((v) => !isPlaceholderValue(v), {
    message: `${label} 使用了占位默认值，禁止启动（威胁 #15）`,
  });

/** AES-256 的密钥长度：32 字节。 */
const ARTIFACT_KEY_BYTES = 32;

/**
 * keyId 的形状。**与 `modules/asset/crypto/key-ring.ts` 里的 `KEY_ID_PATTERN` 逐字相同**。
 *
 * 两处都必须存在：一处是引导期 schema（在**进程启动前**拦下坏配置），一处是模块自己的
 * 构造期判据（模块可以被非 NestJS 的调用方直接使用）。`tests/unit/asset/key-ring.test.ts`
 * 有一条用例逐字比对两者的**行为**，免得它们各自漂移。形状受限的理由见下面
 * `ARTIFACT_ACTIVE_KEY_ID` 的注释。
 */
const ARTIFACT_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * base64 的**严格**判据（与 `key-ring.ts` 同一份约定）。
 *
 * 不用「`Buffer.from(s,'base64')` 解完长度对得上」这一条，是因为 Node 的解码器会
 * **静默忽略非法字符**：`'A'.repeat(44) + '!!!'` 也能解出 32 字节并被放行。
 * 同时接受标准与 URL-safe 字母表、有无填充两种形态——经 docker-compose / k8s 传递时
 * 两种变体都常见，而它们解出的字节相同。
 */
const ARTIFACT_KEY_BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * 把 `ARTIFACT_KEYS` 的原始文本解析成 `keyId → 32 字节` 的映射。
 *
 * @returns 成功时返回映射；失败时返回一句错误（**不含任何密钥材料**，C11）。
 *
 * ## 占位层的检查范围是**每一个值**，不是整串 JSON（这是修出来的，不是想出来的）
 *
 * 一开始这里把 `nonPlaceholder` 套在**整串 JSON 文本**上（与上一版对单个 hex 密钥的做法一致）。
 * 那条路是错的，而且错得很难看出来：**keyId 是运维起的名字**，`example-v1` / `todo` /
 * `test-v2` 都是合法 keyId（`ARTIFACT_ACTIVE_KEY_ID` 的注释里逐字写着这一点），但整串 JSON
 * 里一旦出现这些词，子串层就命中 ⇒ **一个完全合法的环被拒绝**，
 * 而报错说的是「ARTIFACT_KEYS 使用了占位默认值」，与真实原因（keyId 起了个含 example 的名字）
 * 风马牛不相及。`tests/unit/config/placeholder-boundary.test.ts` 的那条
 * 「放行含 example / todo 的 keyId」用例当场变红，是它把这处错误逼出来的。
 *
 * 正确的边界是「**值**才是密钥材料」：占位检查逐个值做，键名只受形状判据约束。
 * 这样占位层的语义与它的**名字**一致了（它拒的是密钥值，不是标识符）。
 */
function parseArtifactKeysText(raw: string): { keys: Map<string, Buffer> } | { error: string } {
  const text = raw.trim();
  if (text.length === 0) {
    return { error: '必须显式给出（JSON 映射 {keyId: base64(32 字节)}），没有默认值' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    // 只报「不是合法 JSON」：原文里就是密钥材料，绝不回显（C11）。
    return { error: '不是合法的 JSON（形状是 {"<keyId>":"<base64 的 32 字节>"}）' };
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return { error: '必须是 JSON **对象**（{keyId: base64(32 字节)}），不是数组或标量' };
  }

  const record = decoded as Record<string, unknown>;
  const ids = Object.keys(record);
  if (ids.length === 0) {
    return { error: '环是空的（至少要含 ARTIFACT_ACTIVE_KEY_ID 指向的那个密钥）' };
  }

  const keys = new Map<string, Buffer>();
  for (const keyId of ids) {
    if (!ARTIFACT_KEY_ID_PATTERN.test(keyId)) {
      // keyId 不是密钥（它逐字写在每份制品头里），回显它能让「哪个条目写坏了」一眼可见。
      return { error: `keyId ${JSON.stringify(keyId)} 形状非法（1..64 位 ASCII 标识符，字母或数字开头）` };
    }
    const value = record[keyId];
    if (typeof value !== 'string' || !ARTIFACT_KEY_BASE64_PATTERN.test(value)) {
      return { error: `keyId ${JSON.stringify(keyId)} 的值不是合法的 base64 字符串` };
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== ARTIFACT_KEY_BYTES) {
      return { error: `keyId ${JSON.stringify(keyId)} 解出 ${bytes.length} 字节，AES-256 需要 ${ARTIFACT_KEY_BYTES} 字节` };
    }
    // 占位层放在最后：走到这里的值已经是「形状合法、32 字节」的 base64，
    // 因此本层在这里**确实改变结果**（`.env.example` 的占位值正是这个形态：
    // `CHANGE_ME_BASE64_OF_32_BYTES` 是合法 base64 字母表、也并非 32 字节，
    // 但把它补齐成 32 字节后，唯一能拦住它的就是这一层）。报错只点名 keyId，不回显值（C11）。
    if (isPlaceholderValue(value)) {
      return { error: `keyId ${JSON.stringify(keyId)} 的密钥值是占位默认值，禁止启动（威胁 #15）` };
    }
    keys.set(keyId, bytes);
  }
  return { keys };
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  /**
   * express 的 `trust proxy`（最终评审 I-6）。
   *
   * 默认值来自 `common/security/trust-proxy.ts` 的 {@link DEFAULT_TRUST_PROXY}——
   * **单一来源**：解析函数与 schema 默认值用的是同一个常量（有常驻断言钉住二者一致，
   * 见 `tests/security/trust-proxy.test.ts`）。校验**不**在这里做（这里只声明「它是个字符串」），
   * 因为可接受取值的清单与解析逻辑同属一处：`parseTrustProxy()`，它在启动期抛错。
   */
  TRUST_PROXY: z.string().default(DEFAULT_TRUST_PROXY),

  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: nonPlaceholder('GITHUB_CLIENT_SECRET').pipe(z.string().min(1)),
  GITHUB_CALLBACK_URL: z.string().url(),

  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().email(),

  /**
   * 制品本地存储卷的根目录（P1 / Task 1）。
   *
   * **必填、无默认值**：一个「没配就用某个相对路径」的默认值会把制品写进进程的当前工作目录
   * （开发机上是 `apps/api/`，容器里可能是 `/`），而那正是备份、磁盘配额与权限三件事
   * 全都失控的形态。目录**不要求预先存在**（存储实现按需 `mkdir -p`），这样引导期不碰文件系统。
   */
  ARTIFACT_STORE_DIR: z.string().min(1),

  /**
   * 单次上传的**硬上限**（字节），同时是 HTTP 层（multipart 解析）与存储层
   * （`ArtifactStore.putStream`）的同一个上限值。
   *
   * **必填、无默认值**：它是安全参数（威胁 #2 的资源滥用面），一个「悄悄生效」的默认上限
   * 等于一次没人做过的部署决定。设计文档 §威胁 #2 的累计未压缩上限是 1 GiB，
   * 上传上限必须 ≥ 它（压缩包本身小于解压后总量），但具体取值属于部署决定，
   * 因此这里只校验形状（正整数字节数），不替运维选数。
   */
  ARTIFACT_MAX_UPLOAD_BYTES: z.coerce.number().int().positive(),

  /**
   * **制品密钥环**（P1 / Task 2，规格 D5 + 修复轮 1 裁定 R5）。
   *
   * ```
   * ARTIFACT_KEYS={"v1":"<base64(32 字节)>","v2":"<base64(32 字节)>"}
   * ```
   *
   * ## 为什么是映射，而不是一个 `ARTIFACT_MASTER_KEY`
   *
   * 单个主密钥（上一版的形状）让环里恰好只有「活动 keyId」这一个条目。后果具体：
   * 轮换到 v2 **必然替换掉**环里唯一的键，旧制品（头里写着 v1）立刻变成「未知 keyId ⇒ 拒绝」
   * ——「旧制品按其 keyId 继续可读」这条要求**在格式上成立、在部署上不成立**。
   * 修复轮 1 的 R5 因此把环境面改成映射：轮换 = 往映射里**加**一个条目、把
   * `ARTIFACT_ACTIVE_KEY_ID` 指过去，旧条目留着给读取端用。
   *
   * ## 这个字段承担的判据（每一层都由用例钉住）
   *
   * 1. 合法 JSON 对象（**非**数组、非标量）；
   * 2. 非空（空环是配置错误，不是「暂时没有密钥」）；
   * 3. 每个 keyId 合形状（与 `key-ring.ts` 的 `KEY_ID_PATTERN` 逐字相同的正则）；
   * 4. 每个值是**严格** base64（标准或 URL-safe、有无填充皆可），解出正好 32 字节（AES-256）。
   *    不用「解码后长度对得上」代替第 4 条：Node 的解码器会静默忽略非法字符。
   *
   * 报错只点名**字段名与 keyId**，绝不回显密钥材料（C11）——连「不是合法 JSON」也
   * 不把原文贴出来，因为原文里就是密钥。
   *
   * ## 绝不入库、不入 git（C10）
   *
   * `.env.example` 里只放**占位值**，且该占位值必须被拒绝。占位层在这里**是承重的**：
   * 那个占位值是合法 JSON、其值也通过 base64 字母表判据，唯一拦住它的是占位层
   * （见 `nonPlaceholder` 的说明；这与上一版 64 位 hex 字段的处境不同）。
   */
  ARTIFACT_KEYS: z
    .string()
    .superRefine((value, ctx) => {
      const parsed = parseArtifactKeysText(value);
      if ('error' in parsed) {
        ctx.addIssue({ code: 'custom', message: parsed.error });
      }
    })
    // **刻意没有 `.pipe(nonPlaceholder('ARTIFACT_KEYS'))`**：占位检查已经由
    // `parseArtifactKeysText` **逐个值**做掉了，而这是必须的——把占位层套在**整串 JSON** 上，
    // 会连 keyId 里的 `example` / `todo` 一起命中，把一个完全合法的环判成占位配置。
    // keyId 是**标识符**（`ARTIFACT_ACTIVE_KEY_ID` 的注释逐字写着这一点），不是密钥材料。
    // 详见 `parseArtifactKeysText` 的注释：这个错误是 `placeholder-boundary.test.ts` 逼出来的。
    ,

  /**
   * 当前**写入**使用的 keyId（P1 / Task 2，规格 D5）。
   *
   * 轮换 = 新增一个 keyId、把新写入指到它；旧制品继续按自己头部里的 keyId 可读。
   * 因此这个值不是密钥、也不会被隐藏：它会逐字写进每一份制品的文件头。
   *
   * **它不受占位层约束**（占位层只允许用于密钥字段，见上面的使用边界）：
   * `v1` / `test` 这类名字是完全合法的 keyId。
   *
   * 形状受限的**理由**（不是格式洁癖）：
   * 1. 它按 1 字节长度写进文件头 ⇒ 必须 ≤ 255 字节。限成 ASCII 且 ≤ 64 字符后，
   *    「字符数」与「UTF-8 字节数」这两个口径不再有分歧；
   * 2. 它会出现在错误信息与日志里 ⇒ 不允许空白与控制字符（`\n` 能把一行日志劈成两行）；
   * 3. 首字符必须是字母或数字，`-`/`.`/`_` 只允许出现在中间 ⇒ 排除 `-` / `--` 这类
   *    会被命令行工具当成选项的值。
   */
  ARTIFACT_ACTIVE_KEY_ID: z
    .string()
    .regex(
      ARTIFACT_KEY_ID_PATTERN,
      'ARTIFACT_ACTIVE_KEY_ID 必须是 1..64 位的 ASCII 标识符（字母或数字开头，可含 . _ -）',
    ),

  /**
   * 下载票据的 HMAC 密钥（P1 / Task 8，规格 D10）。
   *
   * 签名 URL 的全部安全性都落在这一把密钥上：拿到它的人可以自己签出任意
   * `assetVersionId | userId | expiresAt | nonce` 的票据。因此：
   *
   * - **必填、无默认值**——一个「没配就用某个默认值」的密钥等于没有密钥；
   * - **≥32 字符**（256 位熵的常见下限；HMAC-SHA256 的密钥可以更长，但不能更短）；
   * - 走 P0 的**占位值拒绝**层（`nonPlaceholder`）：`CHANGE_ME…` 这类模板值必须在
   *   引导期被拒，而不是成为一把人人皆知的生产密钥（威胁 #15）。
   *
   * ## 为什么它**不叫** `SESSION_SECRET`，也不复用它
   *
   * `SESSION_SECRET` 在 P0 最终评审时被删除：会话是「服务端随机 id + Redis 状态」，
   * CSRF 是不签名的双提交令牌——两者都不需要服务器密钥，而一个「必填、却什么都不保护」
   * 的密钥既违反 C16、又给运维一个错误的保证。下载签名**确实**需要一个密钥，
   * 因此这是一个**新的、有真实读取方**的变量，而不是把那个名字复活。
   *
   * ## 为什么不复用 `ARTIFACT_KEYS` 里的活动密钥
   *
   * 那是 AES-256-GCM 的**加密**密钥。用同一份字节同时做加密与 HMAC 是把两个不同的
   * 密码学用途绑在一起（一个用途的泄露或算法迁移会同时影响另一个），而在环境变量里
   * 多一行是零成本的——密钥**分开**是这里唯一需要付的代价。
   *
   * 生成一把：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   * （形状只要求长度，不要求编码，因此也可以用 hex）。
   */
  DOWNLOAD_URL_SECRET: nonPlaceholder('DOWNLOAD_URL_SECRET').pipe(z.string().min(32)),
})
  /**
   * **跨字段判据：活动 keyId 必须真的在环里**（R5 的 fail-fast）。
   *
   * 上一版只校验两个变量**各自存在**，于是进程可以带着一个「环里根本没有的
   * `ARTIFACT_ACTIVE_KEY_ID`」正常启动，直到某次上传走到 `new ChunkEncryptor(...)`
   * 才失败——运行期、且在一次上传已经开始之后。把它提到引导期，报错就能直接说清
   * 「哪个 keyId 不在环里、环里有哪些」。
   *
   * ## 为什么这里是 `superRefine` 而不是 `.refine`（这个区别是承重的）
   *
   * `z.object(...).refine(fn)` 得到的效果链在**内层解析成功时**才运行 `fn`；而
   * `z.object(...).superRefine(fn)` 在外层，**内层失败时它照样运行**。这一点直接决定
   * 「一次报错列全所有问题」这条性质：
   *
   * - `ARTIFACT_KEYS` 缺失 ⇒ 内层已经有一条「必填」issue；若用 `.refine`，本判据**根本
   *   不会执行**，于是 `ARTIFACT_ACTIVE_KEY_ID` 那一条 issue 不会出现——而
   *   `tests/unit/config/env.schema.test.ts` 有一条用例要求「两个变量都缺时，
   *   报错里同时点名两者」（上一版起就有的断言）。
   * - 用 `superRefine` 后，两条 issue 同时出现在一次报错里，运维一次就能修完。
   *
   * `keys` 解不出来时直接跳过本判据（`'error' in parsed` 分支），避免在同一个字段上
   * 报两条互相矛盾的话——此时「环本身是坏的」已经由 `ARTIFACT_KEYS` 那条说清了。
   */
  .superRefine((env, ctx) => {
    const parsed = parseArtifactKeysText(env.ARTIFACT_KEYS);
    if ('error' in parsed) return;
    if (!parsed.keys.has(env.ARTIFACT_ACTIVE_KEY_ID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ARTIFACT_ACTIVE_KEY_ID'],
        message:
          `ARTIFACT_ACTIVE_KEY_ID=${JSON.stringify(env.ARTIFACT_ACTIVE_KEY_ID)} 不在 ARTIFACT_KEYS 的环里` +
          `（环中有：${[...parsed.keys.keys()].map((id) => JSON.stringify(id)).join(', ')}）。` +
          '这会让每一次写入都在加密时才发现取不到活动键，故在引导期直接拒绝（D5）',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * 解析并校验环境变量。失败时抛出聚合错误，一次性列出所有问题字段，
 * 使运维无需「修一个报一个」。
 */
export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`环境变量校验失败，服务拒绝启动：\n${lines.join('\n')}`);
  }
  return result.data;
}
