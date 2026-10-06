import { describe, expect, it } from 'vitest';
import {
  disputeWindowExpired,
  dueContractActions,
  dueOfferActions,
  lockWindowExpired,
  offerExpired,
} from '@vca/api/modules/exchange/core/timers.js';

/**
 * 三个计时器（D13 / §6.3 的 72h + 24h、§8.4 的 7 天）。**Task 3 的时间判据。**
 *
 * ## 为什么判据是「收 `now` 的纯函数」（控制器裁定 ⑩，逐字）
 * 「**收 `now` 的纯函数 + 可注入 tick 的 runner**（照 `inspectTicket` 的先例）。理由：
 * **一个只能靠等待来测的 7 天计时器是不可测的。**」
 * 预检 §0.5 的实测：`setInterval` / `@nestjs/schedule` / `@Cron` / `scheduler` 源码
 * **零匹配**、测试里**假时钟零匹配**。因此这三个判据一行都不读进程时钟，
 * 而「过窗 / 未过窗」两个方向都能在同一毫秒里被断言。
 *
 * ## 边界是**闭**的
 * `now >= deadline` 算到期（`>=` 而不是 `>`）。用 `>` 会在**恰好**那一毫秒放行，
 * 而「7 天后的自动确认」在毫秒上差一位是不可测的——这条纪律的**唯一**先例是
 * `inspectTicket(ticket, secret, now)`（`signed-url.ts:155` 的 `ticket.expiresAt <= now`）。
 *
 * ## 为什么 `Date` 的比较要写成 `getTime()`
 * `Date` 是对象：`a < b` 走 `valueOf()`（毫秒数，可用），而 `a === b` 走**引用**
 * （两个表示同一毫秒的对象并不相等）。判据里一律显式取毫秒，两种比较因此说的是同一件事。
 */

const T = (iso: string): Date => new Date(iso);

/** 一个「什么都没发生」的合约快照；每条用例只覆盖它关心的那几个字段。 */
const contract = (over: Partial<Parameters<typeof dueContractActions>[0]> = {}) => ({
  status: 'PENDING_BOTH_LOCK',
  lockDeadlineAt: T('2026-10-06T00:00:00.000Z'),
  lockedByAAt: null,
  lockedByBAt: null,
  releasedAt: null,
  disputeDeadlineAt: null,
  disputedAt: null,
  ...over,
});

