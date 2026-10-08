/**
 * 交换资格（§6.1 第 2 条 / D16）。**一个纯函数，输入是元数据的三个事实。**
 *
 * ## 据实划界：它**不是**「平台自动质量校验」的等价物
 * §6.1 第 2 条要求「平台自动质量校验」；而 §6.2 把它展开成七项完整度事实。D16 的实测：
 * `asset_metadata` 今天**只**持久化了 `completeness` 总分与 `readme_excerpt`
 * （`file_tree` / `languages` / `dependencies` 是三个清单的**长度**，不是那七条事实）。
 * 因此本判据是「**完整度 > 0** 且 **README 摘录非空**」，而它**不**检查
 * 「入口文件存在」「技术栈一致」「非空壳」这三条 —— 那三条的原始事实在 P1 的解析器里
 * 被算进分数之后**就被丢掉了**。
 * **复访触发条件**：要真实行那三条时，`asset_metadata` 需要新增对应的列
 * （一次改 P1 schema 的迁移），而不是在本文件里预埋参数。
 *
 * ## 为什么它收一个 facts 对象而不是三个参数
 * 三个参数会在调用点散成三处取值来源（`readMetadata` 的返回、`completeness` 列、
 * 一个布尔），而**加第三项事实时**（见上）改的是这一处签名与所有调用点 —— 那正是我们
 * 想要的摩擦。今天这三项全部来自 `AssetAccessService.readMetadata`（Task 7 的
 * Consumes 行逐字）。
 *
 * ## 为什么 `fileTreeTruncated` 在 facts 里而资格判据不看它
 * §6.2 的七项里没有「文件树完整」这一项；把截断当门槛会拒掉一份**合规的大项目**。
 * 它在这里是因为它是**预览**（Task 9）需要的一个提示，而 facts 是「一次读取里拿到的
 * 全部相关事实」——把资格与预览拆成两次读取会让两处的输入在时间上不一致。
 * `eligibility.test.ts` 有一条用例把「两个方向都不影响结论」钉住。
 */

/** 资格判据读的三个事实（全部来自 `readMetadata`，**没有 I/O**）。 */
export interface MetadataFacts {
  /** §6.2 的完整度总分（0–100；今天的解析器产出，落在闭集外只说明上游坏了）。 */
  readonly completeness: number;
  /** 制品自带的 README 摘录；没读到就是 `null`。 */
  readonly readmeExcerpt: string | null;
  /** 文件树是否被截断（**不是**门槛，是给预览用的提示）。 */
  readonly fileTreeTruncated: boolean;
}

/** 判定结论。`reason` 在合格时为 `null`（**不是一个空串**：空串会让 HTTP 层多一种要处理的形状）。 */
export interface EligibilityVerdict {
  readonly eligible: boolean;
  /** 被判的那个完整度，原样报出（一次「读成 0」的解析 bug 因此看得见）。 */
  readonly completeness: number;
  readonly reason: string | null;
}

/**
 * 判定一件作品是否够格参与交换。
 *
 * 判定顺序是刻意的：**完整度在前**。完整度是上游事实（README 摘录是它的一个输入），
 * 而一个完整度为 0 的制品即使带上了一段 README，拒绝理由也应当是「没有内容」而不是
 * 「README 是空的」——后者会让排障的人去找一个不存在的问题。顺序由
 * `eligibility.test.ts` 里「两条都不满足时报完整度那一条」的用例钉住。
 */
export function assessEligibility(facts: MetadataFacts): EligibilityVerdict {
  // `!(… > 0)` 而不是 `<= 0`：`NaN` 与 0 一样**不合格**（`NaN <= 0` 是 false，
  // 一份完整度读不出来的制品会因此变成合格品）。两个方向都 fail-closed。
  if (!(facts.completeness > 0)) {
    return {
      eligible: false,
      completeness: facts.completeness,
      reason: `完整度为 ${String(facts.completeness)}（§6.1 第 2 条要求 > 0）`,
    };
  }
  const excerpt = facts.readmeExcerpt;
  // `trim()` 而不是 `!== null`：一段只有空白的 README 与没有 README 是同一件事
  // （用户在预览里什么也读不到），而 `''` 与 `' \n '` 都会穿过「非空」这条朴素的判据。
  if (excerpt === null || excerpt.trim() === '') {
    return {
      eligible: false,
      completeness: facts.completeness,
      reason: 'README 摘录为空（§6.1 第 2 条要求非空）',
    };
  }
  return { eligible: true, completeness: facts.completeness, reason: null };
}

/**
 * **一件作品的资格判决**（P3 / Task 7 从 `assertEligible` 提取出来）。
 *
 * ## 为什么它在这里（而不是在每个服务里各写一次）
 * 判据有两个消费点，而它们要的东西不同：
 *   * `proposeOffer`（Task 6）要在**第一次**不合格时**抛**（`IneligibleAssetError`，422）；
 *   * `SwapContractService`（Task 7）要一个**判决**（`eligible` + 哪一件 + 为什么）——
 *     因为它的结论要在 `VALIDATING` **提交之后**才报出去（资格不通过必须**停在**
 *     `VALIDATING`，见 `swap-contract.service.ts`），而「抛在事务里」会把那次推进回滚掉。
 * ⇒ 纯判据留在 `core/`（**一份**），两种呈现方式在各自的调用点。
 * 这正是 `assessEligibility` 的类注释里那条「三个参数会在调用点散成三处取值来源」
 * 的同一条纪律：判定只有一处，包与不包由调用方决定。
 *
 * ## `metadata === null`（没有元数据行）为什么算**不合格**
 * 「没解析过」与「完整度为 0」是**两件不同**的事，而把后者编造出来（喂一个
 * `completeness: 0` 给判据）会让它们在日志与响应里变得一样——那正是
 * `eligibility.ts` 点名的缺陷族。⇒ 这里保留区别：`completeness` 报 `0`
 * （这里没有真值可报），而 `reason` 明说「没有元数据行」。
 */
export function eligibilityOf(metadata: MetadataFacts | null): EligibilityVerdict {
  if (metadata === null) {
    return { eligible: false, completeness: 0, reason: '没有元数据行（解析产物缺失）' };
  }
  return assessEligibility(metadata);
}
