# P2 账本与托管 · 预检验证（2026-10-06）

**目的**：在写 P2 计划之前，用可运行探针把「计划会写错的假设」先打掉。P0 与 P1 的预检各自抓到过一条会在实现期变成返工的缺陷，本文沿用同一标准：**每条结论后面都有实际输出**，凡查文档得出的、或没能测出来的，一律标明。

**被验对象**：`main` / HEAD `4a1a008`（P1 合并完成、工作区干净）。

**探针位置**（全在仓库之外，一次性）：

| 位置 | 内容 |
|---|---|
| `%TEMP%\p2-probe\` | 原生 SQL 探针（延迟约束触发器、行级 CHECK） |
| `%TEMP%\p2-probe-db\` | Prisma 7.10.0 + `@prisma/adapter-pg` + `pg` 探针；`node_modules` 是指向 `apps/api/node_modules` 的**目录联接**（ESM 下临时目录解析不到 pnpm 隔离布局里的包） |
| `%TEMP%\p2-probe-pbt\` | 属性测试探针（自带 `pnpm install`，**没有装进仓库**） |

**数据库**：项目自己跑着的 `postgres:16-alpine`（`infra-postgres-1`，实测 `PostgreSQL 16.15`）。探针全部打在**一次性库 `p2_probe`** 上；开发库 `vca` 只被**读**过一次（一条 `has_table_privilege` 查询）。仓库本身**零改动**（`git status` 干净）。

**未验证面**写在 §G，**不该由验证者决定的产品问题**写在 §H。

---

## 0. 判决

### 0.1 属性测试在 CI 里**根本没有执行点** —— **证伪**（设计假设）

设计文档 §8.3 写着五条不变式「将成为**属性测试**：CI 每次生成 ≥10 万次随机交易序列后断言不变式恒成立。这是资金系统唯一真正可靠的验证方式」，§13.3 把「五条不变式在属性测试（≥10 万次随机操作）中恒成立」列为验收判据。**今天这句话没有任何执行者**：

- `tests/property/` 目录**不存在**（`Test-Path tests\property` → `False`）；
- 根 `package.json` 的 `test:property` 是 `vitest run --project property --passWithNoTests`，实测「include 匹配不到任何文件的 project + `--passWithNoTests`」**退出码 0**（不加则 1）；
- `.github/workflows/ci.yml` 里 **`property` 零匹配**——CI 依次只跑 unit / security(gate) / architecture(gate) / integration / audit，`pnpm test` 与 `pnpm test:property` 都不在其中；
- `scripts/assert-tests-ran.mjs:57-76` 的 `GATES` **只有** `security: 85` 与 `architecture: 5`——没有任何机制会因为 property 用例被删空而变红。

⇒ P2 的**第一条**任务不是写账本，而是先把这条验收判据变成一个有执行者、有下限的门；否则「≥10 万次随机操作」永远只是一句写在规格里的话。这正是 P1 台账里反复出现（7+ 次）的「**声明了但未强制**」缺陷类，只是这次它挂在**整份设计文档最核心的验证手段**上。

### 0.2 延迟约束触发器**可以**在 COMMIT 时刻拒绝不平衡的过账 —— **确认**；但经 Prisma 时它的错误形态是最弱的一档 —— **约束**

设计 §8.3 不变式 #1（每笔交易借贷平衡）在 Postgres 里**有**强制点：`CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`。实测：平衡的两腿在 `COMMIT` 时被接受；单腿/同向两腿在 `COMMIT` 时以 `ERROR: 23514 … CONSTRAINT NAME: entries_tx_balanced` 被拒——**行级 `CHECK` 做不到这件事**（`ERROR: aggregate functions are not allowed in check constraints`），所以「延迟约束触发器」不是可选项而是唯一选项。

但**经 Prisma 7.10.0 时它退化成最弱的一档错误**：`DriverAdapterError`，`code === undefined`，只有 message 与 `cause.code === '23514'`。同一份库里，**即时** CHECK 违反却能被 Prisma 映射成 `PrismaClientKnownRequestError` / `P2039`。⇒ 计划不能把「捕获触发器异常 → 领域错误」当成一条可靠映射；**应用侧必须在提交前自己做一次显式平衡断言**（唯一能产生稳定领域错误的地方），触发器作为**回退防线**。

### 0.3 Prisma 默认的 READ COMMITTED 下，「读-判断-写」会丢更新；余额能被扣成负数 —— **约束**

实测（真实并发两连接，Prisma 7.10.0）：

- 初始 1000 分，两笔并发**无条件** `decrement 600` → 余额 **-200 分**。「不可透支」（不变式 #3）在库里**没有任何强制**。
- 两笔并发「读余额 → 判断 → 写回 `读到的值 - 600`」→ 两笔都成功，库里只剩 400，而实际扣款是 1200 ⇒ **丢更新**。应用层自己判余额**不构成保护**。
- `updateMany({ where: { id, balance: { gte: 600 } }, data: { decrement: 600 } })` → 影响行数 `1/0`，余额 400 ⇒ **挡住了**。
- `SELECT … FOR UPDATE` 行锁 → 也挡住了（第二笔在锁内读到 400 后拒绝）。
- `isolationLevel: 'Serializable'` → 冲突方抛 `PrismaClientKnownRequestError` **P2034**，`originalCode: '40001'`，`kind: 'TransactionWriteConflict'`，消息为「Please retry your transaction」⇒ **可重试**；实测加一层 `P2034` 重试后收敛到正确结果。

⇒ 冻结与释放必须**显式选一条**（条件更新 / 行锁 / SERIALIZABLE+重试），并把选择写进计划；「读出来判一下再写」是被实测否掉的那条。

### 0.4 新建的 `ledger` schema **不会**自动获得 append-only —— **约束**

在真实库上照抄 `infra/db/apply-grants.sql` 的写法（`GRANT USAGE` + `GRANT … ON ALL TABLES IN SCHEMA ledger`）：

```
has_table_privilege('app_user','ledger3.entries','UPDATE') = true
has_table_privilege('app_user','ledger3.entries','DELETE') = true
app_user 执行 UPDATE → 成功，库里 amount 从 100 变成 999      ← append-only 不成立
补上逐表 REVOKE UPDATE, DELETE 后：
has_table_privilege(...'UPDATE') = false
app_user 执行 UPDATE → ERROR: permission denied for table entries
relacl = {vca_owner=arwdDxt/vca_owner,app_user=ar/vca_owner}
```

另有一条**新发现**：`GRANT … ON ALL TABLES` **不覆盖序列**。带 `bigserial` 的表即便拿到了 `INSERT`，也会 `ERROR: permission denied for sequence entries_id_seq`。本仓的 `apply-grants.sql` **今天没有任何 `GRANT … ON SEQUENCES`**——现有四张表全用 UUIDv7 主键所以没暴露，P2 一旦在某张表上用自增主键就会撞上。

而 CI 的运行期权限断言（`.github/workflows/ci.yml:97-108`）只查 5 项，**只覆盖 `auth.users` 与 `audit.audit_logs`**，连 P1 新增的 `asset.ownership_history` 都不在其中。⇒ ledger 的 append-only 若要成立，必须**成套**落地：迁移 + `apply-grants.sql` 的 `ledger` 段 + 逐表 REVOKE + **CI 权限断言扩到 ledger**；少任何一件，它又是一条纸面约束。

### 0.5 钱用 `bigint`「分」是**对的**（**确认**），但 JSON 边界与舍入规则**都没有执行者**（**约束**）

- **确认**：`Prisma 7.10.0` 的 `BigInt` ↔ Postgres `int8` ↔ JS `bigint` **完全无损**：`9007199254740993n` 与 `-1234567890123456789n` 往返一致，`$queryRaw` 路径也返回 `bigint`。小数（`1.5`）在 Prisma 层被 `PrismaClientValidationError` 拒绝。P0 已经把 `Cents = bigint`、`Currency = 'CNY'` 放进 `@vca/shared`，与设计 §5.3 一致——**沿用即可，不需要小数库**。`NUMERIC(20,4)` 是可行的替代（Prisma 返回 `Decimal`，`JSON.stringify` 得到字符串），但它多一层类型、且**不带来本场景需要的任何能力**。
- **约束 1（边界）**：`number` 能溜进 `bigint` 列而 **Prisma 不报错**。实测 `JSON.parse('{"amount":9007199254740993}').amount` → `9007199254740992`，把它写进 `bigint` 列**成功**，库里是 `…992`，**少 1 分**，全程无异常；`12.5` 才会被拒。同时 `JSON.stringify(bigint)` **直接抛 `TypeError: Do not know how to serialize a BigInt`**。⇒ 需要一个显式的 DTO 契约（金额以**字符串**进出 JSON，服务端 `BigInt()`），否则「一律 bigint，禁浮点」（C3）只在 TypeScript 类型层成立，而**请求体不经过 TypeScript**。
- **约束 2（舍入）**：设计给了「平台手续费默认 5%」，但**没有给舍入规则**。实测**不能整除**的拆分：

  | 金额 | 规则 | 平台 | 卖家 | 合计 | 差 |
  |---|---|---|---|---|---|
  | 999 分 / 5% | 两侧各自向下取整 | 49 | 949 | 998 | **−1 分（账不平）** |
  | 999 分 / 5% | 两侧各自四舍五入 | 50 | 949 | 999 | 0 |
  | 999 分 / 5% | 余数归一侧 | 49 | 950 | 999 | 0 |
  | 1 分 / 5% | 两侧各自向下取整 | 0 | 0 | 0 | **−1 分（账不平）** |
  | 7 分 / 3% | 两侧各自向下取整 | 0 | 6 | 6 | **−1 分（账不平）** |
  | 100 分 均分 1:1:1 | 各自向下取整 | 33/33/33 | | 99 | **−1 分** |
  | 100 分 均分 1:1:1 | 最大余数法 | 34/33/33 | | 100 | 0 |

  「各自向下取整」是**最自然**的写法，也是**唯一会把账做平不了**的写法。规则必须先定，它是产品决定（见 §H）。

---

## A 钱的表示法、单位与拆分

### A.1 设计说了什么、仓库里已有什么

| 来源 | 内容 |
|---|---|
| 设计 §5.3:236 | 「所有金额字段为 `bigint`，单位「分」，**币种字段预留**（MVP 单一币种 CNY）」 |
| 设计 §8.1 | 五种账户：`USER_AVAILABLE` / `USER_FROZEN` / `PLATFORM_ESCROW` / `PLATFORM_REVENUE` / `EXTERNAL_TOPUP`；「1 积分 = 1 元」 |
| P0 C3 | 金额一律 `bigint`，单位「分」，禁浮点 |
| `packages/shared/src/index.ts:10,13` | `export type Cents = bigint` / `export type Currency = 'CNY'` |
| 现实 | `apps/api/prisma/schema.prisma` 里**没有任何金额列、也没有 currency 列**（`grep` 五个 model 全部读过） |

⇒ 「币种字段预留」今天只是 `@vca/shared` 里的一个**类型别名**，数据库里没有对应列。这与 C16「不建空抽象」直接张力（见 §H 问题 1）。

### A.2 Prisma 7.10.0 的类型映射（实测）

探针：`%TEMP%\p2-probe-db\p2db.test.mts`（A1–A3），跑法见 §B.0。

```
A1 写入 9007199254740993n → 读回 9007199254740993n typeof = bigint 无损 = true
A1 写入 -1234567890123456789n → 读回 -1234567890123456789n 无损 = true
A1 $queryRaw bigint → 9007199254740993n typeof = bigint
A1 写入 1.5 → 拒绝: PrismaClientValidationError
A1 SELECT 12.5::numeric::bigint = 13n  / 13.5 →  14n （Postgres 静默取整，不是报错）
A2 NUMERIC(20,4) 读回 = 9007199254740993.0001 构造函数 = Decimal2
A2 JSON.stringify(balanceNum) = {"v":"9007199254740993.0001"}
A2 ⚠️ JSON.stringify(bigint) 抛错: TypeError Do not know how to serialize a BigInt
A3 3,000,000,000 写入 int4 列 → 拒绝: PrismaClientKnownRequestError code = P2020
   "Value out of range for the type: value \"3000000000\" is out of range for type integer"
