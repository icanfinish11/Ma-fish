import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../../helpers/app.js';
import { startTestRedis, type TestRedis } from '../../helpers/redis.js';
import { fetchCsrfToken } from '../../helpers/csrf.js';
import { REDIS } from '@vca/api/db/redis.module.js';
import { SESSION_COOKIE } from '@vca/api/common/http/cookie.js';
import { CSRF_COOKIE, CSRF_HEADER } from '@vca/api/common/security/csrf.middleware.js';
import { SessionService } from '@vca/api/modules/auth/session.service.js';

/**
 * 上传请求**形状**上限的端到端契约（修复轮 1 / Fix 4）。
 *
 * ## 这组用例在防什么
 *
 * `asset.module.ts` 的 `limits` 里除 `fileSize` 外还有 `files` / `fields` / `fieldSize` / `parts`。
 * 它们的失效形态是**静默**的：没有这些上限时，请求只是多解析几个字段就成功——
 * 「字段面有界」这件事在测试里不留任何痕迹。而 busboy 的默认值是
 * `fields: Infinity` / `parts: Infinity`（`lib/types/multipart.js` 第 255–264 行，实测读数），
 * multer 又把每个文本字段追加进 `req.body`，因此「很多个小字段」是一条**不吃文件上限**
 * 的内存路径。
 *
 * ## 断言的分工
 *
 * - **状态码**：形状错误一律 **400**（`LIMIT_FIELD_COUNT` / `LIMIT_FILE_COUNT` /
 *   `LIMIT_FIELD_VALUE` 在 Nest 的 `transformException` 里都映射为 `BadRequestException`）。
 *   这一点是刻意断言的：413 只属于 `fileSize`，把形状错误也变成 413 会让客户端以为
 *   「文件太大，切小一点再来」，而真正的原因是请求形状非法。
 * - **制品库**：被拒的请求**一个字节都不留**（与 Task 1 的「无残留」判据同口径）。
 *
 * 为什么用真实请求（而不是直接对着 `limit` 配置断言）：配置对不对不重要，
 * **解析器真的按它拒绝了**才重要——中间隔着 multer/busboy 对每个键的语义。
 */
const STORE_DIR = process.env.ARTIFACT_STORE_DIR as string;
const BOUNDARY = 'vca-test-shape-7c31';

/** 库里现有的对象（相对路径 + 字节数）。递归列目录，才看得见任何残留。 */
async function storedObjects(): Promise<string[]> {
  const names = await readdir(STORE_DIR, { recursive: true, withFileTypes: false }).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names) {
    const info = await stat(join(STORE_DIR, name)).catch(() => null);
    if (info?.isFile()) out.push(name.split('\\').join('/'));
  }
  return out;
}

/** 一段 multipart 的文件部分。 */
function filePart(name: string, filename: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: application/zip\r\n\r\n`,
    ),
    content,
    Buffer.from('\r\n'),
  ]);
}

/** 一段 multipart 的**文本字段**部分（没有 `filename` ⇒ busboy 按字段处理，进 `req.body`）。 */
function fieldPart(name: string, value: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
    value,
    Buffer.from('\r\n'),
  ]);
}

/** 把任意 body 逐块发给上传路由（不用 supertest：它没法发两个同名文件字段）。 */
function postRaw(port: number, body: Buffer, opts: { sessionId: string; csrf: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/assets/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          'content-length': String(body.length),
          cookie: `${SESSION_COOKIE}=${opts.sessionId}; ${CSRF_COOKIE}=${opts.csrf}`,
          [CSRF_HEADER]: opts.csrf,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('请求超时')));
    req.end(body);
  });
}

describe('上传请求形状的上限（修复轮 1 / Fix 4）', () => {
  let app: INestApplication;
  let redis: TestRedis;
  let port: number;
  let csrf: string;
  let sessionId: string;
  let userSeq = 0;

  beforeAll(async () => {
    await rm(STORE_DIR, { recursive: true, force: true });
    redis = await startTestRedis();
    app = await createTestApp({
      overrides: [(builder) => builder.overrideProvider(REDIS).useValue(redis.newClient())],
    });
    const server = app.getHttpServer() as http.Server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    csrf = await fetchCsrfToken(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await rm(STORE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(STORE_DIR, { recursive: true, force: true });
    // 每个用例一个用户：`upload` 层是 10 次/24 小时/用户，共用一个用户会让「下一个用例」
    // 以 429 红，而那个失败看起来像产品缺陷（与 `upload-stream.test.ts` 同一处置，Fix 6）。
    userSeq += 1;
    sessionId = (
      await app.get(SessionService).create(`user-shape-${userSeq}`, { ip: '127.0.0.1', userAgent: 'vitest' })
    ).sessionId;
  });

  it('一次请求里给两个文件：400，且第一个文件也被清掉（不落地任何字节）', async () => {
    // 这条钉的是「第一个文件必须先被写入、再随中止一起清掉」这条路径：multer 放弃请求时会调
    // storage engine 的 `_removeFile`（实测），若那条路径坏了，这里会留下第一个文件。
    //
    // **它不区分 `limits.files: 1` 存不存在**（据实记载，探针实测）：带这个上限时 busboy 报
    // `LIMIT_FILE_COUNT`，不带时 multer 的 `.single()` 报 `LIMIT_UNEXPECTED_FILE`
    // ——两者都是 400，客户端看到的一样（`evidence/t1-fix1-probe-multer-limits.txt`）。
    // 因此这条用例的价值是「第二个文件不会被静默收下」+「无残留」，而不是给 `files` 上限作证。
    const body = Buffer.concat([
      filePart('file', 'first.zip', Buffer.alloc(64 * 1024, 7)),
      filePart('file', 'second.zip', Buffer.alloc(1024, 9)),
      Buffer.from(`--${BOUNDARY}--\r\n`),
    ]);

    const res = await postRaw(port, body, { sessionId, csrf });

    expect(res.status, `响应体=${res.body}`).toBe(400);
    await expect(storedObjects()).resolves.toEqual([]);
  });

  it('单个字段值超限（limits.fieldSize=64 KiB）：400，且不落地任何字节', async () => {
    // 一个 96 KiB 的文本字段：超过 64 KiB 上限，但没有超过文件上限（4 MiB）——
    // 于是这条用例钉住的正是「字段面自己也有上限」这件事。
    const body = Buffer.concat([
      filePart('file', 'pkg.zip', Buffer.alloc(1024, 3)),
      fieldPart('note', Buffer.alloc(96 * 1024, 0x41)), // 0x41 = 'A'
      Buffer.from(`--${BOUNDARY}--\r\n`),
    ]);

    const res = await postRaw(port, body, { sessionId, csrf });

    expect(res.status, `响应体=${res.body}`).toBe(400);
    await expect(storedObjects()).resolves.toEqual([]);
  });
});
