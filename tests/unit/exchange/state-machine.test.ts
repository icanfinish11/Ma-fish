import { describe, expect, it } from 'vitest';
import {
  CONTRACT_TRANSITIONS,
  OFFER_TRANSITIONS,
  assertContractTransition,
  assertOfferTransition,
  bothLocked,
  contractStatusOf,
  offerStatusOf,
} from '@vca/api/modules/exchange/core/state-machine.js';
import {
  CONTRACT_STATUSES,
  OFFER_STATUSES,
} from '@vca/api/modules/exchange/core/types.js';
import {
  InvalidExchangeTransitionError,
  UnknownExchangeStatusError,
} from '@vca/api/modules/exchange/core/errors.js';

/**
 * 两张状态机（设计 §6.3；Task 3）。
 *
 * ## 这张表是**逐条**的，不是「跑几个常见路径」
 * §6.3 的原文是一张图，而图里的**每一条边**都是一次授权：`ACCEPTED → REJECTED` 不是
 * 「少见」，它是**不该存在** —— 一条从 `ACCEPTED` 回到 `REJECTED` 的边会让一个已经生成了
 * 合约的要约重新接受拒绝，而合约还在。因此这里对**每一个 (from, to) 组合**断言，
 * 而不是只走 happy path。
 *
 * ## 为什么拒绝面必须逐条配一条验收面
 * 一个 `assertXTransition` 只要写成 `throw new Error()` 就能通过全部拒绝用例。
 * 因此每个状态都至少有一条**合法**迁移被接受（下面两条「逐条被接受」的用例），
 * 并且终态的**空出边**也被单独钉住。
 *
 * ## 三处取值集合的一致性
 * 闭集同时出现在三处：迁移里的 `CHECK`（`swap_offers_status_check` /
 * `swap_contracts_status_check`，Task 2 的真库取证）、这里的两张表、以及 HTTP 的 DTO
 * （Task 6）。`pnpm test` 里能看着它们的是本文件（表逐字 + 穷举计数）与
 * `tests/integration/db/exchange-enforcement.test.ts`（真库的 `pg_get_constraintdef`）。
 */

/** 常量从**定义处**读（而不是在用例里重抄一遍字面量）——重抄会让「表改了、用例没改」静默通过。 */
const OFFER_ALL = Object.keys(OFFER_TRANSITIONS) as (keyof typeof OFFER_TRANSITIONS)[];
const CONTRACT_ALL = Object.keys(CONTRACT_TRANSITIONS) as (keyof typeof CONTRACT_TRANSITIONS)[];