```

两条要点：

1. `bigint` 路线**无损且类型正确**；`int4` 的溢出在 Prisma 层是 `P2020`（响亮失败，不是静默截断）。
2. **`JSON.stringify(bigint)` 抛错**意味着余额/金额**不能直接放进 HTTP 响应体**——这是 P2 的第一条 API 契约，且它是一条会在「第一次返回余额」时立刻炸的错误。

### A.3 浮点会怎么坏（实测）

```
A4b 0.1 + 0.2 = 0.30000000000000004  等值 = false
A4b 十次 += 0.1 = 0.9999999999999999  等值于 1 = false
A4b 1000 次 += 0.01 = 9.999999999999831  差 = -1.69e-13
A4b 9007199254740993 === 9007199254740992 → true（两个不同的整数在 IEEE754 下是同一个数）
A4b 1,000,000 分 ÷ 3 = 333333.3333333333
A4b 2^53 = 9007199254740991
```

### A.4 舍入与拆分（这是本节真正的判据）

`A5b` 的输出已在 §0.5 表格里。探针同时证明**最大余数法（largest remainder）**能守恒：

```
A5b 100 分按 1:1:1 均分：各自向下取整 = 33/33/33 合计 99n | 最大余数法 = 34/33/33 合计 100n
```

> **诚实边界**：把「1000 分按 5% 拆」写进第一版探针时，两侧向下取整**恰好整除**（50 + 950 = 1000），差为 0——**那个例子什么也证明不了**。第二版换成 999 / 1 / 7 分才把丢钱暴露出来，并把这条教训写进了探针注释。**验证舍入规则必须用不能整除的数**。

### A.5 复式记账与舍入的交点

`sum(entries) = 0` 这条不变式**本身就规定了**舍入规则：任何「各部分独立取整」的方案都必须再补一笔尾差分录，或者采用「一侧取整、另一侧取差额」。前者会在账本里留下 1 分钱的调整腿（可审计但需要 `memo`），后者简单但把误差**固定**推给某一方。**这是必须在计划里写死的决定，不是实现细节。**

---

## B 复式记账不变式：能在 Postgres 里强制到什么程度

### B.0 探针跑法

```powershell
# 一次性库
docker exec infra-postgres-1 psql -U vca_owner -d postgres -c "CREATE DATABASE p2_probe OWNER vca_owner"
docker exec infra-postgres-1 psql -U vca_owner -d postgres -c "GRANT CONNECT ON DATABASE p2_probe TO app_user"

