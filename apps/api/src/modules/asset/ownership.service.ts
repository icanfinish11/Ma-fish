import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';

/**
 * 所有权转让（P1 / Task 7；设计决定 D11，设计文档 §5.2 第 2 条）。
 *
 * ## 转让 = 一次**本地数据库事务**里的两件小事
 *
 * ```
 * BEGIN
 *   ① 读当前所有人（**持行锁**，见下）      ← 前手 fromUserId
 *   ② UPDATE asset.assets SET owner_id = 新所有人
 *   ③ INSERT asset.ownership_history (from → to, reason)
 * COMMIT
 * ```
 *
 * **不解密、不复制制品**：制品只存一份，转让只改指针。这一条不是「省事」，它是
 * 「原子式所有权互换」之所以能成为一个本地事务的**前提**——一旦转让要碰制品，
 * 它就会变成一次跨存储的分布式操作，两阶段与补偿逻辑会立刻跟着来。
 *
 * 本类因此**没有** `ArtifactStore` / `EncryptedArtifactReader` 依赖：不是「忘了注」，
 * 而是结构上够不着（没有对象可以调）。测试从另一侧钉住同一件事：转让前后盘上那份
 * 制品的字节、对象键与版本行逐字段相同，制品库里也不会多出对象。
 *
 * ## 为什么那次读要**持行锁**（`SELECT … FOR UPDATE`）
 *
 * 不持锁时：两笔并发转让都读到同一个前手（MVCC 读不会被行锁挡住），各自追加一行，
 * 于是第二行记下一个**过期的** `fromUserId`；转完两次之后，所有权史读起来是
 * 「alice→bob」+「alice→carol」，而真实链条是 alice→bob→carol。一份自相矛盾的历史
 * 在争议里不构成证据，而这正是这张 append-only 表的全部价值。
 *
 * 持锁之后第二笔会**排队**（不是失败）：拿到锁时它读到的是**已经提交的**新所有人
 * （READ COMMITTED 下 `FOR UPDATE` 在锁释放后重新求值那一行），于是链条始终连续。
 * 这一条有专门的用例：用例自己扣住那一行、改掉所有人再提交，断言转让记下的前手是
 * **最新那个**而非它之前读到的那个——不持锁的实现在那里必然红（探针实测见报告）。
 *
 * ## 「转给自己」在**源头**被拒（控制器裁定；修复轮 1 从「据实记载」改成「实现」）
 *
 * 照字面执行会写下 `ownerId` 写回同一个值 + 一行 `X→X`，而那一行**永久的**：
 * 这张表的 `UPDATE`/`DELETE` 在运行时角色下被 `REVOKE`（判据 10），库里没有任何清理入口，
 * 因此一行 `X→X` 删不掉、也永远不再改变。它承载的信息是零——append-only 的代价只有在
 * 「写进去的每一行都有意义」时才付得起。拒绝的形态是 {@link SelfTransferRejectedError}
 * （领域错误，与 {@link AssetNotFoundError} 同类）。
 *
 * **这条守卫判定的是「规范化之后的取值」**（修复轮 2）：`toUserId` 在方法入口先
 * `toLowerCase()` 再参与比较——PostgreSQL 的 `uuid` 列存的是小写，而大写拼写的
 * 当前所有人曾经因此绕过守卫（实测：`resolved`，历史里留下 `X→X`）。理由见方法里的注释。
 *
 * ## 刻意**没有**做的几件事（都不是遗漏）
 *
 * - **没有权限判定**：`checkAccess` 是 `asset` 模块**唯一**的授权入口（D11），
 *   那是 Task 8 的交付。本服务假定调用方已经判过。
 * - **没有审计**：审计的写入路径有且只有一条（`AuditService`），而「转让要不要写审计」
 *   是 Task 8 的越权/审计矩阵要定的事；本任务只做设计点名的两件事。
 * - **没有输入校验**：`assetId` / `toUserId` 假定是合法 UUID。非法取值会以数据库的
 *   `22P02`（uuid 语法）失败，**不**伪装成「作品不存在」——那会把一次调用错误说成一次
 *   正常的 404。参数校验属于 HTTP 边界（Task 8 的控制器）。**规范化不等于校验**：
 *   前者只把「同一个取值的另一种拼写」对齐，后者是另一件事（见方法入口那段）。
 */
