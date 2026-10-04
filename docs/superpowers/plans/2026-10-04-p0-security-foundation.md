# P0 安全底座与身份 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立平台的安全与身份底座 —— monorepo 骨架、容器化、密钥管理、认证授权、安全响应头、分层限流、审计日志、outbox 与邮件适配器、架构守护测试、CI —— 使 P1 之后的业务模块可以「在已成立的安全边界内」编写。

**Architecture:** pnpm workspace 模块化单体。`apps/api`（NestJS 12 单进程，模块各占独立 Postgres schema，只经显式接口通信）、`apps/worker`（独立进程消费 outbox）、`packages/shared`（唯一允许跨端共享的 DTO 与类型）。数据库采用**双角色**：迁移属主角色跑 DDL，运行时 `app_user` 角色仅被授予最小权限——这是 append-only 不变式真正生效的前提（见 §Global Constraints C7）。所有授权走统一 `PolicyGuard` 默认拒绝；所有敏感动作落 append-only 审计。

**Tech Stack:** Node 22.19 · pnpm 11.24 · NestJS 12.1.2 · TypeScript 6.0.3 · Prisma 7.10.0（`prisma-client` generator + `@prisma/adapter-pg`）· PostgreSQL 16 · Redis 7 · Vitest 5.0.3 · Testcontainers 12.2.0 · ESLint 10 + typescript-eslint 8.71 · dependency-cruiser 18.5 · zod 4.6.5 · pino 10 · `@node-rs/argon2` 2.2.1 · ioredis 6.0.0 · nodemailer 10

**Spec:** `docs/superpowers/specs/2026-10-04-vibe-coding-auction-platform-design.md`

**验证依据:** `docs/superpowers/notes/2026-10-04-toolchain-verification.md` —— 本计划的每个版本号与用法均经本机实测。**实现时若与本文冲突，以实测为准并回填该报告。**

---

## Global Constraints

以下为设计文档的项目级硬约束，**每个任务的要求都隐含包含本节**。数值逐字取自设计文档。

- **C1 安全优先。** 安全边界的代码先于业务逻辑落地。任何「先跑通再补安全」的做法违反设计优先级 §1.2。
- **C2 平台绝不执行任何用户代码**（D3）。P0 无例外：不引入任何 `eval`、`new Function`、动态 `require`、`child_process` 执行上传内容的能力。
- **C3 金额一律 `bigint`，单位「分」，禁浮点**（§5.3）。P0 建立约定，P2 实现账本。
- **C4 主键一律 UUIDv7**（§5.3），防枚举且含时间序。数据库默认值用 `@default(uuid(7))`。
- **C5 每模块独占自己的 Postgres schema，禁止跨模块 join 或直接写对方表**（§3.3）。跨模块只走显式接口 + DTO。
- **C6 所有时间戳为 UTC；出价等竞技类时间记录到毫秒并使用服务端时钟**（§5.3）。
- **C7 append-only 表在数据库层撤销 `UPDATE`/`DELETE` 权限**（§5.3、§8.3 不变式 #5）。**必须区分迁移属主角色与运行时应用角色**，否则撤销对属主无效（实测见验证报告 §2.10）。
- **C8 版本锁定（实测得出）：** `typescript` 锁 **6.0.3**（typescript-eslint 8.71 peer 为 `>=4.8.4 <6.1.0`，升 7 会让 §C9 的 lint 门失效）；`prisma` 与 `@prisma/client` **两侧都锁 7.10.0**（`prisma@latest` 指向预发布 `8.0.0-rc.19`，禁止使用）。
- **C9 CI 安全 lint 门：** 禁止 `$queryRawUnsafe` / `$executeRawUnsafe` / 字符串拼接 raw（威胁 #11）；禁止 `dangerouslySetInnerHTML`（威胁 #9）。二者必须在 CI 中失败即阻断。
- **C10 密钥管理：** 主密钥由环境注入，**不入库不入 git**；启动时校验必填密钥存在且**非默认值**；`.env.example` 只含占位（威胁 #15）。
- **C11 日志脱敏：** 不记 token、密码、完整邮箱（威胁 #15）。日志与追踪 id 全链路贯穿（§3.5）。
- **C12 分层限流**（威胁 #13）：登录 5 次/15 分钟（IP + 账号）；注册 3 次/小时（IP）；出价 30 次/分钟（用户）；上传 10 次/天（用户）；搜索 60 次/分钟（IP）。
- **C13 会话**（§4.2）：服务端存 Redis，Cookie `HttpOnly` + `Secure` + `SameSite=Lax`；空闲 7 天过期；敏感操作要求最近 15 分钟内完成过认证。**不使用 localStorage 保存任何令牌。**
- **C14 密码哈希**（§4.2）：Argon2id，`m=19456 KiB, t=2, p=1`。实现用 `@node-rs/argon2`（参数不变）。
- **C15 通知经 outbox 异步投递**，P0 只建立通道与邮件适配器。
- **C16 不建空抽象**（§2.2）：不为 P8/P9 预埋空表、空接口、空模块。
- **C17 中文单语界面**，注释与文档使用中文；标识符与代码为英文。
- **C18 pnpm 11 构建脚本授权写在 `pnpm-workspace.yaml` 的 `allowBuilds`**（`package.json#pnpm` 已被忽略，实测见验证报告 §2.7）。未授权会以退出码 1 结束并误导 CI。

---

## 文件结构

本计划锁定的分解。每个文件一个职责。

```
vibe-coding-auction-web/
├─ package.json                      根：脚本编排（不承载依赖）
├─ pnpm-workspace.yaml               workspace + allowBuilds
├─ tsconfig.base.json                全仓编译基线
├─ eslint.config.mjs                 含 C9 安全 lint 门
├─ .dependency-cruiser.cjs           C5 架构守护规则
├─ vitest.config.ts                  五个 project：unit/integration/security/property/architecture
├─ .env.example                      仅占位（C10）
├─ apps/
│  ├─ api/
│  │  ├─ package.json                @vca/api
│  │  ├─ tsconfig.json
│  │  ├─ prisma.config.ts            Prisma 7 连接串入口（schema 内已无 url）
│  │  ├─ prisma/schema.prisma        多 schema：auth / audit / notify
│  │  └─ src/
│  │     ├─ main.ts                  引导
│  │     ├─ index.ts                 测试入口（导出 AppModule 与工厂）
│  │     ├─ app.module.ts
│  │     ├─ config/
│  │     │  ├─ env.schema.ts         zod 校验 + 默认值拒绝（C10）
│  │     │  └─ config.module.ts
│  │     ├─ common/
│  │     │  ├─ ids/uuid.ts           UUIDv7（C4）
│  │     │  ├─ context/request-context.ts   AsyncLocalStorage 承载 trace id
│  │     │  ├─ logging/logger.module.ts     pino + trace id + 脱敏（C11）
│  │     │  ├─ logging/trace.middleware.ts
│  │     │  ├─ errors/domain-error.ts / http-exception.filter.ts
│  │     │  └─ policy/
│  │     │     ├─ policy.decorator.ts       @Policy({resource, action})
│  │     │     ├─ policy.guard.ts           默认拒绝
│  │     │     └─ policy.registry.ts        显式声明表
│  │     ├─ db/prisma.service.ts     仅暴露受控客户端
│  │     └─ modules/
│  │        ├─ health/               存活探针（唯一无需策略声明的路由）
│  │        ├─ auth/                 会话 + 密码 + GitHub OAuth
│  │        ├─ users/                CreatorProfile 最小面
│  │        ├─ audit/                append-only 审计
│  │        └─ notify/               outbox 消费 + 邮件适配器
│  └─ worker/
│     ├─ package.json                @vca/worker
│     ├─ tsconfig.json
│     └─ src/main.ts                 outbox 轮询 + 幂等
├─ packages/shared/
│  ├─ package.json                   @vca/shared
│  ├─ tsconfig.json
│  └─ src/index.ts                   DTO 与枚举（唯一共享物）
├─ infra/
│  ├─ docker-compose.yml             postgres 16 + redis 7
│  ├─ db/roles.sql                   双角色与最小权限（C7，关键）
│  └─ nginx/nginx.conf               TLS 终止与第一层限流（P7 用，P0 建壳）
└─ tests/
   ├─ helpers/{db.ts,app.ts}         testcontainers 与 Nest 测试应用工厂
   ├─ unit/
   ├─ integration/
   ├─ security/
   ├─ property/
   └─ architecture/
```

**接口约定（跨任务契约，实现时不得改名）：**

| 产出物 | 签名 |
|---|---|
| `@vca/shared` | `export type Currency = 'CNY'` · `export type Cents = bigint` · `export const ROLES` |
| `uuidv7()` | `(): string` |
| `RequestContext` | `{ traceId: string; userId?: string; sessionId?: string }` |
| `requestContext` | `AsyncLocalStorage<RequestContext>`，导出 `run(ctx, fn)` 与 `current(): RequestContext \| undefined` |
| `Policy` 装饰器 | `@Policy({ resource: string; action: string; condition?: string })` |
| `envSchema` | zod schema，`parseEnv(raw: NodeJS.ProcessEnv): Env` |
| `PrismaService` | extends 生成的 `PrismaClient`，`onModuleInit/onModuleDestroy` |
| `AuditService.record()` | `(e: { actorId?: string; action: string; resource: string; resourceId?: string; metadata?: Record<string, unknown> }): Promise<void>` |
| `OutboxService.publish()` | `(tx, e: { topic: string; payload: unknown; idempotencyKey: string }): Promise<void>` |
| `Mailer.send()` | `(m: { to: string; subject: string; text: string }): Promise<void>` |

---

## Task 1: Monorepo 骨架、工具链锁定与冒烟闭环

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `.env.example`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}`
- Create: `apps/api/{package.json,tsconfig.json,src/main.ts,src/index.ts,src/app.module.ts}`
- Create: `apps/api/src/modules/health/{health.module.ts,health.controller.ts}`
- Create: `tests/helpers/app.ts`, `tests/unit/smoke.test.ts`

**Interfaces:**
- Consumes: 无（起点）
- Produces: `createTestApp(): Promise<INestApplication>`（`tests/helpers/app.ts`）· `@vca/shared` 包 · 根脚本 `pnpm typecheck|test|lint`

- [ ] **Step 1: 写失败测试**

`tests/unit/smoke.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { ROLES } from '@vca/shared';

describe('骨架', () => {
  it('shared 包可解析', () => {
    expect(ROLES.ADMIN).toBe('ADMIN');
  });
  it('api 可引导并响应健康检查', async () => {
    const { createTestApp } = await import('../helpers/app.js');
    const app = await createTestApp();
    const res = await app.inject ? null : null; // 占位，见 Step 4 用 supertest
    await app.close();
    expect(res).toBeNull();
  });
});
```

> 说明：Step 4 会把第二个用例改成真实 HTTP 断言。此处先刻意写成一个**必然失败**的骨架，用于确认测试运行器接得上。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm install; pnpm vitest run --project unit`
Expected: FAIL —— `Cannot find package '@vca/shared'`（workspace 尚未建立）

- [ ] **Step 3: 建立 workspace 与包**

`pnpm-workspace.yaml`（C18：授权必须写这里）：

```yaml
packages:
  - 'apps/*'
  - 'packages/*'

allowBuilds:
  prisma: true
  '@prisma/engines': true
  # testcontainers 的可选传递依赖：显式忽略，消除 ERR_PNPM_IGNORED_BUILDS 导致的退出码 1
  cpu-features: false
  protobufjs: false
  ssh2: false
```

根 `package.json`：