describe('交换的状态机（§6.3 / Task 3）', () => {
  it('要约：§6.3:276-280 的五条边逐条被接受', () => {
    for (const [from, to] of [
      ['DRAFT', 'SENT'],
      ['SENT', 'ACCEPTED'],
      ['SENT', 'REJECTED'],
      ['SENT', 'WITHDRAWN'],
      ['SENT', 'EXPIRED'],
    ] as const) {
      expect(() => assertOfferTransition(from, to), `${from} → ${to} 应当被接受`).not.toThrow();
    }
  });

  it('要约：所有**未在** §6.3 里画出的迁移逐条被拒（穷举 6×6，减去 5 条合法边）', () => {
    let rejected = 0;
    let accepted = 0;
    for (const from of OFFER_ALL) {
      for (const to of OFFER_ALL) {
        if (OFFER_TRANSITIONS[from].includes(to)) {
          accepted += 1;
          continue;
        }
        expect(() => assertOfferTransition(from, to), `${from} → ${to} 不该被接受`).toThrow(
          InvalidExchangeTransitionError,
        );
        rejected += 1;
      }
    }
    // 6×6 = 36 = 5 合法 + 31 非法。写死这两个数：表里**多出**一条边时它会红，
    // 而那正是要拦的改动（多一条边 = 一条没被 §6.3 授权的迁移）。
    // 两个数都断言（而不是只断言 rejected）的原因：只数非法组合的话，
    // 「把一条合法边删掉」会同时让 accepted 少 1、rejected 多 1 —— 计数仍然自洽，
    // 于是那次删除静默通过。两个数一起钉，删除与新增都会红。
    expect(rejected).toBe(31);
    expect(accepted).toBe(5);
    // 终态没有出边（§6.3 的图里它们没有画出去的箭头）。
    for (const terminal of ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'] as const) {
      expect(OFFER_TRANSITIONS[terminal], `${terminal} 是终态，不该有出边`).toEqual([]);
    }
  });

  it('要约：整张表**逐字**等于 §6.3 的图（新增一条边会在这里指名道姓地红）', () => {
    expect(OFFER_TRANSITIONS).toEqual({
      DRAFT: ['SENT'],
      SENT: ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'],
      ACCEPTED: [],
      REJECTED: [],
      WITHDRAWN: [],
      EXPIRED: [],
    });
    // 表覆盖的键**恰好**是闭集（少一个键会让 `assertOfferTransition` 在运行期读到
    // `undefined.includes` ⇒ TypeError，那是一条与「非法迁移」无法区分的红）。
    expect([...OFFER_ALL].sort()).toEqual([...Object.values(OFFER_STATUSES)].sort());
  });

  it('合约：§6.3:282-291 的七条边逐条被接受', () => {
    for (const [from, to] of [
      ['PENDING_BOTH_LOCK', 'VALIDATING'],
      ['PENDING_BOTH_LOCK', 'CANCELLED'],
      ['VALIDATING', 'RELEASED'],
      ['VALIDATING', 'CANCELLED'],
      ['RELEASED', 'SETTLED'],
      ['RELEASED', 'DISPUTED'],
      ['DISPUTED', 'SETTLED'],
    ] as const) {
      expect(() => assertContractTransition(from, to), `${from} → ${to} 应当被接受`).not.toThrow();
    }
  });

  it('合约：未画出的迁移逐条被拒（穷举 6×6 = 7 合法 + 29 非法），终态无出边', () => {
    let rejected = 0;
    let accepted = 0;
    for (const from of CONTRACT_ALL) {
      for (const to of CONTRACT_ALL) {
        if (CONTRACT_TRANSITIONS[from].includes(to)) {
          accepted += 1;
          continue;
        }
        expect(() => assertContractTransition(from, to), `${from} → ${to} 不该被接受`).toThrow(
          InvalidExchangeTransitionError,
        );
        rejected += 1;
      }
    }
    expect(accepted).toBe(7);
    expect(rejected).toBe(29);
    for (const terminal of ['SETTLED', 'CANCELLED'] as const) {
      expect(CONTRACT_TRANSITIONS[terminal], `${terminal} 是终态，不该有出边`).toEqual([]);
    }
    expect([...CONTRACT_ALL].sort()).toEqual([...Object.values(CONTRACT_STATUSES)].sort());
  });

  it('合约：整张表**逐字**等于 §6.3 + D18（`DISPUTED` 只有一个出口）', () => {
    expect(CONTRACT_TRANSITIONS).toEqual({
      PENDING_BOTH_LOCK: ['VALIDATING', 'CANCELLED'],
      VALIDATING: ['RELEASED', 'CANCELLED'],
      RELEASED: ['SETTLED', 'DISPUTED'],
      // ★ C31 / D6：`DISPUTED` 的唯一出路是 `SETTLED`（一次**冻结释放**）。
      //   `RESOLVED_UPHELD` / `RESOLVED_REVERSED` **不存在**（D18：裁决 = 一次冻结释放，
      //   不是账本逆向，因此没有「回到 RELEASED」这条边）。
      DISPUTED: ['SETTLED'],
      SETTLED: [],
      CANCELLED: [],
    });
  });

  it('★ `RELEASED` 之后**没有** CANCELLED 这条边（D8：退出只在释放之前）', () => {
    // 这条单独写出来，因为它是 C31 之所以成立的一半理由：钱还好端端冻着的时候才有退出。
    expect(() => assertContractTransition('RELEASED', 'CANCELLED')).toThrow(
      InvalidExchangeTransitionError,
    );
    expect(() => assertContractTransition('DISPUTED', 'CANCELLED')).toThrow(
      InvalidExchangeTransitionError,
    );
    // 反面对照：`RELEASED` **之前**的两条 CANCELLED 都合法（上面「七条边」那条已断言）。
    // 没有这一对照，一个「CANCELLED 谁都别想进」的实现也能让上面两行绿。
    expect(() => assertContractTransition('PENDING_BOTH_LOCK', 'CANCELLED')).not.toThrow();
    expect(() => assertContractTransition('VALIDATING', 'CANCELLED')).not.toThrow();
  });

  it('★ **不存在** `DISPUTED → RELEASED`（争议裁决 = 一次冻结释放，不是回到已释放）', () => {
    // C31 / D6 的可执行见证：`RESOLVED_REVERSED` 这个状态**不存在**，
    // 因此任何「回到 RELEASED」的迁移都是错的。
    expect(() => assertContractTransition('DISPUTED', 'RELEASED')).toThrow(
      InvalidExchangeTransitionError,
    );
    expect(CONTRACT_TRANSITIONS.DISPUTED).toEqual(['SETTLED']);
  });

  it('闭集外的取值被拒（`status` 从库里读回来时是 `string`）', () => {
    expect(offerStatusOf('SENT')).toBe('SENT');
    expect(contractStatusOf('RELEASED')).toBe('RELEASED');
    expect(() => offerStatusOf('NOT_A_STATUS')).toThrow(UnknownExchangeStatusError);
    expect(() => contractStatusOf('NOT_A_STATUS')).toThrow(UnknownExchangeStatusError);
    // 两个闭集**不通用**：一个 offer 的状态不能被当成合约的状态收下。
    // 这一对断言挡的是「两个函数共用一张集合」那种实现——它今天不会红在任何别的地方。
    expect(() => offerStatusOf('RELEASED')).toThrow(UnknownExchangeStatusError);
    expect(() => contractStatusOf('SENT')).toThrow(UnknownExchangeStatusError);
  });

  it('闭集里的每一个取值都被接受（**验收面**：一个什么都拒的实现上面那条也绿）', () => {
    for (const s of Object.values(OFFER_STATUSES)) {
      expect(offerStatusOf(s), `${s} 应当被接受`).toBe(s);
    }
    for (const s of Object.values(CONTRACT_STATUSES)) {
      expect(contractStatusOf(s), `${s} 应当被接受`).toBe(s);
    }
  });

  it('`bothLocked`：两个时间戳都非 null 才算（一个不算、零个不算）', () => {
    const base = {
      status: 'PENDING_BOTH_LOCK',
      lockDeadlineAt: new Date(0),
      releasedAt: null,
      disputeDeadlineAt: null,
      disputedAt: null,
    };
    const t = new Date('2026-10-07T00:00:00.000Z');
    expect(bothLocked({ ...base, lockedByAAt: t, lockedByBAt: t })).toBe(true);
    expect(bothLocked({ ...base, lockedByAAt: t, lockedByBAt: null })).toBe(false);
    expect(bothLocked({ ...base, lockedByAAt: null, lockedByBAt: t })).toBe(false);
    expect(bothLocked({ ...base, lockedByAAt: null, lockedByBAt: null })).toBe(false);
  });
});
