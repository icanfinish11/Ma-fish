/**
 * 确定性幂等键（D3 / 控制器裁定 ⑤）。**「第二次释放会不会真再付一次」的挡板。**
 *
 * ## 为什么「确定性」是承重的，而不是一个风格选择
 * 预检 §A.5 的原文：「账本侧安全（同键 ⇒ 重放 `created:false`，P2 的幂等三态），
 * **但前提是键由合约 id 确定性地派生**；若键里带时间戳/随机数，第二次释放会**真的再付一次**，
 * 而 §0.3 证明**没有任何东西看得见**。」
 *
 * 也就是说：一个 `exchange:release:${contractId}:${Date.now()}` 形状的键**今天不会红**
 * —— 它会以「一笔新交易」的身份把同一份托管再付一次，而所有不变式、对账与审计都是绿的。
 * 因此键**只能**由 (purpose, businessId) 两个量构成，而 `idempotency.test.ts` 用
 * 逐字字面量 + shape 断言把「不许出现别的成分」变成可执行的判据。
 *
 * ## 五个 purpose 覆盖 P3 的**全部**过账
 * | purpose | 账本动作 | 谁调用 |
 * |---|---|---|
 * | `lock` | 补差进托管（`ESCROW_LOCK`，C31：`RELEASED` 时） | Task 8 |
 * | `release` | 结算释放（`ESCROW_RELEASE`，C31：`SETTLED` 时） | Task 10 |
 * | `dispute` | 争议裁决的**冻结释放**（`ESCROW_RELEASE`，收件人是付款方） | Task 10 |
 * | `settle` | **预留**（今天没有独立的过账：`settle` 与 `release` 是同一个动作） | — |
 * | `cancel` | 撤销时的**托管退回**（`ESCROW_RELEASE`，收件人是付款方） | Task 10 |
 *
 * **`settle` 为什么留着而不删**：它与 `release` 的差别是「谁触发」（自动 vs 手动），
 * 而**同一份合约只能释放一次**这条性质要求两个触发路径**共用同一个键**——
 * 它们都走 `release`。留一个没有调用方的 `settle` 违反 C16 ⇒ **本实现里 `settle` 的作用
 * 只有一条**：`EXCHANGE_KEY_PURPOSES` 是闭集，而「未来谁想加一个独立动作时必须先改这张表」
 * 这件事本身是想要的摩擦。**据实记载**：`settle` 今天**没有**调用方，它的用例只有
 * 「五个键互不相同」与「闭集逐字」那两条。
 *
 * ## 两套命名空间（**不要混用**）
 * `exchangeKey` 进 `ledger.transactions.idempotency_key` —— 那是**单列**唯一索引，
 * 因此账本那一侧的命名空间仍然是**全局**的（据实记载，控制器裁定 ⑤ 的后半句）：
 * P3 的键一律带 `exchange:` 前缀，而**账本侧的那条约定仍未变成守卫**
 * （复访触发条件：出现第三个生产者时）。
 * `obligationKey` 进 `swap_obligations.(producer, key)` —— **两列**唯一索引，
 * 命名空间按生产方分隔。两者不是同一个键空间。
 *
 * **与 schema 注释的一处分歧（据实记载）**：`apps/api/prisma/schema.prisma` 的
 * `SwapObligation` 注释把它写成 `('swap', contractId)`，而本文件（**定义处**）是
 * `('exchange', 'obligation:<id>')` —— 与 D3 的「P3 的键一律带 `producer` 前缀
 * （`exchange:`）」逐字一致。那处注释是 Task 2 的一处笔误，本任务**没有**改它
 * （不在 Task 3 的文件清单里），登记在报告里供控制器处理。
 */

/** 生产者名：`swap_obligations.producer` 与账本键的前缀**同一个**字面量。 */
export const EXCHANGE_PRODUCER = 'exchange';

/** 闭集。`settle` 今天没有调用方（见文件头），而它留着的理由是**摩擦**而不是功能。 */
export const EXCHANGE_KEY_PURPOSES = ['lock', 'release', 'dispute', 'settle', 'cancel'] as const;

export type ExchangeKeyPurpose = (typeof EXCHANGE_KEY_PURPOSES)[number];

/**
 * `exchange:{purpose}:{contractId}` —— **确定性派生**（D3）。
 *
 * 三个成分的理由：`producer` 前缀吸收账本的**全局**命名空间、`purpose` 让同一份合约的
 * 不同动作（锁定 / 释放 / 争议 / 撤销）互不冒充、`contractId` 让不同合约互不冒充。
 * **没有第四个成分**：任何时间戳或随机数都会让重放不再命中同一个键。
 *
 * `contractId` 归一化成小写：库里读回来的 UUID 一律小写，而 URL / DTO 里的可能是大写，
 * 而 `WHERE id = $1::uuid` 之下两串是**同一行** —— 不归一化就会让同一份合约算出两个键
 * （P2 的 `accountKey` / `normalizeRef` 是同一条纪律，那两条各有一个探针在看着）。
 */
export function exchangeKey(purpose: ExchangeKeyPurpose, contractId: string): string {
  return `${EXCHANGE_PRODUCER}:${purpose}:${contractId.toLowerCase()}`;
}

/**
 * 义务行的 `(producer, key)`（控制器裁定 ⑤：唯一索引，不是前缀约定）。
 *
 * ## 它为什么是两列而不是一个拼接好的字符串
 * 「谁登记了这条义务」与「它在那个人自己的命名空间里叫什么」是两个事实。
 * 拼成一个字符串（`exchange:obligation:<id>`）会让**前缀**变成唯一的隔离手段，
 * 而预检 §A.5 实测那个前缀今天**五处全是注释、零检查**（`ledger.service.ts:84-102`）——
 * 正是「声明了但未强制」那一类。两列 + 唯一索引（`swap_obligations_producer_key_key`）
 * 让**数据库**成为执行者。
 *
 * ## 它**不是** `exchangeKey` 的一个 purpose
 * 两套命名空间（见文件头）。混用会让「义务存在」与「过账发生过」这两件事互相冒充，
 * 而 `idempotency.test.ts` 有一条用例把「它们不相等」钉住。
 */
export function obligationKey(contractId: string): { producer: string; key: string } {
  return { producer: EXCHANGE_PRODUCER, key: `obligation:${contractId.toLowerCase()}` };
}