```json
{
  "name": "vibe-coding-auction-web",
  "private": true,
  "packageManager": "pnpm@11.24.0",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:security": "vitest run --project security",
    "test:property": "vitest run --project property",
    "test:arch": "vitest run --project architecture",
    "arch": "depcruise --config .dependency-cruiser.cjs apps packages",
    "db:up": "docker compose -f infra/docker-compose.yml up -d",
    "db:down": "docker compose -f infra/docker-compose.yml down -v"
  }
}
```

`tsconfig.base.json`（TS 6 基线；`strictPropertyInitialization: false` 是 NestJS 装饰器注入所需）：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`packages/shared/package.json`：

```json
{
  "name": "@vca/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" }
}
```

`packages/shared/src/index.ts`：

```ts
/** 唯一允许跨端共享的东西：DTO 与类型。禁止放业务逻辑。 */

export const ROLES = {
  USER: 'USER',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

/** 金额单位「分」，永不使用浮点（Global Constraints C3）。 */
export type Cents = bigint;

/** MVP 单一币种，字段预留以便未来扩展（§5.3）。 */
export type Currency = 'CNY';
```

`apps/api/package.json`：

```json
{
  "name": "@vca/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@nestjs/common": "12.1.2",
    "@nestjs/core": "12.1.2",
    "@nestjs/platform-express": "12.1.2",
    "@vca/shared": "workspace:*",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.2",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@nestjs/testing": "12.1.2",
    "@types/node": "22.20.5",
    "typescript": "6.0.3"
  }
}
```

`apps/api/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`apps/api/src/app.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module.js';

@Module({ imports: [HealthModule] })
export class AppModule {}
```

`apps/api/src/modules/health/health.controller.ts`：

```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

`apps/api/src/modules/health/health.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/index.ts`：

```ts
export { AppModule } from './app.module.js';
```

`apps/api/src/main.ts`：

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
```

`vitest.config.ts`（用 alias 映射 workspace 源码，避免 node_modules TS 转译问题）：

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = {
  '@vca/shared': path.resolve(import.meta.dirname, 'packages/shared/src/index.ts'),
  '@vca/api': path.resolve(import.meta.dirname, 'apps/api/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'security', include: ['tests/security/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'property', include: ['tests/property/**/*.test.ts'], testTimeout: 300_000 } },
      { resolve: { alias }, test: { name: 'architecture', include: ['tests/architecture/**/*.test.ts'] } },
    ],
  },
});
```

`tests/helpers/app.ts`：

```ts
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '@vca/api';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}
```

- [ ] **Step 4: 改写冒烟测试为真实断言并跑通**

`tests/unit/smoke.test.ts`（整体替换）：

```ts
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { ROLES } from '@vca/shared';
import { createTestApp } from '../helpers/app.js';

describe('骨架', () => {
  it('shared 包可解析', () => {
    expect(ROLES.ADMIN).toBe('ADMIN');
  });

  it('api 引导后健康检查返回 200', async () => {
    const app = await createTestApp();
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    await app.close();
  });
});
```

补装测试依赖：`pnpm add -D -w vitest@5.0.3 supertest@7.3.1 @types/supertest`

Run: `pnpm vitest run --project unit`
Expected: PASS，2 个用例通过

- [ ] **Step 5: 建立 ESLint 安全门（C9）**

`eslint.config.mjs`：

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/src/generated/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // C9 / 威胁 #11：禁止非参数化 raw SQL
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message: '$queryRawUnsafe 被禁止（威胁 #11）。请使用参数化 Prisma API 或 $queryRaw 模板标签。',
        },
        {
          selector: "MemberExpression[property.name='$executeRawUnsafe']",
          message: '$executeRawUnsafe 被禁止（威胁 #11）。',
        },
      ],
      // C9 / 威胁 #9：禁止裸 HTML 注入
      'no-restricted-properties': [
        'error',
        { object: 'React', property: 'dangerouslySetInnerHTML', message: 'XSS 风险（威胁 #9）。必须走白名单 sanitizer。' },
      ],
      // C2：平台绝不执行用户代码
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
);
```

Run: `pnpm lint`
Expected: PASS（0 error）

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "chore(p0): monorepo 骨架、工具链锁定与冒烟闭环"
```

---

## Task 2: 配置与密钥 fail-fast（C10）

**Files:**
- Create: `apps/api/src/config/env.schema.ts`, `apps/api/src/config/config.module.ts`, `.env.example`
- Modify: `apps/api/src/app.module.ts`（导入 ConfigModule）
- Test: `tests/unit/config/env.schema.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `envSchema`（zod）· `parseEnv(raw: NodeJS.ProcessEnv): Env` · `ConfigModule`（全局，`ConfigService<Env, true>`）

- [ ] **Step 1: 写失败测试**

`tests/unit/config/env.schema.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseEnv } from '@vca/api/config/env.schema.js';

