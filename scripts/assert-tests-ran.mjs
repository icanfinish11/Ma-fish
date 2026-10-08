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
 * ## 两类下限：按 **project**，与按 **作用域**（P3 / Task 4）
 *
 * `GATES` 的键是 project。它挡不住**某一类**用例的静默消失：`unit` / `integration` 这两个
 * project 的规模与构成一直在变，给它们设总数下限只会制造噪音，于是这两个 project 里的用例
 * **完全不受下限保护**。`SCOPED_GATES` 补的就是这一半：project + 路径（前缀）+ 下限，
 * 跑的是路径过滤而不是整个 project。两类的判据逐字相同（实际执行条数 ≥ 下限、且全绿）。
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
  //
  // P2 / Task 10：**85 → 89**（+4）。把 **ledger 的越权矩阵**纳入 security 门
  // （`tests/security/ledger/authz-matrix.test.ts`）：匿名 / 已登录非管理员 / 管理员 / 管理员同键重放
  // 四条。这条路由是 P2 里**唯一一条外部可达的造钱路径**（`POST /ledger/credits`），
  // 「未授权者发不出额度」因此必须计在 security 的账上——被静默删掉就会红，
  // 而不是「少查了一件事但一切正常」。两条覆盖率门（policy / rate-limit）里新增的是
  // **既有用例里的断言**（不新增条数），它们的判别力由探针 p-drop-policy / p-drop-module 证明。
  //   ⇒ 实测值（不是预测）：`node scripts/assert-tests-ran.mjs security` = `Tests 89 passed (89)`；
  //     把矩阵里任意一条 `it` 改成 `it.skip` ⇒ 88 < 89 ⇒ 以 `::error::` 变红（探针 `p-security-floor` 实测）。
  //
  // P3 / Task 6：**89 → 115**（+26）。把**交换的越权矩阵**纳入 security 门
  // （`tests/security/exchange/authz-matrix.test.ts`）：6 端点 × 4 角色 = 24 格
  // + 1 条「`swapOfferSent` 恰好放行『被要约方 + `SENT`』」（三份断言：对手方 200 /
  // 发起方 403 / 已过期 403）+ 1 条「矩阵覆盖全部已注册的 exchange 路由」。`exchange` 是
  // P3 里**唯一**能改所有权状态的模块（原子释放会换掉 `assets.owner_id`，Task 8），
  // 因此「未授权者动不了它」必须计在 security 的账上。
  //   两条覆盖率门（policy / rate-limit）里新增的是**既有用例里的断言**（六条路由的声明与
  //   限流归属，各 6 条 `expect`，但**不新增 `it`**）⇒ 它们**不**计入这个数，
  //   判别力由探针 P-T6-a（删掉 `ExchangeModule` 的接线）与 P-T6-b（删掉一条 `@RateLimited`）证明。
  //   ⇒ 实测值（不是预测）：`node scripts/assert-tests-ran.mjs security` = `Tests 115 passed (115)`；
  //     把矩阵里任意一条 `it` 改成 `it.skip` ⇒ 114 < 115 ⇒ 以 `::error::security` 变红。
  security: 115,
  architecture: 5,
  // P2 / Task 1：**判决 1 的病根就是这里**——设计 §8.3 的「≥10 万次属性测试」此前
  // 没有任何执行者：`tests/property/` 不存在、`test:property` 带 `--passWithNoTests`
  // （空 project 实测 exit 0）、CI 里 `property` 零匹配、本文件的 GATES 只有
  // security/architecture 两项。于是「资金系统唯一真正可靠的验证方式」是一句
  // 写在规格里的话。这条下限让它无法再静默停止运行：
  // 「文件被改名 / 被删空 / project 名写错 / 用例被 skip」都会红。
  // 数字与当前实际执行条数对齐（本文件的既定规矩）：新增属性用例时必须一起上调。
  //
  // 8 = 五条 100k-runs 金额属性 + 一条预算下限断言 + 一条 2^53 用例
  //     + 一条 `@fast-check/vitest` 接线用例（预检 §G.5）。
  //     实测值来自 `node scripts/assert-tests-ran.mjs property` 的输出，不是预测。
  //
  // P2 / Task 5：**8 → 11**（+3）。新增 `tests/property/ledger-fee-split.test.ts` 三条：
  //   ① 控制器裁定 4 / C23 / 预检 §F.3 明写的那条属性——任意 `(gross, bps)` 下
  //      `fee + net === gross`（bps 上界取到 100_000 ⇒ 顺带行使上限钳制分支）；
  //   ② 向上取整的**全域**命题（`fee = ceil(gross·bps/10⁴)` 的最小性）——守恒那条钉不住
  //      取整方向（向下取整 + 净额减出来照样守恒），这一条才钉得住；
  //   ③ 反 vacuity 的生成器覆盖率（非零 fee / 「向上取整真的起作用」/ 钳制分支都被走到）。
  //   三条的预算都是 `PROPERTY_NUM_RUNS = 100_000`（与设计 §8.3 的下限同源）。
  //   ⚠️ 计划 Task 8 的算术表把「裁定 4 的费率属性」算作它自己的 +4 之一；那一条**已经在这里
  //   交付**，因此 Task 8 落地 `ledger-invariants.test.ts` 时应当**重新读实测条数**再对齐
  //   （本文件的既定规矩：数字与当前实际执行条数对齐，任何删除都会红一次）。
  //
  // P2 / Task 8：**11 → 15**（+4，且**没有**重复那条费率属性——它在 Task 5 已经交付并计在上面的 3 里）。
  // 新增 `tests/property/ledger-invariants.test.ts` 四条，算术 = 8 + 3 + 4：
  //   ① 随机序列 × 100_000 次 × 每序列 20 笔：五条不变式**每一个操作之后**都成立（设计 §13.3 的判据本体）；
  //   ② 生成器覆盖率（反 vacuity）：五类操作各自都被**接受**过；
  //   ③ ★ 不变式 #4 的残差不是「0 减 0」：抽样里真的有带手续费的释放（残差的非平凡性锚点）；
  //   ④ 拒绝路径被行使过（余额不足 / 零金额），且每一类拒绝旁边都有被接受的同类操作。
  //   ⇒ 实测值 `node scripts/assert-tests-ran.mjs property` = `Tests 15 passed (15)`，
  //     不是预测；把其中任意一条 `it` 改成 `it.skip` ⇒ 14 < 15 ⇒ 这道门以 `::error::` 变红（Task 8 实测）。
  //
  // P2 / Task 10 **没有**动这一项：额度发放路由与越权矩阵**不新增属性用例**
  // （属性测试的对象是纯核心与账本不变式，不是 HTTP 路由），实测仍 `Tests 15 passed (15)`。
  property: 15,
};

