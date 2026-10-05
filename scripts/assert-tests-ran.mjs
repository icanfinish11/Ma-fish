#!/usr/bin/env node
/**
 * 「安全门不许空转」的 CI 断言（Task 9 / Ruling 3）。
 *
 * ## 它防的是什么（本仓库已经抓到过的缺陷形状）
 *
 * `package.json` 里的 `test:security` / `test:arch` 等脚本带着 `--passWithNoTests`
 * （Task 1 加的，为的是本地开发时一个空 project 不至于报错）。代价是：
 * **文件名写错、include glob 写错、或者某个 project 整个被搬走时，命令照样以 0 退出**，
 * 而门——默认拒绝覆盖率、限流覆盖率、架构规则——在这一刻**什么都没检查**。
 * 这正是 Task 7 复审记下的那条：「一个能被零条测试满足的安全门，就是本项目反复抓到的
 * 那类缺陷」。CI 里跑测试不是为了看绿色的字，是为了让「门真的存在」这件事可验证。
 *
 * ## 做法
 *
 * 用 vitest 的 **json reporter** 把这次运行的结果写到临时文件，然后断言：
 *   1. 真的**执行**了测试（条数不少于下面 `GATES` 里登记的下限）；
 *   2. 没有失败（退出码与 `success` 同时看）。
 *
 * 「执行」是字面意思：判据取 `numTotalTests - numPendingTests - numTodoTests`，**不是**
 * `numTotalTests`。vitest 的 `numTotalTests` 把 `it.skip` / `it.todo` 也算进去，
 * 于是「把一条安全用例改成 `it.skip`」会让门**照样绿**（修复轮 2 实测：49 条里 skip 掉
 * 一条，`numTotalTests` 仍是 49）。那正是本文件开头那段话的反面——门看起来还在，
 * 实际检查的东西少了一件。被跳过的条数会在下面的输出里显式报出来。
 *
 * 下限写成**具体数字**而不是 `> 0`：整数下限能同时抓住「整个 project 没了」与
 * 「某一个测试文件被静默删掉/改名」。数字与当前实际条数对齐，因此**任何**删除都会
 * 红一次并要求改这里——这是刻意的摩擦：安全门的覆盖面缩小，必须是一次有意识的改动，
 * 而不是某个提交里顺手发生的事。若确有正当理由（合并用例、删掉过时用例），
 * 请连同理由一起下调这里。
 *
 * ## 为什么自己起 vitest（而不是在 yml 里写两行 shell）
 *
 * 同一段逻辑本地与 CI 跑的是**同一份**：`node scripts/assert-tests-ran.mjs security`。
 * 起进程走 `process.execPath` + vitest 自己的 JS 入口，不经过 `pnpm`/`.cmd` 垫片
 * （K19：Windows 上 `execFileSync('pnpm', …)` 会 ENOENT，`shell: true` 也不可靠）。
 *
 * ## 依赖自检（K6）
 *
 * 只用到 node 内建模块，以及根 `devDependencies` 里已声明的 `vitest`——没有新增依赖。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * project 名 → 必须被真正执行的用例条数下限。
 *
 * 只登记**安全相关**的 project：它们的「绿」直接等于一条安全约束成立，
 * 因此必须自证不是空转。`unit` / `integration` 不在此列——那两类门由 CI 的
 * 「跑了测试并全绿」这句本身承担，而它们的规模与构成会频繁变化，钉死条数只会制造噪音。
 */
const GATES = {
  // 修复轮 1（P1 / Task 3）：原先是 **49，而实际执行 53** —— 与上面「数字与当前实际条数对齐」
  // 那句话不符。低的这 4 条让「静默删掉最多 4 条安全用例」不会红，正是本文件开头那段话
  // 要防的形状。那一轮把制品完整性控制纳入 security 门
  // （`tests/security/asset-artifact-integrity.test.ts` 6 条），并把下限**对齐到实际执行数**：49 → 59。
  //
  // 修复轮 1（P1 / Task 4，Ruling 3）：归档校验器**就是**设计文档威胁 #2 的控制面，而它的
  // 八条样本判定此前只住在 `unit`（`tests/unit/asset/validate-archive.test.ts`）⇒ 把
  // `validateArchive` 删掉、或把六个恶意样本的判据逐条去掉，**这道门照样绿**：它数的是
  // `tests/security/` 里的用例。这一轮把那九条（八样本 + 零落盘）**搬进** security 门
  // （`tests/security/validate-archive-samples.test.ts`，复用同一份样本生成器与构造辅助，
  // 不是复制两份），下限随之对齐到实际执行数：59 → 68。任何删除现在都会红一次。
  //
  // P1 / Task 8：越权矩阵（判据 11）落在 `tests/security/asset/authz-matrix.test.ts`——17 条
  // （4 端点 × 4 角色 + 1 条「矩阵覆盖全部已注册路由」）。**它必须进入被计数的门**：
  // 「未授权用户拿不到签名 URL」是 P1 的三条判据之一，而这条控制在 security 的账上
  // 才有「被静默删掉就会红」的性质。下限随之对齐到实际执行数：68 → 85。
  security: 85,
  architecture: 5,
};