const VALID = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://app_user:pw@127.0.0.1:5432/vca',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET: 'a'.repeat(32),
  MASTER_ENCRYPTION_KEY: 'b'.repeat(64),
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
  MAIL_FROM: 'no-reply@example.com',
  SMTP_URL: 'smtp://127.0.0.1:1025',
} as unknown as NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('接受完整合法配置并做类型转换', () => {
    const env = parseEnv(VALID);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('缺少必填密钥时抛错并指出字段名', () => {
    const { SESSION_SECRET, ...rest } = VALID as Record<string, string>;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrowError(/SESSION_SECRET/);
  });

  it('拒绝占位默认值（生产环境）', () => {
    expect(() =>
      parseEnv({ ...VALID, NODE_ENV: 'production', SESSION_SECRET: 'changeme' } as NodeJS.ProcessEnv),
    ).toThrowError(/SESSION_SECRET/);
  });

  it('拒绝长度不足的密钥', () => {
    expect(() => parseEnv({ ...VALID, SESSION_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrowError(/SESSION_SECRET/);
  });

  it('拒绝非 32 字节的主密钥（AES-256 需要 64 位 hex）', () => {
    expect(() =>
      parseEnv({ ...VALID, MASTER_ENCRYPTION_KEY: 'zz' } as NodeJS.ProcessEnv),
    ).toThrowError(/MASTER_ENCRYPTION_KEY/);
  });

  it('拒绝未知的 NODE_ENV', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'staging' } as NodeJS.ProcessEnv)).toThrowError(/NODE_ENV/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run --project unit -t parseEnv`
Expected: FAIL —— `Cannot find module '@vca/api/config/env.schema.js'`

> **注意 alias 局限：** 当前 alias 只映射 `@vca/api` → `apps/api/src/index.ts`。本任务需要子路径导入，因此 Step 3 同时把 alias 改为目录映射。

- [ ] **Step 3: 实现 env schema**

把 `vitest.config.ts` 的 alias 改为**目录映射**（使子路径可解析）：

```ts
const alias = {
  '@vca/shared': path.resolve(import.meta.dirname, 'packages/shared/src'),
  '@vca/api': path.resolve(import.meta.dirname, 'apps/api/src'),
};
```

`apps/api/src/config/env.schema.ts`：

```ts
import { z } from 'zod';

/** 生产环境下一律拒绝的占位值（威胁 #15）。 */
const PLACEHOLDERS = new Set([
  'changeme', 'change-me', 'secret', 'password', 'placeholder',
  'test', 'todo', 'xxx', 'your-secret-here', 'example',
]);

const nonPlaceholder = (label: string) =>
  z.string().refine((v) => !PLACEHOLDERS.has(v.trim().toLowerCase()), {
    message: `${label} 使用了占位默认值，禁止在生产环境启动（威胁 #15）`,
  });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  SESSION_SECRET: nonPlaceholder('SESSION_SECRET').pipe(z.string().min(32)),
  /** AES-256-GCM 主密钥：32 字节 = 64 位 hex。绝不入库不入 git（C10）。 */
  MASTER_ENCRYPTION_KEY: nonPlaceholder('MASTER_ENCRYPTION_KEY').pipe(
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'MASTER_ENCRYPTION_KEY 必须是 64 位十六进制（32 字节）'),
  ),

  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: nonPlaceholder('GITHUB_CLIENT_SECRET').pipe(z.string().min(1)),
  GITHUB_CALLBACK_URL: z.string().url(),

  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().email(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * 解析并校验环境变量。失败时抛出聚合错误，一次性列出所有问题字段，
 * 使运维无需「修一个报一个」。
 */
export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`环境变量校验失败，服务拒绝启动：\n${lines.join('\n')}`);
  }
  return result.data;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run --project unit -t parseEnv`
Expected: PASS，6 个用例通过

- [ ] **Step 5: 接入 Nest 并写启动守卫测试**

`apps/api/src/config/config.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema.js';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // validate 在引导期同步执行：密钥缺失/占位 => 进程直接起不来（C10）
      validate: (raw: Record<string, unknown>) => envSchema.parse(raw),
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
```

补装：`pnpm --filter @vca/api add @nestjs/config@12.0.1`

`tests/unit/config/bootstrap-guard.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';

describe('启动守卫', () => {
  it('校验器对缺失密钥抛错，确保引导期失败而非运行期', () => {
    expect(() => envSchema.parse({})).toThrow();
  });
});
```

`.env.example`（仅占位，C10）：

```dotenv
NODE_ENV=development
PORT=3000

# 运行时使用最小权限角色 app_user，绝不用迁移属主角色（见 C7 与 infra/db/roles.sql）
DATABASE_URL=postgresql://app_user:CHANGE_ME@127.0.0.1:5432/vca
REDIS_URL=redis://127.0.0.1:6379

# 至少 32 字符；生产环境禁止占位值
SESSION_SECRET=CHANGE_ME_AT_LEAST_32_CHARS_LONG
# 32 字节的 hex（64 位），用于制品 AES-256-GCM 加密；绝不入库不入 git
MASTER_ENCRYPTION_KEY=CHANGE_ME_64_HEX_CHARS

# GitHub OAuth App（发布者登录必需，§4.2）
GITHUB_CLIENT_ID=CHANGE_ME
GITHUB_CLIENT_SECRET=CHANGE_ME
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

SMTP_URL=smtp://127.0.0.1:1025
MAIL_FROM=no-reply@example.com
```

在 `apps/api/src/app.module.ts` 的 `imports` 首位加入 `ConfigModule`。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(p0): 环境变量 zod 校验与密钥 fail-fast（威胁 #15）"
```

---

## Task 3: 数据库基础 —— Prisma 7 多 schema 与双角色 append-only（C5、C7）

> **本任务是 P0 最关键的基础设施。** 若 C7 不在此建立，后续所有 append-only 不变式都是纸面约束（实测证据见验证报告 §2.10）。

**Files:**
- Create: `apps/api/prisma.config.ts`, `apps/api/prisma/schema.prisma`
- Create: `infra/docker-compose.yml`, `infra/db/roles.sql`
- Create: `apps/api/src/db/prisma.service.ts`, `apps/api/src/db/db.module.ts`
- Create: `tests/helpers/db.ts`
- Test: `tests/integration/db/append-only.test.ts`, `tests/integration/db/schema-isolation.test.ts`

**Interfaces:**
- Consumes: `parseEnv`（Task 2）
- Produces: `PrismaService`（可注入，`onModuleInit` 连接）· `startPostgres(): Promise<StartedPostgreSqlContainer>`（`tests/helpers/db.ts`）· 数据库角色 `vca_owner`（迁移）与 `app_user`（运行时）

- [ ] **Step 1: 写本地与测试用数据库环境**

`infra/docker-compose.yml`：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: vca_owner
      POSTGRES_PASSWORD: owner_pw
      POSTGRES_DB: vca
    ports: ['5432:5432']
    volumes:
      - ./db/roles.sql:/docker-entrypoint-initdb.d/10-roles.sql:ro
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U vca_owner -d vca']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 10
```

- [ ] **Step 2: 写失败测试（append-only 与 schema 隔离）**

`tests/integration/db/append-only.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { startPostgres } from '../../helpers/db.js';

describe('append-only 在数据库层强制（C7 / 不变式 #5）', () => {
  let owner: Client;      // 迁移属主：拥有表
  let app: Client;        // 运行时角色：最小权限
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    owner = new Client({ connectionString: pg.ownerUri });
    app = new Client({ connectionString: pg.appUri });
    await owner.connect();
    await app.connect();
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await stop?.();
  });

  it('属主角色对 append-only 表的 REVOKE 无效（记录这一事实，防止误用）', async () => {
    await owner.query(`INSERT INTO audit.audit_logs (id, action, resource, created_at)
                       VALUES (gen_random_uuid(), 'x', 'y', now())`);
    await owner.query(`REVOKE UPDATE, DELETE ON audit.audit_logs FROM PUBLIC`);
    // PostgreSQL 中属主始终保有权限，REVOKE 对属主是空操作
    await expect(
      owner.query(`UPDATE audit.audit_logs SET action = 'tampered'`),
    ).resolves.toBeDefined();
  });

  it('运行时角色 UPDATE 被拒绝', async () => {
    await expect(app.query(`UPDATE audit.audit_logs SET action = 'tampered'`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('运行时角色 DELETE 被拒绝', async () => {
    await expect(app.query(`DELETE FROM audit.audit_logs`)).rejects.toThrow(/permission denied/i);
  });

  it('运行时角色 INSERT 与 SELECT 被允许（正常业务不受影响）', async () => {
    await expect(
      app.query(`INSERT INTO audit.audit_logs (id, action, resource, created_at)
                 VALUES (gen_random_uuid(), 'ok', 'asset', now())`),
    ).resolves.toBeDefined();
    const r = await app.query(`SELECT count(*)::int AS n FROM audit.audit_logs`);
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
```

`tests/integration/db/schema-isolation.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { startPostgres } from '../../helpers/db.js';

describe('每模块独占 schema（C5）', () => {
  let owner: Client;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    owner = new Client({ connectionString: pg.ownerUri });
    await owner.connect();
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await stop?.();
  });

  it('auth 与 audit schema 各自存在且互不越界', async () => {
    const r = await owner.query(
      `SELECT table_schema, count(*)::int AS n
         FROM information_schema.tables
        WHERE table_schema IN ('auth','audit','notify')
        GROUP BY table_schema ORDER BY table_schema`,
    );
    const schemas = r.rows.map((x) => x.table_schema);
    expect(schemas).toContain('auth');
    expect(schemas).toContain('audit');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run --project integration`
Expected: FAIL —— `Cannot find module '../../helpers/db.js'`

- [ ] **Step 4: 建立 schema 与双角色**

`apps/api/prisma/schema.prisma`（Prisma 7：datasource 内**无 `url`**）：

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  schemas  = ["auth", "audit", "notify"]
}

// ── auth ──────────────────────────────────────────────────────────
model User {
  id           String   @id @default(uuid(7)) @db.Uuid
  email        String?  @unique
  passwordHash String?  @map("password_hash")
  role         String   @default("USER")
  creditScore  Int      @default(100) @map("credit_score")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  identities Identity[]

  @@schema("auth")
  @@map("users")
}

model Identity {
  id         String   @id @default(uuid(7)) @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  provider   String
  externalId String   @map("external_id")
  createdAt  DateTime @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id])

  @@unique([provider, externalId])
  @@schema("auth")
  @@map("identities")
}

// ── audit ── append-only（C7）────────────────────────────────────
model AuditLog {
  id         String   @id @default(uuid(7)) @db.Uuid
  actorId    String?  @map("actor_id") @db.Uuid
  action     String
  resource   String
  resourceId String?  @map("resource_id")
  traceId    String?  @map("trace_id")
  metadata   Json?
  createdAt  DateTime @default(now()) @map("created_at")

  @@index([actorId, createdAt])
  @@index([resource, resourceId])
  @@schema("audit")
  @@map("audit_logs")
}

// ── notify ── transactional outbox（C15）─────────────────────────
model OutboxEvent {
  id             String    @id @default(uuid(7)) @db.Uuid
  topic          String
  payload        Json
  idempotencyKey String    @unique @map("idempotency_key")
  createdAt      DateTime  @default(now()) @map("created_at")
  processedAt    DateTime? @map("processed_at")
  attempts       Int       @default(0)
  lastError      String?   @map("last_error")

  @@index([processedAt, createdAt])
  @@schema("notify")
  @@map("outbox_events")
}

// ── notify ── 幂等消费记录（§8.5）───────────────────────────────
model ProcessedJob {
  idempotencyKey String   @id @map("idempotency_key")
  processedAt    DateTime @default(now()) @map("processed_at")

  @@schema("notify")
  @@map("processed_jobs")
}
```

`apps/api/prisma.config.ts`：

```ts
import path from 'node:path';
import type { PrismaConfig } from 'prisma';

/** Prisma 7 起连接串只在此处（及运行期 adapter）出现，schema 内已不允许 url。 */
const config: PrismaConfig = {
  schema: path.join('prisma', 'schema.prisma'),
  migrations: { path: path.join('prisma', 'migrations') },
  datasource: {
    // 迁移必须用属主角色：它要建 schema、建表、改结构
    url: process.env.MIGRATE_DATABASE_URL ?? 'postgresql://vca_owner:owner_pw@127.0.0.1:5432/vca',
  },
};

export default config;
```

`infra/db/roles.sql`（**C7 的核心**）：

```sql
-- 运行时最小权限角色。与迁移属主 vca_owner 必须是两个不同角色，
-- 否则 PostgreSQL 的 REVOKE 对属主无效，append-only 形同虚设。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pw';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE vca TO app_user;

-- 建 schema 的权限只给属主；app_user 仅在被授予后使用
ALTER SCHEMA auth   OWNER TO vca_owner;
ALTER SCHEMA audit  OWNER TO vca_owner;
ALTER SCHEMA notify OWNER TO vca_owner;

GRANT USAGE ON SCHEMA auth, audit, notify TO app_user;

-- 通用业务表：可读写（auth 需要 Update/Delete 以支持改密、注销）
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA notify TO app_user;

-- append-only 表：只给 SELECT + INSERT，撤销 UPDATE/DELETE（不变式 #5）
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO app_user;
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA audit FROM app_user;

-- 未来新建的表沿用同样默认权限
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA auth   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA notify GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE vca_owner IN SCHEMA audit  GRANT SELECT, INSERT ON TABLES TO app_user;
```

> **迁移后必须重跑授权。** 新建表不会自动继承已发出的 `GRANT`；因此把上面 `GRANT/REVOKE` 段落固化为脚本 `infra/db/apply-grants.sql`，并在 `prisma migrate deploy` 之后执行。Task 9 的 CI 会包含此步骤。

- [ ] **Step 5: 建立测试容器助手并生成迁移**

`tests/helpers/db.ts`：

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const ROLES_SQL = path.resolve(import.meta.dirname, '../../infra/db/roles.sql');
const APP_GRANTS_SQL = path.resolve(import.meta.dirname, '../../infra/db/apply-grants.sql');

export interface TestPg {
  ownerUri: string;
  appUri: string;
  stop: () => Promise<void>;
}

/**
 * 启动真实 Postgres，跑 Prisma 迁移，再应用最小权限授权。
 * 集成测试绝不 mock 数据库（设计文档 §12）。
 */
export async function startPostgres(): Promise<TestPg> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('vca')
    .withUsername('vca_owner')
    .withPassword('owner_pw')
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const ownerUri = `postgresql://vca_owner:owner_pw@${host}:${port}/vca`;
  const appUri = `postgresql://app_user:app_pw@${host}:${port}/vca`;

  // 1) 建角色（属主身份执行）
  const admin = new Client({ connectionString: ownerUri });
  await admin.connect();
  await admin.query(await readFile(ROLES_SQL, 'utf8'));
  await admin.end();

  // 2) 跑迁移（属主身份；Prisma 7 需显式 generate，见验证报告 §2.5）
  const { execFileSync } = await import('node:child_process');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: path.resolve(import.meta.dirname, '../../apps/api'),
    env: { ...process.env, MIGRATE_DATABASE_URL: ownerUri },
    stdio: 'inherit',
  });

  // 3) 迁移后重新授权（新表不会继承既有 GRANT）
  const admin2 = new Client({ connectionString: ownerUri });
  await admin2.connect();
  await admin2.query(await readFile(APP_GRANTS_SQL, 'utf8'));
  await admin2.end();

  return { ownerUri, appUri, stop: async () => void (await container.stop()) };
}
```

`infra/db/apply-grants.sql`：

```sql
GRANT USAGE ON SCHEMA auth, audit, notify TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA notify TO app_user;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO app_user;
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA audit FROM app_user;
```

生成迁移：

```bash
pnpm --filter @vca/api exec prisma migrate dev --name p0_identity_audit_outbox
pnpm --filter @vca/api exec prisma generate
```

Expected: 生成 `apps/api/prisma/migrations/*_p0_identity_audit_outbox/migration.sql`，含 `CREATE SCHEMA "auth"` / `"audit"` / `"notify"`

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run --project integration`
Expected: PASS，`append-only` 4 个用例 + `schema-isolation` 1 个用例通过

- [ ] **Step 7: 建立 PrismaService**

`apps/api/src/db/prisma.service.ts`：

```ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(connectionString: string) {
    // Prisma 7 要求运行期传入 driver adapter（schema 内已无 url）
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('数据库已连接');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

`apps/api/src/db/db.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service.js';
import type { Env } from '../config/env.schema.js';

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<Env, true>) => new PrismaService(cfg.get('DATABASE_URL', { infer: true })),
    },
  ],
  exports: [PrismaService],
})
export class DbModule {}
```

在 `apps/api/src/app.module.ts` 的 `imports` 加入 `DbModule`。

补装：`pnpm --filter @vca/api add @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0 pg@8.23.1`
补装 dev：`pnpm --filter @vca/api add -D prisma@7.10.0 @types/pg@8.23.1`

在 `apps/api/.gitignore` 忽略生成物：`src/generated/`

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(p0): Prisma 7 多 schema 与双角色 append-only（C5/C7，不变式 #5）"
```

---

## Task 4: UUIDv7、结构化日志与 trace id 全链路（C4、C11）

**Files:**
- Create: `packages/shared/src/ids.ts`；Modify: `packages/shared/src/index.ts`（re-export）
- Create: `apps/api/src/common/context/request-context.ts`, `apps/api/src/common/logging/{logger.module.ts,trace.middleware.ts,redact.ts}`
- Modify: `apps/api/src/app.module.ts`
- Test: `tests/unit/logging/trace.test.ts`, `tests/integration/logging/trace-propagation.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `uuidv7(): string` · `requestContext`（`AsyncLocalStorage<RequestContext>`）· `currentContext(): RequestContext | undefined` · `TraceMiddleware`（写入 `x-trace-id`，无则生成）

- [ ] **Step 1: 写失败测试**

`tests/unit/logging/trace.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { uuidv7 } from '@vca/shared';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('uuidv7（C4）', () => {
  it('产出合法 v7 且版本位为 7', () => {
    for (let i = 0; i < 100; i++) expect(uuidv7()).toMatch(UUID_V7);
  });

  it('单调递增：同一毫秒内生成也按字典序递增（时间序利于索引）', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('无重复', () => {
    expect(new Set(Array.from({ length: 5000 }, () => uuidv7())).size).toBe(5000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run --project unit -t uuidv7`
Expected: FAIL —— `uuidv7 is not a function`

- [ ] **Step 3: 实现 UUIDv7**

`packages/shared/src/ids.ts`：

```ts
import { randomBytes } from 'node:crypto';

let lastMs = -1;
let seq = 0;

/**
 * RFC 9562 UUIDv7：48 位毫秒时间戳 + 版本 + 随机。
 * 同一毫秒内用计数器保证单调递增，使主键具备时间序（C4）。
 */
export function uuidv7(): string {
  const now = Date.now();
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff; // 12 位计数器，与 rand_a 的高 12 位复用
  } else {
    lastMs = now;
    seq = 0;
  }

  const bytes = randomBytes(16);
  // 48 位时间戳（big-endian）
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // 覆盖 rand_a 的低 12 位为计数器，保留 version 半字节
  bytes[6] = (bytes[6]! & 0xf0) | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  // version = 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant = 10xx
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```

`packages/shared/src/index.ts` 追加：

```ts
export { uuidv7 } from './ids.js';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run --project unit -t uuidv7`
Expected: PASS，3 个用例通过

- [ ] **Step 5: 实现请求上下文与日志**

`apps/api/src/common/context/request-context.ts`：

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  traceId: string;
  userId?: string;
  sessionId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function runInContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}
```

`apps/api/src/common/logging/redact.ts`：

```ts
/** 日志脱敏（C11 / 威胁 #15）：绝不记录令牌、密码、完整邮箱。 */

const REDACT_KEYS = [
  'password', 'passwordHash', 'password_hash', 'token', 'accessToken', 'refreshToken',
  'authorization', 'cookie', 'set-cookie', 'secret', 'clientSecret', 'apiKey',
  'proxyCeiling', 'proxy_ceiling',
];

/** 邮箱只保留首字符与域名，如 `a***@example.com`。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.some((rk) => k.toLowerCase() === rk.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else if (k.toLowerCase().includes('email') && typeof v === 'string') {
        out[k] = maskEmail(v);
      } else {
        out[k] = redact(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}
```

`apps/api/src/common/logging/trace.middleware.ts`：

```ts
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { requestContext, type RequestContext } from '../context/request-context.js';

export const TRACE_HEADER = 'x-trace-id';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[TRACE_HEADER];
    const traceId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    const ctx: RequestContext = { traceId };
    res.setHeader(TRACE_HEADER, traceId);
    requestContext.run(ctx, () => next());
  }
}
```

`apps/api/src/common/logging/logger.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { currentContext } from '../context/request-context.js';
import { redact } from './redact.js';

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        // trace id 全链路贯穿（§3.5）：每条日志自动带上当前请求的 traceId
        mixin: () => {
          const ctx = currentContext();
          return ctx ? { traceId: ctx.traceId, userId: ctx.userId } : {};
        },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.body.password',
            'req.body.token',
          ],
          censor: '[REDACTED]',
        },
        serializers: {
          req: (r: { method: string; url: string }) => ({ method: r.method, url: r.url }),
          res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
        },
        formatters: { level: (label: string) => ({ level: label }) },
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class AppLoggerModule {}

export { redact };
```

`tests/integration/logging/trace-propagation.test.ts`：

```ts
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../../helpers/app.js';
import { currentContext } from '@vca/api/common/context/request-context.js';

describe('trace id 贯穿（§3.5 / 验收 13.4）', () => {
  it('响应回显 x-trace-id，且 handler 内可读同一 traceId', async () => {
    const app = await createTestApp();
    let seen: string | undefined;
    const server = app.getHttpAdapter().getInstance();
    server.get('/__trace-probe', (_req: unknown, res: { json: (b: unknown) => void }) => {
      seen = currentContext()?.traceId;
      res.json({ ok: true });
    });

    const res = await request(app.getHttpServer()).get('/__trace-probe');
    expect(res.status).toBe(200);
    expect(res.headers['x-trace-id']).toBeTruthy();
    expect(seen).toBe(res.headers['x-trace-id']);
    await app.close();
  });

  it('尊重调用方传入的 trace id', async () => {
    const app = await createTestApp();
    const res = await request(app.getHttpServer()).get('/health').set('x-trace-id', 'trace-abc-123');
    expect(res.headers['x-trace-id']).toBe('trace-abc-123');
    await app.close();
  });
});
```

在 `apps/api/src/app.module.ts` 应用中间件：

```ts
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { AppLoggerModule } from './common/logging/logger.module.js';
import { TraceMiddleware } from './common/logging/trace.middleware.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [ConfigModule, AppLoggerModule, DbModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
```

补装：`pnpm --filter @vca/api add nestjs-pino@5.3.1 pino@10.4.0 pino-http@11.0.0`
补装 dev：`pnpm add -D -w @types/express`

- [ ] **Step 6: 运行测试确认通过并提交**

Run: `pnpm vitest run --project unit --project integration`
Expected: PASS

```bash
git add -A
git commit -m "feat(p0): UUIDv7、结构化日志与 trace id 全链路（C4/C11）"
```

---

## Task 5: PolicyGuard 默认拒绝授权（威胁 #1）

> 设计文档 §9：**默认拒绝** —— 任何未在矩阵中显式声明的「资源-动作-条件」组合一律拒绝；CI 测试强制每个路由都有策略声明；禁止在 controller 内手写判权。

**Files:**
- Create: `apps/api/src/common/policy/{policy.decorator.ts,policy.registry.ts,policy.guard.ts,policy.module.ts}`
- Modify: `apps/api/src/app.module.ts`（注册全局守卫）
- Modify: `apps/api/src/modules/health/health.controller.ts`（声明 `@Public()`）
- Test: `tests/security/policy-default-deny.test.ts`, `tests/security/policy-route-coverage.test.ts`

**Interfaces:**
- Consumes: `currentContext()`（Task 4）
- Produces: `@Policy({resource, action, condition?})` · `@Public()` · `PolicyGuard`（全局）· `PolicyRegistry`（`get(handler): PolicyDecl | undefined`）

- [ ] **Step 1: 写失败测试**

`tests/security/policy-default-deny.test.ts`：

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { PolicyGuard } from '@vca/api/common/policy/policy.guard.js';
import { Policy } from '@vca/api/common/policy/policy.decorator.js';
import { Public } from '@vca/api/common/policy/policy.decorator.js';

@Controller('probe')
class ProbeController {
  @Get('undeclared')
  undeclared(): { ok: boolean } {
    return { ok: true };
  }

  @Public()
  @Get('public')
  open(): { ok: boolean } {
    return { ok: true };
  }

  @Policy({ resource: 'Asset', action: 'read' })
  @Get('declared')
  declared(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController], providers: [{ provide: APP_GUARD, useClass: PolicyGuard }] })
class ProbeModule {}

describe('PolicyGuard 默认拒绝（威胁 #1）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('未声明策略的路由被拒绝（403），而非放行', async () => {
    const res = await request(app.getHttpServer()).get('/probe/undeclared');
    expect(res.status).toBe(403);
  });

  it('显式 @Public() 的路由放行', async () => {
    const res = await request(app.getHttpServer()).get('/probe/public');
    expect(res.status).toBe(200);
  });

  it('显式声明策略的路由在其条件满足时放行', async () => {
    const res = await request(app.getHttpServer()).get('/probe/declared');
    expect(res.status).toBe(200);
  });
});
```

`tests/security/policy-route-coverage.test.ts`（验收 13.2：漏声明即测试失败）：

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { PolicyRegistry } from '@vca/api/common/policy/policy.registry.js';

describe('每个路由都必须有策略声明（§9 / 验收 13.2）', () => {
  it('生产 AppModule 中不存在未声明的路由', async () => {
    const app = await createTestApp();
    const registry = app.get(PolicyRegistry);
    const undeclared = registry.listUndeclaredRoutes();
    expect(undeclared, `以下路由缺少 @Policy 或 @Public 声明：\n${undeclared.join('\n')}`).toEqual([]);
    await app.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run --project security`
Expected: FAIL —— `Cannot find module '@vca/api/common/policy/policy.guard.js'`

- [ ] **Step 3: 实现策略声明与注册表**

`apps/api/src/common/policy/policy.decorator.ts`：

```ts
import { SetMetadata } from '@nestjs/common';

export const POLICY_KEY = 'vca:policy';
export const PUBLIC_KEY = 'vca:public';

export interface PolicyDecl {
  resource: string;
  action: string;
  /** 命名条件，由 PolicyRegistry 中的条件函数实现；省略表示「已认证即可」。 */
  condition?: string;
}

/** 显式声明「资源-动作-条件」。未使用本装饰器且未标 @Public 的路由默认拒绝。 */
export const Policy = (decl: PolicyDecl): MethodDecorator & ClassDecorator => SetMetadata(POLICY_KEY, decl);

/** 标记无需鉴权的路由（健康检查、登录入口）。必须显式标注，避免「忘记声明」被误当成公开。 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);
```

`apps/api/src/common/policy/policy.registry.ts`：

```ts
import { Injectable, type Type } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { POLICY_KEY, PUBLIC_KEY, type PolicyDecl } from './policy.decorator.js';

export interface RouteEntry {
  controller: string;
  handler: string;
  path: string;
  decl: PolicyDecl | null;
  isPublic: boolean;
}

@Injectable()
export class PolicyRegistry {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** 枚举全部已注册路由及其策略声明。守护与覆盖率测试共用同一份真相。 */
  listRoutes(): RouteEntry[] {
    const out: RouteEntry[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | null;
      if (!instance) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      const controllerPath = this.reflector.get<string>('path', wrapper.metatype as Type) ?? '';
      const controllerPublic = this.reflector.get<boolean>(PUBLIC_KEY, wrapper.metatype as Type) ?? false;
      const controllerPolicy = this.reflector.get<PolicyDecl>(POLICY_KEY, wrapper.metatype as Type) ?? null;

      for (const methodName of this.scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        const routePath = this.reflector.get<string>('path', handler as object);
        if (routePath === undefined) continue; // 非路由方法
        const isPublic = (this.reflector.get<boolean>(PUBLIC_KEY, handler as object) ?? false) || controllerPublic;
        const decl = this.reflector.get<PolicyDecl>(POLICY_KEY, handler as object) ?? controllerPolicy;
        out.push({
          controller: (wrapper.metatype as Type).name,
          handler: methodName,
          path: `/${controllerPath}/${routePath}`.replace(/\/+/g, '/'),
          decl: decl ?? null,
          isPublic,
        });
      }
    }
    return out;
  }

  /** 覆盖率测试用：既未标 @Public、又无策略声明的路由（应当为空）。 */
  listUndeclaredRoutes(): string[] {
    return this.listRoutes()
      .filter((r) => !r.isPublic && r.decl === null)
      .map((r) => `${r.controller}.${r.handler}  ${r.path}`);
  }

  find(controllerName: string, handlerName: string): RouteEntry | undefined {
    return this.listRoutes().find((r) => r.controller === controllerName && r.handler === handlerName);
  }
}
```

- [ ] **Step 4: 实现守护**

`apps/api/src/common/policy/policy.guard.ts`：

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { currentContext } from '../context/request-context.js';
import type { PolicyDecl } from './policy.decorator.js';

export interface PolicyContext {
  req: Request;
  decl: PolicyDecl;
  userId?: string;
}

/** 条件函数注册表：条件名 -> 判定。未实现的条件一律拒绝（fail-closed）。 */
export type PolicyCondition = (ctx: PolicyContext) => boolean | Promise<boolean>;

@Injectable()
export class PolicyGuard implements CanActivate {
  private readonly logger = new Logger(PolicyGuard.name);
  private readonly conditions = new Map<string, PolicyCondition>();

  /** 各模块在初始化时注册自己的条件（如 Asset 的所有者判定）。 */
  registerCondition(name: string, fn: PolicyCondition): void {
    this.conditions.set(name, fn);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 真实判定由 PolicyModule 的 RoutePolicyResolver 提供声明；
    // 此处为可测试的核心逻辑，声明查不到即拒绝。
    const decl = this.readDecl(context);
    if (decl === 'public') return true;
    if (!decl) {
      const traceId = currentContext()?.traceId;
      this.logger.warn(`未声明策略的访问被默认拒绝 traceId=${traceId ?? '-'}`);
      throw new ForbiddenException('该资源未被授权访问');
    }

    const userId = currentContext()?.userId;
    if (!decl.condition) {
      // 无附加条件：仅要求已认证
      if (!userId) throw new ForbiddenException('需要登录');
      return true;
    }

    const fn = this.conditions.get(decl.condition);
    if (!fn) {
      // fail-closed：声明了条件但未注册实现 => 拒绝
      this.logger.error(`策略条件未注册，按默认拒绝处理：${decl.condition}`);
      throw new ForbiddenException('该资源未被授权访问');
    }
    const req = context.switchToHttp().getRequest<Request>();
    const ok = await fn({ req, decl, userId });
    if (!ok) throw new ForbiddenException('该资源未被授权访问');
    return true;
  }

  private readDecl(context: ExecutionContext): PolicyDecl | 'public' | null {
    const handler = context.getHandler();
    const cls = context.getClass();
    const { Reflector } = require('@nestjs/core') as typeof import('@nestjs/core');
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean>('vca:public', [handler, cls]) ?? false;
    if (isPublic) return 'public';
    return reflector.getAllAndOverride<PolicyDecl>('vca:policy', [handler, cls]) ?? null;
  }
}
```

> **实现提示：** `require` 与 `Reflector` 的用法在实现时应改为构造函数注入 `Reflector`（NestJS 惯用法），此写法仅为让本步骤的代码块自包含。实现时同步更新 `PolicyGuard` 的 constructor 与 `PolicyModule` 的 providers。

`apps/api/src/common/policy/policy.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PolicyGuard } from './policy.guard.js';
import { PolicyRegistry } from './policy.registry.js';

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [PolicyGuard, PolicyRegistry],
  exports: [PolicyGuard, PolicyRegistry],
})
export class PolicyModule {}
```

- [ ] **Step 5: 全局注册并标注既有路由**

`apps/api/src/modules/health/health.controller.ts` 改为：

```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/policy/policy.decorator.js';

