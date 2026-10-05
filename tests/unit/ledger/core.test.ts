import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KINDS, SYSTEM_ACCOUNT_KINDS, USER_ACCOUNT_KINDS,
  accountKey, assertAccountKind, isUserAccountKind, normalizeRef,
} from '@vca/api/modules/ledger/core/account-kind.js';
import { UnknownAccountKindError } from '@vca/api/modules/ledger/core/errors.js';

describe('账户类型（§8.1 的五个 / C30）', () => {
  it('取值集合**恰好**是 §8.1 的五个，且用户/系统之分是一张显式的表', () => {
    expect(Object.values(ACCOUNT_KINDS)).toEqual([
      'USER_AVAILABLE', 'USER_FROZEN', 'PLATFORM_ESCROW', 'PLATFORM_REVENUE', 'EXTERNAL_TOPUP',
    ]);
    expect(USER_ACCOUNT_KINDS).toEqual(['USER_AVAILABLE', 'USER_FROZEN']);
    expect(SYSTEM_ACCOUNT_KINDS).toEqual(['PLATFORM_ESCROW', 'PLATFORM_REVENUE', 'EXTERNAL_TOPUP']);
    // 两张表必须**恰好**覆盖五个值（多一个少一个都红）——「不变式 #3 只管用户账户」的依据就是它
    expect([...USER_ACCOUNT_KINDS, ...SYSTEM_ACCOUNT_KINDS].sort())
      .toEqual([...Object.values(ACCOUNT_KINDS)].sort());
  });

  it('§8.2 里的 `SELLER_AVAILABLE` 之流**不是** kind（C30：那会让取值集合与 §8.1 脱钩）', () => {
    for (const fake of ['SELLER_AVAILABLE', 'BUYER_AVAILABLE', 'PAYER_AVAILABLE', 'RECEIVER_AVAILABLE', 'TEST']) {
      expect(isUserAccountKind(fake)).toBe(false);
      expect(() => assertAccountKind(fake)).toThrow(UnknownAccountKindError);
    }
  });

  it('`assertAccountKind` 接受五个、拒绝其余（它是 C30 在库读回值上的执行点）', () => {
    for (const kind of Object.values(ACCOUNT_KINDS)) expect(() => assertAccountKind(kind)).not.toThrow();
    expect(() => assertAccountKind('PLATFORM_ESCROW ')).toThrow(UnknownAccountKindError);   // 尾部空白也不行
  });

  it('`accountKey` / `normalizeRef`：用户 UUID 一律小写、系统账户的 owner 记为空串', () => {
    const UPPER = '018F2A00-0000-7000-8000-00000000000A';
    const user = { kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: UPPER } as const;
    expect(normalizeRef(user).ownerUserId).toBe(UPPER.toLowerCase());
    // accountKey **自己**也归一化：调用方拿到的可能是未规范化的取值（判自转那条路径）
    expect(accountKey(user)).toBe(accountKey({ ...user, ownerUserId: UPPER.toLowerCase() }));
    expect(accountKey({ kind: ACCOUNT_KINDS.PLATFORM_ESCROW, ownerUserId: null })).toBe('PLATFORM_ESCROW:');
  });
});
