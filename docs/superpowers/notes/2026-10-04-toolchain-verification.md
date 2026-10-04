# 工具链验证报告（P0 前置 Spike）

- **日期**：2026-10-04
- **状态**：已验证（所有结论均来自本机实际执行，非文档推断）
- **用途**：为 P0 实现计划提供**已证实**的版本与用法；计划中每条技术决策都可回溯到本文
- **方法**：在 `.spike/` 一次性目录中真实安装、编译、运行、连库、连容器；验证完毕后已删除

---

## 1. 本机环境

| 项 | 值 |
|---|---|
| Node | v22.19.0 |
| pnpm | 11.24.0 |
| Docker | Desktop 4.89.0 / Engine 29.7.2 / linux-amd64 |
| git | 2.51.0.windows.1 |
| 平台 | Windows（`npipe` Docker 端点） |

> Docker Desktop 启动较慢：守护进程就绪前 `docker info` 会以 `npipe:////./pipe/dockerDesktopLinuxEngine` 报错。**这不是配置问题，重试即可**；CI/脚本需带就绪等待。

---

## 2. 已验证结论

### 2.1 版本矩阵（全部实测通过）

| 组件 | 选定版本 | 结果 |
|---|---|---|
| NestJS | 12.1.2 | ✅ |
| TypeScript | **6.0.3** | ✅（**刻意不用 7.0.2**，见 §2.2） |
| Prisma / Client | 7.10.0 | ✅ |
| `@prisma/adapter-pg` | 7.10.0（+ `pg` 8.23.1） | ✅ |
| Vitest | 5.0.3 | ✅ |
| Testcontainers | 12.2.0（`@testcontainers/postgresql`、`@testcontainers/redis`） | ✅ |
| `@node-rs/argon2` | 2.2.1 | ✅ 预编译，无需构建脚本 |
| ioredis | 6.0.0 | ⚠️ 见 §2.6 |
| ESLint / typescript-eslint | 10.12.0 / 8.71.0 | ✅ |
| zod | 4.6.5 | ✅ |

### 2.2 TypeScript 版本必须锁 6.0.3，不能升 7.0.2

`npm view typescript-eslint peerDependencies` → `"typescript": ">=4.8.4 <6.1.0"`。

- 设计文档威胁 **#11** 要求「CI lint 规则禁止 `$queryRawUnsafe` 与字符串拼接 raw」，威胁 **#9** 要求禁 `dangerouslySetInnerHTML` —— 两者都依赖 **typed lint**，即 typescript-eslint。
- typescript-eslint 最新稳定版（8.71.0）**不支持 TS 7**（也不支持 6.1+）。TS 7.0.2 虽是最新稳定版，但会导致上述两条 CI 安全门失效。
- **决策：`typescript: 6.0.3`。** TS 6.0.3 已实测跑通 NestJS DI、Prisma 7 客户端、Vitest。

> 实测 TS 7 报错 `TS5011`：要求显式 `rootDir`。TS 6 无此要求。此差异作为背景记录。

### 2.3 NestJS 12 + 装饰器 DI —— 通过

`experimentalDecorators` + `emitDecoratorMetadata` 生效。实测同时验证：
- **按类型**构造注入（依赖 `emitDecoratorMetadata`）
- **字符串 token** 注入（`@Inject('CONFIG')`）

返回 HTTP 200，`{"ok":true,"msg":"hello world!"}`。

### 2.4 Vitest 5 原生支持装饰器元数据 —— 通过（重要）

**这是最反直觉的一条**：Vitest 默认用 esbuild 转译，而 esbuild 传统上**不支持** `emitDecoratorMetadata`，社区因此普遍加 `unplugin-swc`。

实测 Vitest 5.0.3：`Test.createTestingModule({ providers: [Svc, Dep] })` 中 `Svc` 按类型注入 `Dep` **成功**。

- **结论：不需要 `unplugin-swc` / `@swc/core`，不需要退回 Jest。**
- 测试选型定为 **Vitest 5**（比 Jest 快，且零额外转译插件）。

### 2.5 Prisma 7 破坏性变更（计划必须适配）

实测踩到的四处，均与 Prisma 6 及更早文档不符：