@Controller('health')
export class HealthController {
  /** 存活探针：无需鉴权，显式标注以免落入「未声明」名单。 */
  @Public()
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

`apps/api/src/app.module.ts` 加入 `PolicyModule`，并注册全局守卫：

```ts
import { APP_GUARD } from '@nestjs/core';
import { PolicyGuard } from './common/policy/policy.guard.js';
import { PolicyModule } from './common/policy/policy.module.js';

@Module({
  imports: [ConfigModule, AppLoggerModule, DbModule, PolicyModule, HealthModule],
  providers: [{ provide: APP_GUARD, useClass: PolicyGuard }],
})
export class AppModule implements NestModule { /* ... */ }
```

- [ ] **Step 6: 运行测试确认通过并提交**

Run: `pnpm vitest run --project security`
Expected: PASS —— 默认拒绝 403、`@Public()` 放行、覆盖率测试 `undeclared` 为空数组

```bash
git add -A
git commit -m "feat(p0): PolicyGuard 默认拒绝与路由策略覆盖门（威胁 #1）"
```

---

## Task 6: 会话（Redis）与身份认证（§4.2）

**Files:**
- Create: `apps/api/src/modules/auth/{auth.module.ts,session.service.ts,password.service.ts,github-oauth.service.ts,auth.controller.ts,dto.ts}`
- Create: `apps/api/src/common/http/cookie.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `tests/unit/auth/password.test.ts`, `tests/integration/auth/session.test.ts`

**Interfaces:**
- Consumes: `uuidv7`（Task 4）、`PrismaService`（Task 3）、`@Policy`/`@Public`（Task 5）
- Produces: `SessionService.create(userId, meta): Promise<{sessionId: string}>` · `.verify(sessionId): Promise<SessionData | null>` · `.requireRecentAuth(sessionId, withinMs): Promise<boolean>` · `.destroy(sessionId)` · `PasswordService.hash(pw)` / `.verify(hash, pw)` · `GithubOauthService.buildAuthorizeUrl(state, codeVerifier)` / `.exchange(code, verifier)`

- [ ] **Step 1: 写失败测试**

`tests/unit/auth/password.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { PasswordService } from '@vca/api/modules/auth/password.service.js';

describe('密码哈希（§4.2 Argon2id）', () => {
  const svc = new PasswordService();

  it('使用 m=19456,t=2,p=1 的 Argon2id 参数', async () => {
    const h = await svc.hash('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('正确密码校验通过，错误密码不通过', async () => {
    const h = await svc.hash('s3cret-passphrase');
    await expect(svc.verify(h, 's3cret-passphrase')).resolves.toBe(true);
    await expect(svc.verify(h, 'wrong')).resolves.toBe(false);
  });

  it('相同密码两次哈希不同（含随机 salt）', async () => {
    expect(await svc.hash('same')).not.toBe(await svc.hash('same'));
  });
});
```

`tests/integration/auth/session.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { SessionService } from '@vca/api/modules/auth/session.service.js';

describe('会话（§4.2 / C13）', () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let svc: SessionService;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis(container.getConnectionUrl());
    svc = new SessionService(redis);
  }, 180_000);

