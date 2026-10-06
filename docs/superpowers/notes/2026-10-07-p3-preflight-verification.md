# P3 交换 · 预检验证（2026-10-07）

**目的**：在写 P3 计划之前，用可运行探针把「计划会写错的假设」先打掉。P0 / P1 / P2 三次预检各自证伪过一条承重假设，本文沿用同一标准：**每条结论后面都有实际输出**；凡查文档得出的、或没能测出来的，一律标明。

**被验对象**：`main` / HEAD `8f6ac3b`（P2 已合并、工作区干净 —— 收尾时 `git status --porcelain` 实测为空，仓库**零改动**，只新增本文件）。

**探针位置**（全在仓库之外，一次性）：

| 位置 | 内容 |
|---|---|
| `%TEMP%\p3-probe\` | Prisma / 真实生产类的探针（`lock.test.ts` / `atomic.test.ts` / `preview.test.ts` / `obligation.test.ts`）；`node_modules` 是指向 `apps/api/node_modules` 的**目录联接** |
| `%TEMP%\p3-probe\vitest.config.ts` | 复刻仓库 alias 的最小配置。**必需**：仓库的五个 project include 都锚在 `tests/` 下，仓库外的文件匹配不到任何 project（实测 `No test files found, exiting with code 1`） |
| `%TEMP%\p3-probe\*.sql` | 原生 SQL 探针（逐账户对账、代价、死锁） |
| `%TEMP%\p3-probe\arch\` | `apps/api/src` + `packages/shared` + `apps/worker/src` 的**镜像拷贝**（robocopy，排除 `generated`），用来在**不改仓库**的前提下让 `depcruise` 看见一条环 |

**数据库**：项目自己跑着的 `postgres:16-alpine`（`infra-postgres-1`，实测 `PostgreSQL 16.15`，`deadlock_timeout = 1s`）。探针全部打在一次性库 `p3_probe` / `p3_dl` / `p3_atomic` 上（后者应用了 P0→P2 的全部五条迁移）。开发库 `vca` **一次都没碰**。

**未验证面**写在 §G，**不该由验证者决定的产品问题**写在 §H。

---

## 0. 判决

### 0.1 §6.3 的「单一事务内完成 RELEASED」**建不起来** —— **证伪**（设计假设 / P1 接口）

设计 §6.3:294 原文：「**`RELEASED` 必须在单一数据库事务内完成**，任何异常必须完全回滚，不留半成品所有权。这是本平台最核心的技术命题。」而 P1 的 `OwnershipService.transferOwnership`（`apps/api/src/modules/asset/ownership.service.ts:70,98`）**自己开事务、不收 `tx`**：

```
[B6] 外层事务回滚了 = true
[B6] 回滚之后 owner_id = 00000000-0000-7009-8000-000000000002 （= U2）
[B6] 回滚之后 ownership_history 行数 = 1
[B6] transferOwnership 的签名参数 = 1
```

决定性构造：把它放进一个**注定回滚**的外层事务里，它照样提交了（所有人真的改成 U2、历史真的多了一行）。⇒ **一个「账本回滚、所有权不滚」的释放**是可以构造出来的，而设计说任何异常必须完全回滚。

反过来，把等价的三步用**调用方的 `tx`** 内联写出来，同一事务里还能装下账本释放与审计，且注入异常后**六个量逐项相同**：

```
[B7①] ownerA/ownerB = …0002 …0001      （一起提交）
[B7①] ESCROW 余额 = 0n  审计行 = 4
[B7②] 抛出 = true
[B7②] before = {"ownerA":"…0002","ownerB":"…0001","escrow":"0","audits":4,"entries":9,"transactions":4,"history":2}
[B7②] after  = {"ownerA":"…0002","ownerB":"…0001","escrow":"0","audits":4,"entries":9,"transactions":4,"history":2}
[B7②] 六个量逐项相同 = true
```

⇒ **原子释放是可建的，但前提是 P1 的转让接口先被改**（加 `tx`，形状与 P2 / Task 2 给 `AuditService.record` 加 `tx` 完全同类）。P2 的控制器裁定 C-1 已经警告过这种「可选参数使错误调用合法」的形状；P3 这里是**连参数都没有**。

### 0.2 §9 的「交换对手方（RELEASED 后）可下载」按 P1 指定的落点实现 ⇒ `pnpm arch` **变红** —— **证伪**（架构假设）

`AssetAccessService` 的类注释写着将来加那两档时「**只加在这里**」（`asset-access.service.ts:19-21`，D11 要求 `checkAccess` 是唯一入口）。而 `exchange` 为了原子释放必须 import `asset`。两边一成环，仓库自己的 `no-circular` 就报错：

```
--- ① 只有 asset → exchange ----
✔ no dependency violations found (106 modules, 261 dependencies cruised)
exit=0
--- ② asset ↔ exchange 成环 ----
  error no-circular: apps/api/src/modules/asset/asset-access.service.ts →
      apps/api/src/modules/exchange/index.ts →
      apps/api/src/modules/exchange/exchange.service.ts →
      apps/api/src/modules/asset/index.ts →
      apps/api/src/modules/asset/asset-access.service.ts
