import { UnknownAccountKindError } from './errors.js';

/**
 * §8.1 的五个账户类型 —— **唯一的取值集合定义处**（C30）。
 *
 * ## 为什么 §8.2 里的 `SELLER_AVAILABLE` / `BUYER_AVAILABLE` 之流不在这里
 * 它们**不是**新的 kind，而是「另一个用户的 `USER_AVAILABLE`」（C30）。这不是洁癖：
 * `ledger.accounts.kind` 的取值集合与 §8.1 那张表脱钩之后，迁移里那条**条件化** CHECK
 * （`kind NOT IN ('USER_AVAILABLE','USER_FROZEN') OR balance >= 0`）就失去依据——
 * 一个 `SELLER_AVAILABLE` 会绕过不变式 #3，而且它看起来完全正常。
 *
 * ## 为什么「用户 / 系统」之分必须是两张显式的表
 * 它是三处的共同依据，任何一处写歪都会静默出错：
 *   ① 不变式 #3（只有用户账户不可透支）：纯核心 `applyPosting` 与 `applyBalances` 的守卫；
 *   ② 迁移里的条件化 CHECK（系统账户天然为负——实测：无条件 CHECK 会钉死充值路径）；
 *   ③ D2 的「用户账户惰性创建、系统账户由迁移种子化」（系统账户的 owner 是 NULL，
 *      而 `(owner_user_id, kind)` 上的唯一索引把 NULL 视为互不相同）。
 */
export const ACCOUNT_KINDS = {
  USER_AVAILABLE: 'USER_AVAILABLE',
  USER_FROZEN: 'USER_FROZEN',
  PLATFORM_ESCROW: 'PLATFORM_ESCROW',
  PLATFORM_REVENUE: 'PLATFORM_REVENUE',
  EXTERNAL_TOPUP: 'EXTERNAL_TOPUP',
} as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[keyof typeof ACCOUNT_KINDS];

/** 用户账户：有 owner，受不变式 #3 约束。 */
export const USER_ACCOUNT_KINDS: readonly AccountKind[] = [
  ACCOUNT_KINDS.USER_AVAILABLE,
  ACCOUNT_KINDS.USER_FROZEN,
];

/** 系统账户：owner 为 NULL，天然为负（充值对手方与两个平台账户）。 */
export const SYSTEM_ACCOUNT_KINDS: readonly AccountKind[] = [
  ACCOUNT_KINDS.PLATFORM_ESCROW,
  ACCOUNT_KINDS.PLATFORM_REVENUE,
  ACCOUNT_KINDS.EXTERNAL_TOPUP,
];

const USER_KIND_SET: ReadonlySet<string> = new Set(USER_ACCOUNT_KINDS);
const ALL_KIND_SET: ReadonlySet<string> = new Set(Object.values(ACCOUNT_KINDS));

export function isUserAccountKind(kind: string): boolean {
  return USER_KIND_SET.has(kind);
}

/**
 * C30 的执行点：§8.1 之外的 kind 一律抛 `UnknownAccountKindError`。
 *
 * 为什么是 `asserts kind is AccountKind` 而不是返回 boolean：它的真实用武之地是
 * **从库里读回来的字符串**（`LedgerService` 的 `row.kind`），那里必须把 `string`
 * 收窄成 `AccountKind` 才能交给纯核心；返回 boolean 会逼每个调用点写一次 `as`，
 * 而 `as` 不做任何检查。
 */
export function assertAccountKind(kind: string): asserts kind is AccountKind {
  if (!ALL_KIND_SET.has(kind)) throw new UnknownAccountKindError(kind);
}

/**
 * 规范化：用户 UUID 一律小写。
 *
 * P1 的 `ownership.service` 实测过「大写拼写绕过守卫」：库里存的是小写，而大写形式与
 * 那一行**不相等**——判自转、查账户、比较腿都会静默 miss。
 */
export function normalizeRef(ref: { kind: AccountKind; ownerUserId: string | null }): {
  kind: AccountKind;
  ownerUserId: string | null;
} {
  return {
    kind: ref.kind,
    ownerUserId: ref.ownerUserId === null ? null : ref.ownerUserId.toLowerCase(),
  };
}

/**
 * 账户在**一次过账内**的唯一身份键（纯核心的 Map 用它，与数据库无关）。
 *
 * 系统账户的 owner 记为 `''`：`(owner_user_id, kind)` 的唯一性在库里由索引负责
 * （且 NULL 互不相同，见 D2），这里只需要一个稳定的字符串键。**它自己也做小写归一化**：
 * 调用方（尤其是「判自转」那条路径）手里的取值可能是未规范化的，而 key 必须一致。
 */
export function accountKey(ref: { kind: AccountKind; ownerUserId: string | null }): string {
  return `${ref.kind}:${ref.ownerUserId === null ? '' : ref.ownerUserId.toLowerCase()}`;
}
