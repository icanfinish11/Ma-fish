import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 架构守护（设计 §3.3 的可拆分性约束 / 验收 13.4）。
 *
 * §3.3 的四条约束里，本文件负责把 **(1) 每模块独占自己的表** 与 **(2) 跨模块只走显式接口**
 * 变成「违反就红」的机器约束，而不是文档里的愿望；约束 (4)「CI 加架构守护测试」正是它
 * 出现在 CI 里的理由。约束 (3)（跨模块写入收敛到少数编排入口 + 事务性 outbox）在 P0 只有
 * `AuditService` 一个跨模块写入点，它本身就是那唯一的编排入口，故不另设机制（C16：不建
 * 投机性抽象）——作为延后项记录在 task-9-report.md。
 *
 * 约束 (1) 的**运行时**一半（哪张表真的落在哪个 schema）由
 * `tests/integration/db/schema-isolation.test.ts` 精确钉住（对
 * `(table_schema, table_name)` 全集断言）。
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const MODULES_DIR = path.join(ROOT, 'apps/api/src/modules');
const CONFIG_FILE = '.dependency-cruiser.cjs';

/**
 * depcruise 的**真实 JS 入口**（K19）。
 *
 * 为什么不用 brief 里的 `execFileSync('pnpm', ['exec', 'depcruise', …])`：Windows 上
 * `pnpm` 是 `.cmd` 垫片，`execFileSync` 直接起它会 ENOENT（K19，Task 3 / Task 7 都踩过），
 * 而 `shell: true` 会把参数交给 cmd.exe 重新解析（Task 7 实测它同样不可靠）。
 *
 * 为什么不用 `createRequire().resolve('dependency-cruiser')`：dependency-cruiser 18 是
 * **纯 ESM**（`exports` 里只有 `import` 条件，没有 `require` / `default`），`require.resolve`
 * 会以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 失败（实测留档：evidence/t9-depcruise-resolution.txt）。
 * 因此走 `import.meta.resolve`（Node 22 起同步可用，已实测在 vitest 的模块管线里也可用），
 * 再从包根 `package.json` 读它**自己声明**的 `bin.depcruise`——不猜路径，将来升级挪了文件，
 * 这里读到的也只是新值。最后交给 `process.execPath` 执行，与 `pnpm arch` 跑的是同一个文件。
 */
function resolveDepcruiseBin(): string {
  const mainPath = fileURLToPath(import.meta.resolve('dependency-cruiser'));
  for (let dir = path.dirname(mainPath); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name?: string;
      bin?: Record<string, string>;
    };
    if (pkg.name !== 'dependency-cruiser') continue;
    const declared = pkg.bin?.['depcruise'];
    if (!declared) throw new Error(`dependency-cruiser 的 package.json 未声明 depcruise 入口：${manifest}`);
    const bin = path.join(dir, declared);
    if (!existsSync(bin)) throw new Error(`dependency-cruiser 声明的入口不存在：${bin}`);
    return bin;
  }
  throw new Error(`无法从 ${mainPath} 向上找到 dependency-cruiser 的 package.json`);
}

interface DepcruiseViolation {
  rule: { name: string; severity: string };
  from: string;
  to: string;
}

/**
 * `summary.ruleSetUsed` 里的规则**就是配置里那一条**（depcruise 把加载到的规则原样回灌进报告）。
 * 断言它而不是断言配置文件本身：前者证明「规则真的被加载了」，后者只证明「文件里写着」。
 * 注意 `pathNot` 写成数组时已经在报告里被 `join('|')` 成字符串了（见 `.dependency-cruiser.cjs`）。
 */
interface DepcruiseRuleUsed {
  name: string;
  severity: string;
  from?: { path?: string; pathNot?: string };
  to?: { path?: string; pathNot?: string; circular?: boolean };
}

