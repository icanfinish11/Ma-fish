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
        '同时覆盖平台层、组合根那一层与 worker（见 from.path 的说明）：平台不依赖功能模块的内部实现，' +
        'worker 不深引模块内部——这两者都是同一个约束的反方向，方向反了模块就永远拆不走；' +
        '组合根是唯一的例外，它按设计就该认识每一个模块，豁免写在 from.pathNot 里。',
      /**
       * `from.path` 的四个分支与第 1 个捕获组
       *
       * 四条都是「不许深引 `modules/*` 内部」的主体：
       * 1. `modules/<X>/…` —— 模块之间（§3.3 第 2 条的原样）；
       * 2. `db|common` —— **平台层**。它此前不在规则里，于是 `db/redis.module.ts` 与
       *    `common/security/security.module.ts` 都能反向 import `modules/auth/session.service.ts`
       *    而无人报警（task-9-report.md §11.2 记录了这个空洞，修复轮 1 收口）；
       * 3. `apps/api/src/*.ts` —— **组合根那一层**（`main.ts` / `bootstrap.ts` /
       *    `index.ts` / `app.module.ts`）。修复轮 2 新增：这层此前**根本不在规则里**，
       *    于是「组合根的豁免」是靠「恰好没写进 `from.path`」成立的——读起来像个没人管的洞。
       *    现在它被下面的 `pathNot` **显式**豁免，边界既是写出来的、也是被断言的；
       * 4. `apps/worker/src/` —— 独立进程，此前深引 `modules/notify/*` 的内部文件。
       *
       * **捕获组的位置是刻意选的**：四个分支里只有第 1 个带捕获组，其余三个都没有，
       * 因为 `$1` 要表示的是「**本模块**名」，而平台层 / 组合根层 / worker 都没有模块名。
       *
       * 对这三者，`extractGroups()`（`src/utl/regex-util.mjs`）拿到的匹配结果是
       * `[整个匹配串, undefined]`，而它随后用 `typeof pResult === "string"` **过滤掉**了
       * `undefined`——过滤后数组里只剩下标 0。于是 `replaceGroupPlaceholders()` 的
       * `reduce` 只替换 `$0`，`$1` **原样留在模式里**：`^apps/api/src/modules/$1/` 里的
       * `$` 是**行尾锚点**，这个模式匹配不上任何路径 = 不放行任何模块内部文件，正是要的效果。
       *
       * **修复轮 2 的更正**：此前这里（以及报告 §13.2）写的是「`$1` 被替换成**空串**，
       * 于是 `^apps/api/src/modules//` 匹配不上」——**这句话是错的**。非参与的捕获组是
       * `undefined` 且被 `filter` 掉，**压根没有替换发生**。结论完全相同，而且更硬：
       * 既然没有「替换成空串」这条路径，也就没有随之而来的静默失效模式。
       * 已用**安装版**的 `extractGroups` / `replaceGroupPlaceholders` 直接跑过（见
       * task-9-report.md 修复轮 2 与
       * `.superpowers/sdd/2026-10-04-p0-security-foundation/evidence/t9-fix2-premises.txt`）。
       *
       * 反过来把捕获组套在最外层会**响亮地**坏掉，不是静默：平台/worker 分支会捕获出
       * `db` / `apps/worker/src/` 这类「目录名」，`pathNot` 变成
       * `^apps/api/src/modules/db/`（不存在），模块内部的「本模块自己」放行条款整条失效
       * ——实测 `pnpm arch` 立刻报 **25 条**违规、退出码 25（修复轮 1 §13.4 的 P5）。
       */
      from: {
        path: '^(?:apps/api/src/(?:modules/([^/]+)|(?:db|common))/|apps/api/src/[^/]+\\.ts$|apps/worker/src/)',
        /**
         * 组合根的**显式豁免**（修复轮 2 裁定）。
         *
         * `apps/api/src/app.module.ts` 的职责就是认识每一个模块：它 import
         * `modules/<X>/<X>.module.ts` 与 `modules/auth/session.middleware.ts` 是**正确**的写法。
         * 为了满足本规则而给 auth / health 各造一个 `index.ts`，只是仪式——那些 index 只会
         * 被组合根用到，规则被满足了，可拆分性一点没变（C16：不建只服务于门面的抽象）。
         *
         * 写在这里，而不是靠「`from.path` 恰好没写到它」：豁免是一个**决定**，应该看得见。
         * 它现在是**承重**的——`from.path` 的第 3 条分支已经覆盖 `apps/api/src/*.ts`，
         * 删掉下面这一行，`pnpm arch` 会立刻对着 `app.module.ts` 的 4 条 module import
         * 报错（实测见 task-9-report.md 修复轮 2 的 P9）。
         */
        pathNot: '^apps/api/src/app\\.module\\.ts$',
      },
      to: {
        path: '^apps/api/src/modules/([^/]+)/',
        /**
         * `$1` 是 `from.path` 里的第 1 个捕获组（= 本模块名）；平台层 / 组合根层 / worker
         * 三个分支没有捕获组，因此在那三条分支上 `$1` **保持字面量**——不是被换成空串：
         * 非参与的捕获组是 `undefined`，被 `extractGroups` 的 `typeof === "string"` 过滤掉，
         * `replaceGroupPlaceholders` 于是只替换 `$0`（见上面 `from.path` 的说明）。
         * `^apps/api/src/modules/$1/` 里的 `$` 是行尾锚点，因此这条谁也匹配不上 =
         * 不放行任何模块内部文件，正是要的效果。已实测确认，见 task-9-report.md §3 与修复轮 2。
         *
         * 两个备选写成一个数组会被**直接 `join('|')`**（实测：JSON 报告里的 `pathNot` 就是
         * `^apps/api/src/modules/$1/|^apps/api/src/modules/[^/]+/index\\.ts$`；实现见
         * `src/main/helpers.mjs` 的 `normalizeToREAsString`，不加 `(?:)` 包裹），
         * 因此每一项都必须自带 `^`/`$` 锚点，否则相邻项会互相串味。
         */
        pathNot: [
          // 本模块自己的文件（平台层/组合根层/worker 上 `$1` 是字面量，故本条不匹配任何路径）
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