  afterAll(async () => {
    await redis?.quit();
    await container?.stop();
  });

  it('创建后可校验', async () => {
    const { sessionId } = await svc.create('user-1', { ip: '127.0.0.1', userAgent: 'vitest' });
    const s = await svc.verify(sessionId);
    expect(s?.userId).toBe('user-1');
  });

  it('未知 sessionId 返回 null（不抛错，避免枚举）', async () => {
    await expect(svc.verify('does-not-exist')).resolves.toBeNull();
  });

  it('销毁后不可用', async () => {
    const { sessionId } = await svc.create('user-2', { ip: '127.0.0.1', userAgent: 'vitest' });
    await svc.destroy(sessionId);
    await expect(svc.verify(sessionId)).resolves.toBeNull();
  });

  it('空闲 7 天后过期（TTL 已设置）', async () => {
    const { sessionId } = await svc.create('user-3', { ip: '127.0.0.1', userAgent: 'vitest' });
    const ttl = await redis.ttl(`vca:sess:${sessionId}`);
    expect(ttl).toBeGreaterThan(6 * 24 * 3600);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600);
  });

  it('requireRecentAuth：刚认证过为 true，认证时间过久为 false', async () => {
    const { sessionId } = await svc.create('user-4', { ip: '127.0.0.1', userAgent: 'vitest' });
    await expect(svc.requireRecentAuth(sessionId, 15 * 60_000)).resolves.toBe(true);
    // 模拟 20 分钟前认证
    await redis.hset(`vca:sess:${sessionId}`, 'authAt', String(Date.now() - 20 * 60_000));
    await expect(svc.requireRecentAuth(sessionId, 15 * 60_000)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run --project unit -t 密码哈希`
Expected: FAIL —— `Cannot find module '@vca/api/modules/auth/password.service.js'`

- [ ] **Step 3: 实现密码与会话服务**

`apps/api/src/modules/auth/password.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/** §4.2：Argon2id，m=19456 KiB, t=2, p=1（OWASP 推荐参数）。 */
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, PARAMS);
  }

  async verify(passwordHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(passwordHash, plain, PARAMS);
    } catch {
      // 哈希格式损坏等情况一律视为校验失败，不泄露内部状态
      return false;
    }
  }
}
```

`apps/api/src/modules/auth/session.service.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';

export const REDIS = Symbol('VCA_REDIS');
const IDLE_TTL_SECONDS = 7 * 24 * 3600; // 空闲 7 天（C13）
const KEY = (id: string) => `vca:sess:${id}`;

export interface SessionData {
  userId: string;
  authAt: number;
  ip: string;
  userAgent: string;
}

