# Vibe-Coding 作品交易平台 · 架构设计文档

- **状态**：已复核，进入实现（P0 计划已就绪）
- **日期**：2026-10-04
- **阶段**：架构设计（未进入实现）
- **范围**：MVP（P0–P7）+ 未来子项目登记（P8–P9）

---

## 1. 背景与目标

### 1.1 产品定位

一个面向代码工作者的平台，创作者可以上传自己用 AI 辅助（vibe-coding）产出的完整项目，供他人使用。为激励创作者并形成差异化，平台同时提供两条变现路径：

1. **代码交换** —— 创作者用自己的作品与他人的作品进行所有权互换。
2. **竞拍** —— 通过拍卖宣传并售卖自己的系统与服务。

### 1.2 设计优先级

1. **安全优先**（用户明确要求）—— 平台涉及交换、交易与部署上线，必须先建立安全边界再写业务逻辑。
2. **便利性不被牺牲** —— 安全措施主要落在服务端；用户侧保持顺畅（一键登录、代理出价、一口价、自动结算、邮件通知）。
3. **可演进性** —— 模块边界即未来的服务边界；未来功能（部署上云、AI 素材生成）的接缝必须在今天就已存在。

### 1.3 设计期已确认的关键决策

| # | 决策点 | 结论 | 决策依据 |
|---|---|---|---|
| D1 | 目标阶段 | **高保真可运行 MVP**：完整跑通闭环，结算走内部虚拟账本，架构预留真实支付接口但不实现 | 用户选择 |
| D2 | 交易标的 | **完整项目转让**：源码 + 部署权。平台托管制品，成交后所有权转移。未来的授权式（License）交易通过 `asset.checkAccess(assetId, userId)` 这**一个接缝**接入，不预建 Entitlement 空表 | 用户选择 |
| D3 | 代码执行边界 | **平台绝不执行任何用户代码**，无沙箱预览路径。Demo 由卖方自行部署并提供外链，平台只做跳转与风险提示 | 用户选择（安全优先） |
| D4 | 身份门槛 | **发布者必须绑定 GitHub OAuth，买家可邮箱注册**。平台自身不存储密码用于第三方登录；邮箱账号使用 Argon2id | 用户选择 |
| D5 | 技术栈 | **TypeScript 全栈、前后端分离**：Next.js/React + NestJS + PostgreSQL(Prisma) + Redis + Docker Compose | 用户选择 |
| D6 | 整体架构路线 | **模块化单体 + 自研加密制品存储 + 复式记账账本**（路线 A） | 用户选择 |
| D7 | 价值判定 | **商品价值由用户决定**。平台保证公平交易与售后，不介入价值对等判断 | 用户明确 |
| D8 | 补差机制 | **允许引入虚拟货币补差**，走站内复式账本结清差额 | 用户确认 |
| D9 | 竞拍机制 | 英式加价 + 代理出价 + 反狙击软关闭 + 保留价 + Buy-Now + 保证金；排除维克里次价与荷兰式 | 委托设计方判断 |
| D10 | TypeScript 版本 | **锁 6.0.3，不升 7**。7 是最新稳定版，但 typescript-eslint 尚不支持（peer `<6.1.0`），升 7 会直接废掉威胁 #9/#11 的 CI lint 门 | 实测（见验证报告 §2.2） |
| D11 | 数据库角色 | **双角色**：迁移属主 `vca_owner` + 运行时最小权限 `app_user`。单角色下不变式 #5 的 `REVOKE` 是空操作 | 实测（见验证报告 §2.10） |

### 1.4 核心产品原则

> **平台保证「信息对称」，不保证「价值对等」。**

物物交换是对称的：双方在同一事务中同时获得对方制品的访问权，无人可以先行跑路。因此不存在「单方被白嫖」，只存在「换到了垃圾」。真正的风险是信息不对称 —— 不知道对方的代码是不是空壳。

平台的责任因此落在三件事上：

1. **公平** —— 原子交换、无先后、无单方退出窗口外的损失。
2. **信息对称** —— 受限预览资料真实、质量校验强制执行。
3. **售后** —— 争议期 + 资金托管 + 仲裁。

价值是否对等，交给市场：补差、评价、信誉分。

---

## 2. 范围

### 2.1 MVP 范围（P0–P7）

| # | 子项目 | 范围 |
|---|---|---|
| P0 | 安全底座与身份 | monorepo 骨架、容器化、密钥管理、认证与授权、安全响应头、限流、审计日志、outbox 与邮件适配器、架构守护测试、CI |
| P1 | 作品与制品 | 作品/版本/元数据/所有权历史、上传校验、加密存储、元数据解析、签名下载 |
| P2 | 账本与托管 | 复式记账、不变式校验、额度发放、冻结与释放、属性测试 |
| P3 | 交换 | 上架（交换）、交换要约、受限预览资料、双锁、原子释放、补差结算、争议期 |
| P4 | 竞拍 | 拍卖状态机、代理出价、反狙击、保留价、Buy-Now、保证金、结算、流拍转交换 |
| P5 | 市场体验与通知 | 检索/筛选/排序、评价体系、邮件通知、公开价值信号 |
| P6 | 治理后台 | 管理后台、争议仲裁、风控标记复核、下架封禁、财务对账视图 |
| P7 | 部署上线与加固 | 生产部署、TLS、备份与恢复演练、压测、渗透测试清单 |

**最小可验证闭环 = P0 → P1 → P2 → P3 → P4。**

### 2.2 明确不做（非目标）