x 6 dependency violations (6 errors, 0 warnings). 106 modules, 262 dependencies cruised.
exit=6
```

（`.dependency-cruiser.cjs:109-114` 的 `no-circular` 是 `severity: 'error'`。）**单向 import 是干净的（exit 0），成环才报（exit 6）—— 所以这是「方向」问题，不是「多写一行 import」问题。** 存在一条已验证的接缝可以绕开：`PolicyGuard.registerCondition`（`common/policy/policy.guard.ts:66`）由**各模块自己注册**条件，守卫从不 import 业务模块 —— 与 `LedgerModule` 注册 `ledgerAdminGrant` 同一形状。

### 0.3 不变式 #4 在「跨合约」意义上**无法从账本推出**：超发 500 分，五条不变式与对账**全绿** —— **证伪**（P2 的诚实划界被实测量化）

用真实 `LedgerService`：两笔合约各锁 1000（义务合计 2000），其中一笔释放 **1500**：

```
[E1] 两笔锁定之后 ESCROW = 2000n （义务合计 = 2000）
[E1] 释放 1500（合约 A 只锁了 1000）⇒ created = true · ESCROW = 500n
[E1] 对账：totalBalance = 0n  totalEntryAmount = 0n  isBalanced = true
[E1] 分录数 = 13  审计行 = 12
[E1] 用户可用余额 = ["0001=999000","0002=1001425","0003=999000"]
```

接受、托管剩 500（≥ 0，I1 那条修法放行）、分录侧与实际余额一致、审计如实。**平台为此合约付出了它从未为这份合约持有的 500 分，而没有任何一条不变式看得见。** 而「这笔钱属于哪份合约」在今天的库里**无处可查**：

```
[E2] PLATFORM_ESCROW 账户行数 = 1
[E2] ledger.entries 的列 = id, transaction_id, account_id, amount, created_at
[E2] ledger.transactions 的列 = id, kind, idempotency_key, created_at
```

⇒ 义务来源必须是 **P3 自己按合约维护的一张表**，且**要有一条把过账与合约绑起来的链**（今天只有 `transaction_id`，而 `transactions` 上只有 `kind` 与幂等键）。

### 0.4 死锁在 P3 的两条主路径上**都可复现**，且账本自己的锁序挡不住 —— **约束**（不是假设，是实测）

- 真实 `LedgerService` 的两笔**相反方向**过账（A→B 与 B→A）：`P2034` / `originalCode 40P01` / `kind TransactionWriteConflict`，1.1 s 内一方被中止，**有界重试后收敛**。
- 两笔「原子释放」（同一对作品、相反取锁顺序）：`P2010` / `40P01`，1.28 s。
- `applyBalances` 的「按金额升序 ⇒ 借方先」（`ledger.service.ts:490`）**不是全局锁序**；而且 `entries.createMany`（`:213`）先于余额更新，它对被引用账户取 `FOR KEY SHARE`，**本身就是一个未被排序的取锁点**（实测死锁就报在 `createMany` 那一行）。

### 0.5 7 天计时器与受限预览：**前者完全没有机制，后者已经有一半且比设计要求的更宽** —— **约束**

- **计时器**：源码里 `setInterval` / `@nestjs/schedule` / `@Cron` / `scheduler` **零匹配**，`require.resolve('@nestjs/schedule')` = `MODULE_NOT_FOUND`；worker 只有一个轮询循环（`apps/worker/src/worker.ts:161-172`）；对账服务**没有任何生产调用方**（只在 `ledger.module.ts` / `index.ts` 里被 provide/export）。测试里 `useFakeTimers` / `setSystemTime` **零匹配**。
- **预览**：§6.1 点名的十项里有九项**今天已经产出并落库**（`asset_metadata`：README 摘录 / 文件树含体积 / 依赖 / 语言分布 / 完整度 / 截断标记），而那一整条路由是 `@Public()`（`asset.controller.ts:391-393`），越权矩阵**逐格断言匿名 200**（`tests/security/asset/authz-matrix.test.ts:243-249`）。⇒ §9 的 `Preview Dossier read = 交换要约的对手方 / 要约已 SENT` 那一行**今天没有执行者**，而且它与 §9 自己第一行（`Asset 元数据 read = 所有人`）**在同一份文档里互相矛盾**。
- **部分读取可行但有盲区**：不解密整份制品是可行的（代价有界，见 §C.3），但**只做部分读取的预览路径对 tar.gz 的整块截断是瞎的**（实测：截断制品上预览读取成功、`validateArchive` 拒绝）。

---

## A P2 遗留项：P3 必须继承什么、代价各是多少

P2 的账本（`.superpowers/sdd/2026-10-06-p2-ledger/progress.md`）用「复访触发条件」把五件事留给了 P3。逐条实测如下。

### A.1 周期对账执行者：**可调用，但没有执行者、也没有调用方**

```
=== 源码里 setInterval / @nestjs/schedule / @Cron / CronJob / node-cron / scheduler ===
（空）
=== require.resolve('@nestjs/schedule') ===
MODULE_NOT_FOUND
=== LedgerReconciliationService 的消费者 ===
  2  apps\api\src\modules\ledger\index.ts
  3  apps\api\src\modules\ledger\ledger.module.ts
  1  apps\api\src\modules\ledger\reconciliation.service.ts
 15  tests\integration\ledger\reconciliation.test.ts
=== worker 的 imports ===
worker.module.ts:46: @Module({ imports: [ConfigModule, DbModule, NotifyModule] })
```

`LedgerReconciliationService` 被 provide、被 export，**除此之外没有任何调用方**（无路由、无 worker、无定时任务）。`apps/worker/src/worker.module.ts:41-44` 的复访触发条件逐字写着「worker 第一次写账本时（P3 结算），同一次改动里必须 (a) `imports` 加 `LedgerModule`，(b) 加对账（不变式 #2）的周期执行者（计划 D11）」。

**P3 必须建**：一个周期性执行者。而 worker 今天的形状（`runWorker` 只接一个 `{consumer: {runOnce}}`，`worker.ts:36-39`）**装不下第二个周期任务** —— 要么把 `runOnce` 抽象成一个 `tick()` 列表，要么另起一个循环。两条路都要改 `apps/worker/src/worker.ts` 与 `worker.module.ts`，且 `tests/unit/worker/loop.test.ts` 与 `tests/integration/worker/process.test.ts` 要跟着改。
**代价估计**：新文件 1 个 + 改 3 个（`worker.ts` / `worker.module.ts` / 两份既有用例）+ 一个新用例集；**加上 §A.2 的逐账户判据与 §A.4 的计时器，这是 P3 最大的单块工作量**。

### A.2 逐账户对账：**可行、便宜、且真的抓得住平衡漂移**

P2 实测过「A −300 / B +300」这种**保持总量**的改写会让 `isBalanced` 照样返回 true。本节的探针在同一形状上把**逐账户**判据写出来并跑两个方向：

```
── P2 的判据（reconcile() 的两个量）──
 total_balance | total_entry_amount | is_balanced
             0 |                  0 | t            ← ★ 看不见

── 逐账户判据（物化余额 vs 该账户分录之和）──
                  id                  |      kind      | materialized | derived | drift
 00000000-0000-7000-8000-0000000000a1 | USER_AVAILABLE |          700 |    1000 |  -300
 00000000-0000-7000-8000-0000000000b1 | USER_AVAILABLE |         1300 |    1000 |   300
(2 rows)

── 对照：无漂移时同一个查询返回 0 行 ──
 drift_rows_when_clean
                     0
```

**两个方向都在**（漂移 ⇒ 2 行且差值 ±300；修回去 ⇒ 0 行）。⇒ P2 的警告「只加周期执行者 = 把同一个盲区跑得更勤」成立，而**修法是一个查询**：把每个账户的 `Σ entries.amount` 与物化的 `balance` 逐行比对。

**代价（实测）**：20 万条分录 / 1 万个账户（`p3_probe`，`session_replication_role = replica` 只用于造数据）：

```
── P2 的全局长和耗时 ──
 total_balance | total_entry_amount
      20000000 |           20000000
Time: 8.158 ms
── 逐账户对账耗时（同一批数据）──
 count
     0
Time: 40.398 ms
── 执行计划 ──
HashAggregate (actual time=61.678..61.680 rows=0 loops=1)
  ->  Hash Right Join (actual time=2.910..38.436 rows=200003 loops=1)
        ->  Seq Scan on entries e (actual time=0.007..8.898 rows=200000 loops=1)
```

⇒ **40 ms / 20 万行**（P2 的全局判据 8.2 ms），同一份数据上多花 32 ms。**但有一个要记的事实**：`ledger.entries` 上**没有 `account_id` 索引**

```
         indexname                                        | indexdef
 entries_pkey               | CREATE UNIQUE INDEX entries_pkey ON ledger.entries USING btree (id)
 entries_transaction_id_idx | CREATE INDEX entries_transaction_id_idx ON ledger.entries USING btree (transaction_id)
