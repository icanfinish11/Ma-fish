import { artifactStoreDirFor } from '../helpers/env.js';

/**
 * 让**每个测试 worker 各有一个制品卷**（修复轮 1 / Fix 5）。
 *
 * ## 为什么必须是 setup 文件（实测三次才定位到，不是风格选择）
 *
 * 应用的配置在**模块求值期**就被解析：`ConfigModule.forRoot()` 的 `validate` 同步跑
 * （`apps/api/src/config/config.module.ts`），而 `tests/helpers/app.ts` 会 import `@vca/app`
 * ——该 import 在测试文件的**任何语句之前**求值（ESM 的 import 提升）。于是：
 *
 * 1. 在测试文件里 import 之后、`beforeAll` 里改 `process.env`：太晚（实测三条用例变红，
 *    `evidence/t1-fix1-diag2.txt`）；
 * 2. 在测试文件顶层（import 之后）改：**仍然太晚**（实测同样三条红，`evidence/t1-fix1-diag3.txt`）；
 * 3. 只有比**测试文件本身**更早的钩子才行——Vitest 的 `setupFiles` 正是这个位置：
 *    它在 worker 里、测试文件被 import **之前**执行，因此应用求值时读到的已经是本文件写下的值。
 *
 * ## 为什么按 worker 而不是写死一个路径
 *
 * 制品套件（本任务起是 `tests/integration/asset/upload-stream.test.ts`）会在
 * `beforeAll`/`beforeEach` 里 `rm -rf` 自己的制品目录。目录若是所有文件共用的固定路径，
 * 两个并发文件的清理就会互相删掉对方正在用的对象——失败形态是「上传成功但读回是空」，
 * 完全看不出原因。`VITEST_POOL_ID` 是 worker 的稳定编号（实测存在，见
 * `evidence/t1-fix1-probe-vitest-env.txt`），因此并发文件必然落在不同目录里。
 *
 * 本文件只做这一件事：**把目录定下来**。目录的清理归各套件自己（谁用谁清）。
 * 这里刻意不 import 任何应用代码，理由同 `tests/helpers/env.ts`（加载顺序）。
 */
process.env.ARTIFACT_STORE_DIR = artifactStoreDirFor(process.env.VITEST_POOL_ID ?? process.pid);