- ❌ **不执行任何用户代码**，不提供沙箱预览。制品只做静态解析，永不被运行。
- ❌ **不接真实支付渠道**。仅有站内虚拟账本；MVP **不支持提现**（提现依赖真实支付通道）。
- ❌ **不做实名/KYC**。以 GitHub OAuth + 信誉分 + 交易限额替代。
- ❌ **不做微服务拆分**。
- ❌ **不做实时 WebSocket 出价推送**。MVP 用轮询 + SSE。
- ❌ **不做国际化**，中文单语界面。
- ❌ **不做移动 App**，响应式 Web。
- ❌ **不做抄袭检测**（延后至 P6 评估）。
- ❌ **不做荷兰式降价重拍**（见 §14 延后决策）。
- ❌ **不建空抽象**：不为「部署上云」「AI 素材生成」预埋空表、空接口或空模块。

---

## 3. 总体架构

### 3.1 架构分层

```
┌─ 浏览器 ── Next.js / React (SPA)
│             └ 不在 localStorage 存 token；仅 HttpOnly Cookie
│  HTTPS / TLS 1.3  ·  SameSite=Lax  ·  CSRF 双提交令牌
├─ 反向代理（Nginx）
│             └ TLS 终止 · 安全响应头 · CSP(nonce) · 第一层限流
├─ NestJS API 单进程（模块化单体）
│   auth · users · catalog · asset · exchange · auction · ledger · dispute · audit · notify
├─ Worker 进程（独立，消费 Redis 队列）
│   结算 · 超时过期 · 反狙击计时器 · outbox 消费 · 通知投递
├─ Redis      会话 · 限流桶 · 出价串行化锁 · 任务队列
├─ PostgreSQL 16   业务数据（每模块独立 schema）+ 复式账本（append-only）
└─ 对象存储/加密卷   AES-256-GCM 分块加密的制品包
```

**数据访问层实现约定（Prisma 7，已实测）：** 连接串**不再写在 `schema.prisma` 内**（Prisma 7 已移除 `datasource.url`）。迁移的连接串来自 `prisma.config.ts` 的 `datasource.url`；运行期由 `@prisma/adapter-pg` 的 driver adapter 传入。multiSchema 已 GA（无需 `previewFeatures`），生成器用 `prisma-client`（产出 TS 源码，需显式 `prisma generate` 且输出目录纳入构建）。

### 3.2 模块职责

| 模块 | 单一职责 | 对外接口（深模块原则：小接口、大实现） |
|---|---|---|
| `auth` | 认证、会话、OAuth 绑定 | `login / logout / verifySession / requireRecentAuth` |
| `users` | 用户资料、信誉分、交易限额 | `getProfile / getCreditScore / checkLimit` |
| `catalog` | 上架、分类、标签、检索 | `publish / search / getDetail`。MVP 检索基于 Postgres 全文检索（标题 / 描述 / README 的 tsvector）+ `pg_trgm` 模糊匹配 + 标签 GIN 索引 |
| `asset` | 制品存储、加解密、元数据、**访问判定**、签名下载 | `store / readMetadata / checkAccess / signDownloadUrl` |
| `exchange` | 交换要约与合约 | `proposeOffer / accept / confirmLock / releaseContract` |
| `auction` | 拍卖生命周期与出价 | `create / placeBid / buyNow / closeAuction` |
| `ledger` | 复式记账、托管、冻结与释放 | `post / freeze / release / refund / getBalance` |
| `dispute` | 争议与仲裁 | `open / resolve` |
| `audit` | 审计日志（append-only） | `record / query` |
| `notify` | 异步通知 | 仅消费 outbox 事件 |

### 3.3 可拆分性约束（四条，均为「现在就有收益」的约束）

拆解微服务真正的难点是：**数据所有权**、**事务边界**、**跨模块查询**。因此：

| 约束 | 现在就有收益 | 拆服务时省掉的事 |
|---|---|---|
| **每模块独占自己的表**（独立 Postgres schema），禁止跨模块 join 或直接写对方表 | 表变更影响范围可预测；模块可独立建测试数据 | 省掉最痛的数据拆分 |
| 跨模块只走**显式接口 + DTO**（`packages/shared`），不共享 ORM 实体 | 模块可独立测试；改内部实现不炸调用方 | 接口即现成的服务契约 |
| 跨模块写操作**收敛到少量编排入口**，异步走 **transactional outbox** | 事务边界清晰、重试可靠、不丢事件 | outbox 直接变消息队列，Saga 起点现成 |
| CI 加**架构守护测试**（禁跨模块 import 内部实现、禁直接访问对方表） | 现在就不会长成意大利面 | 让可拆分性成为强制约束而非愿望 |

**关键判断：`ledger` 与 `auction`（以及 `exchange`）必须长期同库、同服务。** 出价与资金冻结、原子所有权互换都需要本地事务。硬拆等于把本地事务换成 Saga，是**用一致性换隔离性** —— 对资金系统是反向收益。

### 3.4 未来功能的接缝（零预留成本）

原则：**一个 adapter 只是假想的接缝，两个才是真实的接缝。** 因此不为未来功能建空抽象，只依赖**今天已经必须存在**的接口。

| 未来功能 | 接缝 | 今天为何已存在 | MVP 现在做什么 | 坚决不做什么 |
|---|---|---|---|---|
| **P8 部署上云服务** | `asset` 的读取接口 + `fulfillments.kind` | 买家下载功能今天就要读制品；交换的双向互交付与竞拍成交交付今天就要表达交付义务（两个真实调用方） | 交付义务独立成 `fulfillments` 表 | 不建 `deployment_targets` 空表；**构建绝不进主进程** |
| **P9 AI 素材生成** | `asset.readMetadata` | 上传本就必须解压校验；元数据今天就用于检索与技术栈标签 | 解析压缩包时顺手产出结构化 `AssetMetadata` | 不调 LLM、不建 `ai` 模块 |
| **未来的授权式（License）交易** | `asset.checkAccess(assetId, userId)` | 制品下载今天就必须做访问判定，这里是唯一判定点 | 用它派生访问权（所有权 + 合约 / 拍卖状态） | 不建 `entitlements` 空表 |