# 原生 SQL 探针（文件在 %TEMP%\p2-probe\）
Get-Content b3b-reject.sql -Raw | docker exec -i infra-postgres-1 psql -U vca_owner -d p2_probe

# Prisma 探针（用仓库自己的 vitest 跑，`--root` 指向临时目录）
node "$VITEST_MJS" run --root $env:TEMP\p2-probe-db p2db.test.mts --testTimeout=120000
```

### B.1 候选一：行级 `CHECK` —— **不可能**（实测拒绝）

```
$ ALTER TABLE ledger.entries ADD CONSTRAINT entries_balanced_check CHECK (sum(amount) = 0);
ERROR:  aggregate functions are not allowed in check constraints
psql exit=3
```

行级 `CHECK` 只能看**这一行**，而「借贷平衡」是一个跨行谓词。**实测否证，不是推理。**

### B.2 候选二：延迟约束触发器 —— **可行，且是唯一能做到「按交易、在 COMMIT 判定」的机制**

```sql
CREATE CONSTRAINT TRIGGER entries_tx_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger.entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_tx_balanced();
-- 回读：entries_tx_balanced | tgdeferrable=t | tginitdeferred=t | tgconstraint=16545
```

**接受与拒绝（实测）**：

```
===== B3a 平衡交易（应被接受） =====
BEGIN
INSERT 0 2
>>> 两条分录已 INSERT 成功（此刻还没有报错，因为触发器是 DEFERRED）
COMMIT
>>> COMMIT 成功 = 平衡交易被接受
                tx_id                 | 借贷合计 | 腿数
--------------------------------------+----------+------
 11111111-1111-7111-8111-111111111111 |        0 |    2
exit=0

===== B3b 不平衡单腿（应在 COMMIT 被拒） =====
BEGIN
INSERT 0 1
>>> INSERT 成功（单腿、不平衡）—— 行级检查此刻什么都看不见
ERROR:  23514: tx 33333333-3333-7333-8333-333333333333 借贷不平衡: sum(amount)=-7000 分录数=1
CONTEXT:  PL/pgSQL function ledger.assert_tx_balanced() line 11 at RAISE
CONSTRAINT NAME:  entries_tx_balanced
exit=3
```

**真并发下的行为（`b5-concurrency.mjs`）**：

```
场景 1：A 与 B 各写一条腿（方向相反、同一个 tx_id），A 先提交
  B COMMIT: 拒绝 [23514] tx 4444… 借贷不平衡: sum(amount)=-100 分录数=1
  A COMMIT: 拒绝 [23514] tx 4444… 借贷不平衡: sum(amount)=100 分录数=1
      ⇒ COMMIT 时刻的检查**看不到未提交的其他事务**（无脏读），谁先提交谁被拒。
场景 2：同一个 tx_id 上先写平衡的一对、再写单腿 → 第 2 笔仍被拒（sum=-500，腿数=3）
场景 3：**单腿 amount=0 → 被接受**（sum 仍为 0）
场景 4：**整个事务一条分录都不写 → 被接受**
场景 5：SET CONSTRAINTS ALL IMMEDIATE → 语句时刻即拒（23514）
场景 6：SET CONSTRAINTS ALL DEFERRED  → 恢复 COMMIT 时刻判定
```

⇒ 该机制能强制的不变式精确表述为：**「同一个 `tx_id` 上，所有已提交分录的 `amount` 之和为 0」**。它**不能**强制「这笔过账真的发生了」（空事务合法）、也不能强制「一条 0 金额的腿没有意义」。这两条只能靠**应用层断言 + 属性测试**。

### B.3 候选三：物化余额 + 行级 `CHECK`（能守住不变式 #3 的一半）

```
B6 已加 CHECK (balance_big >= 0)
B6  一笔扣款成功
B6  一笔扣款被拒: name = PrismaClientKnownRequestError | code = P2039
     meta.driverAdapterError.cause.originalCode = "23514"
     "new row for relation \"accounts\" violates check constraint \"accounts_balance_nonneg\""
B6 最终余额 = 400n （CHECK 生效：不透支）

B10 已加 CHECK (kind NOT IN ('USER_AVAILABLE','USER_FROZEN') OR balance_big >= 0)
B10 系统账户扣到负 → 被**接受**（正确：它是充值对手方，天然为负）
B10 用户账户扣成负 → 被拒: P2039 / 23514 / accounts_nonneg_by_kind
```

**条件化**是必需的：`EXTERNAL_TOPUP`（充值对手方）与 `PLATFORM_*` 这类系统账户**天然为负**（设计 §8.2 第一行 `DR EXTERNAL_TOPUP CR USER_AVAILABLE`；不变式 #3 也**只**约束用户账户）。一个无条件的 `CHECK (balance >= 0)` 会把整个充值路径钉死。

### B.4 候选四：延迟触发器的开销（实测，不是估算）

```
C18  10 条腿 → 11.4 ms  (1.14 ms/腿)
C18  50 条腿 → 11.8 ms  (0.24 ms/腿)
C18 200 条腿 → 35.5 ms  (0.18 ms/腿)
```

`AFTER ROW` 触发器在 COMMIT 时**逐行**触发（20 条腿 = 20 次聚合）。实测在 200 腿以内是近线性的（有 `entries(tx_id)` 索引），200 腿一笔 35.5 ms。⇒ 对 P2 的正常过账（2–6 腿）可忽略；**但批量过账（一次几百腿）会成为可见成本**，计划里若出现批量形态要先量。

### B.5 候选五：对账查询（不变式 #2 只能走这条路）

```
B9 200000 条分录的全表求和：11.2 ms，sum = 0
B9 （对照）一次空查询 1.6 ms
```

⇒ 全表零和**可以作为**周期性对账 / 集成测试判据（20 万行 11 ms），但**不能**做成每次提交都跑的触发器（那是 O(全表)/提交，且会把所有并发过账串行化）。而且它防不住「绕过账本直接改余额」——见 §B.7。

### B.6 append-only：双角色模型在 ledger 上**仍然适用**，但必须重新施加

**（1）属主对自己的 `REVOKE` 是空操作 —— P0 结论复验**（探针 C14）：

```
C14 属主(vca_owner) 在自己发的 REVOKE 之后 UPDATE → 成功，值 = 999n
    ← 属主的 REVOKE 是空操作（P0 结论复现）