```

执行计划里那条 `Seq Scan on entries` 就是它的后果。今天够用（40 ms），但**在 ledger 表上加索引是改 P2 的 schema**，属一次跨模块 DDL 决定（见 §H）。

### A.3 托管义务来源：**必须新建，而且必须自带「过账 ↔ 合约」的链**

见 §0.3 的实测。补充两条：

- **系统账户只有一行**（`[E2] PLATFORM_ESCROW 账户行数 = 1`），迁移里那句「只有这里创建它们，恰好一次」有真库用例守着；⇒ **托管的余额不携带任何合约维度**。
- P2 交付的 `EscrowRecord` 是**刻意的**不做（控制器裁定 3：「账本上的冻结分录本身就是托管记录」）。实测证明那句话**只对「同一合约内」成立**：跨合约时它不成立（§0.3）。
- 要强制 §8.3 的 `≥` 形式，需要：① P3 自己的义务表（合约 id → 义务金额 + 状态）；② 一条把过账绑到合约的链 —— 今天最便宜的形态是**幂等键约定**（`settle:swap:{contractId}`，见 §A.5），**代价是它是一条没有执行者的约定**（§E.3）；③ 一个跨模块的对账入口（C5 禁止跨 schema join，因此它只能是「`exchange` 报义务 + `ledger` 报余额」的编排，不能是一条 SQL）。
- P2 已经把这条写成了自己的限制：「P2 交付的是**残差代理**，不是设计里那条不等式」。

### A.4 §8.4 的托管生命周期与 7 天计时器：**机制完全不存在**

§8.4（设计 399-404）：「成交 → 全额冻结进 `PLATFORM_ESCROW` → 买家确认收到并验收 → **7 天自动确认**（无争议则到期自动释放）→ 释放时扣平台手续费。争议期间**全额冻结**，任何一方都不能单方提取。」

实测的四件事：

1. **没有任何调度器**（§A.1 的三条 grep 全空），**没有任何时钟抽象**：源码里 `Date.now()` / `new Date()` 出现在 **14 处**（跨 7 个文件），全部是「服务自己读进程时钟」；唯一的时间注入先例是 `inspectTicket(ticket, secret, now)`（`download/signed-url.ts:148`，纯函数收 `now`，单测因此能精确踩边界）。
2. **测试里 `useFakeTimers` / `setSystemTime` / `advanceTimersByTime` 零匹配** —— 即「过期」这一类今天只被**参数化的 `now`** 测过，从没有过一个真的定时器。
3. **幂等重复触发只能靠确定性幂等键**：`notify` 的 exactly-once 形状（`outbox.consumer.ts:243-251`）是「事务内先占位 `processed_jobs`（主键 = 幂等键），再投递」，而 `processed_jobs` 在 **`notify` schema**（C5：P3 不能写别人的表）⇒ P3 的「同一份合约的自动确认只跑一次」**必须自带一个载体**，或者完全依赖账本幂等键 + 状态机前置判定（后者只在「状态已经是 RELEASED/COMPLETED 就不动」时成立，实测确定性）。
4. **触发器/释放的两次触发会怎样**：账本侧安全（同键 ⇒ 重放 `created:false`，P2 的幂等三态），**但前提是键由合约 id 确定性地派生**；若键里带时间戳/随机数，第二次释放会真的再付一次，而 §0.3 证明**没有任何东西看得见**。

⇒ **可测的形状**（建议，不是结论）：把「到点了吗 / 该释放吗」做成**收 `now` 的纯函数**（沿用 `inspectTicket` 的先例），把「谁来调用」做成一个可注入 tick 的 runner，两者各自可测；**不要**让判据依赖真的等待 7 天。

### A.5 幂等键：**一个全局命名空间，约定无执行者**

真库上的索引形状（`p3_atomic`）：

```
CREATE UNIQUE INDEX transactions_pkey ON ledger.transactions USING btree (id)
CREATE UNIQUE INDEX transactions_idempotency_key_key ON ledger.transactions USING btree (idempotency_key)
```

单列唯一 ⇒ P2 的 M2 记录属实。**而那条「`settle:` 前缀保留给 worker/P3」的约定今天没有执行者**：

```
=== 'settle:' / producer 的任何检查（96 个源码文件）===
ledger.service.ts:84:  * `transactions_idempotency_key_key`），**不是** `(producer, key)`。因此**所有生产者共用
ledger.service.ts:87:  *   * **worker / P3 自选**（设计 §8.5 举例的 `settle:auction:{id}`）。
ledger.service.ts:90:  *   1. `settle:` 前缀**保留**给 worker / P3 的结算键；管理员（以及任何将来的调用方）
ledger.service.ts:97:  *   是那笔 TOPUP。这不是理论风险：键是调用方给的，而 `settle:auction:{id}` 是可猜的。
ledger.service.ts:102:  * `(producer, key)`。在那之前，本节是这条规则唯一的存在形式。
```

五处全部是**注释**。P2 把复访触发条件写成「出现第二个生产者时（P3 结算落地），同一次改动里必须二选一 —— 加前缀校验，或把唯一索引改成 `(producer, key)`」。

**P3 必须做其中一个**，代价实测：

| 选项 | 代价 | 风险 |
|---|---|---|
| 加前缀校验 | 改 `ledger.service.ts` 的 `postLegs`（一处）+ 一条拒绝用例 + `dto.ts` 的 200 字符上限仍然只约束管理员路径 | 需要先定「谁拥有哪些前缀」（一次契约变更） |
| 唯一索引改 `(producer, key)` | **迁移**（改 `ledger.transactions` 的唯一索引）+ `postLegs` 加一个必填 `producer` 参数 + **全部**调用点（`idempotencyKey` 在 96 个源码文件里出现在 **9 个文件**，生产调用点集中在 `ledger.service.ts` 与 `ledger.controller.ts`） | 既有库上已有键的语义要迁移；`transactions_idempotency_key_key` 这个名字在 `ledger.service.ts:566` 与 `isIdempotencyConflict` 里是**判别器的一部分**（`IDEMPOTENCY_CONSTRAINT` 用子串判），改名会连带改判别器 |

⇒ **P3 自己的键**至少要覆盖：合约释放（`settle:swap:{contractId}:release`）、补差锁定与释放（各一个）、自动确认（必须与手动确认**同键**，否则两次都会过账）、争议回退。**这些键今天只有「一个字符串」这一个载体** —— 建议在 P3 计划里把它们写成**一张显式的键表 + 一条由合约 id 派生的规则 + 一条「同键第二次 ⇒ `created:false` 且余额不变」的用例**。

### A.6 P2 的 P2028 修正：**复现，并量出「挂多久」**

P2 的最终修复波实测：行锁被持有时请求**不会在预算到点时返回，而是挂起**；Prisma 的计时器触发后在同一条连接上发 `ROLLBACK`，而那条连接正被阻塞语句占用。本轮用**默认预算**与**显式预算**各跑一次（另一连接持锁 8 秒，**由定时器放锁**，不是等请求返回才放）：

```
[A6a] 持锁 8000ms，默认预算 ⇒ 返回耗时_ms = 8010
[A6a] 结果 = {"ctor":"PrismaClientKnownRequestError","code":"P2028","message":"Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction"}
[A6b] 持锁 8000ms，预算 2000ms ⇒ 返回耗时_ms = 8010
[A6b] 结果 = {… "code":"P2028" …}
```

⇒ **两件事**：① 预算**完全不影响**挂起时长（8010 / 8010）；② 锁释放后抛的是 **P2028**（P2 已把它翻成可重试的 503 `LEDGER_TX_TIMEOUT`）。**对 P3 的意义**：双锁/原子释放会**持锁跨越更长的工作**（多行锁 + 所有权转移 + 幂等判定），因此「一次请求挂到客户端超时」是可达的；而挂起时长由**对手方事务**决定，不由本进程的预算决定。**它不改变正确性**（P2028 可安全重试、同键重放），只改变可用性 —— 但这正是 P2 记成「可用性限制 + 复访触发条件」的那条。

---

## B 双锁（`PENDING_BOTH_LOCK`）与原子释放

### B.1 什么必须被锁、按什么顺序 —— 实测两条 ABBA

**（1）两行反序 `FOR UPDATE`**（两个独立连接，受控构造，不是靠 sleep 撞）：

```
[B2′] elapsed_ms = 1029
[B2′] S1(A→B) = {"ctor":"PrismaClientKnownRequestError","code":"P2010","message":"Raw query failed. Code: `40P01`. Message: `deadlock detected`","metaOrigin":"40P01","metaKind":"TransactionWriteConflict"}
[B2′] S2(B→A) = "S2(锁 B→A) 成功"
```

**（2）同一个死锁在显式 `{maxWait: 2000, timeout: 15000}` 预算下**：

```
[B3] 带预算的受害者 = "S2 成功"
[B3] 另一侧 = {"ctor":"PrismaClientKnownRequestError","code":"P2010", … "metaOrigin":"40P01" …}
```

⇒ **预算不把死锁变成别的错误**；受害者始终是「后成环」的那一个；耗时 ≈ `deadlock_timeout`（本机 1 s，`SHOW deadlock_timeout` = `1s`）。

**（3）账本自己的过账路径也会死锁**（用**真实** `LedgerService.post`，两笔相反方向）：

```
[B4] S1 = {"ctor":"PrismaClientKnownRequestError","code":"P2034","message":"\nInvalid `tx.ledgerEntry.createMany()` invocation in\n…/ledger.service.ts:213:26","metaOrigin":"40P01","metaKind":"TransactionWriteConflict"}
[B4] S2 = 成功
```

两条要记的读法：
- **错误码随语句类型变**：经 `$queryRaw` 是 **P2010**，经 Prisma 委托（`createMany`）是 **P2034**（消息是「Transaction failed due to a write conflict or a deadlock. Please retry your transaction」）。两个都带 `cause.originalCode = '40P01'`。⇒ P3 的「可重试」判别式**必须同时认这两档**，只看 P2034 会漏掉 `$queryRaw` 那条（`ownership.service.ts:101` 的 `FOR UPDATE` 就是 `$queryRaw`）。
- **死锁报在 `ledgerEntry.createMany()`**，不是余额更新 —— 因为 `entries` 上有指向 `accounts` 的外键，插入子行会对被引用账户取 `FOR KEY SHARE`，而那**发生在 `applyBalances` 之前**。⇒ `applyBalances` 的「按金额升序、借方先」**不是全局锁序**，它连自己这条路径上的取锁点都没覆盖全。

**（4）有界重试收敛**（同一对相反方向过账）：

```
[B5] 第 1 轮 = {"ctor":"PrismaClientKnownRequestError","code":"P2034", … "metaOrigin":"40P01"} | 成功
[B5] 受害者的 code = P2034 ⇒ 被判为可重试 = true
[B5] 重试结果 = "重试成功"
```

**（5）「两笔交换各自想要对方的作品」—— 用 P3 需要的形状构造**（先 `FOR UPDATE` 锁一件作品，再锁另一件，再走账本）：

```
[B8] S1 = 成功
[B8] S2 = {"ctor":"PrismaClientKnownRequestError","code":"P2010","message":"Raw query failed. Code: `40P01`. Message: `deadlock detected","metaOrigin":"40P01","metaKind":"TransactionWriteConflict"}
```

⇒ **结论（对计划的直接要求）**：双锁必须**定义并强制一个全局资产锁序**（例如按 `assetId` 的字节序升序取 `FOR UPDATE`），且这条规则必须**同时覆盖**作品行与账户行 —— 否则「A 想要 B 的作品、B 想要 A 的作品」与「同一个人既卖出又买入」这两类都会死锁。**这两类都不是罕见情形**：§6.5 的流拍转交换、以及一个创作者同时有多份合约，都会产生它。

### B.2 单一事务够不够 —— **够，而且实测了两个方向**

见 §0.1 的 `[B7①]` / `[B7②]`：一个事务里装下了「两个作品的所有权指针 + 两行 append-only 历史 + 补差/成交的托管两腿 + 手续费腿 + 一行审计 + 幂等键」，提交时全部可见，注入异常后**六个量逐项相同**（含 `history` 与 `transactions`）。**没有一件必须发生在事务外。**

两条边界（据实记载）：
1. **前提是所有权转移用调用方的 `tx`**（§0.1）。用今天的 `OwnershipService` 就一定不是单一事务。
2. **`audit.record(input, tx?)` 的 `tx` 是可选的**，而 `PrismaService` 结构上满足 `Prisma.TransactionClient` ⇒ 「忘了传 `tx`」在类型层合法（P2 裁定 C-1 已记录，`audit.service.ts:85-95` 自己的注释也写着「真正的守卫是测试」）。P3 的三条路径（释放 / 自动确认 / 争议回退）**各自都要有一条「回滚后审计 0 行」的独立断言**，不能折进总数核对。

### B.3 与 P1 的转让协议组合 —— **两套锁协议在同一流程里，可组合但有代价**

P1 的转让是「`SELECT … FOR UPDATE` 读前手 → `UPDATE assets.owner_id` → `INSERT ownership_history`」（`ownership.service.ts:98-141`）。实测它在原子释放里**可以**与账本共存（`[B7]`），但要记两条：

- **它是 `$queryRaw` 路径**，因此它的死锁会以 **P2010** 出现（`[B8]` 实测），与账本的 **P2034** 不同档 ⇒ 重试判别式要认两档。
- **它自己那一层还有一道 P1 的守卫**：`SelfTransferRejectedError`（转给自己被拒，`ownership.service.ts:113`）。**交换的语义天然包含「转给对手方」**，但 P3 若在同一事务里对**同一个** `toUserId` 调两次（例如两件作品都属于同一人、或补差方向恰好让某一步变成自转），会撞上它 —— 而它的状态码是 **409**（`asset.controller.ts:140-142`），不是「这次交换不成立」。**这是一处必须在计划里点名的组合风险。**

---

## C 受限预览资料（Preview Dossier）

### C.1 设计到底要求什么（读 §6.1 + §5 + 现实）

§6.1:255 原文：「要约发出后，对手方可见：README、完整文件树、依赖清单、代码行数统计、语言分布、文件体积、平台生成的**完整度评分**、以及作者上传的截图/录屏。**看得到质量，看不到源码。**」

**实测的现实**：这十项里有九项**今天已经产出并落库**，而且是**公开**的：

| 设计要求 | 今天的落点 | 是否已存在 | 可见性 |
|---|---|---|---|
| README | `asset_metadata.readme_excerpt`（截断 2000 字） | ✅ | **公开** |
| 完整文件树 + 文件体积 | `asset_metadata.file_tree`（500 条 / 深度 8，带 `file_tree_truncated`） | ✅ | **公开** |
| 依赖清单 | `asset_metadata.dependencies`（三类清单，最多 500 条） | ✅ | **公开** |
| 语言分布 | `asset_metadata.languages` | ✅ | **公开** |
| 完整度评分 | `asset_metadata.completeness`（§6.2 七项权重） | ✅ | **公开** |
| 代码行数统计 | **只在评分里被消费**（`hasMedia`/`codeLines` 是 `CompletenessFacts` 的字段），**没有对外字段** | ⚠️ 部分 | — |
| 截图 / 录屏（**可看**） | 只有 `hasMedia` 一个**布尔**（按扩展名）；**没有任何字节出口** | ❌ | — |

「公开」不是推断，是**越权矩阵自己的断言**：

```
tests\security\asset\authz-matrix.test.ts:243: handler: 'readMetadata',
:244: label: 'GET /assets/versions/:versionId/metadata（@Public：§9 的「元数据 read = 所有人」）',
:249: anonymous: { status: 200, kind: 'ok' },
```

而路由本身是 `@Public()` + `@RateLimited('search')`（`asset.controller.ts:391-393`）。

⇒ **「受限预览资料」的「受限」在今天的实现里只对源码成立**（源码要签名 URL + `checkAccess`），而 dossier 的非媒体部分**比设计要求的更宽**（设计说要约对手方才能看，今天匿名可看）。**P3 真正要新建的只有「可看的截图/录屏」这一项**，而它恰好是唯一需要碰制品字节的一项。

### C.2 新的授权规则：一行矩阵行 vs 一条已经在跑的公开路由

§9:475 的 `Preview Dossier | read | 交换要约的对手方 | 要约已 SENT` 与 §9:471 的 `Asset 元数据 | read | 所有人 | 仅元数据` **在同一份文档里对同一种对象给出两个不同的「谁」**。三条路，代价与后果各不相同（**这是控制器决定，不是验证能回答的**，见 §H）：

1. **把 `readMetadata` 从 `@Public()` 收紧**：满足 §9 第 4 行，**但与第 1 行冲突**，且是一次 **P1 的行为变更**（越权矩阵第 249 行那格要从 200 改成 403；`policy-route-coverage` 与 `rate-limit-coverage` 两处断言 `isPublic: true` 也要改）。
2. **新增一条 `Preview Dossier` 路由**（由 `exchange` 的 `@Policy({condition: 'swapOfferSent'})` 把关，条件由 `ExchangeModule` 注册 —— **这条接缝实测存在**，`policy.guard.ts:66`，且它**不需要 `asset` import `exchange`**，因此不会撞上 §0.2 的环）：
   - 若它复用 `asset_metadata` 的字段，**它公开的与公开路由完全相同** ⇒ 只是多了一层「看起来受了限制」的门（**本仓库反复抓的那类缺陷**：声明了但没强制，因为同样的字节从另一条匿名路由也能拿到）。
   - 若它要给出**更多**（例如完整代码行数统计、未截断的文件树），那它就有真实内容了，需要 `exchange` 侧的一个读模型。
3. **把 dossier 定义成「元数据 + 可看的媒体」**，只对**媒体**加限制，元数据保持公开 —— 与 §9 第 1 行自洽，但要**在规格里把第 4 行的含义写窄**（P2 的 M1 就是这么处理币种列的：把决定写进规格，而不是留一句与实现不符的话）。

**P3 的新授权规则形状**：条件函数的输入是 `(userId, assetVersionId)`，输出是「这个人是不是某个 `SENT`（或 `ACCEPTED`）要约的对手方，且该要约指向这份作品」。**它是一条「部分访问」规则**：同一个对象，对不同角色可见的部分不同 —— P1 的矩阵是 4 端点 × 4 角色、每格是「整个制品 / 整个元数据」的二元判定，**没有任何一格的粒度是「部分」**。这是 P1 的矩阵与 P3 的 dossier 之间的结构性差别，必须在计划里明说。

### C.3 能不能不解密整份制品就发出预览 —— **能，代价有界；但部分读取有盲区**

探针全部走仓库**真实**的读取器与 P1 的**共享夹具**（`tests/helpers/craft-encrypted-artifact.ts`），块大小 4096（生产是 8 MiB ⇒ **比值随之变，见下**）。

**（1）打开读取器不解密任何块**（沿 P1 的既有结论复验）：

```
[C1] 制品 = 29238 字节 · 明文 = 28857 · 块数 = 8
[C1] open() 请求数 = 4 取回 = 253 字节
[C1] 请求区间 = [{25734..25757 尾部},{0..34 头},{35..36 keyId},{29022..29213 索引}]
```

**（2）只取「那一个媒体条目」的代价随制品规模怎么长**（媒体条目 33 字节）：

```
[C2] 文件数=  8 媒体位置=  0 制品=  29238B 明文=  28857B 块=   8 | 只取媒体条目：取回   37209B /  10 次请求 / 解密  10 次 || 读整份：取回   24873B /   7 次请求 ⇒ 占比 149.6%
[C2] 文件数= 40 媒体位置= 20 制品= 161654B 明文= 159993B 块=  40 | 只取媒体条目：取回   74281B /  19 次请求 / 解密  19 次 || 读整份：取回  160633B /  40 次请求 ⇒ 占比 46.2%
[C2] 文件数=120 媒体位置= 60 制品= 492694B 明文= 487833B 块= 120 | 只取媒体条目：取回   78553B /  20 次请求 / 解密  20 次 || 读整份：取回  489753B / 120 次请求 ⇒ 占比 16.0%
[C2] 文件数=400 媒体位置=200 制品=1651334B 明文=1635273B 块= 400 | 只取媒体条目：取回   87337B /  22 次请求 / 解密  22 次 || 读整份：取回 1641673B / 400 次请求 ⇒ 占比 5.3%
```

读法（**不要读成「部分读取总是更便宜」**）：
- 取一个条目的代价 **不随制品规模增长**（≈ 74–97 KB、19–25 次块解密，无论制品是 29 KB 还是 1.65 MB），因为它只走中央目录 + 一个条目的本地头与数据。
- 但在**块很小**（4096）时它可能**比读整份还贵**（8 块时 149.6%）—— 因为读取器取的是整块，而 yauzl 的条目读与中央目录读在块之间来回跳，一格 memo 会反复失效。
- **生产块大小是 8 MiB**（`CHUNK_SIZE`，P1 的 D6 上限 1 GiB / 128 块）⇒ 同样的逻辑读映射到 1–3 块 = **≤ 24 MiB**，而整份是至多 1 GiB。⇒ **预览不需要派生制品，也不需要整份解密**；它需要的是「按条目取字节」的一条新路径。

**（3）★ 部分读取对「整块截断」是瞎的（tar.gz）**：

```
[C3a] zip：截断之后连预览读取都会失败（中央目录在末尾，末块必然被读到）
[C3a] 只读媒体条目 = 失败：Error: 第 7 块认证失败（密文被篡改，或该块被当作别的块/末块解读）
[C3a] validateArchive = {"ok":false,…"末块认证失败（制品被整块截断，或末块密文被篡改）…"}