**必须现在就写进架构原则的两条纪律：**

1. **「构建」永远不能发生在主 API 进程里。** 上传时的解压是*解析*，安全；未来的 `npm install && build` 是*执行*，必须进一次性隔离环境。
2. **绝不在主服务执行用户代码。** P9 的输入只能是**静态元数据 + 用户自行上传的截图/录屏**。若将来要做自动截图，必须独立立项为「一次性、无网络、无凭证的沙箱」，不得顺手塞进主服务。这条纪律的存在，正是为了防止「AI 素材生成」从后门拆掉 D3 底线。

### 3.5 一笔同时服务两个目的的基础投资

**结构化日志 + trace id 全链路贯穿 + outbox 表** —— 同时满足「安全审计」（首要优先级）与「未来拆服务的可观测性」。不是为未来重复花钱，是一笔钱办两件事。

---

## 4. 安全模型

### 4.1 威胁 → 对策清单

| # | 威胁 | 对策 |
|---|---|---|
| 1 | **越权访问他人制品（IDOR）** | 统一 `PolicyGuard`：每个接口显式声明「资源-动作-条件」，**默认拒绝**；禁止在 controller 内手写判权；资源 ID 使用 UUIDv7 防枚举；CI 测试强制每个路由都有策略声明 |
| 2 | **恶意压缩包**（zip bomb / zip slip / symlink） | 解压前校验条目数与声明大小；解压后累计大小 ≤ 1GB、条目数 ≤ 20,000、压缩比 ≤ 100:1；拒绝绝对路径、`..`、symlink、hardlink；仅接受 zip 与 tar.gz，以 magic bytes 内容嗅探确认 |
| 3 | **制品泄露** | AES-256-GCM 分块加密（块大小 8MB，每块独立 nonce，密钥以 key id 前缀支持轮换）；主密钥由环境注入，**不入库不入 git**；下载走 ≤5 分钟单次签名 URL；每次下载写审计 |
| 4 | **资金篡改** | 复式记账；账本条目 **append-only**（DB 层撤销 `UPDATE`/`DELETE` 权限）；金额一律 `bigint` 的「分」，禁浮点；余额只能由账本推导，物化余额在事务内校验 |
| 5 | **出价竞态 / 双花** | 出价与结算走 `SERIALIZABLE` 事务 + `SELECT ... FOR UPDATE` 行锁；所有写操作携带幂等键 |
| 6 | **代理出价泄价**（含内鬼） | 代理上限**加密存储**；比较只在服务端进行；**任何接口（含管理员接口）都不下发**。字段级强制策略，非可选 |
| 7 | **串通抬价 / 刷单** | 出价记录完整审计字段；同设备指纹/IP/支付方式在不同账号出现即自动打标进入人工复核；新账号限额 |
| 8 | **狙击** | 结束前 60s 内有效出价 → 剩余时间重置为 60s；上限 30 次 / 总时长硬顶 24h |
| 9 | **XSS / 存储型 XSS** | React 默认转义；禁 `dangerouslySetInnerHTML`；用户 Markdown 经白名单 sanitizer；CSP nonce-based、禁 inline；**上传文件绝不从同源路径回源**（独立域或强制 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`） |
| 10 | **CSRF** | Cookie 会话 + SameSite=Lax + 双提交令牌（全部写操作校验） |
| 11 | **SQL 注入** | 一律 Prisma 参数化；CI lint 规则禁止 `$queryRawUnsafe` 与字符串拼接 raw |
| 12 | **SSRF** | Demo 外链**只存不抓**（这也得益于 D3「不在线运行代码」）。若未来做链接校验，必须禁内网地址 |
| 13 | **暴力破解 / 资源滥用** | 分层令牌桶：登录 5 次/15 分钟（IP + 账号）；注册 3 次/小时（IP）；出价 30 次/分钟（用户）；上传 10 次/天（用户）；搜索 60 次/分钟（IP） |
| 14 | **供应链** | lockfile 固定 + CI 内 `pnpm audit` + SBOM + 自动依赖更新 |
| 15 | **密钥与配置泄露** | 启动时校验必填密钥存在且非默认值；`.env.example` 只含占位；日志脱敏（不记 token、密码、完整邮箱） |
| 16 | **数据丢失** | Postgres 每日逻辑备份 + WAL 归档；**恢复演练写入验收标准**（未验证的备份等于没有备份） |

### 4.2 认证与会话

- **发布者**：GitHub OAuth（Authorization Code + PKCE，校验 `state` 与 `nonce`）。
- **买家**：邮箱 + 密码，Argon2id（m=19456 KiB, t=2, p=1，OWASP 推荐参数）；辅以邮箱 magic-link 免密登录。
  - 实现选型：`@node-rs/argon2`（而非 `argon2`）。前者是 N-API 预编译包，**无需 node-gyp/构建工具链**，Docker 与 CI 更省事；参数完全一致，实测 hash 17ms / verify 30ms。
- **会话**：服务端存储于 Redis，HttpOnly + Secure + SameSite=Lax Cookie。空闲 7 天过期；**敏感操作要求最近 15 分钟内完成过认证**。
- **2FA**：TOTP。对**管理员强制**；对普通用户可选，但**单笔金额 ≥ 10,000 元的操作强制**。
- 不使用 localStorage 保存任何令牌。

### 4.3 便利性设计（安全不牺牲体验）

一键 GitHub 登录、邮箱 magic-link、代理出价（无需守到最后）、Buy-Now 即时成交、7 天自动确认释放、邮件通知。全部安全措施落在服务端，用户无感。

### 4.4 通知事件清单（P0 建立通道，P5 完善偏好设置）

经 outbox 异步投递，MVP 全部走邮件：

收到交换要约 / 要约被接受 / 被拒绝 / 要约即将过期（剩余 6 小时）· 交换合约待你锁定 / 对方已锁定 / 合约已释放 / 争议期剩余 24 小时 · 拍卖已开始 / 你的出价被超越 / 拍卖即将结束（剩余 1 小时）/ 触发延长 / 成交 / 流拍 · 保证金冻结 / 释放 / 罚没 · 争议已开启 / 已裁决

---

## 5. 领域模型

### 5.1 实体与关系

```
User ──┬── Identity（GitHub OAuth / 邮箱密码 / magic-link）
       └── CreatorProfile（对外展示、信誉分、交易限额）