```

**（2）新 schema 上的陷阱（探针 B7，见 §0.4）** 已实测：schema 级 `GRANT … ON ALL TABLES` 会把 `UPDATE`/`DELETE` 顺带授给新表，`app_user` 真的改写了分录；补逐表 `REVOKE` 后才拒绝，`relacl` 回到 `app_user=ar/vca_owner`。

**（3）序列不在 `ALL TABLES` 里** —— `permission denied for sequence entries_id_seq`（实测）。

**（4）真实 `vca` 库今天的权限面**（只读查询）：

```
B8 public._prisma_migrations UPDATE   = false
B8 audit.audit_logs UPDATE            = false
B8 audit.audit_logs DELETE            = false
B8 asset.ownership_history UPDATE     = false
B8 asset.ownership_history DELETE     = false
B8 asset.assets UPDATE                = true      ← 业务表，本就可写
B8 auth.users UPDATE                  = true
B8 现有 schema = asset, audit, auth, notify, public     ← **没有 ledger**
```

### B.7 **无法在数据库里强制**的不变式（明确点名）

| # | 不变式 | 为什么库里做不到 | 谁来做 |
|---|---|---|---|
| 1 | 每笔交易 Σ借 = Σ贷 | **可以**（延迟约束触发器） | DB（+ 应用侧显式断言产生稳定错误） |
| 2 | 全局 Σ 所有账户余额 = 0 | 每次提交都要全表聚合 ⇒ O(全表)/提交并串行化过账；且**防不住绕过账本的直接写**（探针里直接 `UPDATE balance` 后全库 Σ = 18014398508486383 ≠ 0，实测） | 周期性**对账任务** + 属性测试 |
| 3 | `USER_AVAILABLE/FROZEN >= 0` | **可以**（条件化行级 CHECK，探针 B6/B10）；但前提是**余额物化在一行上**且所有写入都走它 | DB |
| 4 | `Σ PLATFORM_ESCROW ≥ Σ 未结算托管义务` | **跨模块**：托管余额在 `ledger`，义务在 `exchange`/`auction`。C5 禁止跨 schema join，DB 层无从表达 | 模块间**对账接口** + 周期性对账任务（属 P3/P4，但 P2 要留出口子） |
| 5 | 账本条目 append-only | **可以**（逐表 `REVOKE` + 两个角色） | DB + CI 权限断言 |
| 6 | 「这笔过账真的写了吗 / 有没有 0 金额的腿」 | 触发器只在**有行**时触发；空事务与 `amount = 0` 都被接受（探针场景 3/4） | **只**能是应用层断言与属性测试 |
| 7 | 「所有写操作携带幂等键」（威胁 #5） | 唯一约束能防重复**插入**，但它防不住「调用方忘了传幂等键」 | 应用层 + 测试 |

---

## C 并发：冻结与释放

### C.1 隔离级别（实测）

```
C0 Prisma $transaction 内 transaction_isolation = read committed      ← 默认
C0 显式 isolationLevel:"Serializable" 内 = serializable
C0 Prisma 7 接受 RepeatableRead
```

### C.2 余额能不能为负 —— **能**（实测）

```
C1 初始 1000，两笔并发的无条件 decrement 600 → fulfilled/fulfilled 余额 = -200n
   ← ⚠️ 负数，不透支在库里没有任何强制
```

### C.3 同一笔额度会不会被冻结两次 —— **会**（实测）

```
C15 读-判断-写： F1: 冻结 600 成功 | F2: 冻结 600 成功 → 可用余额 = 400n
     （两笔共冻结 1200，但初始只有 1000）
C15 条件更新  ：影响行数 = 0/1 → 可用余额 = 400n （恰好一次成功 = 冻结 600）
```

「读-判断-写」在 READ COMMITTED 下**丢更新**：两笔都读到 1000、都通过 `>= 600` 的判断、都写回 `1000-600=400` ⇒ **同一笔额度被冻结了两次**，而库里看到的只是一次扣减。这是资金系统里最典型、也最容易在测试里被漏掉的一类缺陷（顺序执行时它完全正常）。

```
C3 T1: 成功（读到的余额 1000） | T2: 成功（读到的余额 1000）
C3 两笔各扣 600（共 1200）都"成功"了，而库里余额 = 400n ⇒ 丢更新
C4 SELECT ... FOR UPDATE： T1: 拒绝 | T2: 成功（锁内读到 1000） → 余额 = 400n     ← 行锁有效
C2 updateMany(where balance >= 600)：影响行数 = 1/0 余额 = 400n                   ← 条件更新有效
```

### C.4 SERIALIZABLE 的失败是否可重试（实测：**是**）

```
C5  拒绝: name = PrismaClientKnownRequestError | code = P2034
    meta = {"modelName":"Account","driverAdapterError":{"name":"DriverAdapterError",
            "cause":{"originalCode":"40001",
                     "originalMessage":"could not serialize access due to concurrent update",
                     "kind":"TransactionWriteConflict"}}}
C5   message = Transaction failed due to a write conflict or a deadlock. Please retry your transaction
C5  T2: 成功 → 余额 = 400n

C6（加一层 P2034 重试） T1: 拒绝（余额不足） | T2: 成功（第 1 次尝试） → 余额 = 400n  总尝试次数 = 3
```

⇒ `P2034` 是**稳定的可重试信号**（`originalCode 40001` / `kind TransactionWriteConflict`），与「余额不足」这类**业务拒绝**可以清晰区分。计划里若要选 SERIALIZABLE，重试必须是封装在 `ledger` 模块内部的、有界的、幂等的。

### C.5 幂等（威胁 #5 / §8.5）

```
C7 三次并发 create（同一幂等键） → fulfilled/rejected/rejected
C7 拒绝形态: PrismaClientKnownRequestError code = P2002
   meta.driverAdapterError.cause.originalCode = "23505"
   "duplicate key value violates unique constraint \"postings_pkey\""  constraint.index = postings_pkey
C7 表里最终行数 = 1
```

⇒ 用**主键/唯一约束**做幂等键在真并发下成立：恰好一个成功、其余得到可判别的 `P2002`（带约束名）。仓库里已有同款先例（`notify.processed_jobs` 主键即幂等键、`outbox_events.idempotency_key` 唯一）。

### C.6 延迟触发器经 Prisma 的错误形态（**计划必须知道**）

```
C8 单腿分录 INSERT 成功（回调内无异常）——检查是延迟的
C8 拒绝: name = DriverAdapterError | code = undefined
C8  message = tx 230f3467-… 借贷不平衡: sum=-500 腿数=1
C8  cause = 同一个 message

C8b 构造函数 = DriverAdapterError
C8b 自有键 = name, cause
C8b code = undefined
C8b cause 自有键 = originalCode, originalMessage, kind, code, severity, message, detail, column, hint
      cause.originalCode = "23514"   cause.kind = "postgres"   cause.code = "23514"
