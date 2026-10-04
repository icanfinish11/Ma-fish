import { z } from 'zod';

/**
 * 一律拒绝的占位值（威胁 #15）。两层判定，缺一不可：
 *
 * 1. `PLACEHOLDERS` —— 逐字相等。**注意它单独存在时是死代码**：这些词都短于下游长度门
 *    （SESSION_SECRET ≥ 32、主密钥 64 位 hex），长度门会先拒绝，占位规则永远轮不到执行；
 *    保留它只为不改变既有语义（并覆盖 `GITHUB_CLIENT_SECRET` 这种无长度门的下游）。
 * 2. `PLACEHOLDER_SUBSTRINGS` —— 子串包含。真实占位值几乎总带后缀或前缀
 *    （`CHANGE_ME_AT_LEAST_32_CHARS_LONG`、`please-changeme`），逐字相等匹配不到，
 *    而它们**又长于**长度门，所以能一路通过生产校验。下面这份清单专门堵这个缺口，
 *    只收「一旦出现就绝无可能属于真实密钥」的占位家族词。
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

  SESSION_SECRET: nonPlaceholder('SESSION_SECRET').pipe(z.string().min(32)),
  /** AES-256-GCM 主密钥：32 字节 = 64 位 hex。绝不入库不入 git（C10）。 */
  MASTER_ENCRYPTION_KEY: nonPlaceholder('MASTER_ENCRYPTION_KEY').pipe(
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'MASTER_ENCRYPTION_KEY 必须是 64 位十六进制（32 字节）'),
  ),

  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: nonPlaceholder('GITHUB_CLIENT_SECRET').pipe(z.string().min(1)),
  GITHUB_CALLBACK_URL: z.string().url(),

  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().email(),
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
