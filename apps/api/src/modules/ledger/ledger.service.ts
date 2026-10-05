import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@vca/shared';
import { PrismaService } from '../../db/prisma.service.js';
import { AuditService } from '../audit/index.js';
import {
  ACCOUNT_KINDS, accountKey, assertAccountKind, isUserAccountKind, normalizeRef,
  SYSTEM_ACCOUNT_KINDS, USER_ACCOUNT_KINDS,
} from './core/account-kind.js';
import {
  IdempotencyKeyReusedError, InsufficientFundsError, MissingAccountError,
  SystemAccountMissingError, UnknownAccountKindError,
} from './core/errors.js';
import { applyPosting, assertBalanced, movesToLegs, sameLegs } from './core/posting.js';
import type {
  AccountRef, AccountSnapshot, MoneyMove, PostingLeg, PostingLegsRequest, PostingRequest, PostingResult,
} from './core/types.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * 过账（P2 的核心；设计 §8.2 / §8.3 / §8.5）。
 *
 * 它同时落实四条**实测**结论，四条合起来才是「钱只有一种流动方式」：
 *
 * | 结论 | 落点 | 谁看着它 |
 * |---|---|---|
 * | C25/D8 余额扣减的并发权威是**条件更新的受影响行数** | `applyBalances` | 「两笔并发各冻结 6000」+ 那条确定性用例（`stage === 'conditional-update'`） |
 * | C26/D9 幂等键是数据库**唯一约束**，三态：重放 / 409 / 新键 | `post` 的 findUnique 比腿 + `isIdempotencyConflict` | 幂等①②③ |
 * | C28 「应用侧显式平衡断言」是唯一稳定的错误通道 | **`postLegs` 头部**那次 `assertBalanced` | 「直接腿入口」三条用例（探针 p7'：删掉它 ⇒ ② 变红） |
 * | D10 一笔过账一行审计，**写在同一个事务里** | `post` 末尾的 `audit.record(…, tx)` | 「账本回滚 ⇒ 审计行 0 行」（独立断言） |
 *
 * **不要**把延迟约束触发器当主错误通道：实测经 Prisma 7.10.0 时它退化成
 * `DriverAdapterError` 且 `code === undefined`（只有 `cause.code === '23514'`）。
 * 本文件里因此**没有任何**捕获 `DriverAdapterError` 的代码——那条防线由
 * `tests/integration/db/ledger-enforcement.test.ts` 用「绕过应用直接写分录」证明。
 *
 * ## 为什么本文件只 import `../audit/index.js`
 * §3.3 第 2 条「跨模块只走显式接口」由 `no-cross-module-internals` 静态强制：
 * 只有 `modules/<other>/index.ts` 被放行。深引 `../audit/audit.service.js` 会让
 * `pnpm arch` 直接报错（那条规则的存在理由写在 `dependency-cruiser.cjs` 里）。
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * **唯一的过账入口**（引用 → 腿：解析账户、展开成复式腿，然后交给 `postLegs`）。
   * 与业务写入共用**调用方**的事务（与 `OutboxService.publish(tx, msg)` 同一纪律：
   * 「必须走到 $transaction 里」这件事在调用点就是看得见的）。
   *
   * ## 为什么签名收 `tx` 而不是自己开事务
   * P3 的「原子释放」要求「所有权转移 + 资金释放」在**同一个**事务里（设计 §8.5 原文：
   * 「`RELEASED` 与 `SETTLEMENT` 各自在单一事务内完成」）。账本自己开事务会从结构上
   * 排除这件事——而那时候的修法是「把账本拆成两半」，代价远大于一开始就收 `tx`。
   *
   * ## 两扇门，一条落库路径
   * 本方法只做「引用 → 腿」这一半（① 解析/惰性创建账户、② 展开成复式腿）；
   * ③–⑥（幂等 / 快照与预判 / 落库 / 审计）在 `postLegs` 里，**两条路共用同一份实现**。
   * 分开的理由不是分层美学，而是 C28 那条平衡断言需要一条**可达**的路径——见 `postLegs`。
   *
   * 顺序里有一处是**承重**的：幂等判定在落库之前。幂等键的唯一约束在 `ledger.transactions`
   * 上，而 `ledgerTransaction.create` 是落库的第一步——因此「同键」在**没有并发**时
   * 由判定判出来（重放或 409）；并发时第二个请求会卡在唯一索引上、等第一个提交后拿到
   * `P2002`，由 `runWithIdempotentRetry` 重试一次、走重放路径。
   */
  async post(tx: Prisma.TransactionClient, request: PostingRequest): Promise<PostingResult> {
    const moves = request.moves.map((m) => ({ ...m, from: normalizeRef(m.from), to: normalizeRef(m.to) }));
    const resolved = await this.resolveAccounts(tx, moves);
    const legs = movesToLegs(moves, resolved);
    return this.postLegs(tx, {
      kind: request.kind,
      idempotencyKey: request.idempotencyKey,
      legs,
      actorId: request.actorId ?? null,
    });
  }

  /**
   * **直接腿入口**：腿由调用方手工构造（`accountId` 已是解析后的 id）。
   *
   * ## 它为什么存在 —— C28 那条显式平衡断言需要一条**可达**的路径
   * `post` 的腿永远来自 `movesToLegs`，而它**按构造**总是平衡的（每一条转移同时产生
   * `−a` 与 `+a`，和恒为 0）。探针 **p7**（Task 6）实测：把 `post` 里那次
   * `assertBalanced` 删掉，**一条用例都不红**——在那条路上它是装饰。
   * 控制器据此裁定（`progress.md` 的 p7 条）：保留这条断言，但把**理由**改成
   * 「它是为**腿集不来自 `movesToLegs`** 的路径准备的」，并给它一条真的见证。
   * 本方法就是那条路径：断言在它的第一行，`tests/integration/ledger/postings.test.ts`
   * 的「直接腿入口」三条用例从这扇门进来（其中 ② 是**判别性**见证，见下）。
   *
   * ## 为什么判别性见证靠的是**顺序**而不是「会不会抛」
   * 任何不平衡的腿集 `applyPosting` 也会抛同一个 `UnbalancedPostingError`（它的第一句
   * 也是 `assertBalanced`），所以「抛没抛」分不开这两处。能分开的只有顺序：
   * 本方法这一次在幂等判定**之前**（因此一笔结构上就是错的请求不会被当成
   * 「一次幂等重放/冲突」来回答），而 `applyPosting` 那次在它**之后**。
   * 探针 **p7'**（删掉本方法里的 `assertBalanced`）实测：入口 ② 以
   * `IdempotencyKeyReusedError` 变红，其余用例全绿。**据实记载**：在同一条路径上，
   * 这次的「拒绝」判据与纯核心那次是**冗余**的；它真正独有的责任是那个**顺序**。
   *
   * ## 这扇门验证得**更少**（据实记载，不是疏漏）
   * 它不解析引用，因此没有：kind/owner 绑定检查、§8.1 之外的 kind 拒绝、
   * 惰性创建账户、自转检查、同账户净额合并。`accountId` 由调用方负责，
   * 从库里读回的快照仍会做 `assertAccountKind`，`applyPosting` 仍会判不变式 #3，
   * 数据库那道延迟约束触发器仍会在 COMMIT 兜底。**P2 里唯一的调用方是本类自己**
   * （`post`）与用例；将来若有第二条腿路，它必须先回答「谁保证那些 id 是被授权的」。
   */
  async postLegs(tx: Prisma.TransactionClient, request: PostingLegsRequest): Promise<PostingResult> {
    const legs = request.legs.map((leg) => ({ ...leg }));
    // ↓ C28 的执行点（本文件里**唯一**一次）：腿集不来自 `movesToLegs` 的那条路上，
    //   这是「借贷必须平衡」的第一道、也是唯一一道应用侧守卫。
    assertBalanced(legs);

    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
      select: { id: true, entries: { select: { accountId: true, amount: true } } },
    });
    if (existing) {
      // 同键同腿 = 重放（**不是**静默去重：调用方拿到 created:false，这是它需要知道的事实）。
      // 比腿用的是纯核心的 `sameLegs`（顺序无关）——顺序敏感会让一个合法重放变成 409。
      if (sameLegs(existing.entries, legs)) return { transactionId: existing.id, created: false };
      throw new IdempotencyKeyReusedError(request.idempotencyKey);
    }

    const snapshots = await this.loadSnapshots(tx, [...new Set(legs.map((leg) => leg.accountId))]);
    applyPosting(snapshots, legs); // ← 只取它的异常；并发权威在下面的受影响行数

    const transaction = await tx.ledgerTransaction.create({
      data: { kind: request.kind, idempotencyKey: request.idempotencyKey },
      select: { id: true },
    });
    await tx.ledgerEntry.createMany({
      data: legs.map((leg) => ({ transactionId: transaction.id, accountId: leg.accountId, amount: leg.amount })),
    });
    await this.applyBalances(tx, legs, snapshots);

    await this.audit.record(
      {
        actorId: request.actorId ?? null,
        action: 'ledger.posted',
        resource: 'LedgerTransaction',
        resourceId: transaction.id,
        metadata: { kind: request.kind, idempotencyKey: request.idempotencyKey, legs: legs.length },
      },
      tx, // ← 与账本同生共死（Task 2）
    );
    return { transactionId: transaction.id, created: true };
  }

  /**
   * ① 解析账户：**用户账户惰性创建、系统账户只查不建**（D2）。
   *
   * ## 为什么用户账户用 `ON CONFLICT DO NOTHING` 而不是 `SELECT … FOR UPDATE` + INSERT
   * 预检实测（C.17/C.19）：`SELECT … FOR UPDATE` **锁不住不存在的行**（没有行可锁），
   * 两个并发「没有就建」会撞唯一约束抛 P2002；而 `INSERT … ON CONFLICT DO NOTHING`
   * 三次并发得到 `1/0/0` 且最终 1 行——**安全**。这里要的就是「无论谁赢，之后行都在」。
   *
   * ## 为什么系统账户不在这里创建
   * `(owner_user_id, kind)` 上的唯一索引把 NULL 视为**互不相同**，因此惰性创建在库里
   * **拿不到**「一个 kind 一行」的保证。系统账户因此只由迁移种子化（D2），这里缺了就抛
   * ——那说明迁移没跑，而这句错误比「悄悄建了第二个 ESCROW 账户」有用得多。
   *
   * ## 为什么 id 在这里生成而不是靠数据库默认值
   * C4：主键是 UUIDv7，由**客户端**生成（与 `@default(uuid(7))` 一致，P1 的迁移注释里
   * 已确立「不要在库里加 `gen_random_uuid()` 兜底」）。而对**裸 SQL** 来说这不是风格问题：
   * 迁移里建的是 `"id" UUID NOT NULL`，**没有** `DEFAULT`（已核对
   * `20261006120000_p2_ledger/migration.sql` 的三条 `CREATE TABLE`）——`@default(uuid(7))`
   * 是 Prisma 查询引擎在客户端填的，`$executeRaw` 拿不到它。省掉 `uuidv7()` 会直接
   * 以 NOT NULL 违反失败。
   * `$executeRaw` 是**标签模板**，插值会变成绑定参数——C9 的 lint 门禁的那条字符串拼接
   * 路径在这里不可达。
   *
   * ## ★ 为什么 INSERT **只对确实不存在的账户**发（实测修正，偏离计划 Step 3 的字面写法）
   * 计划写的是「对每个用户账户无条件发一次 `INSERT … ON CONFLICT DO NOTHING`」。**实测**：
   * 当那一行正被另一个事务 `UPDATE` 时，这条 INSERT 会**等那个事务结束**
   * （唯一索引的冲突检测按行的 `xmin` 等锁；`pg_stat_activity` 实测
   * `wait_event = 'transactionid'`，阻塞语句逐字就是这条 INSERT）。
   * 代价有两条，第二条才是要紧的：
   * ① 它让**每一笔**过账在第一条语句上就被「同一个账户上的并发过账」串行化——一次没有
   *    任何目的的写入与等锁；
   * ② 它挡在条件更新（**真正的**并发权威，C25/D8）**前面**：于是「两笔并发各冻结 6000」
   *    的败者会在 INSERT 上等，等完再读快照 ⇒ 读到的是胜者**已提交**的余额、由纯核心的
   *    预判拦下（`stage = 'predicted'`）。结果就是 `conditional-update` 那条路
   *    **一次都走不到**，而「条件更新是并发权威」这句话在测试里**没有任何见证**。
   * 先读一次、只补缺的那些，就没有这个问题：账户已存在时本方法**不发任何写语句**，
   * 借方守卫因此是这笔过账遇到的第一个锁。
   * **惰性创建的安全性没有变**：并发「没有就建」依旧是 `INSERT … ON CONFLICT DO NOTHING`
   * （预检 C.19 实测 1/0/0），只是把它收窄到真正需要它的那一刻。
   */
  private async resolveAccounts(
    tx: Prisma.TransactionClient,
    moves: readonly MoneyMove[],
  ): Promise<(AccountRef & { id: string })[]> {
    const refs = new Map<string, AccountRef>();
    for (const move of moves) {
      refs.set(accountKey(move.from), normalizeRef(move.from));
      refs.set(accountKey(move.to), normalizeRef(move.to));
    }
    const wanted = [...refs.values()];

    for (const ref of wanted) {
      assertAccountKind(ref.kind); // C30：§8.1 之外的 kind 在这里就报出来
      const isSystem = SYSTEM_ACCOUNT_KINDS.includes(ref.kind);
      // 「kind」与「有没有 owner」是**绑定**的（§8.1 / D2）：用户 kind 必有 owner、系统 kind 必无。
      // 写反了（给系统账户安一个 owner，或用 §8.2 的 `SELLER_AVAILABLE` 冒充 kind）在这里就失败，
      // 而不是等到库里出现第二行 `(NULL, 'PLATFORM_ESCROW')`——那件事只有对账才看得见。
      if (isSystem !== (ref.ownerUserId === null)) throw new UnknownAccountKindError(ref.kind);
    }

    const where = { OR: wanted.map((ref) => ({ kind: ref.kind, ownerUserId: ref.ownerUserId })) };
    const select = { id: true, kind: true, ownerUserId: true } as const;
    const before = await tx.ledgerAccount.findMany({ where, select });

    const have = new Set(
      before.map((row) => {
        assertAccountKind(row.kind); // C30：从库里读回的 `kind` 同样必须落在 §8.1 的五个之内
        return accountKey({ kind: row.kind, ownerUserId: row.ownerUserId });
      }),
    );
    // 系统账户**只查不建**（D2：迁移是唯一的创建者）；用户账户只补缺的那些。
    const missing = wanted.filter(
      (ref) => !SYSTEM_ACCOUNT_KINDS.includes(ref.kind) && !have.has(accountKey(ref)),
    );
    for (const ref of missing) {
      await tx.$executeRaw`
        INSERT INTO "ledger"."accounts" ("id", "kind", "owner_user_id", "balance")
        VALUES (${uuidv7()}::uuid, ${ref.kind}, ${ref.ownerUserId}::uuid, 0)
        ON CONFLICT DO NOTHING
      `;
    }
    // 什么都没补时，上面那次读就是全部答案（少一次往返，也少一次快照）。
    const rows = missing.length === 0 ? before : await tx.ledgerAccount.findMany({ where, select });

    const byKey = new Map(
      rows.map((row) => {
        assertAccountKind(row.kind);
        return [accountKey({ kind: row.kind, ownerUserId: row.ownerUserId }), row] as const;
      }),
    );
    return wanted.map((ref) => {
      const row = byKey.get(accountKey(ref));
      // 这一句在实践中**只**可能为系统账户触发：用户账户在上面刚被「读 + 补缺」保证过
      // （要么本来就有一行，要么这一次插了进去 / 被并发插了进去）。错误消息因此说的是系统账户。
      if (!row) throw new SystemAccountMissingError(ref.kind);
      assertAccountKind(row.kind);
      return { kind: row.kind, ownerUserId: row.ownerUserId, id: row.id };
    });
  }

  /**
   * ④ 读快照（**同一事务内**）。没有它，纯核心的预判就只能靠猜余额。
   * 读出来的 `balance` 是 Prisma 的 `BigInt` → JS `bigint`，预检 A.2 实测**完全无损**
   * （含 `9007199254740993n` 与负数，`$queryRaw` 路径同样成立）。
   *
   * 参数是 **id 列表**（不是解析结果）：两扇门走到这里时都已经有 id 了——`post` 由
   * `resolveAccounts` 解析出来，`postLegs` 由调用方直接给出。
   */
  private async loadSnapshots(
    tx: Prisma.TransactionClient,
    accountIds: readonly string[],
  ): Promise<AccountSnapshot[]> {
    const rows = await tx.ledgerAccount.findMany({
      where: { id: { in: [...accountIds] } },
      select: { id: true, kind: true, ownerUserId: true, balance: true },
    });
    return rows.map((row) => {
      assertAccountKind(row.kind); // C30：从库里读回的 `kind` 同样必须落在 §8.1 的五个之内
      return { id: row.id, kind: row.kind, ownerUserId: row.ownerUserId, balance: row.balance };
    });
  }

  /**
   * ⑤ 落余额：**借方条件更新、以受影响行数为准**（C25 / D8），贷方无条件。
   *
   * ## 为什么只有用户账户带守卫
   * 系统账户（`EXTERNAL_TOPUP` / `PLATFORM_*`）**天然为负**——充值就是把它扣成负的。
   * 给所有借方都加上 `balance >= x`，第一次充值就会失败（余额 0 扣 10000）。
   * 这与迁移里那条**条件化** CHECK 是同一条规则的两个落点，两处必须一致。
   *
   * ## 为什么 `count !== 1` 就是「余额不足」
   * READ COMMITTED 之下，`UPDATE … WHERE balance >= x` 在拿到行锁之后会**重新求值**
   * 那个谓词（PostgreSQL 的 EvalPlanQual）。因此 count=0 的两种含义在这里是同一件事：
   * 「现在不够」与「我们读快照的时候还不够，且中间被别的事务改小了」。两者都是
   * 余额不足；把它区分开只会给出一个调用方无法据以行动的错误码。
   * 并发证据（预检 C.3 实测）：条件更新 ⇒ 影响行数 1/0、余额 400（正确）；
   * 读-判断-写 ⇒ 两笔都成功、余额 400 而实际扣了 1200（丢更新）。
   *
   * ## 为什么按金额排序
   * 先处理借方：**唯一会失败的那一半先失败**，错误信息与顺序无关（同事务，全部回滚）。
   * 这也让「哪一行先被加锁」是确定的——那条确定性并发用例依赖它。
   */
  private async applyBalances(
    tx: Prisma.TransactionClient,
    legs: readonly PostingLeg[],
    snapshots: readonly AccountSnapshot[],
  ): Promise<void> {
    const byId = new Map(snapshots.map((s) => [s.id, s]));
    const ordered = [...legs].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
    for (const leg of ordered) {
      const snapshot = byId.get(leg.accountId);
      if (!snapshot) throw new MissingAccountError(leg.accountId);
      if (leg.amount < 0n) {
        const needed = -leg.amount;
        const applied = await tx.ledgerAccount.updateMany({
          where: isUserAccountKind(snapshot.kind)
            ? { id: leg.accountId, balance: { gte: needed } }
            : { id: leg.accountId },
          data: { balance: { decrement: needed } },
        });
        if (applied.count !== 1) {
          throw new InsufficientFundsError(leg.accountId, snapshot.kind, snapshot.balance, needed, 'conditional-update');
        }
      } else {
        await tx.ledgerAccount.update({ where: { id: leg.accountId }, data: { balance: { increment: leg.amount } } });
      }
    }
  }

  /**
   * 只读：用户的可用 / 冻结余额（路由用它回答「发放之后他的余额是多少」）。
   *
   * **「没有账户行」与「余额为 0」在这里等价**（D2 的落点）：余额只由账本推导，
   * 而账本的第一次写入必然先把行建出来，因此「没有行」只可能意味着「从来没有过钱」。
   * 把这两种状态合成一个返回值不是偷懒——分开表达会让每个调用方都要处理同一个
   * 「其实一样」的分支。
   *
   * ## 关于 `userId.toLowerCase()`（实测更正了一条**说错了的**注释）
   * 计划在这里写的是「先小写：UUID 在库里存的是小写（P1 的 `ownership.service` 在这里踩过）」。
   * **那句话在 `uuid` 列上不成立**：`owner_user_id` 的类型是 `uuid`，PostgreSQL 在输入时就
   * 把大小写归一化了，因此 `'ABC…'` 与 `'abc…'` 在库里是**同一个值**，比较与大小写无关。
   * 证据是探针 **p19**（把 `.toLowerCase()` 删掉）：**一条用例都不红**——这一句今天
   * **既没有见证、也没有作用**。
   * P1 踩到的那个坑在**纯核心**那一侧（`accountKey` 拿字符串当 Map 的键，`'ABC…' !== 'abc…'`），
   * 那里的小写归一化是**承重**的，并且有单测（Task 5 的探针 ak4 / ak5）。
   * 这里保留这一句只为一个理由：它是本模块「引用进账本就先归一化」这条约定的统一点
   * （`resolveAccounts` 走的是同一个 `normalizeRef`），删掉它会让两处的约定看起来不一致。
   * **据实记载**：它是一条约定，不是一条守卫。
   */
  async readBalances(
    client: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ available: bigint; frozen: bigint }> {
    const rows = await client.ledgerAccount.findMany({
      where: { ownerUserId: userId.toLowerCase(), kind: { in: [...USER_ACCOUNT_KINDS] } },
      select: { kind: true, balance: true },
    });
    const byKind = new Map(rows.map((row) => [row.kind, row.balance]));
    return {
      available: byKind.get(ACCOUNT_KINDS.USER_AVAILABLE) ?? 0n,
      frozen: byKind.get(ACCOUNT_KINDS.USER_FROZEN) ?? 0n,
    };
  }

  /**
   * 在**新事务**里跑一段账本调用；同一幂等键的**并发**冲突（P2002）重试一次（D9）。
   *
   * 为什么只需要一次重试，不需要退避、不需要计数：Postgres 会让第二个 `INSERT` 等第一个
   * 提交/回滚，然后以 23505 拒绝（预检 C.5 实测）。此刻那一行**已经提交**，因此重试必然
   * 走重放路径（`created:false`）——第二次尝试不可能再撞同一个键。这与
   * 「`SERIALIZABLE` 的 P2034 重试」是**两件事**：那条路 P2 不走（见 D8 的裁定，
   * 它写在规格 §8.5 里），`P2034` 在这里会原样抛出，不被当成重试信号。
   */
  async runWithIdempotentRetry<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
      return await this.prisma.$transaction(fn);
    }
  }
}

