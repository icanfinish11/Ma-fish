import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_KEY_PURPOSES,
  EXCHANGE_PRODUCER,
  exchangeKey,
  obligationKey,
} from '@vca/api/modules/exchange/core/idempotency.js';

/**
 * 确定性幂等键（D3 / 控制器裁定 ⑤）。**这是「第二次释放会不会真再付一次」的挡板。**
 *
 * ## 为什么「确定性」是承重的，而不是一个风格选择
 * 预检 §A.5 的原文：「账本侧安全（同键 ⇒ 重放 `created:false`，P2 的幂等三态），
 * **但前提是键由合约 id 确定性地派生**；若键里带时间戳/随机数，第二次释放会**真的再付一次**，
 * 而 §0.3 证明**没有任何东西看得见**。」
 *
 * 也就是说：一个 `exchange:release:${contractId}:${Date.now()}` 形状的键**今天不会红** ——
 * 它会以「一笔新交易」的身份把同一份托管再付一次，而所有不变式、对账与审计都是绿的
 * （预检 §0.3：平台为此合约付出了它从未为这份合约持有的 500 分，`isBalanced = true`）。
 * 因此键**只能**由 (purpose, businessId) 两个量构成，而下面几条断言把
 * 「不许出现别的成分」变成**可执行**的判据：逐字的字面量、shape 正则、以及
 * 「同一个合约两次得到同一个键」。
 *
 * ## 两套命名空间（控制器在计划自审时点名的一处混用）
 * `exchangeKey` 进 `ledger.transactions.idempotency_key`（**单列**唯一索引 ⇒ 命名空间是
 * **全局**的），`obligationKey` 进 `swap_obligations.(producer, key)`（**两列**唯一索引 ⇒
 * 命名空间按生产方分隔）。两者**不是**同一个键空间，混用会让「义务存在」与「过账发生过」
 * 这两件事互相冒充 ⇒ 最后一条用例把「它们不相等」钉住。
 */

const CONTRACT = '01920000-0000-7000-8000-0000000000c1';
const OTHER_CONTRACT = '01920000-0000-7000-8000-0000000000c2';

describe('确定性幂等键（D3 / 控制器裁定 ⑤）', () => {
  it('★ 键由**业务 id 确定性派生**：同一个合约两次得到同一个键（同一性）', () => {
    expect(exchangeKey('release', CONTRACT)).toBe(exchangeKey('release', CONTRACT));
    expect(exchangeKey('release', CONTRACT)).toBe(`exchange:release:${CONTRACT}`);
    // 不同合约 ⇒ 不同键（一个丢掉 id 成分的实现会在这里红，
    // 而它在「同一性」那条上照样绿）。
    expect(exchangeKey('release', OTHER_CONTRACT)).not.toBe(exchangeKey('release', CONTRACT));
  });

  it('★ 不同 purpose 得到不同键（**「第二次释放会真再付一次」的挡板**）', () => {
    // 预检 §A.5 的原文：「若键里带时间戳/随机数，第二次释放会真的再付一次，
    // 而 §0.3 证明**没有任何东西看得见**」。因此这条用例问的是：键里**只有**
    // business id 与 purpose，没有任何时间/随机成分。
    const keys = EXCHANGE_KEY_PURPOSES.map((p) => exchangeKey(p, CONTRACT));
    expect(new Set(keys).size).toBe(keys.length);
    // 并且**不含**任何看起来像时间戳/随机数的东西：shape 断言。
    for (const k of keys) expect(k).toMatch(/^exchange:[a-z]+:[0-9a-f-]{36}$/);
  });

  it('五个 purpose 的**取值**逐字钉住（库里对键的形状没有任何约束）', () => {
    // 为什么需要这一条：`ledger.transactions.idempotency_key` 是 `TEXT NOT NULL` + 单列
    // 唯一索引，**没有任何 CHECK**（P2 实测）。因此把 `release` 拼成 `relese` 会
    // **静默**写进账本：没有约束会红、对账会绿（Σ 照样是 0），唯一的差异是
    // 「重放不再命中同一个键」——也就是第二次释放真的再付一次。那条路径的见证
    // 只有这条字面量断言（Task 4 的重试判别式与 Task 10 的释放都消费它）。
    expect([...EXCHANGE_KEY_PURPOSES]).toEqual(['lock', 'release', 'dispute', 'settle', 'cancel']);
    expect(EXCHANGE_PRODUCER).toBe('exchange');
  });

  it('合约 id 的大小写不影响键（`WHERE id = $1::uuid` 之下两串是同一行）', () => {
    // 与 P2 的 `accountKey` / `normalizeRef` 同一条纪律（那两条各有一个探针在看着）：
    // 库里读回来的 UUID 一律小写，而 URL / DTO 里的可能是大写。不归一化 ⇒
    // 「同一份合约的两个拼法」会算出两个键 ⇒ 第二次释放再付一次。
    const upper = CONTRACT.toUpperCase();
    expect(exchangeKey('release', upper)).toBe(exchangeKey('release', CONTRACT));
    expect(obligationKey(upper)).toEqual(obligationKey(CONTRACT));
  });

  it('义务键是 `(producer, key)`（控制器裁定 ⑤：唯一索引而不是前缀约定）', () => {
    expect(obligationKey(CONTRACT)).toEqual({ producer: 'exchange', key: `obligation:${CONTRACT}` });
    expect(obligationKey(CONTRACT)).toEqual(obligationKey(CONTRACT)); // 确定性
    expect(obligationKey(OTHER_CONTRACT).key).not.toBe(obligationKey(CONTRACT).key);
  });

  it('★ 两套命名空间**不互相冒充**（`exchangeKey` 进账本、`obligationKey` 进义务表）', () => {
    for (const purpose of EXCHANGE_KEY_PURPOSES) {
      expect(exchangeKey(purpose, CONTRACT)).not.toBe(obligationKey(CONTRACT).key);
    }
    // producer 那一列**不是** purpose：它恒为 `exchange`，而与 purpose 无关。
    expect(obligationKey(CONTRACT).producer).toBe(EXCHANGE_PRODUCER);
    for (const purpose of EXCHANGE_KEY_PURPOSES) {
      expect(obligationKey(CONTRACT).producer).not.toBe(purpose);
    }
  });
});