```

对照：**即时** CHECK 违反走的是另一条路（`PrismaClientKnownRequestError` / `P2039`，带 `meta.modelName`）。

⇒ 结论（写进计划）：**不要把「捕获延迟触发器异常」当作账本的主错误通道**。正确形状是：

1. 过账函数在**自己算完余额之后、提交之前**做一次显式平衡断言，抛**领域错误**（稳定、可测、可映射到 HTTP）；
2. 延迟触发器是**回退防线**，测试里用「绕过应用直接写分录」来证明它真的会拒绝（否则这条防线永远不会被行使——它只在应用出 bug 时才触发）。

### C.7 `SET CONSTRAINTS ALL IMMEDIATE` 作为工具（实测可用）

```
C9b SET CONSTRAINTS ALL IMMEDIATE 返回 = 0        ← $executeRaw 模板标签可以发出（C9 lint 不禁它）
C9b 失败: P2039 … Database error. Code: `23514`. Message: `tx … 借贷不平衡: sum=-500 腿数=1`
C9c 原生 pg 客户端：SQLSTATE = 23514 | constraint = entries_tx_balanced
```

⇒ `$executeRaw\`SET CONSTRAINTS ALL IMMEDIATE\`` **能跑**（不会被驱动器的扩展协议挡住，也不触发 C9 lint 的 `$executeRawUnsafe` 禁令），且能把检查提前到语句时刻。但实测它把**多语句过账**变成「每条语句都必须自平衡」——对账本**不适用**。它的正确用途是**测试**：想在单测里立刻看到不平衡，不必等到提交。

### C.8 账户行不存在时的并发（P2 是否必须保证注册即建账户）

```
C17 并发 ensure-account（FOR UPDATE 挡不住不存在的行）：
    T1: 新建
    拒绝: PrismaClientKnownRequestError P2002
C17 该账户最终行数 = 1

C19 三次并发 upsert(ON CONFLICT DO NOTHING) → fulfilled/fulfilled/fulfilled
    影响行数 = 1/0/0    最终行数 = 1
```

`SELECT … FOR UPDATE` **锁不住不存在的行**（没有行可锁），两个并发「没有就建」会撞唯一约束。race-free 的两条路：`INSERT … ON CONFLICT DO NOTHING`（实测三次并发 → `1/0/0`），或**在注册时就把账户建出来**。后者有一个 C5 边界问题：`auth` 模块不能直接写 `ledger` 的表——必须经 `ledger` 的显式接口，且注册目前**不是事务**（`auth.service.ts:101-117`：`user.create` → `sessions.create` → `audit.record` 三步分离）。见 §H 问题 2。

### C.9 审计与账本的原子性（P0 自己把这条留给 P2）

`apps/api/src/modules/audit/audit.service.ts:64-66` 原文：

> **持久修法在 P2**：让审计行加入业务事务（在有事务的地方）…… **复访触发条件：P2 账本落地时**——那是第一个审计必须与业务同生共死的地方

而签名是 `record(input: AuditRecordInput): Promise<void>`（`:72`）——**没有 `tx` 参数**（对照 `OutboxService.publish(tx, msg)` **有**，见 `notify/outbox.service.ts:42`）。设计 §13.2 要求「审计日志可完整重建任一次资金变动的链路」。

机制演示（探针 C16，在一次性库里用两张表模拟）：

```
C16 账本事务因借贷不平衡被回滚
C16 回滚之后 auditprobe.logs 里的行数 = 1 ← ⚠️ 审计说「发生过」，账本说「没发生」
C16 对照：同事务写入时，回滚后行数 = 0 ← 审计与账本同生共死
```

⇒ P2 必须改 `AuditService.record()` 的签名（加可选 `tx`），这是一处**跨模块接口改动**，会碰到 P0 的代码与既有调用点。

### C.10 双锁（P3）与保证金（P4）对 P2 的要求

设计 §2.1 的 P2 行只写了「复式记账、不变式校验、额度发放、冻结与释放、属性测试」。据此读 §6.3 与 §7.1：

- **双锁**是 `SwapContract.PENDING_BOTH_LOCK` 的**状态机**（P3 的实体），它需要的是「冻结不释放、双方各自确认」——机械上只用到 P2 的 `freeze` 原语，**锁的记录属于 exchange**（C5：P2 不能替 P3 建表）。
- **保证金**的**金额规则**（新账号 10%、信誉分 ≥60 老账号 5%、单笔上限 5000 元、低分翻倍）是 P4 的业务规则，且依赖 `auth.users.credit_score`（已存在）。P2 只应提供冻结原语，**不应**把百分比/阈值写进 ledger（C16）。
- **补差**（§6.4）与**争议期**（§8.4「争议期间全额冻结」）在机械上都只需要 `USER_AVAILABLE ↔ USER_FROZEN ↔ PLATFORM_ESCROW` 之间的过账 —— 但**触发时机**（7 天自动确认、争议冻结）是 `exchange`/`dispute` 的状态机 + worker 定时任务。
- 设计 §5.1 把 `EscrowRecord（托管，由账本驱动）` 画在 **`Order` 下面**——即 P3/P4 的实体。**P2 到底要不要建 `EscrowRecord` 表**是一个范围问题（§H 问题 3）。

⇒ **建议（供计划参考，不是验证结论）**：P2 交付「账户 + 分录 + 过账函数 + 冻结/释放原语 + 幂等 + 不变式强制 + 属性测试」，**不**交付任何业务状态机、任何百分比规则、任何托管记录表。

---

## D 属性测试

### D.1 库的选择：**fast-check**，但它在 lockfile 里的存在会骗人（P1 §8 的同款陷阱）

```
$ node -e "require.resolve('fast-check', {paths:['apps/api/src']})"
api fast-check ->  MODULE_NOT_FOUND      （root / tests / worker 同样 MODULE_NOT_FOUND）

$ Select-String pnpm-lock.yaml -Pattern 'fast-check'
pnpm-lock.yaml:1651:  fast-check@3.23.2:
pnpm-lock.yaml:4272:      fast-check: 3.23.2
pnpm-lock.yaml:4439:  fast-check@3.23.2:

$ 依赖它的包：
  effect@3.20.0:
    dependencies:
      '@standard-schema/spec': 1.1.0
      fast-check: 3.23.2
```

`node_modules/.pnpm/fast-check@3.23.2` **真实存在**，`pnpm-lock.yaml` 里也有匹配——但它是 **Prisma 的传递依赖**（`effect` 的），**四个 workspace 包一个都 `import` 不到**。这正是 P1 预检 §8 记下的教训：**判断依赖可用性一律以 `require.resolve` 为准，不以目录存在为准**。而且它已经过期（3.23.2），P2 要装的是 4.x。

### D.2 在仓库**之外**的抛掷目录里实测安装与运行

```
$ pnpm add -D vitest@5.0.3 fast-check @fast-check/vitest typescript@6.0.3
devDependencies:
+ @fast-check/vitest 0.5.0
+ fast-check 4.10.2
+ typescript 6.0.3 (7.0.2 is available)
+ vitest 5.0.3
Done in 9s using pnpm v11.24.0
```

peer / engines 实测：`@fast-check/vitest@0.5.0` 的 `peerDependencies.vitest = "^4.1.0 || ^5.0.0"`（**兼容 5.0.3**）；`fast-check@4.10.2` 的 `engines.node = ">=12.17.0"`（**不抬高本仓 22.19 的下限**，与 `testcontainers` 那条 override 的理由不同）。