/**
 * **按作用域**的下限：project + 路径（或路径前缀）+ 实际执行条数下限。
 *
 * ## 它补的是哪一类洞（P3 / Task 4；控制器账本里 Task 3 段落末尾的裁定）
 *
 * 上面的 `GATES` 按 project 设下限，而 `unit` / `integration` **太宽**：它们的规模与构成
 * 一直在变，给它们钉总数只会制造噪音。代价是这两类用例此前**不受任何下限保护**：
 *   * `integration` 里的**真库强制点**（append-only / 唯一索引 / 状态闭集 / 权限事实）；
 *   * `unit` 里的**纯核心判据**（交换的状态机、锁序、幂等键、计时器、资格、义务）。
 * 一个文件被改名、被删空、或被整段 `skip` 掉，`pnpm test` 照样绿——而它检查的东西
 * 一件都没了。P3 到 Task 3 为止这样的用例有 **62 条**（Task 2 的 15 + Task 3 的 47），
 * 这是当时最大的开放项。
 *
 * ## 做法与判据
 *
 * 每一项跑的是 `vitest run --project <project> <paths…>`。刻意用**路径过滤**而不是
 * `-t` 标题过滤：标题过滤会过量匹配（P3 / Task 3 实测 `-t 交换` 多匹配 5 条，
 * 因为 github-oauth 里有一个叫 `exchange()` 的 describe），而过量匹配与零匹配是同一族
 * 缺陷——「过滤器没有选中那一行声称选中的东西」。判据与 `GATES` 逐字相同：
 * **实际执行**条数（`numTotalTests - numPendingTests - numTodoTests`）不得低于下限，
 * 且全部通过。收集到但被 `skip` / `todo` 的不计入。
 *
 * 于是「把其中一条改成 `it.skip`」与「把文件改名 / 搬走 / 删空」都会以非零码 +
 * `::error::<组名>` 变红，而**不必**给整个 `unit` / `integration` 追数字。
 *
 * ## 数字从哪来（本文件的既定规矩：与当前**实测**执行条数对齐）
 *
 * 每一条的 `floor` 都是跑出来量到的执行条数（不是预测），来源写在 `why` 里；
 * 任何删除都会红一次并要求在这里改数——安全面的缩小必须是一次有意识的改动。
 * 新增同类用例时**上调**这里：`node scripts/assert-tests-ran.mjs <组名>` 会把实测条数打出来。
 */
