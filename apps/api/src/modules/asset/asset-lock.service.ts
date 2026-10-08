import { Injectable } from '@nestjs/common';
import { rowLockOrder } from '../../common/db/lock-order.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AssetNotFoundError } from './ownership.service.js';

/**
 * 作品的**交换锁定**（§6.3:284：「资产变为不可编辑 / 不可另行上架 / 不可删除」；P3 / Task 7）。
 *
 * ## 为什么它在 `asset` 而不是 `exchange`
 * 「一件作品现在能不能被编辑」是**作品自己的**属性（D10）。把它记在合约行上会让
 * 同一个问题有多个答案（一份作品可能同时出现在多份合约里），而 §6.3:284 那三个谓词
 * 的作用对象是**作品**。`exchange` 因此只是**调用方**，锁的存储与判定留在 `asset`
 * ——这与 D11 的「`checkAccess` 是唯一判定入口」是同一条纪律。
 *
 * ## ★ 锁是**两件事**，两件都承重（计划 Step 1 的「先验再做」）
 *
 * | 承重的东西 | 它保证什么 | 去掉它的后果 |
 * |---|---|---|
 * | `SELECT … FOR UPDATE`（行锁） | **并发互斥**：两个事务不会同时把同一件作品锁给两份合约 | 读-判断-写的实现会**两条都成功**，而作品被两份合约同时锁着 |
 * | `locked_at` + `holder_contract_id`（列值） | **持久状态**：事务提交之后仍查得到，且知道**谁锁的** | 提交之后就没人知道它锁着（`locked_at` 本来是 Task 2 加的，Task 7 补上「谁」） |
 *
 * 两个谓词在**同一条语句**里取到（`SELECT … FOR UPDATE` 返回的列值就是判据的输入）：
 * 分成「先读、再判断、再写」会让判据的依据是**一份可能已经过期的快照**——
 * READ COMMITTED 下 `FOR UPDATE` 的读在拿到锁之后会**重新求值**（EvalPlanQual），
 * 因此它读到的是**已提交**的锁定（见证：`asset-lock.test.ts` 的 ★ 并发互斥那一条）。
 *
 * ## 三个方法都**收调用方的 `tx`**（它们自己绝不开事务）
 *
 * 这不是风格问题：锁与「合约推进到 `VALIDATING`」必须**一起提交或一起回滚**，
 * 否则会出现一个中间瞬态（作品锁着而合约还在 `PENDING_BOTH_LOCK`），
 * 此时第三个请求（或计时器）能走一条不该走的路（`swap-contract.service.ts` 的类注释）。
 * ⇒ 类型上就要求 `Prisma.TransactionClient`，服务内部没有 `PrismaService`
 * （**没有一个能自己开事务的入口**，这是结构性的而不是约定）。
 *
 * ## 顺序：**共享判据**只有一份（C35 / Task 4 的提取）
 *
 * `rowLockOrder`（`common/db/lock-order.js`）是 `exchange` 侧 `lockOrder` 的**同一个函数**
 * ——Task 4 把顺序判据提到 `common/db/` 正是为了让「资产行」与「账户行」两边 import
 * **同一个决定**（`ledger` 不能 import `exchange/core/*`，`asset` 更不能：那会成环，
 * 预检 §0.2 实测 6 条 error / exit 6）。**据实记载这条路径上顺序的承重面**：
 * 物理取锁顺序由那条 SQL 的 `ORDER BY id` 决定（Task 5 在账户侧量到同一件事，
 * 把比较器反过来时真库锁序的见证照样绿）；共享判据在**本服务里**的第二件事是
 * **报哪一个 id 缺失**（`ordered.find(...)`），那是有行为见证的
 * （`asset-lock.test.ts` 的 ⑤：两个都不存在时报升序里第一个）。
 *
 * ## 幂等重放（「同一次确认被调两次」）
 * 网络重试、或者两个「同时确认」的请求，都会让同一份合约对同一件作品再锁一次。
 * 判据是**持有者相等** ⇒ 放行（不是「已被锁定」）。**不**改写 `locked_at`：
 * 那个时间戳记的是「它是什么时候被锁上的」，重放不是一次新的锁定。
 */