@Injectable()
export class OwnershipService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 把作品转让给另一个用户：指针变更 + 追加一行所有权史，**同一事务**。
   *
   * @throws {AssetNotFoundError} 作品不存在（**不**创建、**不**追加历史行）。
   * @throws {SelfTransferRejectedError} 新所有人就是当前所有人（**不**写历史行、**不**改指针）。
   */
  async transferOwnership(input: TransferOwnershipInput): Promise<OwnershipTransferResult> {
    /**
     * 入参在**方法入口**规范化一次（修复轮 2 / Critical）。
     *
     * ## 为什么必须规范化
     *
     * PostgreSQL 的 `uuid` 列把取值规范成**小写**存进去，`SELECT owner_id` 读回来的因此
     * 必然是小写；而 `toUserId` 是调用方给的字符串。两者直接比较时，一个**大写拼写**的
     * 「当前所有人」看起来就是另一个人 ⇒ 自转守卫（①′）被**绕过**，`ownerId` 被写回同一个值，
     * 而历史里落下**一行 `X→X`**——那一行在运行时角色下删不掉（判据 10），正是这条守卫
     * 存在的全部理由。一次合法的输入拼写就足以造成它（未修复时的实测见任务报告：
     * `resolved`，历史行 `1a37…b128->1a37…b128`）。
     *
     * ## 为什么在入口而不是在比较处
     *
     * `toUserId` 有三个出口：判自转、写指针、写历史行，以及第四个——**返回值**。
     * 只规范化比较那一处，写进库与返回给调用方的就仍是调用方那串拼写，于是
     * 「返回值 vs 库里那一行」又要靠下一处规范化才对得上（同一个缺陷换了个地方）。
     * 入口规范化一次之后，本方法内部只有一个 `toUserId`，它的取值与库里那一行逐字相同。
     *
     * ## 它**不是**输入校验（这条边界没有变）
     *
     * 规范化不是校验：一个根本不是 UUID 的取值（`'abc'`）照样会以数据库的 `22P02` 失败，
     * 不伪装成「作品不存在」——参数校验属于 HTTP 边界（Task 7 的移交，见类注释末条）。
     * 这里只处理**同一个取值的另一种拼写**。
     */
    const toUserId = input.toUserId.toLowerCase();

    return this.prisma.$transaction(async (tx) => {
      // ① 持锁读前手。写成标签模板（而不是拼接字符串）：Prisma 会把插值变成**绑定参数**，
      //    因此这里不存在 C9 点名的字符串拼接 raw 那条路径。
      const locked = await tx.$queryRaw<{ owner_id: string }[]>`
        SELECT owner_id FROM asset.assets WHERE id = ${input.assetId}::uuid FOR UPDATE
      `;
      const current = locked[0];
      if (current === undefined) throw new AssetNotFoundError(input.assetId);
      const fromUserId = current.owner_id;

      // ①′ 「转给自己」在**任何写之前**被拒。顺序是刻意的：先读行、再判自转。
      //     反过来（先判自转）会让一条 `assetId` 不存在的调用拿到「转给自己」这个错误，
      //     而正确的说法是「作品不存在」——而且那样连作品存在与否都不用查就能返回，
      //     成了一条不需要鉴权的探测口。
      //     拒绝的后果由用例实测：没有历史行、指针未变（一行 `X→X` 写下去就删不掉了）。
      if (toUserId === fromUserId) {
        throw new SelfTransferRejectedError(input.assetId, fromUserId);
      }

      // ② 指针变更。用 `update`（不是 `updateMany`）：主键在上一句里已经被锁住，
      //    所以它必然命中一行；命中不了的话那就是「锁读与更新之间被删了」，
      //    让 Prisma 抛错比默默改零行好。
      await tx.asset.update({ where: { id: input.assetId }, data: { ownerId: toUserId } });

      // ③ 追加一行历史。`append-only` 的语义在数据库层（`REVOKE UPDATE, DELETE`，C7），
      //    应用层只负责**只写不更新**：这里没有任何 upsert / update 的分支。
      const history = await tx.ownershipHistory.create({
        data: {
          assetId: input.assetId,
          fromUserId,
          toUserId,
          reason: input.reason,
        },
        select: { id: true, createdAt: true },
      });

      return {
        assetId: input.assetId,
        fromUserId,
        toUserId,
        ownershipHistoryId: history.id,
        transferredAt: history.createdAt,
      };
    });
  }
}

/** {@link OwnershipService.transferOwnership} 的入参。 */
export interface TransferOwnershipInput {
  /** 被转让的作品。 */
  readonly assetId: string;
  /** 新所有人。 */
  readonly toUserId: string;
  /** 事由（原文落库；append-only 的行删不掉，因此**不得**放凭证/令牌，见 C11）。 */
  readonly reason: string;
}

/** 一次成功转让的结果。 */
export interface OwnershipTransferResult {
  readonly assetId: string;
  /** 转让前的所有人（持锁读出来的那个值，就是写进历史行的 `fromUserId`）。 */
  readonly fromUserId: string;
  readonly toUserId: string;
  /** 新追加的那一行历史的 id（调用方据此引用它）。 */
  readonly ownershipHistoryId: string;
  /** 那一行的 `createdAt`（服务端时钟，C6）。 */
  readonly transferredAt: Date;
}

/**
 * 作品不存在。
 *
 * 与「转让失败」区分开：这是**调用方指错了对象**（回 404 的那一类），而不是历史写不进去
 * （那是服务端/存储的问题）。分开的理由与 Task 5 的 `ArchiveRejectedError` /
 * `ArtifactUnreadableError` 完全一致：状态码要说清责任方。
 */
export class AssetNotFoundError extends Error {
  constructor(readonly assetId: string) {
    super(`作品不存在：${assetId}`);
    this.name = 'AssetNotFoundError';
  }
}

/**
 * 「转给自己」被拒（`toUserId` === 当前所有人）。
 *
 * 领域错误，与 {@link AssetNotFoundError} 同类但**不同因**：这次不是调用方指错了对象，
 * 而是这次转让本身不成立——它会在 append-only 的历史里留下一行永远删不掉的 `X→X`。
 * 分开的理由与 `AssetNotFoundError` 那一段完全相同：HTTP 边界要能分开说清责任方
 * （404 还是 409/422），而把两种情况混成一个错误类型会让那次翻译只能靠猜。
 */
export class SelfTransferRejectedError extends Error {
  constructor(
    readonly assetId: string,
    /** 既是当前所有人、也是被指定的新所有人（那个重复的 UUID）。 */
    readonly userId: string,
  ) {
    super(`拒绝对作品 ${assetId} 的转给自己：${userId} 已经是当前所有人`);
    this.name = 'SelfTransferRejectedError';
  }
}
