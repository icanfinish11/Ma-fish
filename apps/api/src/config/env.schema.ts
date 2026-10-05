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
 * 因此它先执行，一旦命中就短路掉下游，报错文案也由它给出。但对
 * `MASTER_ENCRYPTION_KEY`（下游 64 位 hex）而言，逐字相等层命中的每个词
 * 都**同时**被下游拒绝，所以第 1 层**不改变接受/拒绝的结果，只改变报错文案**。
 * 第 1 层真正承担结果的是 `GITHUB_CLIENT_SECRET`（下游只有 `min(1)`）：`test`、`secret`、
 * `password`、`xxx` 这类词**只**被逐字相等层拦住。
 *
 * **第 1 层不覆盖 `.env.example` 的 `GITHUB_CLIENT_SECRET=CHANGE_ME`。** `CHANGE_ME`
 * 归一化后是 `change_me`——它在 `PLACEHOLDER_SUBSTRINGS` 里，却**不在** `PLACEHOLDERS` 里
 * （那里只有 `changeme` 与 `change-me`）。拦住模板自身这个值的是**子串层**：
 * 删掉子串层就会重新放行它，切勿因为「有逐字相等层」而删。
 *
 * ## `SESSION_SECRET` 曾经在这里，现已删除（最终评审 I-2）
 *
 * 它曾是本层的第三个字段（`min(32)`），但**全仓没有任何读取方**：会话是
 * 「服务端随机 id + Redis 状态」的形态（`modules/auth/session.service.ts` 说明了为什么
 * 刻意不自包含签名令牌），CSRF 是**不签名**的双提交令牌——两者都不需要服务器密钥。
 * 一个「必填、且什么都不保护」的密钥是**双重**错误：它是 C16 说的空抽象，
 * 同时给运维一个错误的保证（设了它以为保护了什么）。因此删除而不是给它找一个用途
 * （唯一的「用途」会把上面两条设计改成签名方案——那是另一个决定，不是一次修复）。
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
 * 当前恰好用在三个字段上：`MASTER_ENCRYPTION_KEY`、`ARTIFACT_MASTER_KEY`、
 * `GITHUB_CLIENT_SECRET`。
 *
 * **这三者里只有 `GITHUB_CLIENT_SECRET` 真正靠本层拦下东西**（它的下游只有 `min(1)`）。
 * 两个 64 位 hex 的密钥字段上，占位层**不改变接受/拒绝的结果**：词表里没有任何一个词
 * 是合法的 hex 串（`change_me` 含 `g`/`_`、`example` 含 `x`/`m`/`p`/`l`、`todo` 含 `t`/`o`……），
 * 所以下游的 64 位 hex 正则自己就会拒掉每一个占位值。留着它是为了让报错文案直说
 * 「这是占位值」，而不是「不是 64 位 hex」。**变异实测**：把 `ARTIFACT_MASTER_KEY` 上的
 * 本层删掉，`env.schema.test.ts` 的占位用例**照旧全绿**（`evidence/t2-mutation-mp13-artifact-master-key-without-placeholder-layer.txt`）
 * ——即那一层在该字段上不是承重件，这一点据实记载，不让它冒充证据。
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
const nonPlaceholder = (label: string) =>
  z.string().refine(
    (v) => {
      const normalized = v.trim().toLowerCase();
      return (
        !PLACEHOLDERS.has(normalized) && !PLACEHOLDER_SUBSTRINGS.some((p) => normalized.includes(p))
      );
    },
    { message: `${label} 使用了占位默认值，禁止启动（威胁 #15）` },
  );

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

  /** AES-256-GCM 主密钥：32 字节 = 64 位 hex。绝不入库不入 git（C10）。 */
  MASTER_ENCRYPTION_KEY: nonPlaceholder('MASTER_ENCRYPTION_KEY').pipe(
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'MASTER_ENCRYPTION_KEY 必须是 64 位十六进制（32 字节）'),
  ),

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
   * 制品加密主密钥（P1 / Task 2，规格 D5）：32 字节 = 64 位 hex。
   *
   * **它与 `MASTER_ENCRYPTION_KEY` 是两个变量，这不是笔误**：规格 D5 逐字指定了
   * `ARTIFACT_MASTER_KEY` 这个名字，且要求「沿用 P0 的占位值拒绝机制」。
   * 两者今天都必填、都是 32 字节 hex、都无人读错的后果 —— 已知的重叠已记入
   * `task-2-report.md` 的 Concerns（`MASTER_ENCRYPTION_KEY` 至今没有任何读取方），
   * 由控制器裁定是删掉哪一个、还是让制品层复用它。**在裁定之前不允许出现「取不到
   * ARTIFACT_MASTER_KEY 就回退用 MASTER_ENCRYPTION_KEY」这种代码**：那是本任务
   * 明令禁止的默认键回退，且会把一次配置错误变成一次用错密钥的静默加密。
   *
   * 绝不入库、不入 git（C10）。`.env.example` 里只放占位值，且该占位值必须被拒绝。
   */
  ARTIFACT_MASTER_KEY: nonPlaceholder('ARTIFACT_MASTER_KEY').pipe(
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'ARTIFACT_MASTER_KEY 必须是 64 位十六进制（32 字节）'),
  ),

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
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
      'ARTIFACT_ACTIVE_KEY_ID 必须是 1..64 位的 ASCII 标识符（字母或数字开头，可含 . _ -）',
    ),
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
