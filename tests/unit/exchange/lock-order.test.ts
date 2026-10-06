import { describe, expect, it } from 'vitest';
import { assertLockOrderHeld, lockOrder, lockPair } from '@vca/api/modules/exchange/core/lock-order.js';
import { UnknownLockOrderError } from '@vca/api/modules/exchange/core/errors.js';

/**
 * 全局资产锁序（C35 / 控制器裁定 ⑧；预检 §B.1 的实测）。**Task 3 的锁序执行点。**
 *
 * ## 为什么必须有一个**全序**，而不是「先买后卖」
 * 预检实测了三类死锁，其中两类是**真并发**下的必然结果：
 *   * 「A 想要 B 的作品、B 想要 A 的作品」：两笔交换各自先锁自己想要的那一件 ⇒ ABBA；
 *   * 「同一个人既卖出又买入」：同一对作品、相反取锁顺序 ⇒ 同一个 ABBA。
 * 两种都**不是罕见情形**（§6.5 的流拍转交换、一个创作者同时有多份合约）。
 * 而 `applyBalances` 的「按金额升序 ⇒ 借方先」**不是全局锁序**——它连自己那条路径上的
 * 取锁点都没覆盖全（`entries.createMany` 对被引用账户取 `FOR KEY SHARE`，先于它）。
 *
 * ## 为什么是 `assetId` 升序（而不是角色固定）
 * 「先买后卖」在**一对**资产上是全序，但在**同一方同时参与多份合约**时它不再是一个
 * 全局一致的选择：两份合约里的「买方」是同一个人，而它们各自想要的作品不同。
 * 按 `assetId` 排序不依赖任何角色，因此它在任意一组资产上都给出同一个顺序。
 *
 * ## 这条判据为什么**不需要数据库**
 * 「两个事务会不会以相反顺序取锁」的**全部内容**就是「它们各自排出来的序列是否等于
 * 同一个序列」。那是一次纯排序 + 一次前缀检查，因此可以在毫秒级被穷举；
 * 真库那一段（`P2010`/`40P01` 真的发生、加了锁序之后不再发生）是 Task 7 的
 * `tests/integration/exchange/double-lock.test.ts`——**两边各自只证明自己那一半**。
 */

const A = '01920000-0000-7000-8000-00000000000a';
const B = '01920000-0000-7000-8000-00000000000b';
const C = '01920000-0000-7000-8000-00000000000c';

describe('全局资产锁序（C35）', () => {
  it('按 `assetId` 升序（字节序 = 字符串序，因为 UUID 的十六进制表示是小写定长）', () => {
    expect(lockOrder([B, A])).toEqual([A, B]);
    expect(lockOrder([A, B])).toEqual([A, B]); // 幂等
    expect(lockPair(B, A)).toEqual([A, B]); // 双锁取的是同一个顺序
    expect(lockPair(A, B)).toEqual([A, B]);
    // 三个元素（一份合约只有两件作品，但「同一个人既卖出又买入」会把两三份合约的
    // 资产放进**同一个**事务）——只测两个元素会让「只看前两个」的实现通过。
    expect(lockOrder([C, A, B])).toEqual([A, B, C]);
    expect(lockOrder([C, B, A])).toEqual([A, B, C]);
  });

  it('★ 是**字节序**而不是 locale 序（`localeCompare` 会让同一个输入排成另一个顺序）', () => {
    // 为什么这条要有：计划里写着「**绝不要**用 `localeCompare`（它受 locale 影响，
    // 而锁序必须是全进程一致的）」，而 UUID 的十六进制表示全是小写 ⇒ **在真实输入上
    // 两种写法永远给出同一个答案**，于是那条纪律在域内不可证伪。
    // 这一条用域外的输入（大小写混合）把它变成可证伪的：
    //   字节序  : 'A'(0x41) < 'a'(0x61) < 'b'(0x62)  ⇒ ['A','a','b']
    //   locale 序（本机 ICU 实测）                    ⇒ ['a','A','b']
    // 换了实现就会红。**据实记载**：真实调用方只会传小写 UUID，
    // 因此这条的属性是「实现纪律」而不是「业务行为」。
    expect(lockOrder(['b', 'A', 'a'])).toEqual(['A', 'a', 'b']);
  });

  it('不修改入参、不产生重复（同一件作品出现两次 ⇒ 只锁一次）', () => {
    const input = [A, A];
    expect(lockOrder(input)).toEqual([A]);
    expect(input).toEqual([A, A]); // 入参未被就地排序
    expect(lockOrder([])).toEqual([]);
  });

  it('★ `lockPair` 的退化输入被拒（两件作品是同一件 ⇒ 不返回 [a, a]）', () => {
    // 这条守卫此前**没有任何见证**（本项目反复抓到的那一类：一个分支被另一条守卫
    // 遮住，或者根本没有用例走到它）。它可达：`swap_contracts` 上**没有**
    // `asset_a_id <> asset_b_id` 这条 CHECK（Task 2 的迁移实测），因此「同一件作品
    // 换来换去」这种行是能进库的；`proposeOffer`（Task 6）是**约定**上的第一道守卫，
    // 而这里是**结构性**的那一道——一份作品对自己双锁会在释放时撞上
    // `SelfTransferRejectedError`（预检 §B.3 点名的组合风险）。
    expect(() => lockPair(A, A)).toThrow(/两个不同的 assetId/);
  });

  it('`assertLockOrderHeld`：已持锁的前缀必须仍然是升序的（**ABBA 的可执行判据**）', () => {
    expect(() => assertLockOrderHeld([A], [B])).not.toThrow(); // 验收面
    expect(() => assertLockOrderHeld([B], [A])).toThrow(UnknownLockOrderError); // 拒绝面：反向取锁
    expect(() => assertLockOrderHeld([A, B], [])).not.toThrow(); // 持满之后不再要
    expect(() => assertLockOrderHeld([], [])).not.toThrow(); // 空集合
    // `wanted` **自己**也必须升序：一次要两个、且顺序相反同样是 ABBA 的一半。
    expect(() => assertLockOrderHeld([], [B, A])).toThrow(UnknownLockOrderError);
  });

  it('★ 判据检查**每一对相邻项**，不只是第一个（第三个元素上的倒序也要被抓到）', () => {
    // 只比较「最后已持的」与「第一个要取的」那种实现能通过上面全部用例，
    // 却会放过 held=[A,C] + wanted=[B]（A<C 合法前缀、A<B 合法第一步，而 C>B 是倒序）。
    // 这条用例让「逐对检查」与「只看相邻一处」区分开。
    expect(() => assertLockOrderHeld([A, C], [B])).toThrow(UnknownLockOrderError);
    // 验收对照：同一组资产按锁序取就是合法的（`lockOrder([A,B,C])` 的那个顺序）。
    expect(() => assertLockOrderHeld([A], [B, C])).not.toThrow();
    expect(() => assertLockOrderHeld([A, B], [C])).not.toThrow();
  });

  it('相等的 id 不算倒序（同一行被重复引用时不该红在锁序上）', () => {
    // `>` 而不是 `>=`：一次事务里对同一个 assetId 取两次锁是幂等的（第二句是空操作），
    // 而把它判成 ABBA 会让「先锁一件、再确认它已经锁着」这种写法无法表达。
    expect(() => assertLockOrderHeld([A], [A])).not.toThrow();
    expect(() => assertLockOrderHeld([A, A], [A])).not.toThrow();
  });
});