[C3b] tar.gz：前向流
[C3b] 看到的条目 = ["screenshots/shot.png"]
[C3b] 只读第一个条目 = 33 字节（PNG 33 ） 成功      ← ★ 截断没有被发现
[C3b] validateArchive = {"ok":false,…"末块认证失败（制品被整块截断，或末块密文被篡改）…"}
```

（构造：`zip/tar.gz ‖ 对齐填充 ‖ 3 块纯填充`，然后 `truncateLastBlocks(artifact, 3)` —— 截掉的正好只是填充，归档自身完好且有完全自洽的尾部。）

⇒ **对计划的硬要求**：**预览路径在发出任何字节之前，必须仍然行使那条「先认证末块」的判据**（`validateArchive` 的第一步，或等价的一次末字节读）。zip 天然会撞上它（中央目录在末尾），**tar.gz 不会** —— 而 `tar.gz` 是 D6 允许的两种容器之一。**这条不是推理，是两个方向都跑过的实测。**

**（4）整份校验本身的代价**（对 zip 只走中央目录，不解压任何条目数据）：

```
[C4] validateArchive = {"ok":true,"kind":"zip"} · 取回 78923 字节 / 41 次请求   （制品 161654 字节，40 块）
[C4] 随后取媒体条目 = 33 字节（PNG 原字节 33 ）
```

⇒ 「先完整校验、再按条目取字节」是可行的，且两步都不解密整份制品。

**（5）媒体字节的出口还欠一条控制**（据实记载，未实测）：威胁 #9 要求「上传文件绝不从同源路径回源（独立域或强制 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`）」。今天的下载路径靠 `Content-Disposition: attachment` + 推导出的 `Content-Type`（`asset.controller.ts:363-369`）。**预览要「可看」，就不能用 `attachment`** ⇒ 这是一条新的响应形状，其风险（`image/svg+xml`、`text/html` 伪装成 `.png`）**本轮没有探针**（见 §G）。

