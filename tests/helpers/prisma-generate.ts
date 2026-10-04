import path from 'node:path';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Prisma 7 客户端生成助手（Ruling 3）。
 *
 * `apps/api/src/generated/` 不入 git，而 `migrate deploy` **不会**生成它（已实测），
 * 必须显式 `prisma generate`。任何 import `@vca/api` 的测试都会经
 * `AppModule → DbModule → PrismaService → ../generated/prisma/client.js` 走到它，
 * 缺失时的报错是 `Cannot find module '../generated/prisma/client.js'`（已实测）。
 *
 * 三条入口都指向这里，保证「克隆后直接跑测试」成立：
 *   * `vitest.setup.ts`（**根级 `globalSetup`**，每次测试运行只跑一次）——覆盖
 *     `pnpm vitest run --project X` 这类**绕过 npm script 生命周期**的调用
 *     （`pretest` 只在 `pnpm test` 时触发，而 brief 的验证命令正是
 *     `pnpm vitest run --project unit`）；
 *   * `apps/api` 的 `pretypecheck`——覆盖 typecheck；
 *   * 根 `pretest`——覆盖 `pnpm test`。
 *
 * 放在根级 `globalSetup` 而不是各 project 的 `setupFiles`，是因为后者在每个测试进程里
 * 各求值一次：`pnpm vitest run`（不带 `--project`）会让 5 个进程**并发**对同一个输出目录
 * 跑 `prisma generate`（实测 5 次 vs 现在 1 次，见 evidence/fix8-single-generate.txt）。
 *
 * 用 `execFileSync` 直接执行 Prisma CLI 的真实 JS 入口，不走 `pnpm exec`：
 * Windows 上 `pnpm` 只有 `.cmd` 垫片（`execFileSync` 无 shell 起不来），而一旦交给
 * `shell: true`，shell 会用自己的 PATH 解析 `prisma` 并失败（已实测：`'prisma' is not
 * recognized as an internal or external command`），且 `pnpm exec` 依赖的 `npm_execpath`
 * 在 vitest 工人进程里是 `undefined`（已实测），所以也拿不到 pnpm 的入口路径。
 */

/**
 * 仓库根目录的锚点**由调用方显式给出**，因为本模块会被两个不同深度的入口加载：
 * `vitest.setup.ts`（仓库根）与 `tests/helpers/db.ts`（向下两级）。
 * 若在模块内部用 `path.resolve(import.meta.dirname, '..')` 自算，从根加载时会把仓库根
 * 算成上一级目录（本机实测为 `D:\My-project-file\DSH`），于是 `cwd` 指向不存在的目录、
 * `execFileSync` 抛 `Error: spawnSync node ENOENT`。显式传参杜绝这种歧义。
 */
let repoRoot: string | undefined;

export function configurePrismaGenerate(root: string): void {
  repoRoot = root;
}

function root(): string {
  if (repoRoot === undefined) {
    throw new Error('prisma-generate: 必须先调用 configurePrismaGenerate(repoRoot)');
  }
  return repoRoot;
}

/** `apps/api` 目录（Prisma CLI 入口的解析基准）。 */
export function apiDir(): string {
  return path.join(root(), 'apps/api');
}

/** 生成客户端的落点（新鲜度判据比的是它的 mtime，不是「是否存在」，见下）。 */
export function generatedClientPath(): string {
  return path.join(apiDir(), 'src/generated/prisma/client.ts');
}

/**
 * 用来执行 Prisma CLI 的 node 解释器：**正在运行本测试的那个 node 自己**。
 *
 * 这里曾经写 `'node'`（交给 PATH 解析），理由是「vitest 工人进程里的 `process.execPath`
 * 指向一个并不存在的 node（`D:\Node.js\node.exe`），于是 `execFileSync` 抛
 * `spawnSync ... ENOENT`」。**那个理由与它自己的证据矛盾，是错的**：
 *   * `D:\Node.js\node.exe` **确实存在**（实测 `existsSync(process.execPath) === true`）；
 *   * 同一份证据 `evidence/probeB-schema-isolation.txt` 里，`process.execPath` 已经成功
 *     **起进程**了——它打印的是 `Command failed: D:\Node.js\node.exe ...\prisma\build\index.js
 *     migrate deploy` 加上真正的失败原因 `Database error code: 42P01 / relation
 *     "audit.audit_logs" does not exist`，即 CLI 跑到了连库那一步；
 *   * 真正的 `ENOENT` 来自 **`cwd` 指向不存在的目录**（见报告 §10-4：helper 被两个不同深度
 *     的入口加载时自算相对根会算到仓库上一级），与解释器无关。`spawnSync` 对「可执行文件找不到」
 *     和「工作目录不存在」报的是同一个 `ENOENT`，当年把两者混为一谈了。
 *
 * 用 `process.execPath` 还消除了一个真实风险：裸 `node` 走 PATH，PATH 上排在前面的可能是
 * 另一个 node——于是「跑测试的解释器」与「跑 Prisma CLI 的解释器」不是同一个。
 * `process.execPath` 是绝对路径，无歧义、无 PATH 依赖，两个平台同形。
 */