const SCOPED_GATES = {
  // P3 / Task 2 的真库强制点。实测（`--reporter=json`）：15 条，0 条 skip。
  //
  // P3 / Task 6：**15 → 18**（+3）。**手写谓词**（部分唯一索引）的三条见证：
  // ① 目录里 `pg_indexes.indexdef` 逐字含 `WHERE`，且取值集合与
  //    `ACTIVE_OFFER_STATUSES` 排序后相同（跨文件一致性）；
  // ② `REJECTED`（以及 `ACCEPTED` / `WITHDRAWN` / `EXPIRED`）之后同一对**可以**再插一份；
  // ③ 三条独立连接真并发抢同一对 ⇒ 恰好一份胜出（另两条 23505）。
  // **为什么必须计在这里**：`prisma migrate diff` 对部分索引的谓词**结构性失明**
  // （Task 6 实测四方向，逐条写在 `20261007140000_p3_swap_offers_partial_unique/migration.sql`
  // 的头注释里）。这三条是谓词**唯一**的机器见证，被静默删掉就没有任何东西在检查
  // 「重新要约」这件事仍然成立。
  //   ⇒ 实测值（不是预测）：`node scripts/assert-tests-ran.mjs exchange-enforcement` = `Tests 18 passed (18)`。
  'exchange-enforcement': {
    project: 'integration',
    paths: ['tests/integration/db/exchange-enforcement.test.ts'],
    floor: 18,
    why: 'P3 Task 2 的 exchange 真库强制点 + Task 6 的部分唯一索引（目录 + 两个行为方向 + 真并发）',
  },
  // P3 / Task 3 的交换纯核心。实测：47 条（6 个文件），0 条 skip。
  //
  // P3 / Task 6：**47 → 80**（+33）。本任务在同一个目录里新增三个文件：
  // `claims.test.ts`（13，增量 A-6 的承诺闭集）、`dto.test.ts`（5）、
  // `error-map.test.ts`（15 = 12 档翻译 + 撞码 + 未登记 + 非 Error 输入）。
  // **同一条纪律对新用例立刻生效**（Task 4 在本文件里写下的那句话）：
  // 不给下一个任务留「从零算一遍未受保护面」的活。
  //   ⇒ 实测值（不是预测）：`node scripts/assert-tests-ran.mjs exchange-core` = `Tests 80 passed (80)`。
  //   ★ **首轮我先填了 78（一个估计），门以 78 通过而实际执行 80** —— 正是本文件开头
  //     那段话要防的形状（「低的这 4 条让『静默删掉最多 4 条安全用例』不会红」）。
  //     因此这里对齐到实测的 80；下一次任何删除都会红一次。
  'exchange-core': {
    project: 'unit',
    paths: ['tests/unit/exchange'],
    floor: 80,
    why: 'P3 Task 3 的交换纯核心 + Task 6 的承诺闭集 / DTO / 错误翻译表（A-6）',
  },
  // P3 / Task 4 的账本写路径（本任务自己新增的 36 条）。实测：22 + 4 + 10 = 36 条，0 条 skip。
  // **为什么连新用例也一起钉**：上面那 62 条之所以成为「当时最大的开放项」，正是因为
  // 新用例落在 unit / integration 里没人管；同一条纪律必须对新用例**立刻**生效，
  // 否则下一个任务又要从零算一遍「未受保护面」。
  'ledger-write-path': {
    project: 'unit',
    paths: [
      'tests/unit/db/retryable-conflict.test.ts',
      'tests/unit/db/lock-order.test.ts',
      'tests/unit/ledger/transaction-kind.test.ts',
    ],
    floor: 36,
    why: 'P3 Task 4 的纯判据（两档可重试判别式 / 行锁共享顺序 / 交易 kind 的执行者）',
  },
  // P3 / Task 4 的真库用例（本任务自己新增的 9 条）。实测：6 + 3 = 9 条，0 条 skip。
  'ledger-write-path-db': {
    project: 'integration',
    paths: [
      'tests/integration/ledger/account-lock-order.test.ts',
      'tests/integration/ledger/transaction-kind.test.ts',
    ],
    floor: 9,
    why: 'P3 Task 4 的真库见证（账户行取锁顺序 / 两档真死锁 / 非法 kind 经真实服务被拒）',
  },
  // P3 / Task 5.5（增量 A 的数据面）的**新列形状**见证。实测：3 条，0 条 skip。
  //
  // 为什么它也要有下限：这一组是「六个承诺列 + `code_lines` 在库里长什么样」的**唯一**
  // 机器见证——`prisma migrate diff` 能证明「库与 schema 一致」，但证明不了
  // 「可空性真的是可空的」（它比对的是两份声明，不是数据库的行为；Task 2 的探针 S-2
  // 已经量过漂移门对手写 DDL 的失明）。把这三条静默删掉或 skip 掉，
  // 「`null` = 没有声明」与「旧行没有 `code_lines`」这两条语义就再没有任何东西在检查。
  //
  // ⇒ 同一条纪律对新用例**立刻**生效（Task 4 在本文件里写下的那句话）：
  // 不给下一个任务留「从零算一遍未受保护面」的活。
  'fidelity-columns': {
    project: 'integration',
    paths: ['tests/integration/db/fidelity-columns.test.ts'],
    floor: 3,
    why: 'P3 Task 5.5 的真库见证（增量 A 八个列的类型与可空性 / NULL 是被接受的 / null ≠ 空集）',
  },
  // ★ P3 / Task 6：**新登记**（Task 5.5 的发现 3，控制器裁定「保护它们」）。
  //
  // ## 它补的是哪一类洞
  // Task 5.5 实测：这个文件的 **19 条**此前**不受任何下限保护** ——
  // 它在 `integration` project 里，而那个 project 的规模与构成一直在变，
  // 给它设总数下限只会制造噪音。于是「文件被改名 / 被删空 / 整段 `skip` 掉」
  // 都不会让 `pnpm test` 变红，而它检查的东西（所有权的转让与历史，P1 的核心不变式）
  // 一件都不剩。
  //
  // ## 控制器的裁定逐字
  // 「账本那条裁定的**本意**是『不该有任何一批用例不受保护』，而不是『只保护我当时
  //   点名的那两条路径』。…… ⇒ 给 `tests/integration/asset/ownership.test.ts`
  //   登记一条按路径作用域的下限。」
  // Task 5.5 当时**没有**擅自扩半径（那会把改动伸进 P1 既有文件的门禁）——
  // 那是正确的判断，而正确答案就是现在去做，且它很便宜（`fidelity-columns` 已证明机制可用）。
  //
  // ## 判别力（本轮实测两个方向，见报告）
  // * `it.skip` 掉任意一条 ⇒ 18 < 19 ⇒ `::error::ownership` 变红；
  // * 把路径改成一个不存在的文件 ⇒ 「一条用例都没执行」那一支变红。
  'ownership': {
    project: 'integration',
    paths: ['tests/integration/asset/ownership.test.ts'],
    floor: 19,
    why: 'P1 的所有权转让与历史（Task 5.5 发现它此前不受任何下限保护；控制器裁定保护它们）',
  },
  // ★ P3 / Task 6：**新登记**。本任务新增的集成套件（要约的整个生命周期 + 增量 A-6）。
  // 同一条纪律：新用例落在 `integration` 里就必须**立刻**有下限，否则下一个任务又要
  // 从零算一遍「未受保护面」（Task 4 在本文件里写下的那句话）。
  // 它判的是**服务层**：五个拒绝面各配一条验收对照、控制器裁定 ① 的重新要约、
  // A-6 的承诺列落库 / TOCTOU 两个方向 / 声明侧 fail-closed、以及四个终态的到达路径。
  //   ⇒ 实测值（不是预测）：`node scripts/assert-tests-ran.mjs exchange-offers` = `Tests 22 passed (22)`。
  //     （21 是本任务第一版的条数；随后补了一条**真交错**的用例——并发的第二个 `accept`
  //      撞上条件更新 ⇒ 409，见 `offers.test.ts` 的那条头注释。数字随实测对齐。）
  'exchange-offers': {
    project: 'integration',
    paths: ['tests/integration/exchange'],
    floor: 22,
    why: 'P3 Task 6 的要约生命周期与增量 A-6 的钉住 / TOCTOU（服务层的真库见证）',
  },
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
 * 跑一个门并返回 json 报告。**输出直接透传**（`stdio: 'inherit'`）：
 * CI 日志里必须能看见 vitest 原本的逐文件结果，否则失败时要靠猜。
 *
 * `gate.paths` 为空 = 整跑那个 project（`GATES` 那一类）；非空 = 只跑给定路径
 * （`SCOPED_GATES` 那一类）。两者走**同一条**命令形状与同一份判据。
 */
function runGate(gate, reportFile) {
  const args = [
    resolveVitestBin(),
    'run',
    '--project',
    gate.project,
    // 路径过滤是位置参数；为空时它不出现，于是整跑该 project。
    ...gate.paths,
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

/**
 * 命令行给的是一串**门的名字**，两类都收：`GATES` 的 project 名与 `SCOPED_GATES` 的组名。
 * 不带参数 = 跑全部（这也是 `pnpm test:gate` 的语义）。
 */
const KNOWN_GATES = [...Object.keys(GATES), ...Object.keys(SCOPED_GATES)];

// 自检：两处登记表**不得重名**。重名会让两个门写同一个报告文件名，第二个门读到的是第一个门
// 的报告——那是一条静默的假绿（本文件存在的理由就是防这一族）。宁可在这里响亮地停下。
const COLLIDING = Object.keys(SCOPED_GATES).filter((name) => name in GATES);
if (COLLIDING.length > 0) {
  console.error(
    `::error::门的名字在 GATES 与 SCOPED_GATES 里重复：${COLLIDING.join(', ')}。` +
      '两者会用同一个报告文件名，后者读到的是前者的结果——请改名。',
  );
  process.exit(1);
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : KNOWN_GATES;

const unknown = names.filter((name) => !KNOWN_GATES.includes(name));
if (unknown.length > 0) {
  console.error(
    `::error::未登记的门：${unknown.join(', ')}。可用的有 ${KNOWN_GATES.join(', ')}——` +
      '要新增请同时在 scripts/assert-tests-ran.mjs 的 GATES（按 project）或 ' +
      'SCOPED_GATES（按路径作用域）里写下限。',
  );
  process.exit(1);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'vca-gate-'));
let failed = false;

try {
  for (const name of names) {
    // 两类门在这里归一成同一个形状：`project`（跑哪个 project）、`paths`（作用域，空 = 整个
    // project）、`floor`（实际执行条数下限）、`why`（这一组是什么，红了要能看懂）、
    // `label`（**消息里必须出现的组名**——零匹配陷阱的教训：红了却不知道是哪一组等于没红）。
    const gate =
      name in GATES
        ? { label: name, project: name, paths: [], floor: GATES[name], why: `project ${name}` }
        : { label: name, ...SCOPED_GATES[name] };
    const scope = gate.paths.length > 0 ? `，作用域 ${gate.paths.join(' ')}` : '';
    const reportFile = path.join(workDir, `${name}.json`);
    const run = runGate(gate, reportFile);
    const report = readReport(reportFile);

    if (!report) {
      console.error(
        `::error::${gate.label}：没有拿到 vitest 的 json 报告（${run.reason ?? '未知原因'}）。` +
          `这一组是「${gate.why}」${scope}。` +
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
        `::error::${gate.label}：一条用例都没**执行**（收集到 ${total} 条，其中 ${pending} 条被 skip/todo）。` +
          `这一组是「${gate.why}」${scope}。` +
          '门在这一刻是**空的**，命令不能算通过——最常见的原因是 include glob 或测试文件名被改过、' +
          '路径作用域写错了，或者整个文件被 skip 掉了。',
      );
      failed = true;
      continue;
    }
    if (run.failed || report.success !== true) {
      console.error(
        `::error::${gate.label}：用例未全部通过（执行 ${executed} 条，通过 ${passed} 条）${run.reason ?? ''}`,
      );
      failed = true;
      continue;
    }
    if (executed < gate.floor) {
      console.error(
        `::error::${gate.label}：只**执行**了 ${executed} 条用例，低于登记的 ${gate.floor} 条` +
          `（收集到 ${total} 条，其中 ${pending} 条被 skip/todo，不计入）。` +
          `这一组是「${gate.why}」${scope}。` +
          '门被削弱了（文件被改名/删除？有用例被 skip 掉？路径作用域写错？）。若是有意为之，' +
          '请下调 scripts/assert-tests-ran.mjs 的 GATES / SCOPED_GATES 并在提交信息里说明理由。',
      );
      failed = true;
      continue;
    }
    console.log(
      `✔ ${gate.label}：实际执行 ${executed} 条用例（下限 ${gate.floor}），全部通过。` +
        (scope ? `作用域 ${gate.paths.join(' ')}。` : '') +
        (pending > 0 ? `另有 ${pending} 条被 skip/todo，**未**计入执行数。` : ''),
    );
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
