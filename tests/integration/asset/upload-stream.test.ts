import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../../helpers/app.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { testEnv } from '../../helpers/env.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';
import { ARTIFACT_STORE } from '@vca/api/modules/asset/store/artifact-store.port.js';
import type { ArtifactStore } from '@vca/api/modules/asset/store/artifact-store.port.js';

/**
 * 上传接入的端到端契约（P1 / Task 1）。
 *
 * ## 这一组跑的是**真实**请求流
 *
 * `createTestApp()` 起的是生产 `AppModule`（真中间件栈、真全局守卫链：限流 → CSRF → 授权），
 * Redis 用 testcontainer（限流桶与会话都是真语义）。请求用 **Node 的 http 客户端**逐块发出，
 * 而不是 supertest 的 `.attach()`：后者会把整份 body 一次写完，于是「制品在请求还没结束时
 * 就已经在落盘」这条断言采不到任何中间态——那是本任务唯一能证明「HTTP 层真的在流式转发」
 * 的证据（探针实测：自定义 storage engine 在客户端发到 44ms 时就收到了第一块）。
 *
 * ## 断言的分工（避免「用状态码证明一切」）
 *
 * - **字节**：库里对象的字节数与内容必须和上传的完全相同（`getRange` 逐字节比对）；
 * - **流式**：请求进行中，对象已在盘上且大小在增长，同时目录里**只有对象本身**（无临时副本，C21）；
 * - **上限**：超限 ⇒ 413，且制品库里**一个残留都没有**（验收判据）；
 * - **身份**：未认证 ⇒ 403 且一个字节都没写（这条钉住「上传不是 @Public()」）。
 */
const STORE_DIR = testEnv.ARTIFACT_STORE_DIR as string;
const MAX_UPLOAD_BYTES = Number(testEnv.ARTIFACT_MAX_UPLOAD_BYTES);
const BOUNDARY = 'vca-test-boundary-2f9c';

/** 确定性负载：第 i 字节 = (seed + i) % 251（便于逐字节比对，且压缩不掉内容差异）。 */
function payload(size: number, seed = 0): Buffer {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buffer[i] = (seed + i) % 251;
  return buffer;
}

/** 把负载切成若干块（模拟真实客户端的逐块发送）。 */
function chunked(buffer: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}

/** 库里现有的对象（相对路径 + 字节数）。用递归列目录而不是猜路径，才看得见「临时副本」。 */
async function storedObjects(): Promise<Array<{ name: string; size: number }>> {
  const names = await readdir(STORE_DIR, { recursive: true, withFileTypes: false }).catch(() => [] as string[]);
  const out: Array<{ name: string; size: number }> = [];
  for (const name of names) {
    const info = await stat(join(STORE_DIR, name)).catch(() => null);
    if (info?.isFile()) out.push({ name: name.split('\\').join('/'), size: info.size });
  }
  return out;
}

interface UploadResult {
  status: number;
  body: string;
  /** 请求过程中采到的：目录里的文件数、是否见过「写到一半」的对象、未完成字节数峰值。 */
  observed: { maxFiles: number; samples: number; sawPartial: boolean; peakUnfinished: number };
}

/**
 * 真实 multipart 上传：逐块写、每块之间让出事件循环，并在发送期间采样制品库。
 *
 * 采样得到的三件事正好对上三条验收判据：`sawPartial`（真流式）、
 * `maxFiles`（无临时副本）、`peakUnfinished`（未完成字节数有界，不用 RSS）。
 */
