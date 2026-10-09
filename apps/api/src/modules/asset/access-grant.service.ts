import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../db/prisma.service.js';

/**
 * 交换对手方的访问权（§9:472「`Asset` 制品 download = 所有者 / 交换对手方（`RELEASED` 后）…」）。
 *
 * ## 为什么是「推」而不是「拉」（D11 / 预检 §0.2 的证伪）
 * 预检实测：`asset` 为了回答「这个人是不是某个 `RELEASED` 合约的对手方」而 import
 * `exchange` **会成环**（`no-circular` 6 条 error、exit 6）。裁定因此是：**`asset` 拥有
 * 授权判定**（D11 的本意不变），`exchange` 在 `RELEASED` 那一刻把**这一档**推给它。
 * 依赖方向因此保持单向 `exchange → asset`。
 *
 * ## 存储形状：一行 = (资产, 用户) 的一次授予
 * 它**不是** Entitlement 空表（§3.4 明确禁止预建）：它的读方是 `checkAccess`，
 * 写方是 `releaseContract`，两者今天都存在，因此它是一条**真实接缝**。
 *
 * ## 两个方法各自收调用方的 `tx`（与 `OwnershipService` / `AssetLockService` 同一纪律）
 * `grant` 的类型是 `Prisma.TransactionClient & { readonly $connect?: never }`
 * ——Task 1 给 `transferOwnership` 定的形状（预检 §0.1 的证伪：**自开事务**的写入
 * 建不起 §6.3:294 的单一事务）。**这一条对本表尤其要紧**：一行授权一旦提交，
 * 「作品换了主人而授权也留下了」这种半成品在 `RELEASED` 的语义里是不存在的状态
 * （它只可能来自一次部分提交），而类型层把「忘了传 tx」变成一行红波浪线。
 * `hasGrant` 只读，因此收普通的 `Prisma.TransactionClient`
 * ——`PrismaService` 在结构上满足它（多出来的成员不影响赋值），`checkAccess` 正是那样调它的。
 *
 * ## 幂等：`createMany({ skipDuplicates: true })` 与那条唯一索引
 * `access_grants` 上有 `@@unique([assetId, userId])`，因此「同一 (作品, 用户) 授予两次」
 * 在**数据库层**被拒 —— 与 `swap_obligations.(producer, key)`（控制器裁定 ⑤）同一条纪律：
 * 幂等由约束执行，不由「先查再插」执行（那是 C25 点名的读-判断-写）。
 * **据实记载**：`skipDuplicates` 让重复授予**静默通过**（不报 P2002），这是刻意的
 * ——重放是**正常路径**（释放的 retry 会重跑整个事务），而它在这里不承载任何调用方
 * 需要知道的事实（与 `ledger` 的 `created:false` 不同：那一个是「钱有没有再动一次」）。
 */
@Injectable()
export class AccessGrantService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 授予（幂等：同一 (asset, user) 重复授予 ⇒ 不新增行）。
   *
   * @param tx 调用方的事务（本服务绝不开自己的事务，见类注释）。
   * @param source 这次授予的**来源**（`swap-contract:{contractId}`）。它是审计与
   *   撤销的线索，而今天没有撤销路径（D8）——据实记载。
   */
  async grant(
    tx: Prisma.TransactionClient & { readonly $connect?: never },
    assetId: string,
    userId: string,
    source: string,
  ): Promise<void> {
    await tx.accessGrant.createMany({
      data: [{ assetId, userId, source }],
      skipDuplicates: true,
    });
  }

  /**
   * `checkAccess` 用的读。**只回答有 / 没有**，不回答「为什么」。
   *
   * 它**不**判「作品存在吗」「这个人是不是所有人」——那两问在 `checkAccess` 里，
   * 而那一处是唯一入口（D11）。把它做成「一个能回答全部三个问题的函数」会让
   * 第二档与第一档各有一份判定顺序，而两份顺序迟早不同。
   */
  async hasGrant(client: Prisma.TransactionClient, assetId: string, userId: string): Promise<boolean> {
    const row = await client.accessGrant.findUnique({
      where: { assetId_userId: { assetId, userId } },
      select: { id: true },
    });
    return row !== null;
  }

}

/**
 * 这条路径**没有** `revoke`（据实记载 + 复访触发条件）。
 *
 * `AccessGrant.source` 的列注释已经写明：P3.5 的 D8（机器可证的违约 ⇒ 自动回转所有权）
 * 会在**同一个事务**里撤销对手方访问权。那一次的写法是 `deleteMany({ where: { source } })`
 * ——判据就在那一列上。**今天不建它**：C16 不为不存在的调用方建接口，而「谁有权撤销、
 * 撤销哪一批」是那一次改动的裁决对象（它不是一个机械事实）。
 */