---

## D 补差（§6.4）与争议期（§6.3/§8.4）

### D.1 §6.4 补差：**不需要新 kind，机械形状完全由现成原语表达**

§6.4:296-298：「双方价值不等时，用虚拟账本结清差额。差额同样走托管与 7 天争议期。」

实测（真实 `LedgerService`，补差 10 000 分，`feeBps: 0`）：

```
[E4] 补差前 = {"p1":"1000000","p2":"1000000","escrow":"0"}
[E4] 补差后 = {"p1":"990000","p2":"1010000","escrow":"0"}
[E4] 付款人 −10000 = 10000 · 收款人 +10000 = 10000 · 托管净变化 = 0
[E4] 用到的 kind = ESCROW_LOCK, ESCROW_RELEASE, TOPUP
[E4] 可用的 kind（TRANSACTION_KINDS）= TOPUP, FREEZE, FORFEIT, ESCROW_LOCK, ESCROW_RELEASE, UNFREEZE
```

⇒ **`TRANSACTION_KINDS` 的闭集够用**：补差 = `lockToEscrow(payer)` + `releaseEscrow(payee, feeBps: 0)`。`releaseEscrow` 的 `feeBps` 参数就是为这条业务规则留的（`ledger.service.ts:318` 的注释逐字：「也让『补差不收手续费』这类业务规则在外层表达」）。

