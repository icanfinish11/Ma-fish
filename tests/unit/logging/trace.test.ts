import { describe, it, expect, vi } from 'vitest';
import { uuidv7 } from '@vca/shared';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('uuidv7（C4）', () => {
  it('产出合法 v7 且版本位为 7', () => {
    for (let i = 0; i < 100; i++) expect(uuidv7()).toMatch(UUID_V7);
  });

  it('单调递增：同一毫秒内生成也按字典序递增（时间序利于索引）', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('无重复', () => {
    expect(new Set(Array.from({ length: 5000 }, () => uuidv7())).size).toBe(5000);
  });

  /**
   * Ruling 1（计数器回绕）的对抗用例：**把时钟钉死**，让 4096 的计数器容量必然被打满。
   *
   * 上面那两条与顺序/唯一性有关的用例为什么抓不住回绕：`Date.now()` 在几千次循环里总会
   * 前进，于是每次进入新毫秒都把计数器清零——回绕分支根本不会被执行（5000 条的「无重复」
   * 因此是**靠真实时间流逝**通过的，不是靠实现正确）。时钟冻结后，回绕是必然事件。
   *
   * 判据：唯一性 + **严格**字典序递增。若实现把 12 位计数器简单模回绕，第 4097 条会退回
   * seq=0，在字典序上**小于**第 4096 条，严格递进断言必然失败（与随机位无关，是确定性的）。
   * 数量取 20000（≈ 计数器容量的 5 倍），远大于 brief 的 5000。
   */
  it('固定时钟下打满并越过 12 位计数器容量：仍严格递增且无重复', () => {
    // 用**远期**常量而不是「当前时间」：首调用必然 `now > lastMs`，因此结果与本机时钟、
    // 与前面用例留下的模块级状态都无关（测试要能单独跑、也要能在任何日期跑）。
    const frozen = Date.parse('2099-01-01T00:00:00.000Z');
    // 从 UUID 里取回 48 位时间戳（去掉连字符后前 12 个十六进制位）
    const tsOf = (id: string): number => Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    try {
      const ids = Array.from({ length: 20_000 }, () => uuidv7());

      expect(new Set(ids).size).toBe(ids.length);
      // 逐位比较而非整串排序：失败时能直接指出**第一处**逆序，而不是甩出两个大数组
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]! > ids[i - 1]!, `第 ${i + 1} 条未严格大于前一条`).toBe(true);
      }
      // 非空转证明：时钟冻结时，20000 条唯一且有序的 id 不可能共用一个时间戳
      // （12 位计数器只够 4096 个）。故「借毫秒」必须真的发生过——否则本用例与
      // brief 的 5000 条用例等价，等于没测回绕。
      expect(tsOf(ids.at(-1)!)).toBeGreaterThan(tsOf(ids[0]!));
    } finally {
      nowSpy.mockRestore();
    }
  });
});