/** `transactions_idempotency_key` —— 幂等键的唯一索引名（迁移里逐字核对过，见下）。 */
const IDEMPOTENCY_CONSTRAINT = 'transactions_idempotency_key';

/**
 * 把任意外来值安全地变成字符串（判别器要在**不可信**的错误对象里找约束名）。
 *
 * **这个 helper 必须真的写出来**（自审第 8 条的同类：计划的判别器调用了一个仓库里
 * **不存在**的 `safeJson` —— 核对：`apps/` 与 `packages/` 下 `safeJson` 零匹配，
 * 照抄会以 `Cannot find name 'safeJson'` 让 `pnpm typecheck` 失败）。
 * 它自己**绝不能抛**：判别器的契约是「探不到就返回 false」（fail-closed）。
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value); // 循环引用 / 有 toJSON 会抛的对象：退化成 String
  }
}

/**
 * **只**认这一条约束的 P2002（D9）。
 *
 * 为什么必须窄：P2002 是「唯一约束被违反」这一类，把任何 P2002 都当成「重放」会把
 * 别的唯一冲突（主键重复、将来别的唯一索引）悄悄吞掉——那正是「静默去重」。
 * 实测的错误形态（预检 C.7）：`PrismaClientKnownRequestError` / `code = 'P2002'`，
 * 约束名在 `meta.driverAdapterError.cause.constraint.index` 或 message 里。
 * 两种来源都探，**探不到就返回 false**（fail-closed：不重试、不吞错）。
 *
 * ## 为什么 `IDEMPOTENCY_CONSTRAINT` 是**前缀**而不是全名
 * 库里那条唯一索引的真实名字是 `transactions_idempotency_key_key`（迁移逐字：
 * `CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "ledger"."transactions"("idempotency_key")`），
 * 而 Prisma 在某些路径上报的是 `idempotency_key` / 约束名两种拼法之一。判别器用
 * **子串**判，两种都认得；而它要拒绝的是**别的**约束（`accounts_owner_user_id_kind_key`
 * 之流），那些名字里不含这个子串——这条边界由反例用例守着。
 */
export function isIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== 'P2002') return false;
  const meta = (error as { meta?: unknown }).meta;
  const text = safeJson(meta) + '|' + String((error as { message?: unknown }).message ?? '');
  return text.includes(IDEMPOTENCY_CONSTRAINT);
}
