import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { obligationKey } from './core/idempotency.js';
import { OBLIGATION_STATES } from './core/types.js';

/**
 * 托管义务的**登记**（P3 / Task 8；D2 / 不变式 #4 的右式 / 控制器裁定 ⑤）。
 *
 * ## 它记什么、不记什么
 * 它记「**哪份合约欠多少钱、什么状态**」，**不记钱**——钱的唯一载体仍然是账本（C27）。
 * 于是 `Σ PLATFORM_ESCROW ≥ Σ 未结算义务`（§8.3 不变式 #4）第一次有了**右式**：
 * 左式由 `ledger` 报（`readBalances` 读 `PLATFORM_ESCROW`），右式由 `exchange` 报
 * （本表 + `core/obligation.ts` 的 `sumOutstanding`）。两边在**同一个事务**里读，
 * 而 `exchange` **不 join** `ledger`（C5）——判据的形状因此只能是「两个数进来、
 * 一个布尔出去」（`escrowCovers`）。
 *
 * ## 为什么「跨合约超发」在库里无处可查（预检 §0.3 的证伪，本表就是那个「无处」）
 * 「两个合约各锁 1000，其中一笔释放 **1500** ⇒ 接受、ESCROW = 500（≥0）、
 * `isBalanced = true`、审计如实。**平台为该合约付出了它从未为这份合约持有的 500 分。**」
 * ——托管只有一行账户，`entries` 只有 `(id, transaction_id, account_id, amount)`，
 * 因此「这笔钱属于哪份合约」在账本里**永远**读不出来。这一张表就是那个落点。
 *
 * ## 身份是 `(producer, key)` 唯一索引，不是前缀约定（控制器裁定 ⑤）
 * `obligationKey(contractId)` 确定性派生 `('exchange', 'obligation:<contractId>')`，
 * 而**唯一索引由数据库检查**（`swap_obligations_producer_key_key`）。
 * ⇒ 「同一份合约登记两次」在数据库层被拒（`P2002`），而不是靠「先查再插」——
 * 后者是 C25 点名的读-判断-写，它在并发下的失效形态正是**两条义务行**。
 * **本服务因此刻意不用 `skipDuplicates`**：义务行的重复**不是**可忽略的重放
 * （重放由释放路径的状态守卫挡住：第二次释放根本不进这个函数），
 * 真出现一次重复说明有两条路径在同时登记同一份合约的欠款 —— 那必须响亮。
 *
 * ## 它为什么住在 `exchange`
 * 义务是**交换自己的**业务事实（D2：`EscrowRecord` 的等价物是这张表，而 P2 明确不交付它）。
 * 账本读不懂「合约」，交换读不懂「余额」，两边各自只报自己那一半（C5 / 预检 §A.3 第 ③ 条）。
 */
@Injectable()
export class ObligationService {
  /**
   * 登记一条义务（**在补差那一笔真的进托管之后**，同一个事务里）。
   *
   * ## 为什么必须在过账之后（顺序是承重的）
   * 它登记的金额是「**刚才真的进了托管的**那一笔」。反过来先登记后过账，会让一次失败的
   * 过账留下一条「欠款存在而钱没进来」的义务 —— 那是把不变式 #4 的**右式**做大，
   * 于是 `escrowCovers` 在钱没到位时判**不足**（fail-closed，方向还好），
   * 但义务行的存在本身就在说一件没发生的事。顺序因此不是风格。
   *
   * @param tx 调用方的事务（本服务绝不开自己的事务：义务行与那一笔托管必须一起提交）。
   * @param contractId 合约 id（`obligationKey` 由它确定性派生）。
   * @param amount 金额（**分**，bigint，C3）。恒 `>= 0`（迁移里的 `swap_obligations_amount_nonneg`）。
   * @throws {Prisma.PrismaClientKnownRequestError} `P2002`：这份合约已经登记过义务
   *   （唯一索引 `(producer, key)`）。**不吞**：重复登记说明有一条不该存在的第二条路径。
   */
  async record(
    tx: Prisma.TransactionClient & { readonly $connect?: never },
    input: { readonly contractId: string; readonly amount: bigint },
  ): Promise<{ readonly obligationId: string; readonly state: string }> {
    const { producer, key } = obligationKey(input.contractId);
    const row = await tx.swapObligation.create({
      data: {
        producer,
        key,
        contractId: input.contractId,
        amount: input.amount,
        // `LOCKED`：钱已经进了托管、还在争议期内（D2 只有两个状态；多一个 `REVERSED`
        // 都是多余，理由见 `core/types.ts` 的 `OBLIGATION_STATES`）。
        state: OBLIGATION_STATES.LOCKED,
      },
      select: { id: true, state: true },
    });
    return { obligationId: row.id, state: row.state };
  }
}