LedgerAccount（用户账户：可用 / 冻结；平台账户：托管 / 收入 / 外部充值对手方）

Asset（作品，永久实体）
  ├── AssetVersion（加密制品包：sha256、大小、上传人、key id）
  ├── AssetMetadata（README、文件树摘要、语言分布、依赖、完整度评分）
  ├── OwnershipHistory（append-only 所有权流转）
  └── Listing（上架，可重上架 / 改价 / 下架）
        ├── SwapOffer[]（交换要约）
        ├── Auction（拍卖）
        └── Order（成交订单）
              ├── Fulfillment（交付义务）
              └── EscrowRecord（托管，由账本驱动）

LedgerEntry（双分录，append-only）  AuditLog（append-only）  OutboxEvent  Dispute  Review
```

### 5.2 三个关键区分

1. **`Asset` ≠ `Listing`** —— 作品是永久实体（有版本史、所有权史）；上架是可反复的状态。流拍后转交换 = 换一个 `Listing`，不动 `Asset`。
2. **制品只存一份** —— 所有权转让 = `Asset.owner` 指针变更 + `OwnershipHistory` 追加，不解密、不复制。这使「原子式所有权互换」成为一个**本地数据库事务**。
3. **`Fulfillment` 独立于 `Order`** —— 交换的双向互交付与竞拍的成交交付都需要表达「谁该给谁交付什么」。两个真实调用方 → 真实接缝，不是投机抽象。未来 P8 只是在 `fulfillments.kind` 上多一个取值。

### 5.3 标识与字段约定

- 所有主键使用 **UUIDv7**（防枚举、含时间序便于索引）。
- 所有金额字段为 `bigint`，单位「分」，币种字段预留（MVP 单一币种 CNY）。
- 所有时间戳为 UTC，出价时间记录到毫秒并使用**服务端时钟**。
- 所有 append-only 表（`LedgerEntry`、`AuditLog`、`OwnershipHistory`、`Bid`）在数据库层撤销 `UPDATE`/`DELETE` 权限。
  - ⚠️ **实施前提（已实测）**：PostgreSQL 中**表属主始终保有全部权限**，属主对自己的 `REVOKE` 是**空操作**。因此撤销权限**必须区分两个数据库角色**：迁移属主角色（跑 DDL）与运行时应用角色（`app_user`，最小权限）。只用一个角色时，`REVOKE` 之后 `UPDATE` 依然成功、数据会被真实改写。详见 §8.6 与工具链验证报告 §2.10。

---

## 6. 交换机制

### 6.1 防线（对应 §1.4 原则）

1. **受限预览资料（Preview Dossier）** —— 要约发出后，对手方可见：README、完整文件树、依赖清单、代码行数统计、语言分布、文件体积、平台生成的**完整度评分**、以及作者上传的截图/录屏。**看得到质量，看不到源码。**
2. **平台自动质量校验** —— 制品必须通过校验（非空、项目结构可识别、有入口文件、与声明技术栈一致、非空壳）才有资格进入交换流程。
3. **7 天争议期 + 补差托管** —— 质量问题可仲裁，补差可回退。

### 6.2 完整度评分（默认权重，可配置）

| 项 | 权重 |
|---|---|
| README 存在且 ≥ 200 字 | 25 |
| LICENSE 存在 | 10 |
| 依赖清单存在且可解析 | 15 |
| 入口 / 构建脚本存在 | 15 |
| 文件数在 10–5000 之间 | 10 |
| 有截图或录屏 | 15 |
| 代码行数 > 200 | 10 |

区间 0–100。

### 6.3 状态机

```
SwapOffer:
  DRAFT → SENT ─┬→ ACCEPTED  → 生成 SwapContract
                ├→ REJECTED
                ├→ WITHDRAWN
                └→ EXPIRED（72 小时）

SwapContract:
  PENDING_BOTH_LOCK     双方各需在 24 小时内确认锁定
        ↓ 双方均锁定（资产变为不可编辑 / 不可另行上架 / 不可删除）
  VALIDATING            平台校验双方制品完整性
        ↓ 通过
  RELEASED              【单一事务】所有权互换 + 双方访问权授予 + 补差账本过账
        ↓ 7 天争议期无人提出
  COMPLETED
        ├─ RELEASED 前任一方退出 → CANCELLED（无惩罚；交换本身对等）
        └─ 争议期提出 → DISPUTED → RESOLVED_UPHELD / RESOLVED_REVERSED