@Injectable()
export class AssetLockService {
  /**
   * 按**全局锁序**（C35）锁定全部资产；已被**别的**合约锁定 ⇒ {@link AssetLockedByContractError}。
   *
   * ## 一条语句取完全部行锁（C35 的后半句「先取全部行锁、再动任何一行」）
   * `SELECT … WHERE id = ANY(…) ORDER BY id FOR UPDATE` 之后才 `UPDATE`：
   * 取锁过程中不插入任何别的写动作，也不存在「锁了一半」的中间态。
   *
   * ## 缺失的作品**不**被伪装成「锁定了」
   * 行数不等 ⇒ `AssetNotFoundError`（带上**锁序里第一个**缺失的 id）：
   * 把它当成一次成功的锁定会把一次调用方错误变成一次成功的确认
   * ——那正是「合约进 `VALIDATING` 而作品根本没被锁」的形状。
   *
   * @param tx 调用方的事务（本服务绝不开自己的事务，见类注释）。
   * @param assetIds 任意顺序、可含重复（顺序由共享判据归一化，去重也由它做）。
   * @param holderContractId 锁定者（合约 id）。同一个合约重放 ⇒ 放行。
   */
  async lockAssets(
    tx: Prisma.TransactionClient,
    assetIds: readonly string[],
    holderContractId: string,
  ): Promise<void> {
    const ordered = rowLockOrder(assetIds);
    if (ordered.length === 0) return;

    const rows = await tx.$queryRaw<{ id: string; locked_at: Date | null; holder: string | null }[]>`
      SELECT id, locked_at, holder_contract_id AS holder
        FROM asset.assets
       WHERE id = ANY(${ordered}::uuid[])
       ORDER BY id
         FOR UPDATE
    `;

    if (rows.length !== ordered.length) {
      const found = new Set(rows.map((row) => row.id));
      // `ordered.find(...)`：报**锁序里第一个**缺失的 id（决定性的错误消息）。
      // `?? ordered[0]` 是类型上的兜底，走不到（长度不等 ⇒ 至少有一个缺失）。
      throw new AssetNotFoundError(ordered.find((id) => !found.has(id)) ?? ordered[0]!);
    }

    for (const row of rows) {
      // 已被**别的**合约锁着 ⇒ 拒。`holder === holderContractId` 时是**幂等重放**，放行。
      // `locked_at` 非空而 `holder` 为空（不应存在的行）也走拒绝那一支：fail-closed。
      if (row.locked_at !== null && row.holder !== holderContractId) {
        throw new AssetLockedByContractError(row.id, row.holder);
      }
    }

    // 全部判完才写（「先取全部行锁、再动任何一行」）。`locked_at` 只在**真的从无到有**时
    // 才是一次新的锁定——重放不该把它往后推，因此用 `COALESCE` 保住第一次的时刻。
    await tx.$executeRaw`
      UPDATE asset.assets
         SET locked_at = COALESCE(locked_at, now()), holder_contract_id = ${holderContractId}::uuid
       WHERE id = ANY(${ordered}::uuid[])
    `;
  }

  /**
   * 解锁：**只有持有者能解**（`holder_contract_id` 必须相等）。
   *
   * ## 两个「不报错」的情形（都是刻意的）
   *   * 这一行**本来就是空的**（另一条路径已经解过、或者从来没锁过）⇒ 空操作。
   *     解锁的幂等性是**生产需求**：Task 10 的终态解锁会在重试/重放里再跑一次
   *     （A-10 逐字：`SETTLED` 与 `CANCELLED` 两个终态各调一次，计时器那条路径
   *     走的是同一个结算入口）；
   *   * 持有者**相等**但只有一列非空（不一致的行）⇒ 照样清干净（两个列同生共死）。
   *
   * ## 拒绝面
   * 持有者是**别的**合约 ⇒ {@link AssetLockedByContractError}，且那一行**一个字都不改**。
   * `UPDATE` 上带 `holder_contract_id = $holder` 是第二道：判据与执行者是同一个条件，
   * 不存在「判过了、写错了行」的窗口。
   */
  async unlockAssets(
    tx: Prisma.TransactionClient,
    assetIds: readonly string[],
    holderContractId: string,
  ): Promise<void> {
    const ordered = rowLockOrder(assetIds);
    if (ordered.length === 0) return;

    const rows = await tx.$queryRaw<{ id: string; locked_at: Date | null; holder: string | null }[]>`
      SELECT id, locked_at, holder_contract_id AS holder
        FROM asset.assets
       WHERE id = ANY(${ordered}::uuid[])
       ORDER BY id
         FOR UPDATE
    `;

    if (rows.length !== ordered.length) {
      const found = new Set(rows.map((row) => row.id));
      throw new AssetNotFoundError(ordered.find((id) => !found.has(id)) ?? ordered[0]!);
    }

    for (const row of rows) {
      if (row.locked_at === null && row.holder === null) continue; // 幂等：本来就是空的
      if (row.holder !== holderContractId) throw new AssetLockedByContractError(row.id, row.holder);
    }

    await tx.$executeRaw`
      UPDATE asset.assets
         SET locked_at = NULL, holder_contract_id = NULL
       WHERE id = ANY(${ordered}::uuid[])
         AND holder_contract_id = ${holderContractId}::uuid
    `;
  }

