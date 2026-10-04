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
 *   * `vitest.setup.ts`（所有 project 的 setupFiles）——覆盖 `pnpm vitest run --project X`
 *     这类**绕过 npm script 生命周期**的调用（`pretest` 只在 `pnpm test` 时触发，
 *     而 brief 的验证命令正是 `pnpm vitest run --project unit`）；
 *   * `apps/api` 的 `pretypecheck`——覆盖 typecheck；
 *   * 根 `pretest`——覆盖 `pnpm test`。
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

/** 生成客户的落点：存在即可跳过生成（幂等判据）。 */
export function generatedClientPath(): string {
  return path.join(apiDir(), 'src/generated/prisma/client.ts');
}

/**
 * 用来执行 Prisma CLI 的 node 解释器。
 *
 * **刻意不用 `process.execPath`**：vitest 工人进程里的 `process.execPath` 可能指向一个
 * 并不存在的 node（本机实测为 `D:\Node.js\node.exe`，而实际在跑的是另一份 node），
 * 于是 `execFileSync` 抛 `Error: spawnSync ... ENOENT`。
 * 用裸 `node` 交给 PATH 解析则必然命中「正在运行测试的那个 node」——因为 vitest 就是它跑的。
 * 两侧平台一致（Windows 上 `node.exe` 同样在 PATH 里），不需要平台分支。
 */
export const NODE_BIN = 'node';

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

/**
 * 生成 Prisma 客户端。
 *
 * **幂等且防陈旧**：产物不存在、或 `schema.prisma` 比产物更新时才会真正跑一次
 * `prisma generate`（实测一次约 1.4s，5 个 project 各调一次不值得白跑）。
 *
 * 为什么不只判断「产物是否存在」：那样会**静默给出陈旧客户端**——改了
 * `schema.prisma` 之后，typecheck 与单测会继续用旧的类型和旧的运行时，
 * 而这是最难查的一类失败（现象是「我明明加了字段却报没有」）。
 * 用 mtime 比较可以覆盖这个缺口。
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

/** 产物存在且不比 `schema.prisma` 旧。 */
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
  const schema = mtime(schemaPath());
  // schema 读不到（例如被挪走）时不冒险认定新鲜，直接重生成。
  if (schema === undefined) return false;
  return generated >= schema;
}