```

**`RELEASED` 必须在单一数据库事务内完成**，任何异常必须完全回滚，不留半成品所有权。这是本平台最核心的技术命题。

### 6.4 补差（boot）

双方价值不等时，用虚拟账本结清差额。差额同样走托管与 7 天争议期。这既保住了「以物易物」的产品定位，又避免了引入投机性货币。

### 6.5 交换 ↔ 竞拍 互导流

| 机制 | 设计 | 纳入阶段 |
|---|---|---|
| **流拍 → 自动交换要约** | 拍卖未达保留价结束时，系统自动向**最高出价者**生成一份 `SwapOffer` 草案（用其作品换）。接受即进入交换流程 | P4 |
| **交换邀约数作为公开价值信号** | 详情页显示「已有 N 位创作者愿意用作品交换」，作为拍卖的天然预热与无成交历史时的参考估值 | P5 |
| **交换 → 拍卖的优先权** | 交换合约建立后设 24 小时冷静期，期内任一方可申请把标的升级为拍卖（需解除交换独占性、冻结保证金） | P3.5（延后） |

---

## 7. 竞拍机制

### 7.1 全站默认组合

| 组件 | 规则 |
|---|---|
| **英式公开加价** | 公开递增加价，最高价成交 |
| **代理出价** | 用户填心理最高价，系统按最小增量代加；**上限加密存储、永不下发前端** |
| **反狙击软关闭** | 结束前 60s 内任何有效出价 → 剩余时间重置为 60s；**上限 30 次 / 总时长硬顶 24h** |
| **保留价** | 卖家可设；对外只显示「未达保留价」 |
| **Buy-Now 一口价** | 必须 ≥ 保留价；在**首个达到保留价的出价之前**有效，之后消失（对齐 eBay 规则）；触发即冻结买家保证金并进入托管 |
| **保证金入场** | 新账号冻结起拍价 10%（且单笔成交上限 5,000 元）；信誉分 ≥ 60 的老账号 5% |
| **阶梯最小增量** | < 1,000 元 → +10 元；1,000–10,000 元 → +100 元；> 10,000 元 → +500 元（可配置） |
| **卖家审批竞买人** | 高价值标的可开启 |
| **平台手续费** | 默认 5%，可配置（MVP 可设 0） |

### 7.2 明确排除

- ❌ **维克里次价密封** —— 结算语义反直觉（「出最高价凭什么付次高价」），且密封价内部可见会带来泄价与悔拍风险。理论优雅，实践不讨好。
- ❌ **纯反向拍卖用于服务售卖** —— 唯低价中标会逼出劣质交付。若将来做服务招标，必须改为**多属性评标**（价格 + 交付周期 + 验收标准，权重公开）。
- ❌ **荷兰式降价** —— 延后，见 §14。

### 7.3 拍卖状态机

```
DRAFT → SCHEDULED → LIVE ⇄ EXTENDED
                      ├→ ENDED_MET_RESERVE → SETTLEMENT_PENDING → ESCROW_FROZEN
                      │                            → TRANSFER_IN_PROGRESS → COMPLETED
                      │                            ↘ DISPUTED → REFUNDED / RESOLVED
                      ├→ BIN_TRIGGERED → SETTLEMENT_PENDING
                      └→ ENDED_UNSOLD → SWAP_OFFERED → SWAP_ACCEPTED / ARCHIVED