`kind` 的**执行者**实测：

```
[E3] ledger.transactions 上的约束 = [{"conname":"transactions_pkey","def":"PRIMARY KEY (id)"}]
[E3] 用一个 §8.2 之外的 kind 过账 ⇒ 成功（没有任何东西拦住它）
[E3] 库里 kind = NOT_A_KIND 的行数 = 1
```

⇒ 两句话：**① 加一个 kind 不需要迁移**（列是 `TEXT`，没有 CHECK）；**② `kind` 今天完全没有运行期执行者**（§8.1 的五个账户 kind 有 `assertAccountKind`，而交易的六个 kind 只有 TypeScript 类型）。这是「声明了但未强制」的又一例，落在**账本自己的判别式**上（P2 的审查 I2 刚把 `kind` 加进幂等重放判别式，正是在依赖它）。

**仍可能要新 kind 的那一处**：§6.3 的状态机有 `DISPUTED → RESOLVED_REVERSED`。若释放**先于**争议期结束，逆转就需要一笔「从卖家可用 + 平台收入 回到 付款人可用」的三腿过账 —— 今天没有语义正确的 kind（用 `ESCROW_LOCK` 或 `FORFEIT` 都是在账本里写一句假话），而且 `releaseEscrow` 的守卫（托管 ≥ 0 且不引用具体锁定）也表达不了它。**若释放发生在争议期结束时，则不存在这个问题。** 这正是下一条。

### D.2 ★ 设计文档内部的一处张力：**释放发生在 `RELEASED` 还是争议期结束时？**

| 出处 | 原文 | 含义 |
|---|---|---|
| §6.3:287 | `RELEASED 【单一事务】所有权互换 + 双方访问权授予 + **补差账本过账**` | 钱在 `RELEASED` 那一刻动 |
| §6.3:288-289 | `↓ 7 天争议期无人提出 → COMPLETED` | 争议期在**之后** |
| §8.4:401 | `→ **7 天自动确认**（无争议则到期自动释放）→ 释放时扣平台手续费` | 钱在 7 天**之后**动 |
| §8.4:402 | `争议期间**全额冻结**，任何一方都不能单方提取` | 争议期内钱不能动 |
| §6.1:257 | `7 天争议期 + 补差托管` —— `质量问题可仲裁，补差可回退` | 争议期内可回退 |

**两种读法**：§8.4 的读法是「进托管（`RELEASED`）→ 7 天 → 释放（`COMPLETED`）」，此时 `RESOLVED_REVERSED` = 释放**前**把托管退回付款人 —— **用 `releaseEscrow(sellerId = payer, feeBps: 0)` 就能表达，不需要新 kind，也不需要从卖家账上追钱**。§6.3 的「补差账本过账」若被读成「释放」则与 §8.4 直接冲突，`RESOLVED_REVERSED` 就变成一个没有原语可表达的操作。

⇒ **这是 P3 计划必须写死的第一个决定**（不是验证能回答的，见 §H）：**`RELEASED` 只做 `ESCROW_LOCK`（进托管），`EscrowRecord` 的释放放在 7 天后的 `COMPLETED`。** 只有这个读法能让「争议期内全额冻结」与「补差可回退」同时成立。

### D.3 争议期的时间处理：**能测的形状已经有一个先例，但机制要新建**

- 先例（**唯一**一处）：`inspectTicket(ticket, secret, now)` —— 判定是**收 `now` 的纯函数**，因此单测可以精确踩过期边界（`signed-url.ts:148`，注释：「`now` 由调用方传入（不读进程时钟）：单测因此可以精确地踩过期的边界」）。
- 服务层读进程时钟（11 处 `Date.now()`），**测试里零处假时钟**（`useFakeTimers` / `setSystemTime` / `advanceTimersByTime` 全零匹配）。
- 计时器本身不存在（§A.1 / §A.4）。

⇒ **可测形状**：`due(contract, now)` / `shouldAutoConfirm(now)` 做成纯函数（测试传 `now`），runner 单独测（注入 tick）。**不可测的形状**：任何「等 7 天」的用例、以及把 `Date.now()` 写进判据内部的做法。24 小时（`PENDING_BOTH_LOCK`）与 72 小时（`SwapOffer` 过期）同款，一处形状覆盖三个计时器 —— 建议 P3 计划里**只造一个**时间判据形状，三个计时器共用它。

---

## E P3 需要而今天不存在的东西（含代价）

### E.1 新模块 `exchange` + 新 schema：**十个落点，其中五个是 CI/门**

`Test-Path apps\api\src\modules\exchange` = **False**（模块不存在）。`prisma/schema.prisma` 里 `exchange` **零匹配**。P2 落地 `ledger` 的实测代价（`git show --stat e73ff4a`，即「schema 与迁移」那一个提交）：

```
 .github/workflows/ci.yml                           |  58 ++-
 .../20261006120000_p2_ledger/migration.sql         | 168 ++++++++
 apps/api/prisma/schema.prisma                      | 108 ++++-
 infra/db/apply-grants.sql                          |  43 +-
 tests/integration/db/ledger-enforcement.test.ts    | 453 +++++++++++++++++++++
 tests/integration/db/schema-isolation.test.ts      |  13 +-
 6 files changed, 825 insertions(+), 18 deletions(-)
```

**一个模块 schema 的落点全集**（P3 逐条都要有）：

| # | 落点 | 现状（实测） | P3 要做什么 |
|---|---|---|---|
| 1 | `apps/api/prisma/migrations/<ts>_p3_exchange/migration.sql` | 新文件 | 建 schema + 表 |
| 2 | `apps/api/prisma/schema.prisma:29` | `schemas  = ["auth", "audit", "notify", "asset", "ledger"]` | 加 `"exchange"`，且**必须与声明 model 同一提交**（P2 Task 1 的实测：不列出 ⇒ `migrate diff` 对该 schema **结构性失明**） |
| 3 | `infra/db/apply-grants.sql:35` | `GRANT USAGE ON SCHEMA auth, audit, notify, asset, ledger TO app_user;` | 加 `exchange`；再加表级 GRANT、`ALTER DEFAULT PRIVILEGES … IN SCHEMA exchange`，以及任何 append-only 表的**逐表 REVOKE** |
| 4 | `tests/integration/db/schema-isolation.test.ts:38` | `IN ('auth','audit','notify','asset','ledger','public')` | 加 `'exchange'` —— **漏这一处，查询根本看不到新表，断言照样绿**（文件自己的注释逐字警告过） |
| 5 | 同上 `:51-65` | 13 行的**精确**期望数组 | 加每一张新表（多一张、少一张、换 schema 都会红） |
| 6 | `.github/workflows/ci.yml:120` | 15 项 `has_table_privilege` 的**精确字符串** | 给 exchange 的 append-only 表加断言（否则那条不变式在 CI 里无见证） |
| 7 | 同上 `:140` | ledger `relacl` 的精确字符串 | 若 exchange 也有只增不改的表，同款一条 |
| 8 | `tests/integration/db/<x>-enforcement.test.ts` | P2 的是 **453 行** | 目录断言（`pg_get_constraintdef`/`pg_trigger`/`pg_proc`）+ 行为用例 |
| 9 | `apps/api/src/modules/exchange/{index,exchange.module,service,controller,dto}.ts` + `app.module.ts` | 无 | 新模块 + 组合根接线（`app.module.ts` 是 arch 规则显式豁免的唯一位置） |
| 10 | `apps/worker/src/worker.module.ts:46` + `worker.ts` | `imports: [ConfigModule, DbModule, NotifyModule]` | 若结算/计时器跑 worker：其注释里的复访触发条件要求 `imports` 加模块**与**周期对账执行者同一次落地 |

