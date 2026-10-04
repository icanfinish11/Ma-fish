/**
 * 让「可拆分性」成为强制约束而不是愿望（设计文档 §3.3；验收 13.4）。
 *
 * §3.3 的四条约束里，本文件负责 (1)「跨模块只经显式接口」与 (2)「packages/shared 不反向
 * 依赖 apps」；约束 (3)「每模块独占自己的表」由 Prisma 的多 schema + 运行期角色授权 +
 * `tests/integration/db/schema-isolation.test.ts` 的 `(schema, table)` 全集断言守住。
 *
 * 与 `tests/architecture/module-boundaries.test.ts` 的分工：**这份文件是唯一的规则来源**，
 * 那条用例只是把同一份配置跑起来并断言「真的巡航到了源码、真的加载到了这些规则」——
 * 门的判别力本身也要被断言，否则把规则删掉就能让它恒绿。
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      severity: 'error',
      comment:
        '禁止跨模块 import 内部实现：跨模块只走 modules/<other>/index.ts 的显式接口（§3.3 第 2 条）。' +
        '深引到别人的 service / module / repository，等于把两个模块钉死在一起，"可拆分"就只是文档里的话。' +
        '同时覆盖平台层与 worker（见 from.path 的说明）：平台不依赖功能模块的内部实现，' +
        'worker 不深引模块内部——两者都是同一个约束的反方向，方向反了模块就永远拆不走。',
      /**
       * `from.path` 的三个分支与第 1 个捕获组
       *
       * 三条都是「不许深引 `modules/*` 内部」的主体：
       * 1. `modules/<X>/…` —— 模块之间（§3.3 第 2 条的原样）；
       * 2. `db|common` —— **平台层**。它此前不在规则里，于是 `db/redis.module.ts` 与
       *    `common/security/security.module.ts` 都能反向 import `modules/auth/session.service.ts`
       *    而无人报警（task-9-report.md §11.2 记录了这个空洞，修复轮 1 收口）；
       * 3. `apps/worker` —— 独立进程，此前深引 `modules/notify/*` 的内部文件。
       *
       * **捕获组的位置是刻意选的**：只有第 2 个分支（模块）携带捕获组，平台与 worker
       * 分支只有非捕获组，因为 `$1` 要表示的是「**本模块**名」，而平台/worker 没有模块名。
       * 于是对平台与 worker，`$1` 在下面 `pathNot` 里被替换成**空串**，
       * `^apps/api/src/modules//` 谁也匹配不上 = 不放行任何模块内部文件——正是要的效果。
       * 若反过来把捕获组套在最外层，平台分支会捕获出 `db` 之类的目录名，
       * `pathNot` 就会去放行 `modules/db/…`（不存在），规则静默失效。
       * 这一点**是用变异探针实测过的**，不是读代码推的（见 task-9-report.md 修复轮 1 §13.4）。
       */
      from: {
        path: '^(?:apps/api/src/(?:modules/([^/]+)|(?:db|common))/|apps/worker/src/)',
      },
      to: {
        path: '^apps/api/src/modules/([^/]+)/',
        /**
         * `$1` 是 `from.path` 里的第 1 个捕获组（= 本模块名，平台/worker 时为空串），
         * dependency-cruiser 会把它替换进 `to.path` / `to.pathNot`（实现：
         * `src/validate/matchers.mjs` 的 `replaceGroupPlaceholders` ←
         * `extractGroups(pRule.from, pModule.source)`）。替换前会 `filter` 掉非字符串的
         * 捕获组结果，而**空串是字符串、会被保留**——上面那条「平台/worker 分支留下空串」
         * 的语义因此成立。已实测确认，见 task-9-report.md §3 与修复轮 1 §13.2；此处**不是**照抄假设。
         *
         * 两个备选写成一个数组会被**直接 `join('|')`**（`src/main/helpers.mjs`
         * `normalizeToREAsString`，不加 `(?:)` 包裹），因此每一项都必须自带 `^`/`$` 锚点，
         * 否则相邻项会互相串味。
         */
        pathNot: [
          // 本模块自己的文件（平台/worker 时 `$1` 为空串，故本条不匹配任何模块内部文件）
          '^apps/api/src/modules/$1/',
          // 任何模块的对外接口
          '^apps/api/src/modules/[^/]+/index\\.ts$',
        ],
      },
    },
    {
      name: 'no-shared-to-apps',
      severity: 'error',
      comment:
        'packages/shared 只能放 DTO 与类型，不得反向依赖 apps（设计 §11）：' +
        '一旦 shared 依赖 app，两个 app 就无法各自独立构建，依赖方向也就反了。',
      from: { path: '^packages/shared/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖会让模块无法独立测试与拆分（§3.3 第 1/2 条的前提）。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      /**
       * `warn` 而不是 `error`：孤儿文件的判据（没有任何 import 关系）在入口文件上必然成立，
       * 而「哪些文件是入口」是本仓库的约定（`main.ts` / `index.ts`，见 `pathNot`），
       * 不是依赖事实。把它设成 error 会让 `pnpm arch` 对新加的合法入口变红，
       * 于是下一个人会去放宽规则——那比留一个 warn 更糟。
       * 注意 `depcruise` 的退出码只统计 `error`（`getAdvisedExitCode` 取 `error` 计数），
       * 因此 warn 不会把 CI 弄红，但会打印出来给人看见。
       */
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', 'main\\.ts$', 'index\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    /**
     * `dist` 必须排除：它是构建产物，`pnpm arch` 在本地与 CI 上是否看得到它取决于有没有
     * 先跑 `build`，不排除就会让同一个提交在不同机器上得出不同结论（Task 7 的 bootstrap
     * 用例正是靠构建产物工作，所以本机一定有 dist）。`src/generated` 是 Prisma 生成的
     * 客户端，`generated` 目录在 `apps/worker` 下也可能出现。
     */
    exclude: { path: '(^|/)(dist|generated|node_modules)/|\\.test\\.ts$' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    /**
     * 条件名刻意**不含 `node`**：`apps/api/package.json` 的 `exports["./*"]` 是
     * `{ types: './src/*', node: './dist/*', default: './src/*' }`，带上 `node` 会让
     * `@vca/api/modules/…` 这种跨 app 的引用解析到**构建产物**（可能不存在，也可能过期），
     * 于是本文件分析的不是源码。去掉它之后走 `default` → `./src/*`，与 `pnpm typecheck`
     * 看到的是同一份事实。
     */
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'default'],
    },
  },
};