任意状态可由管理员置为 ADMIN_SUSPENDED（下架 / 风控）
```

**状态的合法迁移仅限上述边**，由状态机守卫强制，不靠散落各处的 `if`。

### 7.4 出价记录的审计字段（防串通与可审计所必需）

`bid_id` / `auction_id` / `bidder_id` / `amount` / `created_at`（服务端毫秒）/ `source_ip` / `device_fingerprint` / `login_session_id` / `bid_type`(manual | proxy) / `proxy_ceiling_encrypted` / `is_valid` / `invalid_reason` / `reserve_met` / `extension_triggered` / `extension_count` / `payment_method_hash` / `bidder_credit_snapshot` / `related_account_flag`

所有出价只追加不可修改。同一 `payment_method_hash` 或 `device_fingerprint` 出现在不同账号时自动打标并进入人工复核（P6）。

---

## 8. 资金与账本

### 8.1 账户模型

| 账户类型 | 说明 |
|---|---|
| `USER_AVAILABLE` | 用户可用余额 |
| `USER_FROZEN` | 用户冻结余额（保证金、未结算出价） |
| `PLATFORM_ESCROW` | 平台代持（成交后待释放资金，**平台不触碰**） |
| `PLATFORM_REVENUE` | 平台手续费收入 |
| `EXTERNAL_TOPUP` | 充值对手方账户（MVP 由管理员发放虚拟额度） |

**MVP 的虚拟货币约束**：1 积分 = 1 元；仅站内结算与补差使用；**不可提现、不可转赠**。此约束同时规避了资金池与合规风险。

### 8.2 记账示例

```
充值             DR  EXTERNAL_TOPUP      CR  USER_AVAILABLE
出价冻结保证金    DR  USER_AVAILABLE      CR  USER_FROZEN
悔拍没收         DR  USER_FROZEN         CR  PLATFORM_REVENUE(罚没) + SELLER_AVAILABLE(赔偿)
成交             DR  BUYER_AVAILABLE     CR  PLATFORM_ESCROW
释放（验收后）    DR  PLATFORM_ESCROW     CR  SELLER_AVAILABLE + PLATFORM_REVENUE
交换补差         DR  PAYER_AVAILABLE     CR  PLATFORM_ESCROW → 释放时转 RECEIVER_AVAILABLE
```

### 8.3 五条不变式（必须写成可测断言）

1. 每笔交易 `Σ 借方 = Σ 贷方`（借贷平衡）
2. 全局 `Σ 所有账户余额 = 0`（零和）
3. `USER_AVAILABLE >= 0` 且 `USER_FROZEN >= 0`（不可透支）
4. `Σ PLATFORM_ESCROW ≥ Σ 所有未结算托管义务`（托管不透支）
5. 账本条目 **append-only**（DB 层撤销 `UPDATE`/`DELETE` 权限）
   - ⚠️ 该撤销**仅对非属主角色有效**。运行时必须以最小权限角色 `app_user` 连接，迁移以属主角色执行；详见 §8.6。

> 这五条将成为**属性测试（property-based test）**：CI 每次生成 ≥10 万次随机交易序列后断言不变式恒成立。这是资金系统唯一真正可靠的验证方式。

### 8.4 托管释放（MVP）

成交 → 全额冻结进 `PLATFORM_ESCROW` → 买家确认收到并验收 → **7 天自动确认**（无争议则到期自动释放）→ 释放时扣平台手续费。
争议期间**全额冻结**，任何一方都不能单方提取。

调研建议的「70% 代码交接 / 20% 部署验收 / 10% 质保」分期释放属于服务类标的，延后至 P6。

### 8.5 幂等与并发

- 每个 Worker 任务有幂等键（如 `settle:auction:{id}`），在 `processed_jobs` 表上加唯一约束，保证 exactly-once 效果。
- 出价与结算在 `SERIALIZABLE` 事务内，对拍卖行加 `SELECT ... FOR UPDATE` 行锁。
- `RELEASED`（交换）与 `SETTLEMENT`（竞拍）各自在单一事务内完成。

### 8.6 数据库角色模型（append-only 生效的前提，已实测）

不变式 #5 要求「在数据库层撤销 `UPDATE`/`DELETE`」。**实测发现：若应用与迁移使用同一角色，该撤销完全无效** —— 因为该角色是表属主，而 PostgreSQL 的属主始终保有全部权限。

**必须采用双角色：**

| 角色 | 用途 | 权限 |
|---|---|---|
| `vca_owner` | **仅**跑 Prisma 迁移（DDL） | 库与 schema 属主；建表、改结构 |
| `app_user` | **运行时连接**（API 与 Worker） | 按表授予最小权限 |

其中 append-only 表对 `app_user` 只授予 `SELECT` + `INSERT`：

```sql
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO app_user;
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA audit FROM app_user;
```

实测结果（以 `app_user` 连接）：

```
UPDATE "ledger"."ledger_entries" SET amount = 999;
ERROR:  permission denied for table ledger_entries      ← 拒绝
INSERT INTO "ledger"."ledger_accounts" ... RETURNING kind;
 kind → TEST, INSERT 0 1                                  ← 允许
```

**两条纪律：**

1. `.env` 中的 `DATABASE_URL` 必须指向 `app_user`；**`MIGRATE_DATABASE_URL` 才是属主角色**，且只在迁移时注入。
2. **迁移后必须重跑授权脚本**（`infra/db/apply-grants.sql`）：新建表不会自动继承已发出的 `GRANT`。CI 与生产发布流程中，`prisma migrate deploy` 之后必须紧跟该脚本。

> 这一条是整份文档中「纸面约束」与「真实约束」差别最大的地方，因此在实现计划中作为独立任务（P0 Task 3）先行落地。


---

## 9. 权限矩阵

`PolicyGuard` 的输入。**默认拒绝**：任何未在此矩阵中显式声明的「资源-动作-条件」组合一律拒绝。

| 资源 | 动作 | 谁 | 条件 |
|---|---|---|---|
| `Asset` 元数据 | read | 所有人 | 仅元数据，绝不含源码 |
| `Asset` 制品 | download | 所有者 / 交换对手方（`RELEASED` 后）/ 买家（成交且已托管） | ≤5 分钟单次签名 URL + 写审计 |
| `Asset` | update / delete | 所有者 | 且 Listing 不处于 `LIVE` / 锁定 / 托管中 |
| `Preview Dossier` | read | 交换要约的对手方 | 要约已 `SENT` |
| `Bid.amount` | read | 所有人 | 出价金额公开 |
| **`Bid.proxy_ceiling`** | read | **任何人，含管理员** | **永不可读**（字段级强制策略） |
| `SwapOffer` | accept / reject | 被要约方 | 状态为 `SENT` |
| `SwapContract` | confirmLock | 合约双方 | 状态为 `PENDING_BOTH_LOCK` 且在 24h 内 |
| `LedgerEntry` | read | 账号本人 / 管理员（只读） | **无任何写接口**，只能由 `ledger` 模块内部过账 |
| `AuditLog` | read | 管理员 | 只读 |
| `Dispute` | resolve | 管理员 | 争议处于开放状态 + 管理员已启用 2FA |

---

## 10. 信誉分与限额

| 项 | 规则 |
|---|---|
| 初始分 | 100（区间 0–150） |
| 完成一笔交易 | +2（上限 150） |
| 悔拍 | −20 |
| 争议败诉 | −15 |
| 管理员确认的恶意行为 | −50 |
| 低于 60 分 | 保证金翻倍，单笔成交上限降至 1,000 元 |
| 未完成首次交易的新账号 | 保证金 10%，单笔成交上限 5,000 元 |

---

## 11. 仓库结构

```
vibe-coding-auction-web/
├─ apps/
│  ├─ api/                    NestJS（模块化单体）
│  │  └─ src/modules/
│  │     ├─ auth/ users/ catalog/ asset/ exchange/ auction/ ledger/ dispute/ audit/ notify/
│  │     └─ 每个 module 独占自己的 Postgres schema，禁止跨模块 join
│  ├─ web/                    Next.js / React
│  └─ worker/                 结算 · 超时 · 反狙击计时 · outbox 消费
├─ packages/
│  └─ shared/                 跨端 DTO 与类型（唯一允许共享的东西）
├─ infra/                     docker-compose · nginx · 迁移脚本
├─ tests/
│  ├─ integration/            testcontainers（真实 Postgres + Redis）
│  ├─ security/               越权矩阵 · 恶意上传样本 · 头部断言
│  ├─ property/               账本不变式 · 随机交易/出价序列
│  └─ architecture/           跨模块 import 守护
└─ docs/superpowers/specs/
```

### 11.1 工具链版本锁定（已实测，见验证报告）

| 组件 | 版本 | 备注 |
|---|---|---|
| Node / pnpm | 22.19.0 / 11.24.0 | pnpm 构建脚本授权写在 `pnpm-workspace.yaml` 的 `allowBuilds`（`package.json#pnpm` 已被忽略） |
| NestJS | 12.1.2 | |
| **TypeScript** | **6.0.3** | ⚠️ **不得升到 7**：typescript-eslint 8.71 的 peer 为 `>=4.8.4 <6.1.0`，升 7 会让威胁 #9/#11 的 CI lint 门失效 |
| Prisma / Client | **7.10.0（两侧同版本）** | ⚠️ `prisma@latest` 目前指向**预发布** `8.0.0-rc.19`，而 `@prisma/client@latest` 是 `7.10.0`。必须硬锁，禁止使用 RC |
| PostgreSQL / Redis | 16 / 7 | |
| Vitest | 5.0.3 | 原生支持 `emitDecoratorMetadata`，**无需 `unplugin-swc`** |
| Testcontainers | **12.0.4**（`@testcontainers/postgresql`/`-redis` 12.0.4）| ⚠️ 经 `pnpm-workspace.yaml` 的 `overrides` 强制。传递依赖会解析到 12.2.0，而 12.2.0 声明 `engines.node >= 22.22`，高于本仓 22.19.0 的下限；若将来升到 12.1+，必须同时抬高 `engines.node` |
| ioredis | 6.0.0 | ⚠️ 是 CJS，必须用具名导入 `import { Redis } from 'ioredis'` |
| `@node-rs/argon2` | 2.2.1 | 预编译，无需构建工具链 |

