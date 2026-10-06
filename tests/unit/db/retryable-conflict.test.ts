import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
  isRetryableConflictError,
  withBoundedConflictRetry,
} from '@vca/api/common/db/retryable-conflict.js';

/**
 * 死锁 / 写冲突的**唯一**判别式与有界重试（P3 / Task 4；C36 / 控制器裁定 ⑧）。
 *
 * ## ★ 两档都要认（预检 §0.4 的实测，逐字）
 * ```
 * [B4]  S1 = {"code":"P2034", … "metaOrigin":"40P01","metaKind":"TransactionWriteConflict"}
 * [B2′] S1 = {"code":"P2010", … "metaOrigin":"40P01"}
 * ```
 * 「**错误码随语句类型变**：经 `$queryRaw` 是 **P2010**，经 Prisma 委托（`createMany`）是
 * **P2034**。两个都带 `cause.originalCode = '40P01'`。」
 * ⇒ 只看 P2034 会漏掉 `$queryRaw` 那条（P1 的 `FOR UPDATE` 就是 `$queryRaw`）——
 * 一个**永远不重试**的判别式，加上一个把原始错误直接抛给调用方的路径。
 *
 * ## 这个文件判的是**判据**（纯逻辑），真库上的两档由
 * ## `tests/integration/ledger/account-lock-order.test.ts` 各造一次**真死锁**见证
 * 两边各自只证明自己那一半：这里证明「给这样一个对象，它说是/不是」；
 * 那里证明「两条真实路径**真的**产出那样一个对象」。
 */
describe('可重试冲突的判别式（C36：两档都要认）', () => {
  it('★ 两档都被认（P2034 = Prisma 委托；P2010 = `$queryRaw`）', () => {
    expect(isRetryableConflictError({ code: 'P2034' })).toBe(true);
    expect(isRetryableConflictError({ code: 'P2010' })).toBe(true);
  });

  it('★ 判别式**不要求** `originalCode` 在场（按 code 判，见下面「代价」那条）', () => {
    // Prisma 到 `@prisma/adapter-pg` 那条路上，`40P01` 出现在 `meta.driverAdapterError.cause`
    // 里，而**两档的 meta 形状不同**（P2010 与 P2034 不是同一个壳）。把 `originalCode` 也
    // 要求上，会让判别式在某个驱动版本上**静默**变成「永不重试」——而那正是本判据要防的方向。
    // 反过来说：带 `meta`、不带 `meta`、带别的 `meta`，只要 code 在两档里就认。
    expect(isRetryableConflictError({ code: 'P2034', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } })).toBe(true);
    expect(isRetryableConflictError({ code: 'P2010', meta: { code: '40P01' } })).toBe(true);
  });

  it('★ 代价据实记载：`P2010` 是「raw query 失败」**一整类**，因此它会**过量接受**', () => {
    // 这是 C36 的裁定方向（「同时认这两档」）的已知代价，写下来免得下一个人以为自己抓到了 bug：
    // 一条**永久性**的 raw 失败（SQLSTATE 42P01 = 表不存在、42601 = 语法错）同样会被判为可重试。
    // 两个理由让它可接受：
    //   ① 上界是 `maxAttempts`（默认 3）——只多跑两次；
    //   ② 用尽之后抛出的是**原来那个错误**（下面那条见证），调用方看到的仍是 42P01，
    //      不会被伪装成「争用」。
    // 反面（只认「带 40P01 的 P2010」）才是危险的：预检实测两档的 `meta` 形状不同，
    // 要求它等于把「永不重试」写死在一个我们没量过的驱动细节上。
    expect(isRetryableConflictError({ code: 'P2010', meta: { code: '42P01' } })).toBe(true);
  });

  it.each([
    ['P2002（唯一约束：重放/冲突，**不是**死锁）', { code: 'P2002' }],
    ['P2028（交互式事务超时，503 那一档）', { code: 'P2028' }],
    ['P2025（记录不存在）', { code: 'P2025' }],
    ['P1001（连不上数据库）', { code: 'P1001' }],
    ['没有 code 的普通 Error', new Error('业务失败')],
    ['code 是数字而不是字符串', { code: 2034 }],
    ["大小写不匹配（`Code` 不是这里的形状）", { Code: 'P2034' }],
  ])('★ 不可重试的一律为 false：%s', (_label, error) => {
    // 拒绝面必须比验收面**宽**地覆盖：把任何 Prisma 错误都当可重试，会让一次真正的
    // 不变量破坏被重试三次（而它每次都坏），也会让「重试安全」这句话变成猜测。
    expect(isRetryableConflictError(error)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'P2034'],
    ['数字', 2034],
    ['函数', () => undefined],
  ])('非对象输入不抛、判为不可重试：%s', (_label, value) => {
    // 判别式在 `catch` 里被调用，输入可能是**任何东西**（P2 审查记过同族的坑：
    // 翻译表在 catch 里再抛一次，得到的是一个与根因无关的 500）。
    expect(() => isRetryableConflictError(value)).not.toThrow();
    expect(isRetryableConflictError(value)).toBe(false);
  });
});

