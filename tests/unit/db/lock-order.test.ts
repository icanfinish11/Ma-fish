import { describe, expect, it } from 'vitest';
import { rowLockOrder } from '@vca/api/common/db/lock-order.js';
import { lockOrder } from '@vca/api/modules/exchange/core/lock-order.js';

/**
 * 行锁的**共享**顺序判据（P3 / Task 4；C35 / 控制器裁定 ⑧）。
 *
 * ## 为什么需要它，以及它为什么在 `common/db/`
 * Task 3 交付了资产侧的全局锁序（`exchange/core/lock-order.ts` 的 `lockOrder`），
 * 而 Task 4 要把**同一条判据**施加到**账户行**上（`LedgerService.lockAccountRows`）。
 *
 * 那一步有一个结构性障碍：`ledger` **不能** import `exchange/core/*`——
 * `no-cross-module-internals` 会直接报错（跨模块只走对方的 `index.ts`），而那正是
 * 「模块可拆分」这条约束的本体。于是「两边各排一次序」是唯一不做重构的写法——
 * 而那就是**同一份决定的两份实现**：改了其中一边、另一边不会跟着改，而两边的调用方
 * 都以为自己在用「全局锁序」（ABBA 只在真并发下现身）。
 *
 * ⇒ 顺序判据本身被提到 `common/db/`：两个调用方 import **同一个函数**
 * （`lockOrder` 变成它的资产侧具名包装）。这条纪律的见证是**变异探针**：
 * 把这里的比较器反过来，`tests/unit/exchange/lock-order.test.ts` 与
 * `tests/integration/ledger/account-lock-order.test.ts` 必须**同时**变红
 * （evidence 里那条 `P-ORDER-SHARED`）。
 */
const A = '01920000-0000-7000-8000-00000000000a';
const B = '01920000-0000-7000-8000-00000000000b';
const C = '01920000-0000-7000-8000-00000000000c';

describe('行锁的共享顺序判据（C35 的唯一实现）', () => {
  it('去重 + **字节**升序：一个不依赖任何角色的全序', () => {
    expect(rowLockOrder([B, A])).toEqual([A, B]);
    expect(rowLockOrder([A, B])).toEqual([A, B]); // 幂等
    expect(rowLockOrder([C, A, B, A])).toEqual([A, B, C]); // 三个元素 + 重复项只留一个
    expect(rowLockOrder([])).toEqual([]);
  });

  it('★ 是**字节序**而不是 locale 序（`localeCompare` 会让同一个输入排成另一个顺序）', () => {
    // 真实输入（小写定长 UUID）上两种写法永远同解 ⇒ 这条纪律只在域外输入上可证伪：
    //   字节序      : 'A'(0x41) < 'a'(0x61) < 'b'(0x62) ⇒ ['A','a','b']
    //   locale 序   : ['a','A','b']（本机 ICU 实测）
    expect(rowLockOrder(['b', 'A', 'a'])).toEqual(['A', 'a', 'b']);
  });

  it('不修改入参（排序结果必须是**取锁那一刻**算出来的，不是某个对象上被别人改过的状态）', () => {
    const input = [B, A];
    expect(rowLockOrder(input)).toEqual([A, B]);
    expect(input).toEqual([B, A]);
  });

  it('★ 资产锁序与账户锁序是**同一个判据**（`lockOrder` 是它的具名包装，不是第二份实现）', () => {
    // 这条把「共享」写成可读的契约。**据实记载**：它对「两份逐字相同的实现」也会绿——
    // 真正证明「不是各写一份」的是变异探针 `P-ORDER-SHARED`（改 `common/db/lock-order.ts`
    // 的比较器 ⇒ 交换纯核心那条用例与账户锁序的真库见证**同时**红）。没有那条探针，
    // 这一条只是一句宣言。
    for (const ids of [[B, A], [C, A, B], ['b', 'A', 'a'], [], [A, A]]) {
      expect(lockOrder(ids), `lockOrder 与 rowLockOrder 对 ${JSON.stringify(ids)} 给出了不同的顺序`).toEqual(
        rowLockOrder(ids),
      );
    }
  });
});