---

## 12. 测试策略

| 层 | 覆盖什么 | 关键要求 |
|---|---|---|
| 单元 | 状态机守卫、增量阶梯、反狙击计时、手续费计算、完整度评分 | 纯函数，快 |
| **属性测试** | **账本五条不变式**：随机生成 ≥10 万次操作序列后断言恒成立 | 资金系统唯一可靠的验证方式 |
| 集成 | 真实 Postgres + Redis；事务原子性、行锁并发、幂等键 | **账本与授权绝不用 mock**。用 testcontainers 起真实容器；Windows 下 Docker 守护进程就绪较慢，需带就绪等待与镜像预热（实测冷启动约 16.5s） |
| 并发 | N 个并发出价无超卖、无重复结算；两个交换同时 `RELEASED` 的竞态 | 必须真并发，不能顺序模拟 |
| 安全 | **越权矩阵**（遍历所有 API × 所有角色，断言默认拒绝）、恶意压缩包样本集、CSRF/限流/CSP 断言 | 每个新路由漏声明策略会让测试失败 |
| 契约 | OpenAPI ↔ 实现 ↔ 前端 client 三方不漂移 | 防「文档骗人」 |
| 架构 | CI 禁跨模块 import 内部实现、禁直接访问对方表 | 让可拆分性成为强制约束 |
| E2E | Playwright 只跑关键路径 | 注册 → 上传 → 上架 → 成交/交换 → 托管释放 |
| 恢复演练 | 从备份还原并校验一致 | P7 验收项 |

---

## 13. 验收标准（MVP Definition of Done）

### 13.1 功能闭环

- [ ] 注册 → 绑 GitHub → 上传作品 → 上架为**交换** → 对手方发起要约 → 双方锁定 → **原子释放** → 7 天后完成
- [ ] 上架为**拍卖** → 代理出价 → 反狙击延时生效 → Buy-Now 成交 → 保证金冻结 → 托管 → 释放 → 所有权转移
- [ ] 流拍 → 自动向最高出价者生成交换要约

### 13.2 安全

- [ ] 越权矩阵测试全绿（未显式声明的组合一律拒绝）
- [ ] 恶意上传样本集（zip bomb / zip slip / symlink / 超大 / 伪装 MIME）**100% 被拒且无任何文件落地**
- [ ] `proxy_ceiling` 在数据库之外的**任何路径**均不可读（含管理员接口的字段级测试）
- [ ] 安全响应头 / CSP(nonce) / CSRF / 分层限流断言全部通过
- [ ] 依赖审计无 high/critical（或有书面豁免记录）
- [ ] 审计日志可完整重建**任一次资金变动**与**任一次制品访问**的链路

### 13.3 资金与一致性

- [ ] 五条不变式在属性测试（≥10 万次随机操作）中恒成立
- [ ] 并发出价无超卖、无重复结算
- [ ] `RELEASED` 事务在异常注入下**完全回滚**，不留半成品所有权

### 13.4 运维与架构

- [ ] 备份恢复演练成功
- [ ] trace id 贯穿一次请求的全部日志
- [ ] 架构守护测试通过（无跨模块内部依赖）