describe('三个计时器（D13 / §6.3 的 72h / 24h + §8.4 的 7 天）', () => {
  it('★ 边界是**闭**的：恰好到点算到期（`>=` 而不是 `>`）', () => {
    const offer = { status: 'SENT', expiresAt: T('2026-10-10T00:00:00.000Z'), acceptedContractId: null };
    expect(offerExpired(offer, T('2026-10-09T23:59:59.999Z'))).toBe(false);
    expect(offerExpired(offer, T('2026-10-10T00:00:00.000Z'))).toBe(true); // ← 恰好
    expect(offerExpired(offer, T('2026-10-10T00:00:00.001Z'))).toBe(true);
    // ★ 同一毫秒的两个**不同对象**必须算到期（`===` 走引用，那是这个坑的另一半）。
    expect(offerExpired(offer, new Date('2026-10-10T00:00:00.000Z'))).toBe(true);
  });

  it('24h 的边界同样是闭的（`lockWindowExpired` 直接行使，不只靠 `dueContractActions`）', () => {
    const c = contract(); // lockDeadlineAt = 2026-10-06T00:00:00.000Z
    expect(lockWindowExpired(c, T('2026-10-05T23:59:59.999Z'))).toBe(false);
    expect(lockWindowExpired(c, T('2026-10-06T00:00:00.000Z'))).toBe(true);
    expect(lockWindowExpired(c, T('2026-10-06T00:00:00.001Z'))).toBe(true);
  });

  it('7 天的边界同样是闭的；**没有窗口**（未释放）时判为「未到期」', () => {
    const released = contract({
      status: 'RELEASED',
      releasedAt: T('2026-10-07T00:00:00.000Z'),
      disputeDeadlineAt: T('2026-10-14T00:00:00.000Z'),
    });
    expect(disputeWindowExpired(released, T('2026-10-13T23:59:59.999Z'))).toBe(false);
    expect(disputeWindowExpired(released, T('2026-10-14T00:00:00.000Z'))).toBe(true);
    // `dispute_deadline_at` 是**可空**列（只有释放过的合约才有值）。
    // 没有窗口 ⇒ **不**判为到期（fail-closed）：在一个没有窗口的合约上自动放款，
    // 等于绕开 §8.4 的「争议期间全额冻结」。见 `dueContractActions` 的第四种输入。
    expect(disputeWindowExpired(contract(), T('2030-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('`dueOfferActions`：只有 `SENT` 会过期（终态的要约即使过期也不产生动作）', () => {
    const past = T('2020-01-01T00:00:00.000Z');
    const now = T('2026-10-07T00:00:00.000Z');
    for (const status of ['DRAFT', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED']) {
      expect(dueOfferActions({ status, expiresAt: past, acceptedContractId: null }, now)).toEqual([]);
    }
    expect(dueOfferActions({ status: 'SENT', expiresAt: past, acceptedContractId: null }, now)).toEqual([
      { kind: 'expire-offer' },
    ]);
  });

  it('`dueOfferActions`：**未**过期的 `SENT` 不产生动作（反面对照——少了它，「怎么都过期」也能骗过上面那条）', () => {
    const now = T('2026-10-07T00:00:00.000Z');
    expect(
      dueOfferActions({ status: 'SENT', expiresAt: T('2026-10-10T00:00:00.000Z'), acceptedContractId: null }, now),
    ).toEqual([]);
    expect(
      dueOfferActions({ status: 'SENT', expiresAt: T('2026-10-07T00:00:00.000Z'), acceptedContractId: null }, now),
    ).toEqual([{ kind: 'expire-offer' }]);
  });

  it('★ 已有合约的 `SENT` 要约**不**被自动过期（一行不一致的数据不该产生动作）', () => {
    // `acceptedContractId` 非空而 `status` 还是 `SENT` 是一行**不可能**的数据
    // （接受动作在同一次迁移里把 status 翻成 ACCEPTED）。而这份快照的字段是
    // `timers.ts` 唯一的消费者，因此这条守卫必须有见证：真出现这种行时，
    // 自动 EXPIRED 会让「合约存在」与「要约是终态 EXPIRED」同时成立。
    const now = T('2026-10-07T00:00:00.000Z');
    expect(
      dueOfferActions(
        { status: 'SENT', expiresAt: T('2020-01-01T00:00:00.000Z'), acceptedContractId: 'c-1' },
        now,
      ),
    ).toEqual([]);
  });

  it('24h：`PENDING_BOTH_LOCK` 超时 ⇒ cancel；`VALIDATING` 超时 ⇒ **不**产生动作（D8 的边界）', () => {
    // 为什么 VALIDATING 不自动取消：§6.3:286 的箭头只有 `通过 → RELEASED` 与
    // `RELEASED 前任一方退出 → CANCELLED`。把「校验超时」也自动取消会**多出一条**
    // §6.3 没授权的边，而那正是状态机用例要拦的改动。校验不通过是一次拒绝，
    // 合约停在 VALIDATING 等人修（或人退）。
    const now = T('2026-10-07T00:00:00.000Z');
    const overdue = contract(); // lockDeadlineAt = 2026-10-06T00:00:00.000Z
    expect(dueContractActions(overdue, now)).toEqual([{ kind: 'cancel-contract', reason: 'lock-timeout' }]);
    expect(dueContractActions({ ...overdue, status: 'VALIDATING' }, now)).toEqual([]);
  });

  it('24h：**未**到期的 `PENDING_BOTH_LOCK` 不产生动作（反面对照）', () => {
    expect(dueContractActions(contract(), T('2026-10-05T23:59:59.999Z'))).toEqual([]);
    expect(dueContractActions(contract(), T('2026-10-06T00:00:00.000Z'))).toEqual([
      { kind: 'cancel-contract', reason: 'lock-timeout' },
    ]);
  });

  it('★ 7 天自动确认：`RELEASED` 且过窗且**无争议** ⇒ settle；其余四种输入都**不** settle', () => {
    const now = T('2026-10-15T00:00:00.000Z');
    const released = contract({
      status: 'RELEASED',
      lockDeadlineAt: T('2026-10-05T00:00:00.000Z'),
      lockedByAAt: T('2026-10-05T00:00:00.000Z'),
      lockedByBAt: T('2026-10-05T00:00:00.000Z'),
      releasedAt: T('2026-10-07T00:00:00.000Z'),
      disputeDeadlineAt: T('2026-10-14T00:00:00.000Z'),
      disputedAt: null,
    });
    expect(dueContractActions(released, now)).toEqual([{ kind: 'settle-contract' }]);
    // ① 未到点：不产生动作（反面对照 —— 少了它，「怎么都 settle」的实现也能骗过上面那条）。
    expect(dueContractActions(released, T('2026-10-13T23:59:59.999Z'))).toEqual([]);
    // ② 已争议：**不再**自动结算（钱还冻着等裁决）。
    expect(dueContractActions({ ...released, disputedAt: T('2026-10-08T00:00:00.000Z') }, now)).toEqual([]);
    // ③ `DISPUTED` 状态本身不产生定时动作（裁决是人的动作，§2.1 把仲裁归 P6）。
    expect(dueContractActions({ ...released, status: 'DISPUTED' }, now)).toEqual([]);
    // ④ fail-closed：`RELEASED` 但**没有争议期截止时刻**（列可空）⇒ 不自动放款。
    expect(dueContractActions({ ...released, disputeDeadlineAt: null }, now)).toEqual([]);
    // ⑤ 两个终态不产生任何定时动作。
    expect(dueContractActions({ ...released, status: 'SETTLED' }, now)).toEqual([]);
    expect(dueContractActions({ ...released, status: 'CANCELLED' }, now)).toEqual([]);
  });

  it('★ 判据内部**绝不**读进程时钟（D13）', () => {
    // 判据全部显式收 `now`。这条用例把「不可能通过等待来测」这个性质变成一条可执行的断言：
    // 同一个 snapshot 传两个不同的 `now`，**必须**得到不同的结论。
    const c = contract({
      status: 'RELEASED',
      releasedAt: T('2026-10-07T00:00:00.000Z'),
      disputeDeadlineAt: T('2026-10-14T00:00:00.000Z'),
    });
    expect(dueContractActions(c, T('2026-10-13T00:00:00.000Z'))).toEqual([]);
    expect(dueContractActions(c, T('2026-10-15T00:00:00.000Z'))).toEqual([{ kind: 'settle-contract' }]);
    // 同一份快照 + 同一个 `now` ⇒ 逐字相同的结论（没有隐藏状态、没有累积）。
    expect(dueContractActions(c, T('2026-10-15T00:00:00.000Z'))).toEqual(
      dueContractActions(c, T('2026-10-15T00:00:00.000Z')),
    );
  });
});
