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
 *   1. 真的跑了测试（`numTotalTests` 不少于下面 `GATES` 里登记的下限）；
 *   2. 没有失败（退出码与 `success` 同时看）。
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
  security: 49,
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
    if (total === 0) {
      console.error(
        `::error::${project}：一条用例都没跑起来（0 条）。门在这一刻是**空的**，` +
          '命令不能算通过——最常见的原因是 include glob 或测试文件名被改过，' +
          '或者 project 选择写错了。',
      );
      failed = true;
      continue;
    }
    if (run.failed || report.success !== true) {
      console.error(`::error::${project}：用例未全部通过（${passed}/${total} 通过）${run.reason ?? ''}`);
      failed = true;
      continue;
    }
    if (total < floor) {
      console.error(
        `::error::${project}：只跑了 ${total} 条用例，低于登记的 ${floor} 条。` +
          '门被削弱了（文件被改名/删除？project 选择写错？）。若是有意为之，' +
          '请下调 scripts/assert-tests-ran.mjs 的 GATES 并在提交信息里说明理由。',
      );
      failed = true;
      continue;
    }
    console.log(`✔ ${project}：实际执行 ${total} 条用例（下限 ${floor}），全部通过。`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
