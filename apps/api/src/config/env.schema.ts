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
 * 当前恰好用在两个字段上：`MASTER_ENCRYPTION_KEY`、`GITHUB_CLIENT_SECRET`。
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