interface DepcruiseSummary {
  error: number;
  warn: number;
  violations: DepcruiseViolation[];
  totalCruised: number;
  ruleSetUsed?: { forbidden?: DepcruiseRuleUsed[] };
}

interface DepcruiseRun {
  /**
   * 子进程退出码（被信号杀掉 / 拿不到状态时为 `null`）。
   *
   * **不要**把它当成「有没有架构违规」的判据。本文件用 `--output-type json`
   * （为了断言结构而不是文案），而实测 dependency-cruiser 18.5.0 **在这个模式下
   * 即使有 error 违规也以 0 退出**：同一个必然违规的配置，默认 reporter 退出 1、
   * json reporter 退出 0，`summary.error = 1` 照样写在报告里。
   * 违规判据是 `summary.error`（`pnpm arch` 走默认 reporter，它的退出码才是承重的）。
   * 取证：`.superpowers/sdd/2026-10-04-p0-security-foundation/evidence/t9-fix2-premises.txt`。
   */
  exitCode: number | null;
  summary?: DepcruiseSummary;
  /** 被巡航到的模块路径（相对 ROOT，正斜杠），用于「守护不是空转」的证据。 */
  sources: string[];
  raw: string;
}

/**
 * 跑一次与 `pnpm arch` 同源的命令。
 *
 * `--output-type json` 是刻意的：断言要看**结构**（规则名、规则范围、模块数、违规对），
 * 而不是看文案。文案在版本间会变，结构也是 depcruise 自己的公开契约
 * （reporters 文档里的 cruise-result schema）。
 */
function runDepcruise(): DepcruiseRun {
  const args = [
    resolveDepcruiseBin(),
    '--config',
    CONFIG_FILE,
    '--output-type',
    'json',
    'apps',
    'packages',
  ];
  try {
    const raw = execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return parseRun(raw, raw, 0);
  } catch (error) {
    // 子进程失败（配置缺失、解析不了、崩溃）时报告仍在 stdout 上；没有 JSON 时 `summary` 为空。
    //
    // **实测（dependency-cruiser 18.5.0）**：`--output-type json` 下「发现 error 违规」
    // **不会**让进程以非零码退出——同一份必然违规的配置，默认 reporter 退出 1、
    // json reporter 退出 0（`summary.error = 1` 照样写在报告里）。因此这里的退出码
    // 只用来区分「进程正常跑完」与「进程根本没跑起来」，**不能**当违规判据。
    const status = (error as { status?: number | null }).status ?? null;
    const stdout = String((error as { stdout?: string }).stdout ?? '');
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    return parseRun(stdout, `${stdout}\n${stderr}`, status);
  }
}

function parseRun(stdout: string, raw: string, exitCode: number | null): DepcruiseRun {
  try {
    const parsed = JSON.parse(stdout) as {
      modules?: Array<{ source: string }>;
      summary: DepcruiseSummary;
    };
    return {
      exitCode,
      summary: parsed.summary,
      sources: (parsed.modules ?? []).map((m) => m.source.replaceAll('\\', '/')),
      raw,
    };
  } catch {
    return { exitCode, sources: [], raw };
  }
}

/** 只跑一次：两条用例读同一份事实，也省掉一次完整巡航。 */
let cached: DepcruiseRun | undefined;
function cruise(): DepcruiseRun {
  cached ??= runDepcruise();
  return cached;
}

