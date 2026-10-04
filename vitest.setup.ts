/**
 * Vitest **globalSetup**：在**任何**测试文件被收集/加载之前，保证 Prisma 客户端已生成。
 *
 * ## 为什么挂在 globalSetup 而不是 setupFiles
 *
 * 这里原先挂在每个 project 的 `setupFiles` 上。功能上能用，但 `setupFiles` 是在**每个
 * 测试进程**里求值的，而本仓库有 5 个 project——`pnpm vitest run`（不带 `--project`）会
 * 让 5 个进程**并发**对着同一个输出目录 `apps/api/src/generated/` 跑 `prisma generate`。
 * 幂等性由 Prisma 自己兜底，但那是「同一份产物被五个进程同时写」，没有理由去赌。
 *
 * `globalSetup` 的语义正好合适：Vitest 的**根** `globalSetup` 每次测试运行只跑一次
 * （Vitest 5 源码里它是 `NON_INHERITED_ROOT_OPTIONS`，即子项目不会各自继承、也不会各自执行，
 * 见 `vitest/dist/chunks/index.*.js` 的 `the root globalSetup already runs once per test run`
 * 注释）。而且它与 `--project X` 无关——`vitest run`、`vitest run --project unit`、
 * IDE 单跑都会走一次，正是我们要的覆盖面：生成**恰好一次**，且**一定在**测试之前。
 *
 * ## 为什么不能只靠 npm 脚本的 `pretest`
 *
 * 那只在 `pnpm test` 时触发，而本项目多处（含 brief 的验证命令
 * `pnpm vitest run --project unit`）直接调 vitest，于是新克隆的仓库一跑就报
 * `Cannot find module '../generated/prisma/client.js'`（已实测）。
 *
 * 生成本身是幂等的（`ensurePrismaClientGenerated` 见到产物不旧于任一输入即返回），
 * 所以正常（新鲜）情况下这里不会启动任何 CLI。
 *
 * `repoRoot` 由本文件（就位于仓库根）显式给出，而不是让 helper 去猜相对深度——原因见
 * `tests/helpers/prisma-generate.ts` 顶部注释。
 */
import { configurePrismaGenerate, ensurePrismaClientGenerated } from './tests/helpers/prisma-generate.js';

export function setup(): void {
  configurePrismaGenerate(import.meta.dirname);
  ensurePrismaClientGenerated();
}