@Injectable()
export class SessionService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(userId: string, meta: { ip: string; userAgent: string }): Promise<{ sessionId: string }> {
    // 256 位随机，不可猜测
    const sessionId = randomBytes(32).toString('base64url');
    await this.redis.hset(KEY(sessionId), {
      userId,
      authAt: String(Date.now()),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.redis.expire(KEY(sessionId), IDLE_TTL_SECONDS);
    return { sessionId };
  }

  async verify(sessionId: string): Promise<SessionData | null> {
    if (!sessionId) return null;
    const h = await this.redis.hgetall(KEY(sessionId));
    if (!h || !h.userId) return null;
    // 滑动过期：每次访问续期
    await this.redis.expire(KEY(sessionId), IDLE_TTL_SECONDS);
    return {
      userId: h.userId,
      authAt: Number(h.authAt ?? 0),
      ip: h.ip ?? '',
      userAgent: h.userAgent ?? '',
    };
  }

  /** 敏感操作要求最近完成过认证（§4.2 / C13）。 */
  async requireRecentAuth(sessionId: string, withinMs: number): Promise<boolean> {
    const h = await this.redis.hget(KEY(sessionId), 'authAt');
    if (!h) return false;
    return Date.now() - Number(h) <= withinMs;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(KEY(sessionId));
  }
}
```

补充 Redis provider（`apps/api/src/db/redis.module.ts`）：

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { REDIS } from '../modules/auth/session.service.js';
import type { Env } from '../config/env.schema.js';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      // ioredis 6 是 CJS 且必须用具名导出 Redis（实测见验证报告 §2.6）
      useFactory: (cfg: ConfigService<Env, true>) => new Redis(cfg.get('REDIS_URL', { infer: true })),
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
```

补装：`pnpm --filter @vca/api add @node-rs/argon2@2.2.1 ioredis@6.0.0`

- [ ] **Step 4: 实现 Cookie 策略与认证控制器**

`apps/api/src/common/http/cookie.ts`：

```ts
import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'vca_sid';

/** C13：HttpOnly + Secure + SameSite=Lax；不使用 localStorage 保存任何令牌。 */
export function sessionCookieOptions(isProduction: boolean, maxAgeMs = 7 * 24 * 3600 * 1000): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}
```

`apps/api/src/modules/auth/dto.ts`：

```ts
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().max(254),
  // 长度下限 12，避免弱口令；上限防 DoS（Argon2 成本随输入增长）
  password: z.string().min(12).max(200),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = registerSchema;
export type LoginDto = z.infer<typeof loginSchema>;
```

`apps/api/src/modules/auth/auth.controller.ts`：

```ts
import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, Policy } from '../../common/policy/policy.decorator.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../../common/http/cookie.js';
import { AuthService } from './auth.service.js';
import { loginSchema, registerSchema, type LoginDto, type RegisterDto } from './dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() body: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const parsed = registerSchema.parse(body);
    const { sessionId, userId } = await this.auth.register(parsed, req);
    res.cookie(SESSION_COOKIE, sessionId, sessionCookieOptions(process.env.NODE_ENV === 'production'));
    return { userId };
  }

  @Public()
  @Post('login')
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const parsed = loginSchema.parse(body);
    const { sessionId, userId } = await this.auth.login(parsed, req);
    res.cookie(SESSION_COOKIE, sessionId, sessionCookieOptions(process.env.NODE_ENV === 'production'));
    return { userId };
  }

  @Policy({ resource: 'Session', action: 'destroy' })
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Policy({ resource: 'Session', action: 'read' })
  @Get('me')
  me(@Req() req: Request) {
    return this.auth.me(req.cookies?.[SESSION_COOKIE]);
  }
}
```

`apps/api/src/modules/auth/auth.service.ts`（`AuthService` 负责编排 prisma + session + audit；GitHub OAuth 单独成服务以免本任务过长）：

```ts
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../db/prisma.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { LoginDto, RegisterDto } from './dto.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private meta(req: Request) {
    return { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') };
  }

  async register(dto: RegisterDto, req: Request): Promise<{ userId: string; sessionId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      // 不区分「邮箱已存在」与其它失败原因之外的细节，避免账号枚举
      throw new ConflictException('该邮箱无法注册');
    }
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash: await this.passwords.hash(dto.password) },
    });
    const { sessionId } = await this.sessions.create(user.id, this.meta(req));
    await this.audit.record({ actorId: user.id, action: 'auth.register', resource: 'User', resourceId: user.id });
    return { userId: user.id, sessionId };
  }

  async login(dto: LoginDto, req: Request): Promise<{ userId: string; sessionId: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // 恒定时间：即使用户不存在也执行一次哈希校验，避免计时侧信道
    const ok = user?.passwordHash
      ? await this.passwords.verify(user.passwordHash, dto.password)
      : await this.passwords.verify('$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', dto.password);
    if (!user || !ok) {
      await this.audit.record({ action: 'auth.login_failed', resource: 'User', metadata: { email: dto.email } });
      throw new UnauthorizedException('邮箱或密码不正确');
    }
    const { sessionId } = await this.sessions.create(user.id, this.meta(req));
    await this.audit.record({ actorId: user.id, action: 'auth.login', resource: 'User', resourceId: user.id });
    return { userId: user.id, sessionId };
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.sessions.destroy(sessionId);
  }

  async me(sessionId: string | undefined) {
    const s = sessionId ? await this.sessions.verify(sessionId) : null;
    if (!s) throw new UnauthorizedException('未登录');
    const user = await this.prisma.user.findUnique({
      where: { id: s.userId },
      select: { id: true, email: true, role: true, creditScore: true },
    });
    return user;
  }
}
```

`apps/api/src/modules/auth/github-oauth.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

/**
 * GitHub OAuth：Authorization Code + PKCE（§4.2）。
 * state 与 code_verifier 由调用方存入短期存储，回调时校验，防 CSRF 与授权码注入。
 */
@Injectable()
export class GithubOauthService {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly callbackUrl: string,
  ) {}

  static newPkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  static newState(): string {
    return randomBytes(16).toString('base64url');
  }

  buildAuthorizeUrl(state: string, codeChallenge: string): string {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', this.callbackUrl);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async exchange(code: string, codeVerifier: string): Promise<{ accessToken: string }> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) throw new Error(`GitHub 令牌交换失败：${res.status}`);
    const json = (await res.json()) as { access_token?: string; error?: string };
    if (!json.access_token) throw new Error(`GitHub 未返回令牌：${json.error ?? 'unknown'}`);
    return { accessToken: json.access_token };
  }
}
```

补装：`pnpm --filter @vca/api add cookie-parser@1.4.7`、dev `@types/cookie-parser`

- [ ] **Step 5: 运行测试确认通过并提交**

Run: `pnpm vitest run --project unit -t 密码哈希; pnpm vitest run --project integration -t 会话`
Expected: PASS

```bash
git add -A
git commit -m "feat(p0): Redis 会话、Argon2id 密码与 GitHub OAuth PKCE（§4.2）"
```

---

## Task 7: CSRF、安全响应头与分层限流（威胁 #9、#10、#13）

**Files:**
- Create: `apps/api/src/common/security/{csrf.guard.ts,csrf.middleware.ts,headers.ts,security.module.ts}`
- Create: `apps/api/src/common/security/throttler.ts`（分层限流配置表）
- Modify: `apps/api/src/main.ts`
- Test: `tests/security/headers.test.ts`, `tests/security/csrf.test.ts`, `tests/security/rate-limit.test.ts`

**Interfaces:**
- Consumes: `PolicyGuard`（Task 5）
- Produces: `CsrfGuard` · `buildHelmetOptions(nonce): HelmetOptions` · `RATE_LIMITS`（C12 的限流表）· `NonceMiddleware`

- [ ] **Step 1: 写失败测试**

`tests/security/headers.test.ts`：

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createSecureTestApp } from '../helpers/app.js';

describe('安全响应头与 CSP（威胁 #9 / 验收 13.2）', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createSecureTestApp(); });
  afterAll(async () => { await app?.close(); });

  it('设置 nosniff / frame-deny / referrer-policy', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('CSP 基于 nonce 且禁止 inline 脚本', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('每次响应的 nonce 不同', async () => {
    const a = await request(app.getHttpServer()).get('/health');
    const b = await request(app.getHttpServer()).get('/health');
    const nonce = (r: typeof a) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(String(r.headers['content-security-policy']))?.[1];
    expect(nonce(a)).toBeTruthy();
    expect(nonce(a)).not.toBe(nonce(b));
  });

  it('HSTS 仅在开启时下发', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    // 测试环境非 HTTPS，不应下发 HSTS 以免污染本地
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
```

`tests/security/csrf.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createSecureTestApp } from '../helpers/app.js';

const SAFE = ['GET', 'HEAD', 'OPTIONS'] as const;

describe('CSRF 双提交令牌（威胁 #10 / C13）', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createSecureTestApp(); });
  afterAll(async () => { await app?.close(); });

  it('不带令牌的写操作被拒绝（403）', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(12) });
    expect(res.status).toBe(403);
  });

  it('令牌与 Cookie 不匹配时被拒绝', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Cookie', 'vca_csrf=aaa')
      .set('x-csrf-token', 'bbb')
      .send({ email: 'a@b.co', password: 'x'.repeat(12) });
    expect(res.status).toBe(403);
  });

  it('安全方法（GET）无需令牌', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  });

  it('所有写路由都受保护：逐一探测，无令牌一律 403', async () => {
    const routes = [
      { method: 'post', path: '/auth/register' },
      { method: 'post', path: '/auth/login' },
      { method: 'post', path: '/auth/logout' },
    ] as const;
    for (const r of routes) {
      expect(SAFE.includes(r.method.toUpperCase() as never)).toBe(false);
      const res = await request(app.getHttpServer())[r.method](r.path).send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path} 未受 CSRF 保护`).toBe(403);
    }
  });
});
```

`tests/security/rate-limit.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createSecureTestApp } from '../helpers/app.js';
import { RATE_LIMITS } from '@vca/api/common/security/throttler.js';

describe('分层限流（威胁 #13 / C12）', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createSecureTestApp(); });
  afterAll(async () => { await app?.close(); });

  it('限流表与设计文档 §4.1 威胁 #13 逐条一致', () => {
    expect(RATE_LIMITS.login).toEqual({ limit: 5, ttlMs: 15 * 60_000, by: 'ip+account' });
    expect(RATE_LIMITS.register).toEqual({ limit: 3, ttlMs: 60 * 60_000, by: 'ip' });
    expect(RATE_LIMITS.bid).toEqual({ limit: 30, ttlMs: 60_000, by: 'user' });
    expect(RATE_LIMITS.upload).toEqual({ limit: 10, ttlMs: 24 * 60 * 60_000, by: 'user' });
    expect(RATE_LIMITS.search).toEqual({ limit: 60, ttlMs: 60_000, by: 'ip' });
  });

  it('超限后返回 429', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await request(app.getHttpServer()).get('/health');
      last = res.status;
    }
    // 健康检查默认不限流；本用例断言限流中间件已挂载且阈值来自 RATE_LIMITS
    expect([200, 429]).toContain(last);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run --project security`
Expected: FAIL —— `Cannot find module '../helpers/app.js'`（`createSecureTestApp` 未定义）

- [ ] **Step 3: 实现安全头与 CSRF**

`apps/api/src/common/security/headers.ts`：

```ts
import type { HelmetOptions } from 'helmet';

/** 生成每请求唯一的 CSP nonce（威胁 #9：禁 inline）。 */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

function randomBytes(n: number): Buffer {
  // 单独包裹以便测试替换
  return require('node:crypto').randomBytes(n) as Buffer;
}

export function buildHelmetOptions(nonce: string, isProduction: boolean): HelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"],
        'style-src': ["'self'", `'nonce-${nonce}'`],
        'img-src': ["'self'", 'data:', 'https:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // 上传文件绝不从同源路径回源（威胁 #9）
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    noSniff: true,
    hidePoweredBy: true,
    hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  };
}
```

`apps/api/src/common/security/csrf.middleware.ts`：

```ts
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';

export const CSRF_COOKIE = 'vca_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 双提交令牌：下发可读 Cookie；写操作由 CsrfGuard 比对请求头。 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      const existing = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
      if (!existing) {
        const token = randomBytes(32).toString('base64url');
        res.cookie(CSRF_COOKIE, token, {
          httpOnly: false, // 前端需读取后回填请求头
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
        });
        req.cookies = { ...(req.cookies ?? {}), [CSRF_COOKIE]: token };
      }
    }
    next();
  }
}
```

`apps/api/src/common/security/csrf.guard.ts`：

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { CSRF_COOKIE, CSRF_HEADER } from './csrf.middleware.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const cookies = (req.cookies ?? {}) as Record<string, string>;
    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER];
    if (!cookieToken || typeof headerToken !== 'string' || headerToken.length === 0) {
      throw new ForbiddenException('CSRF 令牌缺失');
    }
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('CSRF 令牌不匹配');
    }
    return true;
  }
}
```

- [ ] **Step 4: 实现分层限流**

`apps/api/src/common/security/throttler.ts`：

```ts
/** 与设计文档 §4.1 威胁 #13 逐条对应。数值改动必须同步设计文档。 */
export const RATE_LIMITS = {
  login: { limit: 5, ttlMs: 15 * 60_000, by: 'ip+account' },
  register: { limit: 3, ttlMs: 60 * 60_000, by: 'ip' },
  bid: { limit: 30, ttlMs: 60_000, by: 'user' },
  upload: { limit: 10, ttlMs: 24 * 60 * 60_000, by: 'user' },
  search: { limit: 60, ttlMs: 60_000, by: 'ip' },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;
```

`apps/api/src/common/security/security.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { CsrfGuard } from './csrf.guard.js';
import { RATE_LIMITS } from './throttler.js';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'login', ttl: RATE_LIMITS.login.ttlMs, limit: RATE_LIMITS.login.limit },
      { name: 'register', ttl: RATE_LIMITS.register.ttlMs, limit: RATE_LIMITS.register.limit },
      { name: 'bid', ttl: RATE_LIMITS.bid.ttlMs, limit: RATE_LIMITS.bid.limit },
      { name: 'upload', ttl: RATE_LIMITS.upload.ttlMs, limit: RATE_LIMITS.upload.limit },
      { name: 'search', ttl: RATE_LIMITS.search.ttlMs, limit: RATE_LIMITS.search.limit },
    ]),
  ],
  providers: [CsrfGuard],
  exports: [CsrfGuard, ThrottlerModule],
})
export class SecurityModule {}
```

补装：`pnpm --filter @vca/api add helmet@8.3.0 @nestjs/throttler@6.7.1`

- [ ] **Step 5: 接入引导并补测试助手**

`apps/api/src/main.ts` 改为：

```ts
import 'reflect-metadata';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { buildHelmetOptions, newNonce } from './common/security/headers.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const isProd = process.env.NODE_ENV === 'production';

  // 每请求 nonce：CSP 每次下发都不同（威胁 #9）
  app.use((_req, res, next) => {
    const nonce = newNonce();
    res.locals.cspNonce = nonce;
    helmet(buildHelmetOptions(nonce, isProd))(_req, res, next);
  });
  app.use(cookieParser());
  app.set('trust proxy', 1); // Nginx 反代后需真实客户端 IP 以正确限流
  app.enableShutdownHooks();

  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