| # | 变更 | 实测现象 | 适配 |
|---|---|---|---|
| 1 | **`datasource.url` 被移除** | `error: The datasource property 'url' is no longer supported in schema files` (P1012) | 连接串移到 `prisma.config.ts`；运行时用 **driver adapter** |
| 2 | **`migrate dev --skip-generate` 被移除** | `! unknown or unexpected option` | 不再传该参数 |
| 3 | **generator `prisma-client` 产出 TS 源码** | 生成 `client.ts` / `models.ts` / `enums.ts`，非编译后 JS | 输出目录需纳入 `tsconfig` 与构建；且 **`migrate` 不会自动生成**，需显式 `prisma generate` |
| 4 | **`prisma@latest` = `8.0.0-rc.19`（RC 发布到 latest）** | `npm view prisma dist-tags` → `latest: 8.0.0-rc.19`，而 `@prisma/client@latest` = `7.10.0`（**主版本不一致**） | **两侧都硬锁 `7.10.0`**；`8.0.0-rc.19` 是预发布，禁止使用 |

实测可用配置：

```prisma
generator client {
  provider = "prisma-client"          // 注意不是 prisma-client-js
  output   = "../src/generated/prisma"
}
datasource db {
  provider = "postgresql"
  schemas  = ["auth", "ledger"]        // multiSchema 已 GA，无需 previewFeatures
}
```

### 2.6 ioredis 6 是 CJS，默认导入不可构造

`import Redis from 'ioredis'` 在 `module: nodenext` 下报 `TS2351: This expression is not constructable`。

**正确写法：`import { Redis } from 'ioredis'`**（具名导出）。实测连接、读写成功。

### 2.7 pnpm 11 构建脚本授权位置变了

`package.json` 的 `pnpm.onlyBuiltDependencies` **被忽略**：

> `The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.onlyBuiltDependencies"`

**正确位置是 `pnpm-workspace.yaml` 的 `allowBuilds`**（pnpm 会自动生成占位文件）：

```yaml
allowBuilds:
  prisma: true
  '@prisma/engines': true
  argon2: true
```

未授权时安装以 `ERR_PNPM_IGNORED_BUILDS` **退出码 1** 结束（会让 CI 误判失败）。

### 2.8 密码哈希选 `@node-rs/argon2`，不选 `argon2`

| | `argon2@0.45.1` | `@node-rs/argon2@2.2.1` |
|---|---|---|
| 安装 | 需 `node-gyp` 构建（要 python/VS 工具链） | **N-API 预编译，零构建** |
| 授权 | 需 `allowBuilds` | 不需要 |

实测 `@node-rs/argon2` 输出符合 OWASP 参数（`m=19456,t=2,p=1`，Argon2id），hash 17ms / verify 30ms：

```
$argon2id$v=19$m=19456,t=2,p=1$...
```

**决策：`@node-rs/argon2`**（Docker 与 CI 更省事）。设计文档 §4.2 的参数要求完全满足。

### 2.9 数据库能力验证

| 能力 | 结果 |
|---|---|
| Prisma `multiSchema`（`@@schema`） | ✅ 迁移正确产出 `CREATE SCHEMA "auth"` / `"ledger"` 与各自表 |
| UUIDv7 `@default(uuid(7))` | ✅ 实测 `01a1060c-404b-755b-be2c-1b1165246f33`，版本位 = 7 |
| 金额 `BigInt` | ✅ 往返为 `bigint`，无精度损失 |
| 跨 schema join | ✅ 被拒（无关系定义即无法 join，符合「禁跨模块 join」） |
| `SERIALIZABLE` + `SELECT ... FOR UPDATE` | ✅ 事务内行锁可用 |
| 时间戳 | ⚠️ 见下方修订：**必须用 `@db.Timestamptz(3)`**，不能用裸 `TIMESTAMP(3)` |

