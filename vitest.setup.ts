/**
 * Vitest 全局 setup：在**任何**测试项目加载模块之前，保证 Prisma 客户端已生成。
 *
 * 为什么不能只靠 npm 脚本的 `pretest`：那只在 `pnpm test` 时触发，而本项目多处
 * （含 brief 的验证命令 `pnpm vitest run --project unit`）直接调 vitest，
 * 于是新克隆的仓库一跑就报 `Cannot find module '../generated/prisma/client.js'`（已实测）。
 * 放在这里则与调用方式无关：`pnpm test` / `pnpm vitest run --project X` / IDE 单跑都成立。
 *
 * 生成是幂等的（`ensurePrismaClientGenerated` 见到产物即返回），因此 5 个 project
 * 各调一次也不会重复启动 CLI。
 *
 * `repoRoot` 由本文件（仓库根）显式给出，而不是让 helper 自己去猜相对深度——原因见
 * `tests/helpers/prisma-generate.ts` 顶部注释。
 */
import { configurePrismaGenerate, ensurePrismaClientGenerated } from './tests/helpers/prisma-generate.js';

configurePrismaGenerate(import.meta.dirname);
ensurePrismaClientGenerated();