export const NODE_BIN = process.execPath;

/**
 * 解析 `apps/api` 里 `prisma` CLI 的真实 JS 入口。
 *
 * 以 `apps/api` 为基准做 `createRequire`，在 pnpm 的隔离布局下会正确落到
 * `.pnpm/prisma@7.10.0.../node_modules/prisma`，再取 `bin.prisma` 指向的 `build/index.js`。
 * 这条路两侧平台完全同形：不依赖 PATH 解析包、不依赖 shell、无引号转义问题。
 */
export function resolvePrismaCli(): string {
  const api = apiDir();
  const requireFromApi = createRequire(path.join(api, 'package.json'));
  const pkgPath = requireFromApi.resolve('prisma/package.json') as string;
  const pkg = requireFromApi(pkgPath) as { bin: { prisma: string } };
  return path.join(path.dirname(pkgPath), pkg.bin.prisma);
}

/** `apps/api/prisma/schema.prisma`（schema 的唯一来源，用于新鲜度比较）。 */
export function schemaPath(): string {
  return path.join(apiDir(), 'prisma/schema.prisma');
}

/** `apps/api/prisma.config.ts`：决定 CLI 怎么跑（schema 路径、迁移路径、连接串来源）。 */
function prismaConfigPath(): string {
  return path.join(apiDir(), 'prisma.config.ts');
}

/**
 * 生成 Prisma 客户端。
 *
 * **幂等且防陈旧**：产物不存在、或**任一决定产物的输入**比产物更新时才会真正跑一次
 * `prisma generate`。
 *
 * 为什么不只判断「产物是否存在」：那样会**静默给出陈旧客户端**——改了
 * `schema.prisma` 之后，typecheck 与单测会继续用旧的类型和旧的运行时，
 * 而这是最难查的一类失败（现象是「我明明加了字段却报没有」）。
 * 用 mtime 比较可以覆盖这个缺口。
 *
 * 比较的输入有三类（取其中**最新**的一个与产物比），缺任何一类都会留下一个静默陈旧的口子：
 *   1. `prisma/schema.prisma` —— 模型/类型变了；
 *   2. `prisma.config.ts` —— 生成器的落点（`output`）与 CLI 行为由它决定，改了它不重生成
 *      会得到「配置说改了、产物还是旧的」；
 *   3. `prisma` CLI 的入口文件（`resolvePrismaCli()` 的返回值，即 `build/index.js`）——
 *      版本一升，产物应当由**新** CLI 重新产出；只比 schema 的话，`pnpm install` 升级
 *      Prisma 之后产物仍是旧版本生成的，而两者对同一份 schema 可能生成不同代码。
 *
 * `force` 为真时无条件重生成（排障用）。
 */
export function ensurePrismaClientGenerated(force = false): void {
  if (!force && isGeneratedClientFresh()) return;
  execFileSync(NODE_BIN, [resolvePrismaCli(), 'generate'], {
    cwd: apiDir(),
    env: process.env,
    stdio: 'inherit',
  });
}

/** 产物存在且不比**任何**输入旧。 */
function isGeneratedClientFresh(): boolean {
  const mtime = (p: string): number | undefined => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return undefined;
    }
  };
  const generated = mtime(generatedClientPath());
  if (generated === undefined) return false;

  // Prisma CLI 的入口文件：`resolvePrismaCli()` 已经解析过它，这里再取一次 mtime。
  // 版本升级会换掉 pnpm store 里的目录，因此 mtime 必然更新。
  const inputs = [mtime(schemaPath()), mtime(prismaConfigPath()), mtime(resolvePrismaCli())];
  // 任一届时读不到（例如被挪走）时不冒险认定新鲜，直接重生成。
  if (inputs.some((t) => t === undefined)) return false;
  const newestInput = Math.max(...(inputs as number[]));
  return generated >= newestInput;
}