---

## 14. 延后决策（含决策时点）

以下事项**明确不在 MVP**，并已指定决策时点，避免范围蔓延：

| 事项 | 延后至 | 决策依据来源 |
|---|---|---|
| 荷兰式降价重拍 | P5 之后 | 真实流量数据（是否有冷启动问题） |
| 服务类标的多属性招标 + 分期托管（70/20/10） | P6 | 服务类交易量 |
| 抄袭 / 相似度检测 | P6 | 举报量与实际侵权案例 |
| 真实支付渠道与提现 | P7 之后 | 合规评估与运营需要 |
| 交换 → 拍卖升级（24h 冷静期） | P3.5 | P3 完成后的实际使用反馈 |
| 是否引入 Gitea / git push 协作 | P5 之后（首次创作者访谈完成后） | 创作者访谈结果 |
| 高级检索（独立搜索引擎） | 视数据量 | 全文检索性能瓶颈是否出现 |
| 自动截图沙箱 | P9 之后（需独立立项） | 是否必须自动化，且能否满足隔离要求 |
| **GitHub OAuth 完整授权流** | **P1（与「发布」同批）** | P0 只交付了 `GithubOauthService`（授权 URL、PKCE、state 生成、令牌交换）及其单元测试。**尚缺**：`/auth/github` 与 `/auth/github/callback` 两条路由、`state` 与 PKCE verifier 的短期 Redis 存储、以及 `Identity` 表的写入方（`auth.identities` 至今无任何写入者）。因此 §4.2 的「校验 `state` 与 `nonce`」与 D4「发布者必须绑定 GitHub OAuth」在 P0 结束时**尚未在实质上满足**。延后理由：P0 没有发布功能，这道门暂时无物可守，为无消费者的流程建路由属于 §2.2 禁止的空抽象。**必须在 P1 落地，届时 D4 的门槛才成立。** |

---

## 15. 风险登记

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| **冷启动 / 双边网络效应** | 交换需要双方在场，早期可能无人可换 | 拍卖先提供单边冷启动；流拍自动转交换；邀请种子创作者；交换邀约数作为公开信号 |
| **平台责任边界**（用户上传恶意或侵权代码） | 法律与声誉风险 | 平台不执行代码；交付前校验；用户协议声明 + 举报下架；争议仲裁 |
| **许可证冲突** | 用户上传非自己所有或含冲突许可证的代码 | 发布时强制声明；举报机制；下架。抄袭检测延后至 P6 |
| **虚拟货币合规** | 若可提现则触及资金池监管 | MVP 明确不可提现、不可转赠、仅站内记账 |
| **保证金威慑力不足** | MVP 使用虚拟额度，悔拍成本不真实 | 测试期人工复核所有悔拍；信誉分惩罚即时生效；转为真实资金前重新评估 |
| **反狙击延长结束时间** | 用户困惑与客服成本 | 硬顶 30 次 / 24h；界面明确提示「有出价则延长」 |
| **加密制品的主密钥丢失** | 所有制品不可恢复 | 主密钥纳入备份与恢复演练范围；key id 支持轮换 |

---

## 16. 附录：竞拍机制调研结论与来源

调研结论（已采纳进 §7）：以「英式加价 + 反狙击延时（60 秒重置）+ Buy-Now + 流拍转交换」为全站默认；排除维克里次价密封（结算语义反直觉、密封价内部可见带来泄价与悔拍风险）；纯反向拍卖不适用于服务售卖，应改为多属性评标。

来源：

- eBay AU 延长竞拍（60 秒重置）：https://abpost.ebay.cn/policy/506
- eBay Buy It Now 规则（首个出价后 BIN 消失）：https://pages.ebay.com.sg/help/sell/contextual/inframe/buyitnow-price-onlineauction.html
- eBay 出价机制说明：https://www.ebay.com/help/buying/bidding/bidding?id=4003
- Flippa 拍卖规则（3–30 天、最小增量、卖家审批竞买人、保留价）：https://support.flippa.com/hc/en-us/articles/360001027595-How-does-an-Auction-work
- Flippa Buy It Now：https://support.flippa.com/hc/en-us/articles/360000944096-How-does-Buy-It-Now-work
- Sedo 域名拍卖（首个报价自动成为开拍价）：https://sedo.cn/uk/sell-domains/domain-auction/
- 密封次价（Vickrey）与真实报价激励：https://chekuri.cs.illinois.edu/teaching/spring2008/Lectures/scribed/Notes11.pdf
- 多属性反向拍卖用于服务选择：https://ouci.dntb.gov.ua/en/works/40eXgjml/

**局限说明**：Flippa / Empire Flippers / Sedo 均未公开机制 A/B 的收入对比数据，因此「卖方收益表现」类判断为经验判断，不作为设计依据；本设计仅采纳了有明确规则来源的机制（反狙击窗口、BIN 消失条件、保留价、卖家审批竞买人）。

---

## 17. 下一步

本设计文档经用户复核确认后，进入 `writing-plans` 技能，为 **P0（安全底座与身份）** 生成第一份实现计划。后续每个子项目各自经历 spec → plan → 实现循环。

**已完成：**

- 工具链验证报告：`docs/superpowers/notes/2026-10-04-toolchain-verification.md`
  （在写计划前对全部版本与关键用法做了真实安装/编译/连库/连容器验证，本文档的修订即由该报告驱动）
- P0 实现计划：`docs/superpowers/plans/2026-10-04-p0-security-foundation.md`
  （9 个任务，TDD，逐步含真实代码与预期命令输出）
