import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DOWNLOAD_TTL_SECONDS,
  buildDownloadPath,
  createNonce,
  inspectTicket,
  parseTicketQuery,
  signTicket,
  verifyTicket,
  type DownloadTicket,
} from '@vca/api/modules/asset/download/signed-url.js';

/**
 * 签名下载票据的**纯函数**判据（P1 / Task 8；规格 D10）。
 *
 * ## 这个文件问的四件事
 *
 * 1. **签名能不能被伪造**——篡改任何一个被签字段（制品版本、当事人、过期时间、nonce）
 *    都必须让校验失败。逐字段一条用例，而不是「改一个字段试试」；
 * 2. **过期的判定与 TTL 的上界**——`expiresAt` 是签名载荷的一部分，因此它同时是
 *    「过期即拒」与「TTL ≤ 300 秒」两条要求的落点；
 * 3. **畸形输入一律是「拒绝」而不是「抛错」**——签名长度、字符集、超长串、非字符串、
 *    数组、缺字段：这些都来自**客户端**，一个未捕获异常在这里就是一次 500
 *    （威胁 #3 的入口面）。`parseTicketQuery` 是那条边界；
 * 4. **比较用的是常量时间原语**——见文件末尾那条用例（它是一处**结构**判据，
 *    理由写在它的注释里：常量时间不可被行为观测）。
 *
 * 端到端的那一半（真 Redis、单次使用、并发、审计、以及下载路径的**带外长度核对**）
 * 住在 `tests/integration/asset/signed-download.test.ts`。
 */

const SECRET = 'unit-test-download-secret-0123456789abcdef';
const NOW = 1_700_000_000;

function ticket(over: Partial<DownloadTicket> = {}): DownloadTicket {
  const base = {
    assetVersionId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    userId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
    expiresAt: NOW + DOWNLOAD_TTL_SECONDS,
    nonce: createNonce(),
  };
  const signed = { ...base, ...over };
  return { ...signed, signature: over.signature ?? signTicket(signed, SECRET) };
}

