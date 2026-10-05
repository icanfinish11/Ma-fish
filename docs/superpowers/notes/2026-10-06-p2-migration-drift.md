# P2 手写 DDL 与 `prisma migrate diff` 的漂移判定（2026-10-06 实测）

> **谁该读这份文件**：P2 / Task 4（`ledger` schema、迁移、授权、数据库强制点）。它决定 Task 4 的
> `migration.sql` 头部注释写什么、CI 里那条零漂移门该不该加、以及**那条门到底证明了什么**。
>
> **为什么有这份文件**：预检 §G.2 明确记载「本轮**没有**实测手写的 `CREATE CONSTRAINT TRIGGER`
> 会不会被 `migrate diff` 判成漂移——这条会在 P2 第一次写非 Prisma 可表达的 DDL 时立刻变成问题，
> 建议实现第一步就验」。本文件就是那次验证。**Task 1 计划里 ②③④ 三步的原始输出逐字抄在下面。**
>
> **结论一句话**：差值**为空**（可加零漂移门），但**门看不见手写 DDL**——它与手写对象是否存在
> **无关**。计划原文「手写 DDL 从此有机器见证」这一句被测**证伪**。

---

## 0. 探针环境

| 项 | 值 |
|---|---|
| 被验对象 | `feat/p2-ledger` / HEAD `2c2fe81`（P1 合并完成） |
| Prisma | 7.10.0（C8 锁定版本） |
| 数据库 | 项目自己的 `postgres:16-alpine`（容器 `infra-postgres-1`，30 小时 healthy） |
| 一次性库 | `p2_drift`（`CREATE DATABASE p2_drift OWNER vca_owner`），探针结束后已 `DROP DATABASE` |
| 迁移 | `MIGRATE_DATABASE_URL=postgresql://vca_owner:owner_pw@127.0.0.1:5432/p2_drift` + `pnpm --filter @vca/api db:migrate:deploy` → **3 个迁移全部成功**（`20261004104254_p0_identity_audit_outbox` / `20261004133000_outbox_abandoned_at` / `20261005120609_p1_asset`） |
| 仓库改动 | **零**：`prisma/schema.prisma` 未被改动（③ 用的是一份 `%TEMP%` 里的副本，见下） |
| 原始输出留档 | `.superpowers/sdd/2026-10-06-p2-ledger/evidence/t1-step0-*.txt` |

**先记一条计划原文的笔误**：计划 Step 0 的探针 SQL 直接写 `CREATE TABLE IF NOT EXISTS ledger.probe_entries`，
但**库里没有 `ledger` schema**（预检 §B.8 已实测：现有 schema = `asset, audit, auth, notify, public`），
原样执行会以 `ERROR: schema "ledger" does not exist` 失败。本探针在最前面补了一行
`CREATE SCHEMA IF NOT EXISTS ledger;`——这也正是 Task 4 迁移要做的第一件事。

---

## 1. ① 基线：迁移后、任何手写 DDL 之前

```
$ pnpm --filter @vca/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
Loaded Prisma config from prisma.config.ts.

-- This is an empty migration.

（退出码 0）

$ pnpm --filter @vca/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
Loaded Prisma config from prisma.config.ts.

No difference detected.

（退出码 0）
```

**这是后面每一条对照的基准**：三个迁移跑完的库与 `schema.prisma` **完全一致**。

---

## 2. ② 计划原文的探针：往库里加一整套手写 DDL

追加的 DDL（与 Task 4 要写的那三类同形：函数 + 约束触发器、非零 `CHECK`）**逐字执行、全部成功**：

```
CREATE SCHEMA
CREATE TABLE
CREATE FUNCTION
CREATE TRIGGER
ALTER TABLE
psql-exit=0
```

然后：

```
$ pnpm --filter @vca/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
Loaded Prisma config from prisma.config.ts.

-- This is an empty migration.

（退出码 0）

$ pnpm --filter @vca/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
Loaded Prisma config from prisma.config.ts.

No difference detected.

（退出码 0）
```

### ⇒ 这个「空」是**假的**，原因不在手写 DDL

`ledger` 这个 schema **不在 `datasource.schemas` 里**（`apps/api/prisma/schema.prisma:24`：
`schemas = ["auth", "audit", "notify", "asset"]`），而 `migrate diff --from-config-datasource`
**只内省受管 schema**——它自己在输出里就把范围说出来了：

```
Datasource "db": PostgreSQL database "p2_drift", schemas "asset, audit, auth, notify" at "127.0.0.1:5432"
```

所以 ② 的「空」只说明**`ledger` 整个 schema 对这条门是不可见的**，与手写 DDL 无关。
**若照计划原文在 Task 4 里直接加这条门、却忘了把 `ledger` 加进 `schemas`，它会绿着放行
一个连表都丢了的账本**——正是本项目反复抓到的那类「声明了但未强制」。

---

## 3. ③ 决定性的探针：把 `ledger` 纳入受管 schema，并声明对应的 model

`%TEMP%\p2-drift\probe.prisma` = `schema.prisma` 的完整副本，只改两处：

```diff
-  schemas  = ["auth", "audit", "notify", "asset"]
+  schemas  = ["auth", "audit", "notify", "asset", "ledger"]
```

```prisma
model ProbeEntry {
  id     String @id @db.Uuid
  txId   String @map("tx_id") @db.Uuid
  amount BigInt

  @@schema("ledger")
  @@map("probe_entries")
}
```

此时库里 `ledger.probe_entries` **仍在**，且**仍带着** §2 那段手写 DDL：plpgsql 函数
`ledger.probe_assert_tx_balanced()`、`DEFERRABLE INITIALLY DEFERRED` 的
`CONSTRAINT TRIGGER probe_entries_balanced`、`CHECK (amount <> 0)`。