### E.2 新路由：每条都要声明，且**限流层的归属是一次设计裁定**

路由声明由两道覆盖率门强制（实测存在）：`RouteDeclarationRegistry.listUndeclaredRoutes()`（策略）与 `listRateLimitGaps()`（限流）。每条新路由**必须**二选一：`@Policy`/`@Public()`；`@RateLimited('层名')`/`@SkipRateLimit()`。

而限流表是**闭集**（`throttler.ts:15-21`）：

```
login:    { limit: 5,  ttlMs: 15*60_000, by: 'ip+account' }
register: { limit: 3,  ttlMs: 60*60_000, by: 'ip' }
bid:      { limit: 30, ttlMs: 60_000,    by: 'user' }
upload:   { limit: 10, ttlMs: 24*60*60_000, by: 'user' }
search:   { limit: 60, ttlMs: 60_000,    by: 'ip' }
```

它是设计 §4.1 威胁 #13 那张表的投影，`tests/security/rate-limit.test.ts` 逐条断言与设计一致 —— **新增一档是一次设计裁定**（P1 与 P2 都因此把新路由挂在 `search` 上，并把「名字叫 search 而挂的是下载/元数据/额度发放」这个代价写进类注释）。

**P3 的处境比 P1/P2 好一点**：表里有一档 **`bid`（30 次/分钟，**按用户**）**，语义上正对「按用户的写动作」。交换要约的创建/接受/锁定可以挂它，读取挂 `search`。但这仍要控制器点头（因为 `bid` 的名字是给竞拍写的）。

### E.3 「声明了但未强制」清单（每条：谁强制、怎么验的）

| 声明 | 今天谁强制 | 怎么验的 |
|---|---|---|
| `kind ∈ TRANSACTION_KINDS`（§8.2 六行） | **无人** —— 只有 TS 类型 | 实测 `kind='NOT_A_KIND'` 过账成功且落库（§D.1） |
| `settle:` 前缀保留给 worker/P3 | **无人** —— 五处全是注释 | 源码里对该前缀的**任何检查**零匹配（§A.5） |
| 幂等键全局唯一 | DB 唯一索引（单列） | 真库 `pg_indexes` 实测（§A.5） |
| `Σ PLATFORM_ESCROW ≥ Σ 未结算义务`（§8.3 #4） | **无人**：托管 ≥ 0 只保证「不跨账户透支」 | 实测超发 500 分被接受、对账绿（§0.3） |
| 全局 `Σ 余额 = 0`（§8.3 #2） | 只有**可调用**的对账服务，**无执行者、无调用方** | `LedgerReconciliationService` 的消费者只有 module/index/测试（§A.1） |
| 逐账户 `balance == Σ entries` | **无人**，且 P2 的对账对它**结构性失明** | 平衡漂移 700/1300 vs 1000/1000，`isBalanced = true`（§A.2） |
| `RELEASED` 单一事务（§6.3:294） | **无人**：P1 的转让自己开事务 | 外层回滚后所有权与历史**都留下了**（§0.1） |
| `Preview Dossier` 只对要约对手方可见（§9:475） | **无人**，且元数据是 `@Public()`，越权矩阵断言匿名 200 | 实测（§C.1） |
| `owner_user_id` 的角色校验（§8.1） | 应用层 `assertAccountKind`（P2） | P2 已交付，有单测 |
| `Preview Dossier` 的「看得到质量」 | **无人**：媒体一个字节都没有出口 | `hasMedia` 只有一个布尔（§C.1） |
| §9 的 `SwapOffer accept/reject` 等三行 | **无人**：模块不存在 | `Test-Path` = False（§E.1） |
| 7 天争议期 | **无人**：无计时器、无时钟注入、无假时钟用例 | 三条 grep 全空（§A.4） |

---

## F 对计划的直接影响（必须体现在 P3 计划里）

1. **先改 P1 的转让接口，再谈原子释放**：`OwnershipService.transferOwnership` 必须收调用方的 `tx`（形状照 P2 Task 2 的 `record(input, tx?)`，但**建议必填**——可选参数使「忘了传」合法，P2 裁定 C-1 已吃过一次）。**这是 P3 的第一个任务**，且它必须在同一个提交里给出「外层回滚 ⇒ 所有权与历史都回滚」的两方向用例（§0.1）。
2. **双锁必须定义全局资产锁序**（作品行与账户行都要覆盖），并给出「两笔相反方向交换」与「同一人既买入又卖出」两类**真并发**用例（§B.1）。死锁重试判别式**同时认 P2034 与 P2010**，且两者都要检查 `cause.originalCode === '40P01'`。
3. **跨模块授权不要走 `asset → exchange`**：用 `PolicyGuard.registerCondition`（由 `ExchangeModule` 注册）或一条由 `exchange` 提供的读模型。加环会让 `pnpm arch` 报 6 条 error、exit 6（§0.2）。
4. **`RELEASED` 只进托管；释放放在 `COMPLETED`**（7 天后），否则 `RESOLVED_REVERSED` 没有原语可表达，且与 §8.4「争议期间全额冻结」冲突（§D.2）。**把这个决定写进规格**（照 P2 的 M1 的做法）。
5. **托管义务表 + 过账↔合约的链**：义务表是 P3 的；链最便宜的形态是幂等键约定，而**约定必须同时变成执行者**（前缀校验或 `(producer, key)` 唯一索引），否则它就是 §E.3 里第 2 行的第二份拷贝（§0.3 / §A.5）。
6. **对账的周期执行者与逐账户判据一起落地**（P2 的警告逐字：「否则只是把同一个盲区跑得更勤」）。逐账户判据已经是一个 40 ms 的查询（§A.2），但 `ledger.entries` 上没有 `account_id` 索引 —— **加索引是改 P2 的 schema，要控制器点头**。
7. **7 天 / 24h / 72h 三个计时器共用一个「收 `now` 的纯函数 + 可注入 tick 的 runner」形状**（照 `inspectTicket` 的先例）。**不要**让任何判据内部读 `Date.now()`（§D.3）。
8. **预览路径必须先认证末块，再发字节**：tar.gz 的部分读取对整块截断是瞎的（实测），zip 天然会撞上（也实测）。复用 `validateArchive` 的第一步即可（§C.3）。
9. **幂等键表**：P3 的每一个键都由业务 id 确定性派生，写成一张显式表；每个键都要有「同键第二次 ⇒ `created:false` 且余额不变」的用例（§A.5）。
10. **新 schema 的十个落点逐条落地**（§E.1），其中 4 / 5 / 6 / 7 四格**不写就是纸面约束**。
11. **审计的 `tx` 必须显式传**，且三条资金路径（释放 / 自动确认 / 争议回退）**各自**要有一条「回滚后审计 0 行」的独立断言（不得折进总数核对，P2 裁定 C-1）。
12. **`origin/release` 的两个 `kind` 语义边界**：若决定加交易 kind，同一次改动里要给它一个运行期执行者（`assertTransactionKind`，照 `assertAccountKind` 的形状）+ 一条拒绝用例；若不加，把「闭集只有类型层执行者」写成具名限制（§D.1 / §E.3）。
13. **`SelfTransferRejectedError` 与交换语义的交点**：计划里要点名「同一次释放里两次转让可能撞上 409 的转给自己守卫」（§B.3）。
14. **媒体预览的响应形状要用一条新控制**（不能用 `attachment`），并把威胁 #9 的那两条（独立域 / `nosniff`）写成验收判据（§C.3，本轮**未**探针）。