### D.3 与 Vitest 5.0.3 的协作（实测两种形态都能跑）

```
$ pnpm exec vitest run
 ✓ ledger.test.ts (5 tests) 99ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

`fc.assert(fc.property(...))` 与 `@fast-check/vitest` 的 `fcTest.prop([...])(name, fn)` 两种写法都跑通（含 `numRuns` 选项）。

### D.4 反例缩小（shrinking）输出可用（实测）

故意写一个有缺陷的「手续费拆分」（两侧各自向下取整）：

```
$ pnpm exec vitest run shrink.test.ts
 ❯ shrink.test.ts (1 test | 1 failed) 14ms
 FAIL  shrink.test.ts > 手续费拆分必须保持借贷平衡
 Error: Property failed after 1 tests
 { seed: 1304539940, path: "0:0:0", endOnFailure: true }
 Counterexample: [1n,1n]
 Shrunk 2 time(s)
 Caused by: AssertionError: expected 0n to be 1n
```

`[1n, 1n]` —— 即「金额 1 分、费率 1 个基点」，**最小值反例**，直接指出缺陷成因（`1 * 1 / 10000 = 0`）。**输出足以定位，不需要人工再猜。**

### D.5 CI 预算：设计要求的「≥10 万次」要跑多久（实测）

```
D2 numRuns=10000  每序列过账笔数=20  →   155 ms  ( 64310 次/秒, 总腿数≈400000)
D2 numRuns=100000 每序列过账笔数=20  →  1230 ms  ( 81277 次/秒, 总腿数≈4000000)
D2 numRuns=100000 每序列过账笔数=100 →  5653 ms  ( 17689 次/秒, 总腿数≈20000000)
```

两条计划必须知道的：

1. **`numRuns` 的语义是「属性的运行次数」**，不是「操作总数」。100k × 20 笔 = 1.2 秒（可接受），100k × 100 笔 = 5.7 秒。规格写「≥10 万次随机操作序列」时必须把**每序列的操作数**一起定下来，否则预算差 5 倍。
2. **vitest 默认 `testTimeout = 5000` 会把第三种情形打红**——实测第一次运行就是 `Error: Test timed out in 5000ms`。仓库的 `vitest.config.ts` 已经给 `property` project 设了 `testTimeout: 300_000`（**已存在，无需新增**），但**任何一条属性用例本身都必须显式给 timeout 或依赖该配置**；这条在今天的仓库里是「配好了但没有任何用例行使过」——P2 是第一个行使者。

### D.6 TypeScript 6.0.3 的类型兼容（实测）

```
$ pnpm exec tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck ledger.test.ts
tsc exit=0
```

⇒ fast-check 4.10.2 的类型在 **TS 6.0.3** 下干净通过（C8 的版本锁定不需要变动）。

### D.7 属性测试能防什么、不能防什么

- **能**：账本纯逻辑的不变式（Σ=0、非负、幂等、拆分守恒、随机操作序列后的状态一致性）——**快、覆盖广、能缩小反例**。
- **不能**：上面所有**并发**结论（§C）。属性测试是单线程的；`README` 式的「N 个并发出价无超卖」必须靠**真并发**容器测试（设计 §12 已经这么写）。P2 的计划不要把并发不给 PBT。
- **不能**：DB 层的强制点是否真的存在。属性测试断言的是**模型**，不是**约束**。触发器/CHECK/REVOKE 三条都必须有**独立**的、会对着真库跑的用例（P1 的 `tests/integration/db/append-only.test.ts` 是现成范式）。

---

## E 可能推翻 P2 计划的机械假设

### E.1 设计 §2.1 的 P2 行与 §5/§8 里所有机械假设

| # | 假设（计划会依赖它） | 探针结论 |
|---|---|---|
| 1 | 金额可以用 `bigint`「分」表示，Prisma 7.10.0 无损映射 | **成立**（A.2） |
| 2 | 行级约束/CHECK 能表达「每笔借贷平衡」 | **不成立**（B.1）——必须延迟约束触发器 |
| 3 | 延迟约束触发器能在 COMMIT 拒绝不平衡 | **成立**，且并发下无脏读（B.2） |
| 4 | 不平衡拒绝会以一个稳定的 Prisma 错误码出现 | **不成立**（C.6：`DriverAdapterError`，`code` 为 `undefined`） |
| 5 | 余额非负可以靠「应用层判一下」 | **不成立**（C.2/C.3：可扣成 −200、冻结两次） |
| 6 | Prisma 的默认隔离级别足以支撑冻结/释放 | **不成立**（C.1：READ COMMITTED）——必须显式选机制 |
| 7 | SERIALIZABLE 的失败是可重试的 | **成立**（C.4：`P2034`/`40001`） |
| 8 | 幂等键（唯一约束）能防重复过账 | **成立**（C.5：`P2002`/`23505`） |
| 9 | 新建 `ledger` schema 后 append-only 自动成立 | **不成立**（B.6：schema 级 GRANT 顺带授权；序列还要单独授权） |
| 10 | 属主的 `REVOKE` 无效（双角色是必需的） | **成立且复验**（B.6） |
| 11 | 设计要求的属性测试已经有执行点 | **不成立**（§0.1） |
| 12 | 审计可以与账本同生共死 | **今天不成立**（C.9：`AuditService.record()` 无 `tx`；P0 自己把修法留给 P2） |
| 13 | worker 侧也有运行期角色校验 | **不成立**（E.3） |
| 14 | 「币种字段预留」已有字段 | **不成立**（A.1：只有类型别名，库里无列） |
| 15 | 舍入规则已在设计里定好 | **不成立**（A.4/§0.5：设计只给了 5% 费率） |
| 16 | 拆分后账本仍然平衡是「自然」的 | **不成立**（A.4：两侧各自向下取整会丢 1 分） |

### E.2 P1/P0 留给 P2 的东西：哪些够用、哪些不够

**够用**（已存在，可直接消费）：

- `auth.users`（含 `credit_score`，`@default(100)`）与 UUIDv7 主键约定（C4）；
- `@vca/shared` 的 `Cents = bigint` / `Currency = 'CNY'`；
- `OutboxService.publish(tx, msg)` —— **已强制要求传事务客户端**，P2 的账本事件可以直接用（`notify/outbox.service.ts:42`）；
- 双角色模型 + `infra/db/apply-grants.sql` + `tests/integration/db/append-only.test.ts` 的范式（P2 照抄即可）；
- `assertRuntimeDbRole`（`apps/api/src/db/runtime-role.ts`）在 API 引导期生效（`bootstrap.ts:212`）；
- `vitest.config.ts` 的 `property` project 已存在且已设 `testTimeout: 300_000`。

**不够用**（P2 必须补，且部分是**改既有文件**）：

| 缺口 | 位置 | 影响 |
|---|---|---|
| **属性测试没有执行点** | `.github/workflows/ci.yml`（零匹配）、`scripts/assert-tests-ran.mjs:57-76`（GATES 无 property）、`tests/property/`（不存在） | 设计 §13.3 的验收判据今天无法被满足 |
| `apply-grants.sql` 没有 `ledger` 段 | `infra/db/apply-grants.sql`（`GRANT USAGE` 只列了 4 个 schema） | 不补则 `app_user` 对账本表零权限 |
| CI 权限断言不含 ledger | `.github/workflows/ci.yml:97-108`（只查 auth/audit 五项，连 `asset.ownership_history` 都不查） | append-only 无 CI 见证 |
| `AuditService.record()` 无 `tx` | `modules/audit/audit.service.ts:72` | 审计与账本不能同生共死（§C.9） |
| worker 无运行期角色校验 | `apps/worker/src/main.ts`（`bootstrap()` 里没有 `assertRuntimeDbRole`） | 见 E.3 |
| 金额 DTO 契约不存在 | 无 | `number` 可溜进 `bigint`（A.2/A.3）；`JSON.stringify(bigint)` 会炸 |
| 没有幂等表 | 无 | §8.5 要求的「每个 Worker 任务有幂等键」在 ledger 侧没有载体（`notify.processed_jobs` 属 notify） |
| `modules/` 下没有 `ledger` | `apps/api/src/modules/` = asset, audit, auth, health, notify | 全新模块 |
| `CreatorProfile` 表不存在 | 设计 §5.1 列了它；P0 把它扁平化成了 `auth.users` 的列 | 不影响 P2，但「信誉分/限额」的落点与设计图不一致，值得记一笔 |

### E.3 worker 侧运行期角色校验：设计说了、P1 没做（**实测**）

设计 §14 的延后决策表原文：「**P1 应补 worker 侧同一校验**」。实测：

```
$ Select-String apps\worker\src\main.ts -Pattern 'assertRuntimeDbRole'   → 无匹配
$ Get-ChildItem apps,packages -Recurse -Include *.ts | Select-String 'assertRuntimeDbRole'
   apps\api\src\bootstrap.ts:11   import { assertRuntimeDbRole } from './db/runtime-role.js';
   apps\api\src\bootstrap.ts:212  await assertRuntimeDbRole(app.get(PrismaService), {
   + runtime-role.ts 自身的定义与文档
```

**为什么这对 P2 特别要命**：P2 的结算与超时释放跑在 **worker** 里（设计 §3.1「Worker 进程：结算 · 超时过期 · 反狙击计时 · outbox 消费」）。若 worker 被以属主角色启动，`REVOKE UPDATE, DELETE` 对账本重新变成**空操作**（B.6 已复验），而 `runtime-role.ts` 自己的注释把后果说得比我说得更准：

> 任何一次部署把 `DATABASE_URL` 指成属主…… **append-only 的 REVOKE 就重新变成空操作**……此时**所有测试仍然全绿**。

⇒ 这是 P2 之前必须补的一处（一条几行的改动 + 一条用例），否则「账本 append-only」在**唯一的自动结算进程**上是不成立的。

### E.4 「声明了但未强制」清单（每条：谁强制、怎么验的）

| 声明 | 今天谁强制 | 怎么验的 |
|---|---|---|
| 不变式 #5 append-only（**新** ledger 表） | **无人** —— 必须新增逐表 `REVOKE`；schema 级 GRANT 会顺带授权 | 实测 `has_table_privilege=true` 且 app_user 真的改写了值（B.7） |
| 不变式 #5 append-only（现有 audit / ownership_history） | DB 权限 + 集成用例 + （audit 的）CI 断言 | 只读查询实测 `UPDATE/DELETE=false`（B.6） |
| 不变式 #1 借贷平衡 | **今天无人**；延迟约束触发器**可以**成为执行者 | 接受/拒绝都实测（B.2） |
| 不变式 #3 不可透支 | **今天无人**；条件化 `CHECK` 可以 | 实测扣成 −200（C.2），加 CHECK 后拒绝（B.6/B.10） |
| 不变式 #2 零和 | **今天无人**，且只能是对账任务 | 全表求和 11.2 ms/20 万行（B.5）；直接改余额后 Σ≠0（B.7 旁的实测） |
| 不变式 #4 托管不透支 | **今天无人**（跨模块，P3/P4 才成形） | 设计 §8.3 列为不变式，但没有执行者，C5 也禁止跨 schema 表达 |
| 「≥10 万次属性测试」 | **无人**（CI 不跑、无下限、目录不存在） | `ci.yml` 零匹配 + `Test-Path=False` + 空 project `exit 0`（§0.1） |
| C3「禁浮点」 | TS 类型层（编译期）；**运行期对整数型 `number` 不设防** | `JSON.parse` 丢 1 分后写库成功且无异常（A.2） |
| 威胁 #5「所有写操作携带幂等键」 | 唯一约束能防重复插入，**防不住漏传** | 三次并发 → `1 成功 / 2 个 P2002`，最终 1 行（C.5） |
| 运行期角色必须是 `app_user`（API） | `bootstrap.ts:212` 启动期拒绝服务 | 代码核对 + P0 用例 |
| 运行期角色必须是 `app_user`（**worker**） | **无人** | 实测 `main.ts` 无该调用（E.3） |
| 「审计可重建任一次资金变动」 | **无人**：`record()` 无 `tx`，账本回滚后审计行仍在 | 机制实测（C.9） |

---

## F 对计划的直接影响（必须体现在 P2 计划里）

1. **先补门，再写账本**：`tests/property/` 落地 + `assert-tests-ran.mjs` 的 `GATES` 加 `property: <下限>` + CI 增加一步。否则 §13.3 无判据。（§0.1）
2. **钱的表示法**：`bigint`「分」，Prisma `BigInt`；HTTP 边界**显式** string↔bigint（`JSON.stringify(bigint)` 会抛 `TypeError`）；入参用 zod 校验「十进制整数字符串」，禁止 `number` 直达服务层。（A.2）
3. **舍入规则必须先定死**，且属性测试要有一条「任意金额 × 任意费率，拆分前后守恒」的用例（D.4 的 `[1n,1n]` 就是它的最小反例）。（A.4/§0.5）
4. **不变式 #1 用延迟约束触发器**（迁移里手写 SQL；`prisma migrate` 只能 `--create-only`）+ **应用侧显式断言**产生稳定领域错误。两者的分工必须写清，且**两条都要有会红的用例**。（B.2/C.6）
5. **不变式 #3 用条件化 `CHECK`**（`kind NOT IN ('USER_AVAILABLE','USER_FROZEN') OR balance >= 0`），不要写成无条件。（B.3）
6. **冻结/释放的并发机制三选一并写进计划**：条件 `updateMany` / `SELECT … FOR UPDATE` / `SERIALIZABLE + P2034 重试`。默认的 READ COMMITTED **不够**。（C.1–C.4）
7. **幂等键 = 唯一约束**（表内主键或唯一索引），重复得到可判别的 `P2002`；**不要**用 `upsert` 静默去重（P0 的 `OutboxService` 已经立了同款规矩）。（C.5）
8. **`apply-grants.sql` 加 `ledger` 段**：`GRANT USAGE ON SCHEMA ledger`，业务表可读写，`ledger_entries`/对账表**逐表** `GRANT SELECT, INSERT` + `REVOKE UPDATE, DELETE`；若任何表用自增主键，还要 `GRANT USAGE ON SEQUENCES`。（B.6/B.7）
9. **CI 权限断言扩到 ledger**（并顺手补上 P1 漏掉的 `asset.ownership_history`）。（E.2）
10. **`AuditService.record()` 加 `tx` 参数**（可选参数，默认仍用自己的客户端），账本路径传事务客户端。（C.9）
11. **补 worker 侧 `assertRuntimeDbRole`**（设计 §14 已点名，P1 未做）。（E.3）
12. **账户创建策略要定**（注册即建 vs 惰性 `ON CONFLICT DO NOTHING`）；`SELECT … FOR UPDATE` 锁不住不存在的行。（C.8）
13. **属性测试只覆盖纯逻辑**；并发与 DB 约束各自要真库用例。（D.7）
14. **不要替 P3/P4 建业务状态机、百分比规则或托管记录表**（C.10，C16）。

---

## G 未能验证的面（据实记载）

1. **争议期（7 天自动确认）的计时器**：属 worker 的定时任务，P2 只提供过账原语。本轮**没有**验证 worker 的定时/重试机制能否承载「7 天后自动释放」，因为设计把它归在 P3/P4。
2. **`prisma migrate` 对「手写 SQL 迁移」的验证强度**：P1 台账记过「全新库上 `migrate deploy` 不校验被改过的迁移文件」，以及仓库里有一对 `migrate diff` 作为真正的保护。本轮**没有**实测「手写的 `CREATE CONSTRAINT TRIGGER` 会不会被 `migrate diff` 判成漂移」——这条会在 P2 第一次写非 Prisma 可表达的 DDL 时立刻变成问题，建议实现第一步就验。
3. **`BigInt` 在 NestJS 响应序列化链路上的具体行为**：只验了 `JSON.stringify(bigint)` 抛 `TypeError`，**没有**跑通一个真实 HTTP 路由返回余额。拦截器/`class-transformer` 是否会先转换、抛出的会是 500 还是 200 里的空字段，未测。
4. **`SERIALIZABLE` 在高并发（>2 连接）下的重试风暴**：只跑了 2 并发的确定性场景，没有压测。计划的「有界重试」参数需要另一次测量。
5. **`@fast-check/vitest` 的 `test.prop` 与仓库 vitest project 配置（`property` / `setupFiles` / `globalSetup`）的完整接线**：探针用的是独立的最小 vitest 配置，**没有**在仓库的 `vitest.config.ts` 下跑过。装进仓库后第一次运行要重新验一遍（P1 §8 的教训：探针环境与仓库环境的差异本身就是一个坑）。
6. **跨 schema 的 `ledger` ↔ `exchange`/`auction` 对账接口**（不变式 #4）：没有验证任何实现形态，因为它的两端都还不存在。

---

## H 给控制器的开放问题（产品/设计判断，不是机械事实）

1. **币种列要不要现在加？** 设计 §5.3 说「币种字段预留（MVP 单一币种 CNY）」，C16 说「不建空抽象」。实测：库里现在没有 currency 列，`@vca/shared` 只有一个类型别名。加了它，每笔过账的平衡检查要按 `(tx_id, currency)` 分组（延迟触发器的聚合条件随之改变）；不加，则未来多币种是一次**改账本表结构**的迁移。**这是产品对未来市场的判断，不是验证能回答的。**
2. **账户在什么时候创建？** 三个选项：① 注册时建（`auth` 必须经 `ledger` 的接口、且注册目前不是事务，见 C.8/C.9）；② 首次过账时 `ON CONFLICT DO NOTHING`；③ 管理员发放额度时才建。选项 ② 之后「没有账户行」与「余额为 0」是两种状态，`getBalance` 必须定义返回什么。
3. **P2 要不要建 `EscrowRecord`？** 设计 §5.1 把它画在 `Order` 下面（P3/P4），但 P2 的名字就叫「账本与**托管**」。P2 只交付过账原语，还是也交付托管记录表 + 生命周期？
4. **舍入规则的归属方**：5% 手续费在不能整除时，那 1 分给平台还是给卖家？均分场景用最大余数法（误差分散）还是固定归一侧（可预测）？补差（§6.4）适用同一条规则吗？——**这是产品规则，规格里没有。**
5. **金额在 API 上的编码**：字符串（`"1234"`，无损但前端要处理）还是数字（前端自然，但超过 2^53 会静默出错，且与「benefit 不牺牲」的 §1.2 有张力）？若选数字，需要写下**明确的金额上限**并在 DTO 层强制。
6. **属性测试的门槛与预算**：`numRuns` 与「每序列操作数」各是多少（实测 100k×20 = 1.2s，100k×100 = 5.7s）？`GATES` 里 property 的下限登记多少条？——这决定了 CI 时长与这条门的强度。
7. **`AuditService.record()` 的签名改动归谁**：它是 P0 的代码、P1 的资产，P2 的必需前置。放在 P2 的第一个任务里，还是单独一次「P0 补丁」？
8. **worker 侧的运行期角色校验**：设计 §14 说「P1 应补」，P1 没补。是作为 P2 的前置任务，还是作为一次独立的 P1 欠账修复？
9. **P2 是否需要「额度发放」的管理入口？** §2.1 的 P2 行明确写了「额度发放」，设计 §8.1 说 `EXTERNAL_TOPUP`「MVP 由管理员发放虚拟额度」。这意味着 P2 需要一条**管理员路由**（含 `PolicyGuard` 声明、限流层、越权矩阵用例、审计），而不只是一个内部函数。这条路由的权限、限额、幂等语义需要控制器的明确裁定。

---

## 附：探针文件清单（一次性，不在仓库内）

| 文件 | 内容 |
|---|---|
| `%TEMP%\p2-probe\b1-schema.sql` / `b2-deferred.sql` / `b3a-accept.sql` / `b3b-reject.sql` | 行级 CHECK 否证、延迟约束触发器、接受/拒绝 |
| `%TEMP%\p2-probe\b5-concurrency.mjs` | 延迟触发器在真并发下的六个场景 |
| `%TEMP%\p2-probe-db\p2db.test.mts` | A1–A5、C0–C14（类型映射、浮点、隔离级别、冻结、幂等、错误形态） |
| `%TEMP%\p2-probe-db\p2db2.test.mts` | A4b/A5b（重做的浮点与舍入）、B6/B7/B8（CHECK、授权陷阱、真实库权限面）、C8b/C9b/C9c、B9 |
| `%TEMP%\p2-probe-db\p2db3.test.mts` | A6（`number` 溜进 bigint）、C15（重复冻结）、C16（审计原子性）、C17（并发建账户） |
| `%TEMP%\p2-probe-db\p2db4.test.mts` | A6b（丢 1 分的量化） |
| `%TEMP%\p2-probe-db\p2db5.test.mts` | B10（条件化非负 CHECK）、C18（触发器开销）、C19（race-free 建账户） |
| `%TEMP%\p2-probe-pbt\*.test.ts` | D1–D6（fast-check 安装、运行、shrink、预算、tsc、空 project 退出码） |
