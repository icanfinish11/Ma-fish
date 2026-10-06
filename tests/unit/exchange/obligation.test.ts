import { describe, expect, it } from 'vitest';
import { escrowCovers, sumOutstanding } from '@vca/api/modules/exchange/core/obligation.js';

/**
 * 托管的 `≥` 判据（§8.3 不变式 #4 / Task 3）。**跨合约那一半的第一个执行点。**
 *
 * ## 它为什么必须存在（预检 §0.3 的证伪，逐字）
 * 「两个合约各锁 1000，其中一笔释放 **1500** ⇒ **接受**、ESCROW=500（≥0）、
 * `isBalanced=true`、审计如实。**平台为该合约付出了它从未为这份合约持有的 500 分，
 * 而没有任何东西看得见。**」
 *
 * 不变式 #4 的两边来自**两个模块**：`Σ PLATFORM_ESCROW`（左式）由 **ledger** 报，
 * `Σ 未结算义务`（右式）由 **exchange** 报。C5 禁止 `exchange` join `ledger`，
 * 因此这条判据的形状只能是「两个数进来、一个布尔出去」——**它不查库，也查不了库**。
 * 编排（真的去问 ledger 要 ESCROW 余额、拿到不符时抛 `EscrowShortfallError`）是
 * Task 10 的事；本文件证明的是：**那个不等式一旦被喂进正确的一对数，它真的会说不。**
 *
 * ## 右式为什么要「只数 `LOCKED`」
 * `SETTLED` 是义务的**终态**：钱已经付出去、义务已经消失，把它再算进「还欠多少」
 * 会让已结算的合约永远占着额度（并让 `escrowCovers` 在完全正常的状态下为假）。
 * 第三个取值今天不存在（`swap_obligations_state_check` 只允许这两个，Task 2 的真库取证），
 * 而**白名单**的语义（只有 `LOCKED` 算数）由下面那条「未知 state 不计入」的用例显式钉住。
 */