describe('签名下载票据：签名与校验（D10）', () => {
  it('正确签名的票据通过校验，且签名是确定性的（同一载荷同一密钥 ⇒ 同一签名）', () => {
    const t = ticket();
    expect(verifyTicket(t, SECRET, NOW)).toBe(true);
    // 逐字段重建载荷（而不是删掉 `signature` 再看类型）：`Omit<…,'signature'>` 的形状
    // 由这一行显式写出来，字段少一个/多一个都会让 tsc 报错。
    const payload = {
      assetVersionId: t.assetVersionId,
      userId: t.userId,
      expiresAt: t.expiresAt,
      nonce: t.nonce,
    };
    expect(signTicket(payload, SECRET)).toBe(t.signature);
    // 换一把密钥就签不出同一个值（否则「签名」只是载荷的哈希，任何人都能算）
    expect(signTicket(payload, `${SECRET}-other`)).not.toBe(t.signature);
  });

  it('签名的长度固定为 base64url(32 字节) = 43 字符（形状判据的前提）', () => {
    expect(ticket().signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  for (const field of ['assetVersionId', 'userId', 'expiresAt', 'nonce'] as const) {
    it(`篡改被签字段 ${field} ⇒ 拒绝（载荷的每一段都在签名覆盖范围内）`, () => {
      const t = ticket();
      const tampered: DownloadTicket =
        field === 'expiresAt'
          ? { ...t, expiresAt: t.expiresAt + 1 }
          : field === 'nonce'
            ? { ...t, nonce: createNonce() }
            : { ...t, [field]: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d' };

      expect(verifyTicket(tampered, SECRET, NOW), `改掉 ${field} 之后签名仍然通过`).toBe(false);
      expect(inspectTicket(tampered, SECRET, NOW)).toBe('bad_signature');
    });
  }

  it('过期 ⇒ 拒绝（判定用的是调用方给的 now，不是进程时钟）', () => {
    const t = ticket({ expiresAt: NOW - 1 });
    expect(verifyTicket(t, SECRET, NOW)).toBe(false);
    expect(inspectTicket(t, SECRET, NOW)).toBe('expired');
    // 边界：恰好等于 now 就算过期（否则 TTL 实际比声称的多一秒）
    expect(inspectTicket(ticket({ expiresAt: NOW }), SECRET, NOW)).toBe('expired');
    expect(inspectTicket(ticket({ expiresAt: NOW + 1 }), SECRET, NOW + 1)).toBe('expired');
    expect(inspectTicket(ticket({ expiresAt: NOW + 1 }), SECRET, NOW)).toBe('ok');
  });

  it('TTL 超过 300 秒 ⇒ 拒绝（上界在**校验侧**也成立，不只是签发侧写了个常数）', () => {
    // 这条的判别式：把 `DOWNLOAD_TTL_SECONDS` 调大（例如 3600）时，本用例会红——
    // 「≤5 分钟」因此不是一句注释，而是两侧都被检查的性质。
    expect(DOWNLOAD_TTL_SECONDS).toBeLessThanOrEqual(300);
    const long = ticket({ expiresAt: NOW + DOWNLOAD_TTL_SECONDS + 1 });
    expect(verifyTicket(long, SECRET, NOW)).toBe(false);
    expect(inspectTicket(long, SECRET, NOW)).toBe('ttl_too_long');
    // 正好 300 秒仍然有效（上界是**闭**的：≤300 而不是 <300）
    expect(inspectTicket(ticket({ expiresAt: NOW + 300 }), SECRET, NOW)).toBe('ok');
  });

  it('非法的 now（NaN / 非整数）⇒ 拒绝，而不是让比较变成一个恒真的结果', () => {
    // `expiresAt > NaN` 恒为 false ⇒ 「过期」；但这属于**入口校验**，不该靠比较的巧合。
    const t = ticket();
    expect(verifyTicket(t, SECRET, Number.NaN)).toBe(false);
    expect(verifyTicket(t, SECRET, 1.5)).toBe(false);
    expect(inspectTicket(t, SECRET, Number.NaN)).toBe('malformed');
  });

  it('畸形签名（长度 / 字符集 / 空 / 超长）⇒ 拒绝，且**不抛未捕获异常**', () => {
    const cases: Array<[string, string]> = [
      ['空串', ''],
      ['少一个字符', ticket().signature.slice(0, 42)],
      ['多一个字符', `${ticket().signature}A`],
      ['非 base64url 字符', '!'.repeat(43)],
      ['全等号（填充）', '='.repeat(43)],
      ['超长（4096 字符）', 'A'.repeat(4096)],
      ['空白', '   '],
      ['含换行', `${ticket().signature}\n`],
    ];
    for (const [label, signature] of cases) {
      const t = ticket({ signature });
      // 判据是「返回 false」，不是「抛了某个错」：这条路径由**攻击者**驱动，
      // 一次抛出就是一次 500（D10 的畸形输入要求）。
      expect(() => verifyTicket(t, SECRET, NOW), `${label} 让校验抛出了异常`).not.toThrow();
      expect(verifyTicket(t, SECRET, NOW), `${label} 被当成了合法签名`).toBe(false);
    }
  });

  it('载荷本身畸形（缺字段 / 非字符串 / 数组 / null）⇒ 拒绝而不抛错', () => {
    const junk: unknown[] = [
      null,
      undefined,
      42,
      'not-a-ticket',
      [],
      {},
      { assetVersionId: ticket().assetVersionId, userId: ticket().userId, expiresAt: NOW + 10, nonce: ticket().nonce },
      { ...ticket(), signature: undefined },
      { ...ticket(), expiresAt: '1700000300' },
      { ...ticket(), assetVersionId: { toString: () => 'x' } },
      { ...ticket(), nonce: ['a'] },
    ];
    for (const value of junk) {
      expect(() => verifyTicket(value as DownloadTicket, SECRET, NOW), `${JSON.stringify(value)} 抛出了异常`).not.toThrow();
      expect(verifyTicket(value as DownloadTicket, SECRET, NOW)).toBe(false);
    }
  });

  it('超长的载荷字段 ⇒ 拒绝（比较与拼串都不吃无界输入）', () => {
    const huge = 'A'.repeat(64 * 1024);
    for (const field of ['assetVersionId', 'userId', 'nonce'] as const) {
      const t = { ...ticket(), [field]: huge };
      expect(verifyTicket(t, SECRET, NOW), `${field} 超长时仍然通过`).toBe(false);
    }
  });
});

describe('签名下载票据：URL 的编码与解析（客户端输入的那一侧）', () => {
  it('buildDownloadPath → parseTicketQuery 往返一致（含 nonce 与签名逐字相同）', () => {
    const t = ticket();
    const built = buildDownloadPath(t);
    expect(built.startsWith('/assets/download?')).toBe(true);

    const query = Object.fromEntries(new URLSearchParams(built.slice(built.indexOf('?') + 1)));
    expect(parseTicketQuery(query)).toEqual(t);
    // 往返之后再校验一次：客户端拿到的那串东西必须原样可用
    expect(verifyTicket(parseTicketQuery(query) as DownloadTicket, SECRET, NOW)).toBe(true);
  });

  it('expiresAt 必须是无前导零的十进制整数串（`1e9` / `+1` / ` 1` / 小数一律拒绝）', () => {
    const t = ticket();
    const base = Object.fromEntries(new URLSearchParams(buildDownloadPath(t).split('?')[1] as string));
    for (const value of ['1e9', '+1700000300', ' 1700000300', '1700000300.0', '01700000300', '', 'abc']) {
      expect(parseTicketQuery({ ...base, expiresAt: value }), `expiresAt=${JSON.stringify(value)} 被接受了`).toBeNull();
    }
  });

  it('缺字段 / 重复字段（数组）/ 嵌套对象 ⇒ 一律 null，而不是「取第一个」', () => {
    const t = ticket();
    const base = Object.fromEntries(new URLSearchParams(buildDownloadPath(t).split('?')[1] as string));
    for (const field of Object.keys(base)) {
      const without = { ...base };
      delete (without as Record<string, unknown>)[field];
      expect(parseTicketQuery(without), `缺少 ${field} 时没有拒绝`).toBeNull();
      expect(parseTicketQuery({ ...base, [field]: [base[field as keyof typeof base], base[field as keyof typeof base]] })).toBeNull();
    }
    expect(parseTicketQuery({ ...base, nonce: { toString: () => 'x' } })).toBeNull();
    expect(parseTicketQuery(null)).toBeNull();
    expect(parseTicketQuery('?assetVersionId=x')).toBeNull();
  });

  it('字段形状受限（版本 id / 当事人必须是 UUID，nonce 与签名是固定长度 base64url）', () => {
    const t = ticket();
    const base = Object.fromEntries(new URLSearchParams(buildDownloadPath(t).split('?')[1] as string));
    // 版本 id 形状受限不是格式洁癖：它保证「畸形票据」在**碰数据库之前**就被拒
    // （非 UUID 打到 Postgres 会以 22P02 失败 ⇒ 一次 500）。
    for (const bad of ['not-a-uuid', '0199a1b2c3d47e5f8a9b0c1d2e3f4a5b', '../../etc/passwd', "' OR 1=1 --"]) {
      expect(parseTicketQuery({ ...base, assetVersionId: bad })).toBeNull();
      expect(parseTicketQuery({ ...base, userId: bad })).toBeNull();
    }
    expect(parseTicketQuery({ ...base, nonce: 'short' })).toBeNull();
    expect(parseTicketQuery({ ...base, signature: 'A'.repeat(44) })).toBeNull();
  });
});

describe('nonce 的形状（它是 Redis 键的一部分，因此必须有界）', () => {
  it('createNonce 是 base64url(16 字节) 且两次不同', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });
});

/**
 * **常量时间比较**的判据（唯一可能的那一种）。
 *
 * ## 为什么不是行为断言
 *
 * 常量时间比较与 `===` 比较在**外部行为上逐字节相同**：输入相同、返回值相同、
 * 异常相同，只有**耗时分布**不同。而「两种实现各测 N 次取平均」在 CI 上是一条
 * 随机器负载变红的断言——本仓库不接受那种证据（它证明的是机器有多闲）。
 *
 * 因此判据落在**结构**上：源码必须调用 `crypto.timingSafeEqual`。
 * **判别力不是推的**：把实现换成 `computed === t.signature`，本用例立刻变红
 * （变异探针的逐字输出见 `.superpowers/sdd/2026-10-05-p1-asset-artifact/task-8-report.md`）。
 * 它证明的是「用的是那个原语」，**不是**「耗时真的是常量」——后者今天没有常驻证据，
 * 据实记载在这里，免得被读成比它更强的东西。
 */
describe('签名比较必须是常量时间原语（结构判据）', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '../../../apps/api/src/modules/asset/download/signed-url.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('源码里调用了 timingSafeEqual', () => {
    expect(code).toMatch(/timingSafeEqual\s*\(/);
  });

  it('源码里没有对签名的 `===` / `==` 比较（那正是它要替代的写法）', () => {
    expect(code).not.toMatch(/(?:signature|computed|expected)\s*[!=]==?\s*(?:t\.signature|signature|computed|expected)/);
  });
});