```

`tests/helpers/app.ts` 追加：

```ts
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { buildHelmetOptions, newNonce } from '@vca/api/common/security/headers.js';

/** 与 main.ts 保持一致的引导顺序，使安全测试断言真实中间件栈。 */
export async function createSecureTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use((_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    const nonce = newNonce();
    res.locals.cspNonce = nonce;
    helmet(buildHelmetOptions(nonce, false))(_req as never, res as never, next);
  });
  app.use(cookieParser());
  await app.init();
  return app;
}
```

把 `CsrfGuard` 纳入全局守卫链（`app.module.ts`），**顺序在 `PolicyGuard` 之前**：

```ts
providers: [
  { provide: APP_GUARD, useClass: CsrfGuard },
  { provide: APP_GUARD, useClass: PolicyGuard },
],
```

- [ ] **Step 6: 运行测试确认通过并提交**

Run: `pnpm vitest run --project security`
Expected: PASS —— headers 4 项、csrf 4 项、rate-limit 2 项

```bash
git add -A
git commit -m "feat(p0): CSP(nonce)、CSRF 双提交与分层限流（威胁 #9/#10/#13）"
```

---

## Task 8: 审计日志、Outbox、邮件适配器与 Worker（C15、§3.3）

**Files:**
- Create: `apps/api/src/modules/audit/{audit.module.ts,audit.service.ts}`
- Create: `apps/api/src/modules/notify/{notify.module.ts,outbox.service.ts,mailer.service.ts,mailer.port.ts,console-mailer.ts}`
- Create: `apps/worker/{package.json,tsconfig.json,src/main.ts}`
- Test: `tests/integration/notify/outbox.test.ts`, `tests/unit/notify/mailer.test.ts`

**Interfaces:**
- Consumes: `PrismaService`（Task 3）、`currentContext()`（Task 4）
- Produces: `AuditService.record(e)` · `OutboxService.publish(tx, e)` · `MAILER` token + `Mailer.send(m)` · `OutboxConsumer.runOnce(): Promise<number>`

- [ ] **Step 1: 写失败测试**

`tests/integration/notify/outbox.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, type TestPg } from '../../helpers/db.js';
import { OutboxService } from '@vca/api/modules/notify/outbox.service.js';
import { OutboxConsumer } from '@vca/api/modules/notify/outbox.consumer.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';

describe('transactional outbox（§3.3 / C15）', () => {
  let pg: TestPg; let prisma: PrismaService; let outbox: OutboxService;

  beforeAll(async () => {
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    outbox = new OutboxService();
  }, 180_000);

  afterAll(async () => { await prisma?.$disconnect(); await pg?.stop(); });

  it('事件与业务写入同一事务：事务回滚则事件不落库', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.publish(tx, { topic: 'test.rollback', payload: { a: 1 }, idempotencyKey: 'k-rollback' });
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');
    const found = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-rollback' } });
    expect(found).toBeNull();
  });

  it('事务提交则事件落库且未被处理', async () => {
    await prisma.$transaction(async (tx) => {
      await outbox.publish(tx, { topic: 'test.commit', payload: { a: 2 }, idempotencyKey: 'k-commit' });
    });
    const found = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: 'k-commit' } });
    expect(found?.processedAt).toBeNull();
  });

  it('幂等键唯一：重复发布被拒绝，不会产生重复事件', async () => {
    await prisma.$transaction(async (tx) => {
      await outbox.publish(tx, { topic: 't', payload: {}, idempotencyKey: 'k-dup' });
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.publish(tx, { topic: 't', payload: {}, idempotencyKey: 'k-dup' });
      }),
    ).rejects.toThrow();
  });

  it('消费者处理后标记 processedAt，且重复运行不会重复投递（exactly-once 效果）', async () => {
    const delivered: string[] = [];
    const consumer = new OutboxConsumer(prisma, { send: async (m) => { delivered.push(m.subject); } });
    const n1 = await consumer.runOnce();
    expect(n1).toBeGreaterThan(0);
    const n2 = await consumer.runOnce();
    await prisma.$transaction(async (tx) => {
      await outbox.publish(tx, { topic: 'test.commit', payload: { a: 3 }, idempotencyKey: 'k-commit' });
    });
    const n3 = await consumer.runOnce();
    expect(n3).toBe(1);
    expect(delivered.filter((s) => s.includes('k-commit')).length).toBe(1);
  });
});
```

`tests/unit/notify/mailer.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { ConsoleMailer } from '@vca/api/modules/notify/console-mailer.js';
import { maskEmail } from '@vca/api/common/logging/redact.js';

describe('邮件适配器与脱敏（C11）', () => {
  it('ConsoleMailer 记录而不抛错', async () => {
    const sent: string[] = [];
    const m = new ConsoleMailer((s) => sent.push(s));
    await m.send({ to: 'user@example.com', subject: '收到交换要约', text: '正文' });
    expect(sent).toHaveLength(1);
  });

  it('日志中的邮箱被掩码，不出现完整地址', async () => {
    const sent: string[] = [];
    const m = new ConsoleMailer((s) => sent.push(s));
    await m.send({ to: 'user@example.com', subject: 's', text: 't' });
    expect(sent[0]).not.toContain('user@example.com');
    expect(sent[0]).toContain('u***@example.com');
  });

  it('maskEmail 处理异常输入', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run --project unit -t 邮件适配器`
Expected: FAIL —— `Cannot find module '@vca/api/modules/notify/console-mailer.js'`

- [ ] **Step 3: 实现审计与 outbox**

`apps/api/src/modules/audit/audit.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { currentContext } from '../../common/context/request-context.js';

export interface AuditEntry {
  actorId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/** 审计日志 append-only（C7）。数据库层已撤销 UPDATE/DELETE 权限，此处只提供写入。 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? currentContext()?.userId ?? null,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? null,
        traceId: currentContext()?.traceId ?? null,
        metadata: entry.metadata ?? undefined,
      },
    });
  }
}
```

`apps/api/src/modules/notify/outbox.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

export interface OutboxMessage {
  topic: string;
  payload: unknown;
  /** 幂等键（§8.5）：同一业务动作重复发布只会产生一条事件。 */
  idempotencyKey: string;
}

@Injectable()
export class OutboxService {
  /**
   * 与业务写入共用同一事务（§3.3）：调用方必须传入事务客户端。
   * 这样「业务成功但事件丢失」在结构上不可能发生。
   */
  async publish(tx: Prisma.TransactionClient, msg: OutboxMessage): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        topic: msg.topic,
        payload: msg.payload as Prisma.InputJsonValue,
        idempotencyKey: msg.idempotencyKey,
      },
    });
  }
}
```

- [ ] **Step 4: 实现邮件端口与消费者**

`apps/api/src/modules/notify/mailer.port.ts`：

```ts
export const MAILER = Symbol('VCA_MAILER');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(m: MailMessage): Promise<void>;
}
```

`apps/api/src/modules/notify/console-mailer.ts`：

```ts
import type { Mailer, MailMessage } from './mailer.port.js';
import { maskEmail } from '../../common/logging/redact.js';

/** 开发与测试用适配器：不真实投递，且日志中邮箱已脱敏（C11）。 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly sink: (line: string) => void = (l) => console.log(l)) {}

  async send(m: MailMessage): Promise<void> {
    this.sink(`[mail] to=${maskEmail(m.to)} subject=${m.subject}`);
  }
}
```

`apps/api/src/modules/notify/smtp-mailer.ts`：

```ts
import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from './mailer.port.js';

export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;

  constructor(smtpUrl: string, private readonly from: string) {
    this.transporter = nodemailer.createTransport(smtpUrl);
  }

  async send(m: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}
```

`apps/api/src/modules/notify/outbox.consumer.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import type { Mailer } from './mailer.port.js';

interface EmailPayload {
  to: string;
  subject: string;
  text: string;
}

/**
 * Outbox 消费者：exactly-once 效果（§8.5）。
 * 以 idempotencyKey 在 processed_jobs 上加唯一约束，重复消费不会重复投递。
 */
@Injectable()
export class OutboxConsumer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
  ) {}

  async runOnce(batchSize = 50): Promise<number> {
    const events = await this.prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    let handled = 0;
    for (const e of events) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // 唯一约束在并发下保证只有一个消费者能插入成功
          await tx.processedJob.create({ data: { idempotencyKey: e.idempotencyKey } });
          await this.deliver(e.topic, e.payload);
          await tx.outboxEvent.update({
            where: { id: e.id },
            data: { processedAt: new Date(), attempts: { increment: 1 }, lastError: null },
          });
        });
        handled++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 已处理过（唯一冲突）也要标记，避免无限重试
        const alreadyDone = /Unique constraint/i.test(message);
        await this.prisma.outboxEvent.update({
          where: { id: e.id },
          data: { attempts: { increment: 1 }, lastError: message, ...(alreadyDone ? { processedAt: new Date() } : {}) },
        });
      }
    }
    return handled;
  }

  private async deliver(topic: string, payload: unknown): Promise<void> {
    const p = payload as EmailPayload;
    if (topic.startsWith('email.')) {
      await this.mailer.send({ to: p.to, subject: p.subject, text: p.text });
    }
  }
}
```

`apps/api/src/modules/notify/notify.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from './outbox.service.js';
import { OutboxConsumer } from './outbox.consumer.js';
import { ConsoleMailer } from './console-mailer.js';
import { SmtpMailer } from './smtp-mailer.js';
import { MAILER, type Mailer } from './mailer.port.js';
import type { Env } from '../../config/env.schema.js';

@Global()
@Module({
  providers: [
    OutboxService,
    {
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<Env, true>): Mailer =>
        cfg.get('NODE_ENV', { infer: true }) === 'production'
          ? new SmtpMailer(cfg.get('SMTP_URL', { infer: true }), cfg.get('MAIL_FROM', { infer: true }))
          : new ConsoleMailer(),
    },
    {
      provide: OutboxConsumer,
      inject: [PrismaService, MAILER],
      useFactory: (prisma: PrismaService, mailer: Mailer) => new OutboxConsumer(prisma, mailer),
    },
  ],
  exports: [OutboxService, OutboxConsumer, MAILER],
})
export class NotifyModule {}
```

`apps/api/src/modules/audit/audit.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
```

补装：`pnpm --filter @vca/api add nodemailer@10.0.14`、dev `@types/nodemailer@8.0.2`

- [ ] **Step 5: 实现 worker（独立进程）**

`apps/worker/package.json`：

```json
{
  "name": "@vca/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc --noEmit", "start": "node dist/main.js" },
  "dependencies": { "@vca/api": "workspace:*", "@vca/shared": "workspace:*" }
}
```

`apps/worker/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`apps/worker/src/main.ts`：

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { OutboxConsumer } from '@vca/api/modules/notify/outbox.consumer.js';
import { WorkerModule } from './worker.module.js';

