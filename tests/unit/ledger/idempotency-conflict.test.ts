import { describe, expect, it } from 'vitest';
import { isIdempotencyConflict } from '@vca/api/modules/ledger/ledger.service.js';

/**
 * P2002 判别器（D9 / C26）。
 *
 * 它守的是一句**规则**而不是一种错误：幂等键的并发冲突**只**认
 * `transactions_idempotency_key` 这一条约束，别的唯一冲突必须冒出来。
 * 把任何 P2002 都当成「重放」，就是把「静默去重」写进重试层——那正是 C26 禁止的形状。
 *
 * 三条用例里**第二条是反例**：没有它，`return code === 'P2002'` 也能全绿，
 * 而那种实现在库里多一个唯一索引的那天就会开始吞错。
 */

/** 造一个 Prisma 形状的 P2002（预检 C.7 实测的字段位置）。 */
function p2002(constraint: string): unknown {
  return {
    name: 'PrismaClientKnownRequestError',
    code: 'P2002',
    message: 'Unique constraint failed on the fields: (`idempotency_key`)',
    meta: {
      modelName: 'LedgerTransaction',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { originalCode: '23505', constraint: { index: constraint } },
      },
    },
  };
}

describe('幂等冲突判别器（D9）', () => {
  it('认这一条约束（约束名在 meta 里）', () => {
    expect(isIdempotencyConflict(p2002('transactions_idempotency_key'))).toBe(true);
    // 库里那条唯一索引的**真实名字**带一个 `_key` 后缀（迁移逐字：
    // `CREATE UNIQUE INDEX "transactions_idempotency_key_key"`）。判别器按**子串**判，
    // 两种写法都是同一条约束；这条断言把「真实名字也能被认出来」钉住。
    expect(isIdempotencyConflict(p2002('transactions_idempotency_key_key'))).toBe(true);
  });

  it('别的 P2002 **不**认（否则别的唯一冲突会被静默吞掉 —— 那就是「静默去重」）', () => {
    expect(isIdempotencyConflict(p2002('accounts_owner_user_id_kind_key'))).toBe(false);
    expect(isIdempotencyConflict(p2002('ledger_transactions_pkey'))).toBe(false);
    expect(isIdempotencyConflict(p2002('audit_logs_pkey'))).toBe(false);
  });

  it('非 P2002 与任意怪值不认（fail-closed：不重试、不吞错）', () => {
    expect(isIdempotencyConflict(null)).toBe(false);
    expect(isIdempotencyConflict(undefined)).toBe(false);
    expect(isIdempotencyConflict('P2002')).toBe(false);
    expect(isIdempotencyConflict({ code: 'P2034' })).toBe(false);
    expect(isIdempotencyConflict({})).toBe(false);
    // 只有约束名、没有 code 也不认：判别器的判据是「P2002 **且** 那一条约束」，缺一不可。
    expect(isIdempotencyConflict({ code: 'P2002', meta: {} })).toBe(false);
    expect(isIdempotencyConflict({ code: 'P2002' })).toBe(false);
  });

  it('判别器自己**绝不抛**：循环引用 / 会抛的 toJSON 都不该把失败路径变成另一个失败', () => {
    // `safeJson` 的契约是「探不到就返回 false」。若它自己在 JSON.stringify 上抛出，
    // 这个错误会从 `runWithIdempotentRetry` 的 catch 块里冒出来，把「重不重试」这件事
    // 换成一个与数据库毫无关系的异常。
    const circular: { code: string; meta: Record<string, unknown> } = { code: 'P2002', meta: {} };
    circular.meta.self = circular;
    expect(() => isIdempotencyConflict(circular)).not.toThrow();
    expect(isIdempotencyConflict(circular)).toBe(false);

    const throwing = {
      code: 'P2002',
      meta: { toJSON: () => { throw new Error('toJSON 炸了'); } },
    };
    expect(() => isIdempotencyConflict(throwing)).not.toThrow();
    expect(isIdempotencyConflict(throwing)).toBe(false);
  });

  it('约束名落在 message 里（而不是 meta 里）时也认 —— 两种来源都探', () => {
    expect(
      isIdempotencyConflict({
        code: 'P2002',
        message: 'duplicate key value violates unique constraint "transactions_idempotency_key_key"',
      }),
    ).toBe(true);
    expect(
      isIdempotencyConflict({
        code: 'P2002',
        message: 'duplicate key value violates unique constraint "accounts_owner_user_id_kind_key"',
      }),
    ).toBe(false);
  });
});