/** vitest 自己的 JS 入口（读它 `package.json` 里声明的 `bin.vitest`，不猜路径）。 */
function resolveVitestBin() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('vitest/package.json');
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declared = pkg.bin?.vitest;
  if (!declared) throw new Error(`vitest 的 package.json 未声明 bin.vitest：${manifestPath}`);
  return path.resolve(path.dirname(manifestPath), declared);
}

/**
 * 跑一个 project 并返回 json 报告。**输出直接透传**（`stdio: 'inherit'`）：
 * CI 日志里必须能看见 vitest 原本的逐文件结果，否则失败时要靠猜。
 */
function runProject(project, reportFile) {
  const args = [
    resolveVitestBin(),
    'run',
    '--project',
    project,
    // 两个 reporter 并存：`default` 给人看（透传到日志），`json` 给下面的断言看。
    // `--outputFile.json=` 只把 json 写文件，人读的那份仍留在 stdout。
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportFile}`,
  ];
  try {
    execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    return { failed: false };
  } catch (error) {
    return { failed: true, reason: `vitest 以非零码退出（${error?.status ?? '?'}）` };
  }
}

function readReport(reportFile) {
  try {
    return JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch {
    return null;
  }
}

const requested = process.argv.slice(2);
const projects = requested.length > 0 ? requested : Object.keys(GATES);

const unknown = projects.filter((p) => !(p in GATES));
if (unknown.length > 0) {
  console.error(
    `::error::未登记的门：${unknown.join(', ')}。可用的有 ${Object.keys(GATES).join(', ')}——` +
      '要新增请同时在 scripts/assert-tests-ran.mjs 的 GATES 里写下限。',
  );
  process.exit(1);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'vca-gate-'));
let failed = false;

try {
  for (const project of projects) {
    const floor = GATES[project];
    const reportFile = path.join(workDir, `${project}.json`);
    const run = runProject(project, reportFile);
    const report = readReport(reportFile);

    if (!report) {
      console.error(
        `::error::${project}：没有拿到 vitest 的 json 报告（${run.reason ?? '未知原因'}）。` +
          '最常见的原因是**一条测试都没匹配到**（include glob 或文件名被改过）——' +
          '门在这一刻是空的，命令不能算通过。',
      );
      failed = true;
      continue;
    }

    const total = report.numTotalTests ?? 0;
    const passed = report.numPassedTests ?? 0;
    // 「收集到」不等于「执行了」：`it.skip` / `it.todo` 都计入 numTotalTests。减法而不是
    // 直接用 numPassedTests，是为了让失败时能报出「收集了多少、跳过多少」这两项，
    // 归因不必靠猜。（失败本身由下面的 success 分支负责，不会漏。）
    const pending = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
    const executed = total - pending;
    if (executed === 0) {
      console.error(
        `::error::${project}：一条用例都没**执行**（收集到 ${total} 条，其中 ${pending} 条被 skip/todo）。` +
          '门在这一刻是**空的**，命令不能算通过——最常见的原因是 include glob 或测试文件名被改过、' +
          'project 选择写错了，或者整个文件被 skip 掉了。',
      );
      failed = true;
      continue;
    }
    if (run.failed || report.success !== true) {
      console.error(
        `::error::${project}：用例未全部通过（执行 ${executed} 条，通过 ${passed} 条）${run.reason ?? ''}`,
      );
      failed = true;
      continue;
    }
    if (executed < floor) {
      console.error(
        `::error::${project}：只**执行**了 ${executed} 条用例，低于登记的 ${floor} 条` +
          `（收集到 ${total} 条，其中 ${pending} 条被 skip/todo，不计入）。` +
          '门被削弱了（文件被改名/删除？有用例被 skip 掉？project 选择写错？）。若是有意为之，' +
          '请下调 scripts/assert-tests-ran.mjs 的 GATES 并在提交信息里说明理由。',
      );
      failed = true;
      continue;
    }
    console.log(
      `✔ ${project}：实际执行 ${executed} 条用例（下限 ${floor}），全部通过。` +
        (pending > 0 ? `另有 ${pending} 条被 skip/todo，**未**计入执行数。` : ''),
    );
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