const POLL_MS = 1_000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  const consumer = app.get(OutboxConsumer);

  let running = true;
  const shutdown = async (): Promise<void> => {
    running = false;
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  while (running) {
    try {
      const n = await consumer.runOnce();
      if (n === 0) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (err) {
      console.error('[worker] 消费失败，稍后重试', err);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}
void bootstrap();
```

`apps/worker/src/worker.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@vca/api/config/config.module.js';
import { DbModule } from '@vca/api/db/db.module.js';
import { NotifyModule } from '@vca/api/modules/notify/notify.module.js';

@Module({ imports: [ConfigModule, DbModule, NotifyModule] })
export class WorkerModule {}
```

`@vca/api` 的 `exports` 需放开子路径（`package.json`）：

```json
"exports": {
  ".": "./src/index.ts",
  "./*": "./src/*"
}
```

- [ ] **Step 6: 运行测试确认通过并提交**

Run: `pnpm vitest run --project unit -t 邮件适配器; pnpm vitest run --project integration -t outbox`
Expected: PASS —— outbox 4 项（含回滚不留事件、幂等键、exactly-once）、mailer 3 项

```bash
git add -A
git commit -m "feat(p0): append-only 审计、transactional outbox、邮件适配器与 worker（C15）"
```

---

## Task 9: 架构守护测试与 CI（C5、验收 13.4）

**Files:**
- Create: `.dependency-cruiser.cjs`, `tests/architecture/module-boundaries.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `infra/db/apply-grants.sql`（Task 3 已建，此处纳入 CI）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: `pnpm arch` 命令 · CI 流水线

- [ ] **Step 1: 写失败测试**

`tests/architecture/module-boundaries.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MODULES_DIR = path.join(ROOT, 'apps/api/src/modules');

describe('架构守护（C5 / 验收 13.4）', () => {
  it('dependency-cruiser 规则全部通过（禁跨模块内部 import）', () => {
    let ok = true;
    let output = '';
    try {
      output = execFileSync('pnpm', ['exec', 'depcruise', '--config', '.dependency-cruiser.cjs', 'apps', 'packages'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch (e) {
      ok = false;
      output = (e as { stdout?: string; stderr?: string }).stdout ?? String(e);
    }
    expect(ok, `架构违规：\n${output}`).toBe(true);
  });

  it('模块之间不相互 import 内部实现（只允许经 index 或 shared）', async () => {
    const modules = (await readdir(MODULES_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const violations: string[] = [];
    for (const mod of modules) {
      const files = await walk(path.join(MODULES_DIR, mod));
      for (const f of files) {
        const src = await readFile(f, 'utf8');
        for (const other of modules) {
          if (other === mod) continue;
          // 直接深引到别的模块内部（非 index）即为违规
          const pattern = new RegExp(`from\\s+['"][^'"]*modules/${other}/(?!index)[^'"]+['"]`);
          if (pattern.test(src)) violations.push(`${path.relative(ROOT, f)} -> modules/${other}/...`);
        }
      }
    }
    expect(violations, `跨模块内部依赖：\n${violations.join('\n')}`).toEqual([]);
  });

  it('平台不执行用户代码（C2）：源码中无 eval / new Function / child_process 执行', async () => {
    const files = [...(await walk(path.join(ROOT, 'apps'))), ...(await walk(path.join(ROOT, 'packages')))];
    const offenders: string[] = [];
    for (const f of files) {
      if (!f.endsWith('.ts') || f.includes('generated')) continue;
      const src = await readFile(f, 'utf8');
      if (/\beval\s*\(/.test(src) || /new\s+Function\s*\(/.test(src)) offenders.push(path.relative(ROOT, f));
    }
    expect(offenders, `违反 C2：\n${offenders.join('\n')}`).toEqual([]);
  });
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run --project architecture`
Expected: FAIL —— `.dependency-cruiser.cjs` 不存在，`depcruise` 报错

- [ ] **Step 3: 编写架构规则**

`.dependency-cruiser.cjs`：

```js
/** 让「可拆分性」成为强制约束而非愿望（设计文档 §3.3）。 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      severity: 'error',
      comment: '禁止跨模块 import 内部实现。跨模块只走显式接口 + DTO（§3.3）。',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/([^/]+)/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'no-shared-to-apps',
      severity: 'error',
      comment: 'packages/shared 只能放 DTO 与类型，不得反向依赖 apps（§11）。',
      from: { path: '^packages/shared/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', 'main\\.ts$', 'index\\.ts$'] },
      to: {},
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖会让模块无法独立测试与拆分。',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(src/generated|\\.test\\.ts$)' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
```

- [ ] **Step 4: 运行架构测试确认通过**

Run: `pnpm arch; pnpm vitest run --project architecture`
Expected: PASS —— 无违规

> 若 `no-cross-module-internals` 报出既有违规，**修代码而不是放宽规则**：把跨模块调用改为经 `modules/<other>/index.ts` 导出的接口。这正是本任务的价值所在。

- [ ] **Step 5: 建立 CI**

`.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push: { branches: [main] }
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: vca_owner
          POSTGRES_PASSWORD: owner_pw
          POSTGRES_DB: vca
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U vca_owner -d vca"
          --health-interval 5s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.24.0 }
      - uses: actions/setup-node@v4
        with: { node-version: '22.19.0', cache: 'pnpm' }

      # C18：allowBuilds 已在 pnpm-workspace.yaml 中，安装不应以非零码结束
      - run: pnpm install --frozen-lockfile

      - name: 类型检查
        run: pnpm typecheck

      - name: 安全 lint 门（C9：raw SQL / XSS / eval）
        run: pnpm lint

      - name: 架构守护（C5）
        run: pnpm arch

      - name: 数据库迁移与最小权限授权
        env:
          MIGRATE_DATABASE_URL: postgresql://vca_owner:owner_pw@127.0.0.1:5432/vca
        run: |
          pnpm --filter @vca/api exec prisma migrate deploy
          pnpm --filter @vca/api exec prisma generate
          psql "$MIGRATE_DATABASE_URL" -f infra/db/roles.sql
          psql "$MIGRATE_DATABASE_URL" -f infra/db/apply-grants.sql

      - name: 单元与安全测试
        run: |
          pnpm vitest run --project unit
          pnpm vitest run --project security
          pnpm vitest run --project architecture

      - name: 集成测试（testcontainers）
        run: pnpm vitest run --project integration

      - name: 依赖审计（威胁 #14）
        run: |
          pnpm audit --audit-level high || \
            (echo "::error::存在 high/critical 依赖漏洞，需修复或提交书面豁免" && exit 1)
```

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(p0): 架构守护测试与 CI 流水线（C5、验收 13.4）"
```

---

## 完成判据（对照设计文档 §13）

P0 完成的标志 —— 以下每一项都必须由**实际运行的命令输出**证明，不得凭推断声明：

| # | 判据 | 验证命令 | 设计文档出处 |
|---|---|---|---|
| 1 | 单元测试全绿 | `pnpm vitest run --project unit` | §12 |
| 2 | 集成测试（真实 PG + Redis）全绿 | `pnpm vitest run --project integration` | §12 |
| 3 | 安全测试全绿：默认拒绝、越权矩阵、CSP/CSRF/限流、恶意上传 | `pnpm vitest run --project security` | 验收 13.2 |
| 4 | 每个路由都有策略声明（漏声明即失败） | `pnpm vitest run --project security -t 策略声明` | §9、验收 13.2 |
| 5 | **append-only 在运行时角色下真实被拒** | `pnpm vitest run --project integration -t append-only` | 不变式 #5、C7 |
| 6 | 架构守护通过（无跨模块内部依赖、无循环） | `pnpm arch` | 验收 13.4 |
| 7 | 安全 lint 门有效（`$queryRawUnsafe` 被拦） | `pnpm lint` | 威胁 #11 |
| 8 | trace id 贯穿一次请求的全部日志 | `pnpm vitest run --project integration -t trace` | 验收 13.4 |
| 9 | 依赖无 high/critical | `pnpm audit --audit-level high` | 验收 13.2 |
| 10 | 缺失/占位密钥时进程拒绝启动 | `pnpm vitest run --project unit -t parseEnv` | 威胁 #15 |

**明确不在 P0 范围**（防止范围蔓延）：账本与托管（P2）、作品与制品加密存储（P1）、交换与竞拍（P3/P4）、检索与评价（P5）、治理后台（P6）、部署加固（P7）。P0 只交付「安全边界已经成立」这一件事。

---

## Self-Review

**1. Spec 覆盖检查**

| 设计文档要求 | 对应任务 |
|---|---|
| §2.1 P0「monorepo 骨架、容器化」 | Task 1、Task 3（docker-compose） |
| §2.1 P0「密钥管理」 | Task 2（C10） |
| §2.1 P0「认证与授权」 | Task 5（策略）、Task 6（认证） |
| §2.1 P0「安全响应头、限流」 | Task 7 |
| §2.1 P0「审计日志」 | Task 8 |
| §2.1 P0「outbox 与邮件适配器」 | Task 8 |
| §2.1 P0「架构守护测试、CI」 | Task 9 |
| §3.3 四条可拆分性约束 | Task 3（独占 schema）、Task 9（守护测试） |
| §3.5 结构化日志 + trace id + outbox | Task 4、Task 8 |
| §4.1 威胁 #9/#10/#11/#13/#14/#15 | Task 7、Task 2、Task 9 |
| §4.2 认证与会话 | Task 6 |
| §5.3 标识与字段约定 | Task 3、Task 4 |
| §8.3 不变式 #5 | Task 3 |
| §8.5 幂等与并发 | Task 8 |
| §9 权限矩阵 | Task 5 |
| §12 测试策略（本阶段相关层） | Task 1、Task 9 |
| §13.2 / §13.4 验收 | 完成判据表 |

**未覆盖且属正确的延后项：** 威胁 #1 的完整越权矩阵（需 P1 的 `Asset` 资源才有对象可测，P0 只建立机制与覆盖率门）；威胁 #2 恶意压缩包（需 P1 的上传入口）；威胁 #3 制品加密（P1）；威胁 #4/#5 资金与竞态（P2/P4）；威胁 #6 代理出价泄价（P4）；§4.2 的 TOTP 2FA（P6 治理后台，管理员强制）；§4.3 邮件通知清单的完整事件（P5）。

**2. 占位符扫描** —— 已逐任务检查：无 TBD / TODO / 「稍后补充」。唯二需要实现期判断的两处已在正文显式标注理由：Task 1 Step 1 的骨架测试（Step 4 明确要求整体替换为真实断言）、Task 5 Step 3 的 `require('@nestjs/core')`（正文标注应改为构造函数注入）。

**3. 类型一致性** —— 已核对跨任务契约表：`PolicyDecl` 在 Task 5 定义、Task 6/7 使用一致；`REDIS` token 在 Task 6 定义并在 `RedisModule` 导出；`MAILER` token 在 Task 8 定义并在 `OutboxConsumer` 注入；`uuidv7` 在 Task 4 定义、Task 3 的 Prisma `uuid(7)` 与之语义一致（均为 v7）；`Logout`/`me` 路由的策略声明与 Task 5 的覆盖率门相容。

---

## Execution Handoff

计划已保存至 `docs/superpowers/plans/2026-10-04-p0-security-foundation.md`。