/** 造一个「前 `failures` 次抛可重试错误、之后成功」的假件，并记下每次调用的序号。 */
function flaky<T>(failures: number, value: T, error: unknown = { code: 'P2034' }) {
  const calls: number[] = [];
  const fn = async (): Promise<T> => {
    calls.push(calls.length + 1);
    if (calls.length <= failures) throw error;
    return value;
  };
  return { fn, calls, error };
}

describe('有界重试（`withBoundedConflictRetry`）', () => {
  it('验收面：一次就成功 ⇒ 只调用一次、不触发 onRetry', async () => {
    const retries: number[] = [];
    const { fn, calls } = flaky(0, 'ok');
    await expect(withBoundedConflictRetry(fn, { onRetry: (n) => retries.push(n) })).resolves.toBe('ok');
    expect(calls).toHaveLength(1);
    expect(retries).toEqual([]);
  });

  it('★ 前两次可重试、第三次成功 ⇒ 调用三次，onRetry 收到**序号与那个错误**', async () => {
    const seen: Array<[number, unknown]> = [];
    const { fn, calls, error } = flaky(2, 'ok');
    await expect(
      withBoundedConflictRetry(fn, { onRetry: (attempt, err) => seen.push([attempt, err]) }),
    ).resolves.toBe('ok');
    expect(calls).toHaveLength(3);
    // 序号是「第几次尝试失败」（1、2），且**原样**把错误交出来（排障要它的 code 与 meta）：
    expect(seen.map(([n]) => n)).toEqual([1, 2]);
    expect(seen.every(([, err]) => err === error)).toBe(true);
  });

  it('★ 次数用尽 ⇒ 抛出**最后一次**的原错误（不包装、不换成聚合错误）', async () => {
    const errors = [{ code: 'P2034', tag: 'first' }, { code: 'P2010', tag: 'second' }, { code: 'P2034', tag: 'third' }];
    let i = 0;
    const fn = async (): Promise<never> => {
      const error = errors[Math.min(i, errors.length - 1)];
      i += 1;
      throw error;
    };
    const captured = await withBoundedConflictRetry(fn).then(() => null, (e: unknown) => e);
    // 同一个对象（`toBe`），不是「一个消息相同的 Error」——包装会同时毁掉 `code` 与 `meta`，
    // 而那两样是 `ledgerErrorToHttp` 与日志判别式的全部线索。
    expect(captured).toBe(errors[2]);
    expect(i).toBe(3);
    expect(DEFAULT_MAX_CONFLICT_ATTEMPTS).toBe(3);
  });

  it('★ 不可重试的错误**不重试**：调用一次、原样抛出（两种输入各一条）', async () => {
    for (const error of [{ code: 'P2002' }, new Error('业务失败')]) {
      let calls = 0;
      const fn = async (): Promise<never> => {
        calls += 1;
        throw error;
      };
      const captured = await withBoundedConflictRetry(fn).then(() => null, (e: unknown) => e);
      expect(captured).toBe(error);
      expect(calls, '不可重试的错误被重试了').toBe(1);
    }
  });

  it('`maxAttempts` 可控：给 1 ⇒ 只试一次（即便错误是可重试的）', async () => {
    const { fn, calls } = flaky(5, 'never');
    const captured = await withBoundedConflictRetry(fn, { maxAttempts: 1 }).then(() => null, (e: unknown) => e);
    expect(captured).toEqual({ code: 'P2034' });
    expect(calls).toHaveLength(1);
  });

  it('★ `maxAttempts` 给 0 / 负数 ⇒ 夹到 1（否则 `throw lastError` 会抛 `undefined`）', async () => {
    // 这条钉的是一个**边界而不是风格**：循环体一次都不进时 `lastError` 仍是 `undefined`，
    // 于是 `throw lastError` 抛出的那个值连 `instanceof Error` 都不成立——调用方拿到的
    // 失败没有任何栈、没有任何 code。夹到 1 保住的正是「抛出的永远是调用方给的那个错误」。
    for (const maxAttempts of [0, -1]) {
      const { fn, calls, error } = flaky(5, 'never');
      const captured = await withBoundedConflictRetry(fn, { maxAttempts }).then(() => null, (e: unknown) => e);
      expect(captured).toBe(error);
      expect(calls, `maxAttempts=${String(maxAttempts)} 时一次都没试`).toHaveLength(1);
    }
  });

  it('不传 `onRetry` 不崩（可选参数）', async () => {
    const { fn } = flaky(1, 'ok');
    await expect(withBoundedConflictRetry(fn)).resolves.toBe('ok');
  });
});