> **修订（Task 3 审查时发现，已回填）**：本行原记录为「`TIMESTAMP(3)`（毫秒），符合『出价记录到毫秒』」——**这是错的，已废弃**。
>
> 裸 `timestamp(3)` **不带时区**，PostgreSQL 会按**会话 `TimeZone`** 求值 `CURRENT_TIMESTAMP`，并据此转换带偏移的输入。因此在非 UTC 会话下，数据库默认值与 Prisma 自身的 `Date` 写入都会把**本地墙钟时间**存进一个无时区列——审计与账本的时间戳会静默错误。它此前「看起来没问题」，只是因为所用的 Postgres 镜像恰好默认 UTC。
>
> **正确做法（已作为全仓约定）：所有 `DateTime` 字段一律 `@db.Timestamptz(3)`**，从而存储的是**时刻**而非墙钟，毫秒精度不变，C6 的「所有时间戳为 UTC」才真正被强制而非仅仅被声明。另在 compose 的 Postgres 服务上设 `TZ=UTC` / `PGTZ=UTC` 作为纵深防御。此约定同样适用于 P2 的账本与 P4 的出价。


### 2.10 ⚠️ 关键安全发现：append-only 的 `REVOKE` 对表属主无效

设计文档 §5.3 / §8.3 不变式 #5 要求「在数据库层撤销 `UPDATE`/`DELETE` 权限」。

**实测：以迁移用户（= 表属主）执行 `REVOKE UPDATE, DELETE ... FROM PUBLIC` 后，`UPDATE` 仍然成功，数据被真实改写（`amount` 从 12345 变成 1）。**

原因：PostgreSQL 中**表属主始终保有全部权限**，对自己的 `REVOKE` 是空操作。

**唯一有效做法 —— 应用与迁移使用两个不同的数据库角色：**

```
迁移角色（属主）  → 跑 prisma migrate，DDL
应用角色 app_user → 运行时连接，仅被授予所需权限
```

实测验证（以 `app_user` 连接）：

```
UPDATE "ledger"."ledger_entries" SET amount = 999;
ERROR:  permission denied for table ledger_entries      ← 拒绝 ✅
INSERT INTO "ledger"."ledger_accounts" ... RETURNING kind;
 kind → TEST, INSERT 0 1                                  ← 允许 ✅
```

**这是 P0 必须建立的基础设施**，否则不变式 #5 只是纸面约束。计划中作为独立任务（Task 3）。

### 2.11 CI 安全 lint 门实测有效

ESLint 10 + typescript-eslint 8.71 配置 `no-restricted-syntax` 后，对 `prisma.$queryRawUnsafe(\`...${id}\`)` 实测报错：

```
error  Use parameterized Prisma APIs; $queryRawUnsafe is banned  no-restricted-syntax
```

### 2.12 Testcontainers 在 Windows Docker 上可用

实测 `PostgreSqlContainer` + `RedisContainer` 并行启动 **16.5s**，`pg` 与 `ioredis` 均连通。

- 首次运行需拉取镜像（`postgres:16-alpine`、`redis:7-alpine`），CI 需预热或缓存。
- `testcontainers` 的传递依赖 `cpu-features` / `protobufjs` / `ssh2` 会触发 `ERR_PNPM_IGNORED_BUILDS`；属可选优化，**加入 `allowBuilds: false` 显式忽略即可**，不影响功能（实测通过）。

---

## 3. 对设计文档的影响（需要回填的修订）

| 设计文档位置 | 原文 | 修订建议 |
|---|---|---|
| §5.3 / §8.3 不变式 #5 | 「DB 层撤销 `UPDATE`/`DELETE` 权限」 | 补充：**必须区分迁移属主角色与运行时应用角色**，否则撤销无效（§2.10） |
| §3.1 / §11 | 「PostgreSQL(Prisma)」 | 补充 Prisma 7 的 driver adapter 与 `prisma.config.ts` 形态（§2.5） |
| §4.2 | Argon2id `m=19456,t=2,p=1` | 实现选 `@node-rs/argon2`，参数不变（§2.8） |
| §12 集成测试 | testcontainers | 追加：Windows 下需 Docker 就绪等待与镜像预热（§2.12） |
| 新增 | — | 锁定 `typescript@6.0.3`，禁止升 7（§2.2） |

---

## 4. 未验证项（诚实声明）

以下**没有**在本次 spike 中验证，计划中不得当作既成事实：

- Next.js 16.3.8 与 React 19.3.0 的实际搭建（P0 不涉及前端页面；P5 前需单独验证）
- GitHub OAuth 真实回调（需真实 OAuth App 凭据）
- Nodemailer 10 真实投递（P0 只用本地 transport 断言）
- `dependency-cruiser` 18.5 的实际规则效果（未跑；P0 的 Task 9 将首次验证）
- 压测 / 渗透测试（P7）