```
$ pnpm --filter @vca/api exec prisma migrate diff --from-config-datasource --to-schema <tmp>\probe.prisma --script
Loaded Prisma config from prisma.config.ts.

-- This is an empty migration.

（退出码 0）

$ pnpm --filter @vca/api exec prisma migrate diff --from-config-datasource --to-schema <tmp>\probe.prisma --exit-code
Loaded Prisma config from prisma.config.ts.

No difference detected.

（退出码 0）
```

### ⇒ 结论（决定性）：`migrate diff` **完全看不见**函数 / 约束触发器 / `CHECK`

「表已建模 + schema 已受管 + 库里挂着手写触发器与 CHECK」这一组合下，差值是**空**的。
换句话说：**这条门无论手写对象在不在，都会是绿的。** 它不是手写 DDL 的见证，
它只是「Prisma 建模的那部分（表、列、索引、外键）与库一致」的见证。

---

## 4. ④ 反方向：门能不能看见对象**消失**

同一份 `probe.prisma`，`DROP TABLE ledger.probe_entries CASCADE` 之后：

```
-- CreateTable
CREATE TABLE "ledger"."probe_entries" (
    "id" UUID NOT NULL,
    "tx_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "probe_entries_pkey" PRIMARY KEY ("id")
);
```

`--exit-code` 形式：

```
[+] Added tables
  - probe_entries

[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command failed with exit code 2:
  prisma migrate diff ... --exit-code
```

**对照（同一时刻、用仓库真实 schema）**：`ledger` 不受管 ⇒ 表已经删了，依然
`No difference detected.`（退出码 0）。

⇒ 门**确实有判别力**，但**只在受管 schema 内**。

### 4.1 一条必须写进 Task 4 的实现细节：`pnpm` 会把 2 包成 1

计划 Step 0 记的退出码语义（`--help` 实测）是「空=0 / 出错=1 / **非空=2**」。
经 `pnpm --filter @vca/api exec` 调用时，**prisma 的 2 会被 pnpm 包成 1**（本探针实测：
`exitcode-exit=1`，而 stderr 里写着 `Command failed with exit code 2`）。

* 对「通过/不通过」而言没有影响（非空仍然非零）；
* 但它意味着**「非空」与「diff 出错」在 shell 里是同一个退出码**（都是 1），
  Task 4 的 CI 步骤注释不要写成「非空=2」，否则下一个人会以为能看到 2。

---

## 5. ⑤ 数据（种子行）算不算漂移 —— 不算

Task 4 要按 D2 用迁移**种子化系统账户**（`INSERT` 行）。往一张受管表插一行：

```
INSERT 0 1
$ pnpm --filter @vca/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
Loaded Prisma config from prisma.config.ts.

No difference detected.

（退出码 0）
```

⇒ 种子行不影响这条门（预期如此：schema diff 不看数据，但这是**实测**而不是推断）。

---

## 6. Task 4 该怎么做（照此执行）

| # | 动作 | 依据 |
|---|---|---|
| 1 | **加**那条零漂移门（③ 的差值为空 ⇒ 计划表里「差值非空」那一栏不适用） | ③ 实测退出码 0 |
| 2 | **前置条件**：`datasource db` 的 `schemas` 必须已经含 `"ledger"`。Task 4 本来就要加（不加则 `ledger` 根本不受迁移管理），但**两者必须在同一个提交里**——顺序反了会先绿后红 | ② 实测：`ledger` 不受管时，整个 schema 连表带触发器一起不存在也是绿的 |
| 3 | **不要**把这条门写成「手写 DDL 有机器见证了」。它的准确语义是：**「Prisma 建模对象（表/列/索引/外键）与库一致」**。手写对象的存在性它证明不了 | ③ 实测：手写函数 + 延迟约束触发器 + CHECK 全在，差值仍为空 |
| 4 | 手写对象的**存在性**仍然只能靠 Task 4 的真库断言（`pg_get_constraintdef` / `pg_trigger` / `pg_proc` 查询）+ 行为用例（不平衡过账必须被拒）。计划 Step 0 表格里「存在性断言比漂移门更直接」那句判断**依然成立**，且现在有了实测支撑 | ③ + 计划 Step 0 原文 |
| 5 | 迁移文件头部注释粘 §2/§3 的**原始输出**作为基线（本条建议在两种结论下都做——它记录的是「为什么这条门的绿不代表手写对象还在」） | ② ③ |
| 6 | CI 那条门建议写成 `pnpm --filter @vca/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`，注释里写「**非空经 pnpm 包成退出码 1**（prisma 原为 2）」 | §4.1 |

### 6.1 这条门自己的变异探针（Task 4 落地时照跑一次）

| 探针 | 预期 |
|---|---|
| 在受管 schema 里 `DROP` 一张已建模的表 | **红**（④ 实测：`Added tables - probe_entries`，退出码非零） |
| 往库里加一个**未建模**的 schema / 表 / 函数 / 触发器 / CHECK | **绿**（② ③ 实测）——这是**已知边界**，不是缺陷，但必须写在注释里，否则会被当成「门证明的东西比它实际证明的多」 |

---

## 7. 与计划原文的差异汇总（实现者须知）

1. 计划 Step 0 的探针 SQL 缺 `CREATE SCHEMA ledger;`，原样跑会失败（§0）。
2. 计划 Step 0 表格里「差值为**空** ⇒ 手写 DDL 从此有机器见证」**被证伪**：差值为空是事实，
   但「有机器见证」不成立（§3）。
3. 计划没有预料到 `datasource.schemas` 的可见性边界（②）：不改 `schemas` 的话，
   这条门对 `ledger` 是**结构性失明**的（§2）。
4. 退出码经 `pnpm` 是 1 而不是 2（§4.1）。