  /**
   * 这件作品**锁着吗**、谁锁的。作品不存在 ⇒ `null`。
   *
   * ## 名字与返回形状（一处据实说明）
   * 简报的 Files 行逐字写的是 `isLocked`，而它的**唯一**消费者（增量 A-7 的版本写入边界）
   * 除了「锁着吗」还要**点名持有者**（那个错误的消息里要写「由合约 X 持有」）。
   * ⇒ 返回一个判决对象而不是布尔：`{locked, holderContractId}`。
   * `null` 专门表示「作品不存在」，**不**折进 `locked: false` —— 把「不存在」说成「没锁」
   * 会让调用方把一次 `AssetNotFoundError` 当成一次放行（唯一的消费者正是这样用它的）。
   *
   * ## 它是**读**，不是锁
   * 它不开事务、也不加行锁。**复访触发条件**（据实记载这条边界）：
   * `persistIngested({ assetId })` 今天**零生产调用方**（见 A-7 的说明），因此
   * 「读完之后、写版本之前，别人把作品锁上了」这个窗口今天不可达；等那条路径第一次
   * 有调用方时，正确的形状是在这里用**同一条全局锁序**取行锁（`FOR UPDATE`），
   * 而不是把判据挪到调用方去。
   */
  async isLocked(
    tx: Prisma.TransactionClient,
    assetId: string,
  ): Promise<{ readonly locked: boolean; readonly holderContractId: string | null } | null> {
    const row = await tx.asset.findUnique({
      where: { id: assetId },
      select: { lockedAt: true, holderContractId: true },
    });
    if (row === null) return null;
    return { locked: row.lockedAt !== null, holderContractId: row.holderContractId };
  }
}

/**
 * 作品正被**另一份**合约锁着 ⇒ 409（§6.3:284）。
 *
 * ## 为什么它住在 `asset` 而不复用 `exchange/core/errors.ts` 的 `AssetLockedError`
 * 与增量 A-7 的 `AssetLockedForVersionError` 逐字同一条理由：预检 §0.2 实测
 * `asset → exchange` 一旦成环，`pnpm arch` 就是 **6 条 error / exit 6**（单向时 exit 0）。
 * D11 的接缝是「`asset` 拥有处分判定，`exchange` 把事实**推**给它」。
 *
 * ## 据实记载：于是「作品被锁着」有两个错误类（**同一个状态码、同一个 `code`**）
 *   * `AssetLockedError`（`exchange` 的）：`proposeOffer` 读到 `locked_at` 非空时抛
 *     —— 那一处只判「锁着吗」，**不需要**持有者；
 *   * 本类（`asset` 的）：锁服务在**它自己那条 SQL 的结果上**判，那里**知道**持有者是谁。
 * 两者的 HTTP 出口是**同一格**（`exchangeErrorToHttp` ⇒ 409 `EXCHANGE_ASSET_LOCKED`），
 * 因此调用方看不出这个内部区别——而模块边界又要求它们不能是同一个类。
 * 把 `exchange` 的那个类挪到 `asset` 会让 `exchange` 的 12 档翻译表里出现一个
 * 「本模块不拥有的错误」，那是另一种真实的代价。
 */
export class AssetLockedByContractError extends Error {
  constructor(
    readonly assetId: string,
    /** 持有者（合约 id）；行不一致时为 `null`。 */
    readonly holder: string | null,
  ) {
    super(`作品已被锁定（§6.3:284）：${assetId}，持有者 ${holder ?? '(未知)'}`);
    this.name = 'AssetLockedByContractError';
  }
}