describe('托管的 `≥` 判据（§8.3 不变式 #4 / Task 3）', () => {
  it('`sumOutstanding` 只数 `LOCKED`（`SETTLED` 已经不再是义务）', () => {
    expect(
      sumOutstanding([
        { state: 'LOCKED', amount: 1000n },
        { state: 'SETTLED', amount: 1000n },
        { state: 'LOCKED', amount: 500n },
      ]),
    ).toBe(1500n);
    expect(sumOutstanding([])).toBe(0n);
    expect(sumOutstanding([{ state: 'SETTLED', amount: 1000n }])).toBe(0n);
  });

  it('`sumOutstanding` 是**加法**（三个义务逐个相加，不做任何截断/比较）', () => {
    // 这条挡的是「只取第一条」或「取最大的一条」这类实现——它们在单元素用例上全绿。
    expect(
      sumOutstanding([
        { state: 'LOCKED', amount: 1n },
        { state: 'LOCKED', amount: 2n },
        { state: 'LOCKED', amount: 4n },
        { state: 'LOCKED', amount: 8n },
      ]),
    ).toBe(15n);
    // 金额取到 2^53 之上也不丢精度（C3：bigint，绝不走浮点）。
    expect(sumOutstanding([{ state: 'LOCKED', amount: 2n ** 60n }])).toBe(2n ** 60n);
  });

  it('★ 预检 §0.3 的那个数：两个合约各锁 1000，托管 500 ⇒ **不足**', () => {
    // 这条用例把预检的 `[E1]` 逐字搬进断言。原文：「接受、托管剩 500（≥ 0，I1 那条修法放行）、
    // 分录侧与实际余额一致、审计如实。**平台为此合约付出了它从未为这份合约持有的 500 分，
    // 而没有任何一条不变式看得见。**」
    const obligations = [
      { state: 'LOCKED', amount: 1000n },
      { state: 'LOCKED', amount: 1000n },
    ];
    expect(escrowCovers(2000n, obligations)).toBe(true); // 恰好够 ⇒ 接受（边界是闭的）
    expect(escrowCovers(500n, obligations)).toBe(false); // ← 预检的 500
    expect(escrowCovers(1999n, obligations)).toBe(false);
    // ★ 少一个 `LOCKED` 就够了的反面（证明上面那个 `false` 来自**和**，不是来自某个常量）：
    expect(escrowCovers(1000n, [obligations[0]!])).toBe(true);
  });

  it('★ 恒等式：**非负**托配上空义务集恒成立；而托管为负 ⇒ **不**成立（这一条推翻了计划里的一行）', () => {
    // ────────────────────────────────────────────────────────────────────────
    // 这一格是**实测**的，不是照抄计划的。
    //
    // 计划 Step 5 的 `obligation.test.ts` 写着：
    //     expect(escrowCovers(-5n, [])).toBe(true);   // 托管为负是**另一条**判据的事
    // 而计划自己的实现（`escrowCovers(b, os) { return b >= sumOutstanding(os) }`）
    // 对这两个输入给出 `-5n >= 0n` = **false**。⇒ **计划的那条用例与计划自己的实现互相矛盾**，
    // 第一次运行就在这一行红（`AssertionError: expected false to be true`，见
    // `evidence/t3-tdd-green-five-files.txt`）。
    //
    // 两个读法只能留一个，而**留下的是实现那一侧**，理由是「不变式 #4 的原文」：
    //   * §8.3 不变式 #4 逐字是「`Σ PLATFORM_ESCROW ≥ Σ 未结算义务`」。义务集为空时它的
    //     右式是 `0`，于是这条不变式**仍然在说话**：它说的是 `ESCROW ≥ 0`。
    //     托管为 `-5` 时不变式 #4 **被违反**（platform 付过它没有的钱 —— 预检 §0.3 的
    //     那类事故留下的正是这种痕迹），而「空集 ⇒ 恒真」那个读法会把它报成**满足**。
    //   * 「空义务集不能凭空挡人」这个意图**没有丢**：非负托管配空集恒为 `true`（下两行），
    //     因此判据不会因为「一条义务都没有」而拒绝一个正常状态。
    // 反向对照（另一个方向也测了）：把 `>=` 改成 `>` ⇒ 上面 `2000n/2000n` 那一格变红
    // （探针 P-OBL-GE，见报告）—— 两个方向各自有见证，这句话才不是修辞。
    // ────────────────────────────────────────────────────────────────────────
    expect(escrowCovers(0n, [])).toBe(true);
    expect(escrowCovers(1n, [])).toBe(true);
    expect(escrowCovers(-5n, [])).toBe(false);
  });

  it('零金额义务不改变结论（0 ≥ 0 成立；补差为 0 的等价互换是合法的）', () => {
    expect(escrowCovers(0n, [{ state: 'LOCKED', amount: 0n }])).toBe(true);
    // 到 0 为止：多一分钱都不行（负的托管配一份义务 ⇒ 不足）。
    expect(escrowCovers(-5n, [{ state: 'LOCKED', amount: 1n }])).toBe(false);
  });

  it('★ 单调性：多一份义务只可能更难满足（这条即「跨合约超发」的判据本体）', () => {
    // 预检 §0.3 的缺陷形状就是「一份合约花的钱是另一份合约锁的」，因此这条用例
    // 把那个形状缩小到最小可判别形式：同一笔托管，义务多一条就从 true 变 false。
    expect(escrowCovers(1000n, [{ state: 'LOCKED', amount: 1000n }])).toBe(true);
    expect(
      escrowCovers(1000n, [
        { state: 'LOCKED', amount: 1000n },
        { state: 'LOCKED', amount: 1n },
      ]),
    ).toBe(false);
  });

  it('闭集之外的 state **不计入**（白名单语义，据实记载它的代价）', () => {
    // 为什么把它写成一条用例而不是留给读者：这是**一次决定**，而且它有代价。
    // 白名单（只认 `LOCKED`）的失败方向是**少算义务** ⇒ 判据更宽 —— 若将来出现第三个
    // state 而人们忘了在这里加一笔，`escrowCovers` 会静默地变宽。
    // 今天兜住这条的是数据库：`swap_obligations_state_check` 只允许 ('LOCKED','SETTLED')，
    // 而它是 Task 2 的真库取证（`tests/integration/db/exchange-enforcement.test.ts`）里
    // 逐条断言的对象。**复访触发条件**：任何一次给 `swap_obligations.state` 加取值的迁移
    // 都必须同时改这里与那条 CHECK。
    expect(sumOutstanding([{ state: 'NOT_A_STATE', amount: 1000n }])).toBe(0n);
    expect(escrowCovers(0n, [{ state: 'NOT_A_STATE', amount: 1000n }])).toBe(true);
  });
});