---

## G 未能验证的面（据实记载）

1. **`@nestjs/schedule` 之外的自研周期执行者在这个代码基里到底怎么写**：本轮只证明「今天没有」，**没有**验证任何实现形态（改 `runWorker` 的签名 vs 第二个循环 vs 在 `NotifyModule` 之外加一个 `SchedulerModule`）。它会在 P3 第一步就变成具体问题，建议**实现第一步就量**（照 P2 的做法：先跑一个最小 tick 循环，量「空转打库的频率」与「停机顺序」）。
2. **worker 侧的周期任务与 `SIGTERM` 关停的交互**：`runWorker` 今天把「消费一批 → 睡一个间隔 → 收到信号则关停」写成一个循环（`worker.ts:161-172`）。加第二个周期任务之后「一轮」的定义会变，而**停机超时是 5 秒**（`DEFAULT_SHUTDOWN_TIMEOUT_MS`）。本轮**没有**验证「一次 7 天计时器的 tick 需要多久、会不会把关停拖过 5 秒」。
3. **预览媒体的响应头形态**：`Content-Type` 怎么推导、要不要独立域、`nosniff` 够不够 —— 本轮只指出威胁 #9 要求它们，**没有探针**（需要一个真实的浏览器/HTTP 断言，而它属实现期）。
4. **`image/*` 字节从加密制品里取出后是否需要一个派生副本**：本轮证明「按条目取字节」可行且代价有界，**没有**验证「一次预览请求的端到端耗时」（含中央目录解析 + 块解密 + 流式写出）。生产块 8 MiB 时一次块解密的开销（P1 的预检量过 8 MiB 往返，本轮没重跑）**未在本轮量**。
5. **`transferOwnership(tx)` 的改动对 P1 既有调用点的影响面**：本轮**没有**枚举 `transferOwnership` 的全部调用点（今天只有 P1 自己的用例），因此「改签名会红几条」没有实测。
6. **`SwapContract` 的 24 小时（`PENDING_BOTH_LOCK`）在真实并发下「双方同时确认」的语义**：本轮只按「确定性幂等 + 状态机前置判定」推理，**没有**构造两方同时 `confirmLock` 的真并发探针。
7. **交换 ↔ 竞拍的互导流（§6.5）**：属 P4/P5，本轮未验。
8. **`migrate diff` 对新 schema 的可见性**：P2 已实测过一次（不列出即失明），本轮**没有**重跑，只引用。

---

## H 给控制器的开放问题（产品/设计判断，不是机械事实）

1. **§9 的两行冲突怎么收**：`Asset 元数据 read = 所有人`（今天已实现，越权矩阵断言匿名 200）与 `Preview Dossier read = 交换要约的对手方`（今天无执行者）。**收紧元数据路由**（满足第 4 行、违反第 1 行、改 P1 行为）还是**把第 4 行写窄成「元数据 + 可看的媒体，媒体那部分受限」**（与第 1 行自洽）？后者更便宜，但要求规格承认「dossier 的九项本来就是对所有人公开的」。
2. **`RELEASED` 到底动不动钱**（§D.2）：进托管（`ESCROW_LOCK`）在 `RELEASED`、释放（`ESCROW_RELEASE`）在 `COMPLETED`？还是 §6.3 的字面读法（`RELEASED` 就释放）？**后者会让 `RESOLVED_REVERSED` 没有原语可表达**，且与 §8.4「争议期间全额冻结」冲突。**这是 P3 的第一个决定。**
3. **补差要不要收手续费**：`releaseEscrow` 的 `feeBps` 是可传的（`feeBps: 0` 就能不收），但「补差不收手续费」是一条产品规则，规格里**没有**（§6.4 只说「走托管与 7 天争议期」）。
4. **交换要约的限流归哪一档**：新增一档（一次设计裁定 + 改设计文档 + 改 `rate-limit.test.ts`）、复用 `bid`（30/分钟按用户，语义最接近但名字是给竞拍写的）、还是复用 `search`（60/分钟按 IP，P1/P2 的既有做法）？
5. **托管义务表的归属与「过账 ↔ 合约」的链**：幂等键约定（便宜、无执行者）还是 `(producer, key)` 唯一索引（迁移 + 全部调用点）？**后者是一次跨模块的账本 schema 变更**，且会改动 `isIdempotencyConflict` 的判别器（它按索引名子串判）。
6. **要不要给 `ledger.entries` 加 `account_id` 索引**：逐账户对账今天在 20 万行上 40 ms（Seq Scan），够用；加索引是改 P2 的 schema，收益是「对账规模再大一个量级也不疼」。**要不要现在付？**
7. **`kind` 要不要一个运行期执行者**：今天 `kind='NOT_A_KIND'` 能落库（实测）。加一个 `assertTransactionKind` 是几行 + 一条用例；不加就要把「闭集只有类型层」写成具名限制。
8. **资产锁序的形态**：按 `assetId` 字节序？按合约里「先买后卖」的固定角色？还是按 `(assetId, accountId)` 全序？**只要不确定并强制一种，§B.1 的两种死锁都会在真流量下出现** —— 而它们只在真并发下出现。
9. **媒体预演的响应形状**：同源 `inline` + `nosniff`，还是独立域？威胁 #9 给了两个选项，规格没有选。
10. **7 天 / 24h / 72h 三个计时器共用一个形状**：收 `now` 的纯函数 + 可注入 tick 的 runner —— 这条是建议，但「谁来 tick」（worker 的现有循环 / 第二循环 / 每次请求顺带）需要控制器定，因为它决定 worker 结构与停机语义。

---

## 附：探针文件清单（一次性，全在仓库之外）

| 文件 | 内容 |
|---|---|
| `%TEMP%\p3-probe\a2-per-account.sql` | 逐账户对账的两个方向（漂移被抓 / 无漂移 0 行）+ P2 判据的对照 |
| `%TEMP%\p3-probe\a2b-cost.sql` | 20 万分录 / 1 万账户下的全局与逐账户代价 + 执行计划 + 索引清单 |
| `%TEMP%\p3-probe\dl-*.sql` | 死锁探针（会话 1 A→B / 会话 2 B→A） |
| `%TEMP%\p3-probe\lock.test.ts` | B2′/B3 反序锁与预算下的死锁、B4 真实 `LedgerService` 的相反方向过账 |
| `%TEMP%\p3-probe\atomic.test.ts` | A6a/A6b 事务预算 vs 锁等待、B5 死锁重试收敛、**B6 外层回滚后所有权留下**、B7 单一事务的提交/回滚、B8 两笔并发原子释放 |
| `%TEMP%\p3-probe\preview.test.ts` | C1 open 代价、C2 规模扫描（12 行）、C3a zip / C3b tar.gz 的截断盲区、C4 完整校验的代价 |
| `%TEMP%\p3-probe\obligation.test.ts` | E1 超发 500 分而全绿、E2 托管归属不可查、E3 `kind` 无执行者、E4 补差的金额守恒 |
| `%TEMP%\p3-probe\arch\` | `apps/api/src` + `packages/shared` + `apps/worker/src` 的镜像；`depcruise` 的基线与注入环路后的实测 |
| `%TEMP%\p3-probe\vitest.config.ts` | 仓库之外的最小 vitest 配置（复刻 alias；`node_modules` 目录联接指向 `apps/api/node_modules`） |
