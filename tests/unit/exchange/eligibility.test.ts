import { describe, expect, it } from 'vitest';
import { assessEligibility } from '@vca/api/modules/exchange/core/eligibility.js';

/**
 * 交换资格（§6.1 第 2 条 / D16）。
 *
 * ## 这条判据**据实划界**，不是「平台自动质量校验」的等价物
 * §6.1 第 2 条要求「平台自动质量校验」。而 D16 的实测划界是：`asset_metadata` 今天
 * **只**持久化了 `completeness` 总分与 `readme_excerpt`（`file_tree` / `languages` /
 * `dependencies` 是三个清单的**长度**，不是那七条事实）。因此资格判据是
 * 「**完整度 > 0** 且 **README 摘录非空**」——它**不**检查「入口文件存在」「技术栈一致」
 * 「非空壳」这三条：那三条的原始事实在 P1 的解析器里被算进分数之后**就被丢掉了**。
 * 复访触发条件：要真实行那三条时，`asset_metadata` 需要新增对应的列（一次改 P1 schema
 * 的迁移），而不是在本任务里预埋。
 *
 * ## 为什么「验收面」那一条是必需的
 * 一个 `return { eligible: false, reason: '不合格' }` 的实现能通过本文件里全部三条拒绝
 * 用例。第六条用例（两条都满足 ⇒ 合格，且 `completeness` 原样报出）就是它的反面对照，
 * 而变异探针 P-ELIG 把「一个什么都拒的实现」真的跑了一遍。
 */

describe('交换资格（§6.1 第 2 条 / D16）', () => {
  it('完整度为 0 ⇒ 不合格（理由是「完整度」），且把完整度原样报出', () => {
    const v = assessEligibility({ completeness: 0, readmeExcerpt: 'x'.repeat(500), fileTreeTruncated: false });
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('完整度');
    // 报出被判的那个数（不报的话，一次「完整度读成了 0」的解析 bug
    // 与一次「真的完整度为 0」在响应上完全一样）。
    expect(v.completeness).toBe(0);
  });

  it('负的完整度也不合格（`> 0` 而不是 `!== 0`）', () => {
    // D16 的规则是「**完整度 > 0**」。写成 `completeness !== 0` 会让 -1 通过，
    // 而 -1 只可能来自一次解析/序列化事故——它不该被当成「有内容」。
    const v = assessEligibility({ completeness: -1, readmeExcerpt: 'a', fileTreeTruncated: false });
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('完整度');
  });

  it('README 摘录为空 / null / 全空白 ⇒ 不合格', () => {
    for (const readme of [null, '', '   \n  ']) {
      const v = assessEligibility({ completeness: 100, readmeExcerpt: readme, fileTreeTruncated: false });
      expect(v.eligible, `readme=${JSON.stringify(readme)} 应当不合格`).toBe(false);
      expect(v.reason).toContain('README');
    }
  });

  it('两条都不满足时，报的是**完整度**那一条（判定顺序被钉住）', () => {
    // 为什么这条要有：两个守卫里只有一个能报理由，而「报哪一个」是一次决定。
    // 完整度是**上游**事实（README 摘录是它的一个输入），因此先说完整度；
    // 不钉住顺序的话，两条拒绝理由会随实现细节漂移，而用例两条都绿。
    const v = assessEligibility({ completeness: 0, readmeExcerpt: null, fileTreeTruncated: false });
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('完整度');
    expect(v.reason).not.toContain('README');
  });

  it('两条都满足 ⇒ 合格，且 `completeness` 原样报出（**验收面**：一个什么都拒的实现在上面四条上全绿）', () => {
    const v = assessEligibility({ completeness: 55, readmeExcerpt: 'a'.repeat(300), fileTreeTruncated: true });
    expect(v).toEqual({ eligible: true, completeness: 55, reason: null });
    // 最小可通过的完整度（1）也合格：边界是开的（`> 0`）。
    expect(assessEligibility({ completeness: 1, readmeExcerpt: 'a', fileTreeTruncated: false })).toEqual({
      eligible: true,
      completeness: 1,
      reason: null,
    });
  });

  it('`fileTreeTruncated` **不影响**资格（据实记载：它是给预览用的提示，不是门槛）', () => {
    // §6.2 的七项里没有「文件树完整」这一项；把截断当门槛会拒掉一份合规的大项目。
    // 两个方向都断言（合格侧与不合格侧），否则「截断只在合格侧不起作用」也能通过。
    const a = assessEligibility({ completeness: 40, readmeExcerpt: 'a', fileTreeTruncated: false });
    const b = assessEligibility({ completeness: 40, readmeExcerpt: 'a', fileTreeTruncated: true });
    expect(a).toEqual(b);
    const badA = assessEligibility({ completeness: 0, readmeExcerpt: 'a', fileTreeTruncated: false });
    const badB = assessEligibility({ completeness: 0, readmeExcerpt: 'a', fileTreeTruncated: true });
    expect(badB).toEqual(badA);
    expect(badB.eligible).toBe(false);
  });
});