function upload(
  port: number,
  bytes: Buffer,
  opts: { csrf?: string; sessionId?: string; gapMs?: number },
): Promise<UploadResult> {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="pkg.zip"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const parts = [head, ...chunked(bytes, 64 * 1024), tail];
  const total = parts.reduce((n, part) => n + part.length, 0);

  // 会话与 CSRF 令牌**各自独立**地进 cookie：匿名用例要能带上合法 CSRF 令牌
  // （否则它的 403 可能只是 CSRF 拦的，断言就测不到策略判定，见该用例的说明）。
  const cookies = [
    ...(opts.sessionId ? [`${SESSION_COOKIE}=${opts.sessionId}`] : []),
    ...(opts.csrf ? [`${CSRF_COOKIE}=${opts.csrf}`] : []),
  ];

  return new Promise((resolve, reject) => {
    const observed = { maxFiles: 0, samples: 0, sawPartial: false, peakUnfinished: 0 };
    let acked = 0;
    const timer = setInterval(() => {
      void storedObjects()
        .then((files) => {
          observed.samples += 1;
          observed.maxFiles = Math.max(observed.maxFiles, files.length);
          const onDisk = files.reduce((n, f) => n + f.size, 0);
          if (onDisk > 0 && onDisk < bytes.length) observed.sawPartial = true;
          observed.peakUnfinished = Math.max(observed.peakUnfinished, acked - onDisk);
        })
        .catch(() => undefined);
    }, 1);

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/assets/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          'content-length': String(total),
          ...(cookies.length > 0 ? { cookie: cookies.join('; ') } : {}),
          ...(opts.csrf ? { [CSRF_HEADER]: opts.csrf } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          clearInterval(timer);
          resolve({ status: res.statusCode ?? 0, body, observed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('上传超时')));

    let index = 0;
    const next = (): void => {
      if (index >= parts.length) {
        req.end();
        return;
      }
      const part = parts[index++]!;
      req.write(part, () => (acked += part.length));
      if (opts.gapMs && opts.gapMs > 0) setTimeout(next, opts.gapMs);
      else setImmediate(next);
    };
    next();
  });
}

describe('上传接入与制品存储（Task 1）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let port: number;
  let sessionId: string;
  let csrf: string;

  beforeAll(async () => {
    await rm(STORE_DIR, { recursive: true, force: true });
    redis = await startTestRedis();
    app = await createTestApp({
      overrides: [(builder) => builder.overrideProvider(REDIS).useValue(redis.newClient())],
    });
    const server = app.getHttpServer() as http.Server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;

    // 真会话（走 SessionService 本身，不是伪造的上下文）：上传路由的策略声明要求登录。
    sessionId = (await app.get(SessionService).create('user-uploader', { ip: '127.0.0.1', userAgent: 'vitest' }))
      .sessionId;
    csrf = await fetchCsrfToken(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await rm(STORE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 每个用例从空库开始：「无残留」这类断言需要一个已知的起点。
    await rm(STORE_DIR, { recursive: true, force: true });
  });

  it('上传成功：字节原样入库，返回键与字节数', async () => {
    const body = payload(256 * 1024, 7);

    const res = await upload(port, body, { csrf, sessionId });
    const parsed = JSON.parse(res.body) as { key: string; bytes: number };

    expect(res.status, `响应体=${res.body}`).toBe(201);
    expect(parsed.bytes).toBe(body.length);

    const objects = await storedObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0]?.size).toBe(body.length);

    // 逐字节比对：不是「大小对了就算对」——分块/边界处理写歪一个字节也必须红。
    const store = app.get<ArtifactStore>(ARTIFACT_STORE);
    const readBack = await store.getRange(parsed.key, 0, body.length - 1);
    expect(readBack.equals(body), '库里读回的字节与上传的不一致').toBe(true);
  });

  it('请求进行中对象已在落盘（真流式），且目录里始终只有对象本身（无临时副本）', async () => {
    const body = payload(2 * 1024 * 1024, 11);

    const res = await upload(port, body, { csrf, sessionId, gapMs: 2 });

    expect(res.status).toBe(201);
    expect(res.observed.samples, '采样器一次都没采到（下面的断言会恒真）').toBeGreaterThan(0);
    expect(
      res.observed.sawPartial,
      '整个上传期间都没见过「写到一半」的对象——这是「先把整份攒起来再落盘」的形态',
    ).toBe(true);
    expect(res.observed.maxFiles, `采样到的最大文件数=${res.observed.maxFiles}（>1 说明出现过临时副本）`).toBeLessThanOrEqual(1);
    // 未完成字节数（已发出 − 已落盘）有界：验收口径是它，不是 RSS。
    expect(
      res.observed.peakUnfinished,
      `未完成字节数峰值=${res.observed.peakUnfinished}（4 MiB 上限之下不该出现整份缓冲）`,
    ).toBeLessThan(2 * 1024 * 1024);
  });

  it('超过硬上限：413，且制品库里没有任何残留对象', async () => {
    const body = payload(MAX_UPLOAD_BYTES + 1024 * 1024, 13);

    const res = await upload(port, body, { csrf, sessionId });
    const parsed = JSON.parse(res.body) as { statusCode?: number; message?: string };

    expect(res.status).toBe(413);
    expect(parsed.statusCode).toBe(413);
    await expect(storedObjects()).resolves.toEqual([]);
  });

  it('超限中止之后，同一连接池里的下一次上传仍然正常（中止没把解析器写坏）', async () => {
    const tooBig = payload(MAX_UPLOAD_BYTES + 512 * 1024, 17);
    const oversize = await upload(port, tooBig, { csrf, sessionId });
    expect(oversize.status).toBe(413);

    const body = payload(128 * 1024, 19);
    const res = await upload(port, body, { csrf, sessionId });

    expect(res.status).toBe(201);
    const objects = await storedObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0]?.size).toBe(body.length);
  });

  it('缺少文件字段：400，且不落地任何字节', async () => {
    const res = await request(app.getHttpServer())
      .post('/assets/upload')
      .set('Cookie', `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .field('note', '没有附件');

    expect(res.status).toBe(400);
    await expect(storedObjects()).resolves.toEqual([]);
  });

  it('未认证：403，且一个字节都没写（上传不是 @Public()）', async () => {
    const body = payload(64 * 1024, 23);

    // **必须带上合法 CSRF 令牌**，否则这个 403 有两个可能的来源（CsrfGuard 或 PolicyGuard），
    // 断言就没有判别力。变异探针 IMP5 实测过：把路由改成 `@Public()` 之后，
    // 不带令牌的版本照旧 403（这次是 CSRF 拦的），用例全绿——一个恒真的断言。
    // 带上令牌之后，唯一还能拒绝它的就是「要求登录」这条策略声明。
    const res = await upload(port, body, { csrf, sessionId: undefined });

    expect(res.status, `响应体=${res.body}`).toBe(403);
    const parsed = JSON.parse(res.body) as { message?: string };
    expect(parsed.message, '拒绝理由必须来自策略判定（需要登录）').toBe('需要登录');
    await expect(storedObjects()).resolves.toEqual([]);
  });
});