describe('架构守护（C5 / 验收 13.4）', () => {
  it('dependency-cruiser 规则全部通过（禁跨模块内部 import）', () => {
    const { exitCode, summary, raw } = cruise();

    if (!summary) {
      throw new Error(
        `depcruise 没有产出 JSON 报告（进程退出码 ${exitCode}；多半是配置缺失或无法解析，而不是发现违规）：\n${raw}`,
      );
    }

    const report = summary.violations
      .map((v) => `[${v.rule.severity}] ${v.rule.name}\n    ${v.from} → ${v.to}`)
      .join('\n');

    // 规则集本身也要被断言，否则「把规则从配置里删掉」这条最省事的走法能让本用例**恒绿**：
    // 没有规则时 depcruise 照样输出 `error: 0`。这正是本仓库反复抓到的「门是空的」形态
    // （与 Task 7 的 `--passWithNoTests` 同源），所以门必须自证它加载到了什么。
    //
    // `no-cross-module-internals` 在修复轮 1 之后**一条规则同时管四个主体**：模块之间、
    // 平台层（`db` / `common`）、`apps/api/src/*.ts`（组合根那一层，修复轮 2 加入）与
    // `apps/worker`。共用同一个规则名是刻意的——它们是同一个约束（§3.3 第 2 条：
    // 不许依赖别人的内部实现）的四个方向，而拆成四条规则会让「谁覆盖了谁」变成要读
    // 四遍 `from.path` 才知道的事。
    const declared = summary.ruleSetUsed?.forbidden ?? [];
    for (const rule of ['no-cross-module-internals', 'no-shared-to-apps', 'no-circular']) {
      expect(
        declared.map((r) => r.name),
        `规则集里没有 ${rule}：${CONFIG_FILE} 的 forbidden 被改过？`,
      ).toContain(rule);
    }

    // ── 规则的**范围**也要被断言（修复轮 2）────────────────────────────────
    //
    // 只断言规则名是不够的：实测反例——把 `from.path` 里的 `apps/worker/src/` 分支删掉，
    // `pnpm arch` 退出 0 且输出 `57 modules, 110 dependencies cruised`，与基线**逐字相同**，
    // 整个架构套件也照样全绿（其余断言只看规则名、巡航目录、模块↔模块文本、写入路径与 C2）。
    // 也就是说：这条规则——修复轮 1 两个依赖反转收口的**唯一**执行者——当时是被散文钉住的。
    // 这里改成直接拿规则**自己声明的**正则去匹配代表路径，断言的是语义（这条边归不归它管），
    // 而不是正则怎么写。
    const crossModule = declared.find((r) => r.name === 'no-cross-module-internals');
    const scope = crossModule?.from?.path;
    if (typeof scope !== 'string') {
      throw new Error(
        `no-cross-module-internals 没有声明 from.path（规则范围不明）：${JSON.stringify(crossModule?.from)}`,
      );
    }
    const scopeRe = new RegExp(scope);
    for (const [layer, subject] of RULE_SCOPE_SUBJECTS) {
      expect(
        scopeRe.test(subject),
        `no-cross-module-internals 的 from.path 不再覆盖「${layer}」（${subject}）：\n${scope}\n` +
          '（修复轮 1 的两个依赖反转靠这条规则兜底；范围缩了不会有别的东西报警）',
      ).toBe(true);
    }

    // 组合根的**显式豁免**（修复轮 2 裁定）：`app.module.ts` 的职责就是认识每一个模块，
    // 强制它改走 index 只是仪式。豁免写在 `from.pathNot` 里，而不是靠「`from.path` 恰好
    // 没写到它」——它是承重的：`from.path` 的第 3 条分支已经覆盖 `apps/api/src/*.ts`，
    // 删掉这一行 `pnpm arch` 会立刻对着 app.module.ts 的 4 条 module import 报错（P9 实测）。
    const exemption = crossModule?.from?.pathNot;
    if (typeof exemption !== 'string') {
      throw new Error(
        `no-cross-module-internals 没有声明组合根豁免（from.pathNot）：${JSON.stringify(crossModule?.from)}`,
      );
    }
    expect(
      new RegExp(exemption).test(COMPOSITION_ROOT),
      `组合根没有被显式豁免：from.pathNot = ${exemption}，它匹配不上 ${COMPOSITION_ROOT}`,
    ).toBe(true);

    expect(summary.error, `架构违规 ${summary.error} 条：\n${report}\n`).toBe(0);

    // 这里**刻意没有** `expect(exitCode).toBe(0)` 之类的断言（修复轮 2 删掉的那一条）。
    // 它此前写作 `expect(ok, 'depcruise 以非零码退出…').toBe(true)`，而这是**恒真**的：
    // 本文件用 `--output-type json`，实测该模式下即使有 error 违规进程也以 0 退出，
    // 于是 `ok` 只等价于「进程没崩」——但进程真崩了、拿不到 JSON 时上面第 1 个 `throw`
    // 已经先响了。一个永远不会因为自己声称的理由而失败的断言，就是这个项目反复抓到的
    // 第四种缺陷形状；判据是上面的 `summary.error`。
  });

  /**
   * 「0 违规」只有在**真的巡航到了源码**时才有意义。
   *
   * 判别式：把 `.dependency-cruiser.cjs` 的 `exclude` 改成一个吃掉全部源码的规则
   * （例如 `'\\.ts$'`），上一条用例仍然全绿（0 违规），而这一条会红——已用变异取证，
   * 见 task-9-report.md §4。
   */
  it('每个模块目录、两个 app 与 shared 包都被真的巡航到了（守护不是空转）', async () => {
    const { summary, sources } = cruise();
    if (!summary) throw new Error('depcruise 没有产出 JSON 报告');
    expect(summary.totalCruised).toBeGreaterThan(0);

    const expected = [
      ...(await listModuleNames()).map((name) => `apps/api/src/modules/${name}/`),
      'apps/worker/src/',
      'packages/shared/src/',
    ];
    const missing = expected.filter((prefix) => !sources.some((s) => s.startsWith(prefix)));
    expect(
      missing,
      `下列目录一个源文件都没被巡航到：${missing.join(', ')}\n（cruise 目标或 exclude 是否把它们排除了？）`,
    ).toEqual([]);

    // 修复轮 1 起，`no-cross-module-internals` 那条规则**放行**的正是
    // `modules/<other>/index.ts`。两个 index 因此成了「平台层与 worker 唯一的合法入口」：
    // 它们若没被巡航到（被 exclude 吃掉、或路径写错），放行条款就无从判断，
    // 而规则会以「到不了任何目标」的形式恒绿——今天必须点名把它们钉住。
    const named = ['apps/api/src/modules/notify/index.ts', 'apps/api/src/modules/audit/index.ts'];
    const notCruised = named.filter((source) => !sources.includes(source));
    expect(
      notCruised,
      `这些对外接口文件没被巡航到：${notCruised.join(', ')}\n` +
        '（它们是跨模块/平台/worker 唯一被放行的入口，规则依赖它们在场）',
    ).toEqual([]);
  });

  it('模块之间不相互 import 内部实现（只允许经 index 或 shared）', async () => {
    const modules = await listModuleNames();
    expect(modules.length, `没有在 ${path.relative(ROOT, MODULES_DIR)} 下发现任何模块目录`).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const mod of modules) {
      for (const file of await walk(path.join(MODULES_DIR, mod))) {
        if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
        // 注释里出现的 `from '…'` 不是依赖。先剥注释再扫，规则才不会对着散文变红
        // （本仓库注释密度很高，这一步是必须的）。
        const src = stripComments(await readFile(file, 'utf8'));
        for (const specifier of importSpecifiers(src)) {
          const target = resolveSpecifier(file, specifier);
          if (!target) continue;
          const rel = path.relative(MODULES_DIR, target).split(path.sep);
          const other = rel[0];
          // 只关心「指向另一个模块目录」的说明符；本模块自己的文件、以及
          // `modules/<other>/index.*`（对外接口）都放行。
          if (other === undefined || other === mod || rel.length < 2 || other.startsWith('..')) continue;
          const entry = rel.slice(1).join('/');
          if (/^index(\.[cm]?[jt]s)?$/.test(entry)) continue;
          violations.push(`${path.relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(
      violations,
      `跨模块内部依赖（应改为经 modules/<other>/index.ts 导出的接口）：\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * §3.3 第 3 条「跨模块写入收敛到少数编排入口」在 P0 的**可执行切片**。
   *
   * P0 里真正存在跨模块写入关系的只有两处：`auth` 要写审计（经 `AuditService.record`，
   * 而审计表是 append-only 的，写进去就删不掉），以及 outbox 的读写（`notify` 自己的表）。
   * 它们的共同要求是**写入路径唯一**——`audit.service.ts` 的注释把这句话写死过：
   * 「审计的**写入路径**必须有且只有一条，否则『审计是否可靠』就要按最弱的那条来判断」。
   * 在那之前，没有任何东西在检查这句话：`.dependency-cruiser.cjs` 只管 import 关系，
   * 而 `PrismaService` 是全局的——`auth` 完全可以绕开 `AuditService` 直接
   * `this.prisma.auditLog.create(...)`，依赖图上看不出任何异常。
   *
   * ## 为什么按**模型名**匹配，而不是按 `prisma.<模型>` 匹配
   *
   * 因为真实的写法有两种：`this.prisma.outboxEvent.findMany(...)` 与事务里的
   * `tx.outboxEvent.update(...)`（`outbox.consumer.ts` 两处都有）。只认前者会漏掉
   * 事务内的写入——那恰恰是最需要收敛的路径。模型名本身足够独特，可直接精确匹配。
   *
   * ## 覆盖边界（据实说明，别当成比它更强的保证）
   *
   * 文本层面区分不了读与写：这条规则把「读别人的表」也一并报了。这是**有意**的——
   * C5 说的就是「每模块独占 schema，不做跨模块表访问」，读同样算。它管不到的：
   * 把模型名拼成字符串（`prisma['auditLog']`）、或经 `@vca/api/db/prisma.service` 之外的
   * 连接串自己开一个 pg 客户端。后者要比对连接串，属于 P7 部署加固的范畴。
   */
  it('审计与 outbox 的表只由所属模块直接触碰（写入路径唯一，§3.3 第 3 条）', async () => {
    const owners = new Map(SINGLE_WRITE_PATH.map((entry) => [entry.delegate, entry.owner]));
    const pattern = new RegExp(`\\b(${[...owners.keys()].join('|')})\\b`, 'g');
    /** 这次扫描**看到的全部**命中（不只是违规的），阳性对照要用它。 */
    const hits: Array<{ rel: string; delegate: string; own: string | null; line: number }> = [];

    for (const root of [path.join(ROOT, 'apps'), path.join(ROOT, 'packages')]) {
      for (const file of await walk(root)) {
        if (!SCAN_FILE_PATTERN.test(file) || file.endsWith('.d.ts')) continue;
        const rel = path.relative(ROOT, file).replaceAll('\\', '/');
        if (SCAN_SKIP_PATTERN.test(rel)) continue;
        const src = stripComments(await readFile(file, 'utf8'));
        // 该文件属于哪个模块；不在 `modules/<name>/` 下的（app 入口、common、db、worker）
        // 一律记为「模块之外」，它们同样不许直接碰别人的表。
        const own = /^apps\/api\/src\/modules\/([^/]+)\//.exec(rel)?.[1] ?? null;
        for (const match of src.matchAll(pattern)) {
          const delegate = match[1];
          if (delegate === undefined) continue;
          hits.push({ rel, delegate, own, line: src.slice(0, match.index).split('\n').length });
        }
      }
    }

    // ── 阳性对照（K4）：本门是**文本扫描**，扫描一旦空转就永远报 0 违规 ──────────
    //
    // 判据：每张登记的表**必须**在它所属模块的源码里被提到至少一次。它同时证两件事：
    // ① `delegate` 这个名字在真实代码里存在（Prisma 模型改名后这里会响）；
    // ② 上面那套目录遍历 + 扩展名过滤 + 「这个文件属于哪个模块」的归属判定真的走到了模块内部。
    // 判别力是实测的，不是推的：把 `auditLog` 改成不存在的名字（模拟模型改名）、
    // 或把扩展名过滤换成 `.tsx`（扫描一条都命中不了），本条都会红——见报告修复轮 2。
    const unwitnessed = SINGLE_WRITE_PATH.filter(
      (entry) => !hits.some((h) => h.delegate === entry.delegate && h.own === entry.owner),
    ).map((entry) => `${entry.delegate}（应属于 ${entry.owner} 模块）`);
    expect(
      unwitnessed,
      `这些表在它们所属模块的源码里一次都没被扫到：${unwitnessed.join('、')}\n` +
        '（模型改名了？扩展名过滤或目录遍历把模块目录漏掉了？扫描空转时本门会**恒绿**）',
    ).toEqual([]);

    const offenders = new Set(
      hits
        .filter((h) => owners.get(h.delegate) !== h.own)
        .map(
          (h) =>
            `${h.rel}:${h.line}  ← 直接触碰 ${h.delegate}（属于 ${owners.get(h.delegate)} 模块）`,
        ),
    );

    expect(
      [...offenders],
      `这些位置绕过了所属模块的编排入口：\n${[...offenders].join('\n')}`,
    ).toEqual([]);
  });

  it('平台不执行用户代码（C2）：源码中无 eval / Function 构造器 / child_process / vm', async () => {
    // 阳性对照：每条模式都必须命中一段**已知坏代码**，否则「0 违规」可能只是模式坏掉了
    // ——与写入路径那条门同一个理由（K4：首跑即绿不等于有判别力）。
    for (const [label, bad] of C2_FIXTURES) {
      expect(
        c2Pattern(label).test(bad),
        `C2 的「${label}」模式匹配不上已知坏代码：${bad}\n` +
          '（模式被改坏了？这条门会以「什么都匹配不到」的形式恒绿）',
      ).toBe(true);
    }
    // 反向对照：`this.redis.eval(…)` 是 Redis 的 Lua 入口，**不是**执行用户代码。
    // 这条负向后视是实测逼出来的（见 C2_PATTERNS 的注释），不能被后人「顺手简化」掉。
    expect(
      c2Pattern('裸 eval 调用').test('await this.redis.eval(lua, 1, key);'),
      'C2 的裸 eval 模式把 redis.eval(…) 误报了——那会让本门对着限流器变红，而修不了',
    ).toBe(false);

    const offenders: string[] = [];
    for (const root of [path.join(ROOT, 'apps'), path.join(ROOT, 'packages')]) {
      for (const file of await walk(root)) {
        if (!SCAN_FILE_PATTERN.test(file) || file.endsWith('.d.ts')) continue;
        // `dist`（构建产物，与源码同一份事实）与 `generated`（Prisma 生成的客户端）
        // 都不属于本仓库手写的源码。
        const rel = path.relative(ROOT, file).replaceAll('\\', '/');
        if (SCAN_SKIP_PATTERN.test(rel)) continue;
        const src = stripComments(await readFile(file, 'utf8'));
        for (const [label, pattern] of C2_PATTERNS) {
          if (pattern.test(src)) offenders.push(`${rel}  ← ${label}`);
        }
      }
    }
    expect(offenders, `违反 C2（绝不执行用户代码）：\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * C2 的判别式（「平台绝不执行用户代码」的**能力**清单）。
 *
 * 口径是「拿到执行一段字符串的能力」，而不是「调用某个函数名」——所以拦的是
 * `eval` / `Function` 构造器 / `child_process` / `node:vm` 四类入口。
 *
 * `eval` 一条**不能**照 brief 写成 `/\beval\s*\(/`：Redis 的 Lua 脚本入口就叫 `eval`，
 * 而 `\b` 在 `.` 与 `e` 之间成立，于是 `this.redis.eval(…)`
 * （`apps/api/src/common/security/redis-throttler.storage.ts`）会被误报——实测过。
 * 这里用负向后视排除「带限定名的成员调用」，再单独列出真正的全局 eval 别名：
 * 放行 `redis.eval`，不放行 `globalThis.eval`（后者与裸 `eval` 是同一个东西）。
 * 同一套负向后视也让 `Function` 那条放行 `foo.Function(…)`（不是全局构造器）。
 */
const C2_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['裸 eval 调用', /(?<![\w.$])eval\s*\(/],
  ['全局 eval 的限定名写法', /\b(?:globalThis|window|self|global)\s*\.\s*eval\s*\(/],
  // `new Function` **与** 裸 `Function(...)` 是同一样东西——两者都从字符串编译出可执行代码，
  // 效果与 `eval` 没有区别。修复轮 2 之前只拦带 `new` 的那种，`Function('…')()`
  // 可以整个绕过本门（实测：探针文件只被 `child_process` 那条命中）。
  // 因此收紧成「不带限定名的 `Function(` 调用就行」——`new Function(` 里那个 `Function(`
  // 照样被这条命中（前面是空格，不是 `.`），所以 `new` 那种**不需要**单独一条。
  // 这一点不是推的：`C2_FIXTURES` 里两种写法各有一段坏代码做阳性对照。
  ['Function 构造器（new Function / 裸 Function 调用）', /(?<![\w.$])Function\s*\(/],
  // 只拦「拿到 child_process 这个能力」的语句，而不是拦每一个 `spawn(` 调用形式：
  // 没有这个模块就 spawn 不了进程，而拦调用形式在注释与日志文案上会误报。
  ['child_process', /(?:from|require\s*\(|import\s*\()\s*['"](?:node:)?child_process['"]/],
  // `node:vm` 与上面两个同级：`vm.runInNewContext` / `new vm.Script` / `vm.compileFunction`
  // 都是「执行一段字符串」，正是 C2 要禁的那件事。修复轮 2 补上（此前整个 VM 模块
  // 都不在门的视野里，`vm` 也是 core module，裸 `'vm'` 同样要拦）。
  ['node:vm（VM 模块 = 任意代码执行）', /(?:from|require\s*\(|import\s*\()\s*['"](?:node:)?vm['"]/],
];

/** 按标签取一条 C2 模式；取不到时**抛错**而不是返回 undefined（门自己不许静默降级）。 */
function c2Pattern(label: string): RegExp {
  const entry = C2_PATTERNS.find(([candidate]) => candidate === label);
  if (!entry) {
    throw new Error(
      `C2 模式表里没有「${label}」——阳性对照与模式表已经对不上了（模式被删或被改名？）`,
    );
  }
  return entry[1];
}

/**
 * C2 每条模式的**阳性对照**：一段必须被它命中的已知坏代码（修复轮 2）。
 *
 * 为什么需要它：`expect(offenders).toEqual([])` 在模式坏掉时**恒真**——把
 * `Function\s*\(` 写成 `Functon\s*\(`，本门会安静地什么都不检查。这段坏代码是
 * 「模式还能匹配」的常驻证人，与写入路径那条门的阳性对照同一个理由（K4）。
 * 标签必须与 `C2_PATTERNS` 一一对应，对不上就抛错（见 `c2Pattern`）；同一个标签可以出现
 * 多次——同一个能力的不同写法各配一段坏代码（`Function` 就有裸调用与 `new` 两种）。
 */
const C2_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['裸 eval 调用', 'const out = eval(userInput);'],
  ['全局 eval 的限定名写法', 'const out = globalThis.eval(userInput);'],
  ['Function 构造器（new Function / 裸 Function 调用）', 'const out = Function("return " + src)();'],
  ['Function 构造器（new Function / 裸 Function 调用）', 'const out = new Function("return 1")();'],
  ['child_process', "import { execSync } from 'node:child_process';"],
  ['node:vm（VM 模块 = 任意代码执行）', "import { runInNewContext } from 'node:vm';"],
];

/** 组合根：唯一被 `no-cross-module-internals` **显式豁免**的文件（见配置里的说明）。 */
const COMPOSITION_ROOT = 'apps/api/src/app.module.ts';

/**
 * `no-cross-module-internals` 的 `from.path` 必须覆盖的**层**，每层一个代表路径。
 *
 * 断言方式是把规则**自己声明的正则在报告里是什么样**拿去匹配这些路径，而不是比对字符串：
 * 前者是「这条边归不归它管」的语义，后者会因为一次等价改写（例如把两个分支并成一个）
 * 而假红。修复轮 2 之前这里什么都没有，于是把 `apps/worker/src/` 分支删掉能让规则
 * 少管一层而**没有任何东西**报警（实测：`pnpm arch` 输出与基线逐字相同）。
 */
const RULE_SCOPE_SUBJECTS: ReadonlyArray<readonly [string, string]> = [
  ['模块之间（modules/<X>/ 的内部文件）', 'apps/api/src/modules/auth/auth.service.ts'],
  ['平台层（db）', 'apps/api/src/db/redis.module.ts'],
  ['平台层（common）', 'apps/api/src/common/security/security.module.ts'],
  ['apps/api/src 下的顶层文件（组合根那一层）', 'apps/api/src/bootstrap.ts'],
  ['worker 进程', 'apps/worker/src/main.ts'],
];

/**
 * 两个文本扫描门（写入路径、C2）共用的文件过滤。
 *
 * 抽成常量是刻意的：这两条门都是「扫源码里的文本」，判据必须一致，否则「哪些文件算源码」
 * 会在两处慢慢漂移。也正因为它是**过滤条件**，它的阳性对照（见各用例）才是必要的——
 * 把它改坏，两条门都会以「一个文件都没扫」的形式恒绿。
 */
const SCAN_FILE_PATTERN = /\.(ts|mts|cts)$/;
const SCAN_SKIP_PATTERN = /(^|[\\/])(dist|node_modules|generated)([\\/]|$)/;

/** 只允许所属模块直接触碰的表（§3.3 第 3 条，见下面对应用例的长注释）。 */
const SINGLE_WRITE_PATH: ReadonlyArray<{ delegate: string; owner: string }> = [
  { delegate: 'auditLog', owner: 'audit' },
  { delegate: 'outboxEvent', owner: 'notify' },
  { delegate: 'processedJob', owner: 'notify' },
];

/** 模块目录名清单（`apps/api/src/modules/<name>`）。 */
async function listModuleNames(): Promise<string[]> {
  return (await readdir(MODULES_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * 取出一个源码片段里所有 import / export 语句的模块说明符。
 *
 * 三种写法都覆盖：`from '…'`（静态 import / `export … from`）、副作用导入 `import '…'`、
 * 动态导入 `import('…')`。少了动态那条，`await import('@vca/api/modules/x/y.js')`
 * 就能绕过本门。
 */
function importSpecifiers(src: string): string[] {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) out.add(specifier);
    }
  }
  return [...out];
}

/** 把说明符解析成绝对路径；只解析指向本仓库源码的两种写法，其余（裸包名等）返回 null。 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return path.resolve(path.dirname(fromFile), specifier);
  }
  if (specifier.startsWith('@vca/api/')) {
    return path.join(ROOT, 'apps/api/src', specifier.slice('@vca/api/'.length));
  }
  return null;
}

/**
 * 剥掉行注释（`//` 起）与块注释（`/*` 起、`*` + `/` 止）。
 *
 * 刻意用正则而不是真解析器：这里只需要「别把散文当成依赖」。正则会误伤字符串里的 `//`
 * （例如 URL），而那种误伤只让某一行少被扫到、不会造成误报——方向是安全的。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
