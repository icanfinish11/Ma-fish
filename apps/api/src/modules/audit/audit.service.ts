import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { currentContext } from '../../common/context/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';

/** 一条审计记录的入参。`traceId` **不**在此：它来自请求上下文，由本服务统一盖戳。 */
export interface AuditRecordInput {
  /** 当事人。匿名/系统行为（登录失败、定时任务）为 `null`。 */
  actorId?: string | null;
  /** 稳定的动作名，`<域>.<动作>`，如 `auth.login` / `auth.login_failed`。 */
  action: string;
  resource: string;
  /**
   * 被操作对象的**非凭证**标识（通常是业务主键）。
   *
   * **绝不放凭证**：`audit_log` 是 append-only 的（INSERT-only 授权 + 不可 UPDATE/DELETE，
   * 见 `infra/db/apply-grants.sql`），因此写进来的东西**删不掉**。会话 id 是完整的
   * bearer 凭证，写进本列等于把凭证永久留档（C11）；把「本该放 `metadata` 的令牌改放到
   * `resourceId`」是同一个暴露面换了个字段，**不是**修复。需要当事人时用 `actorId`。
   */
  resourceId?: string | null;
  /**
   * 结构化补充。**不得**放口令、令牌、完整邮箱（C11）；会话 id 同属令牌，也不得放。
   *
   * 说明（修复轮 2 的边界，避免误读这条约束的强度；**修复轮 2/3 之后已过时的那半句已改正**）：
   * `redact.ts` 的黑名单**曾经**没有运行时调用方，但 **Task 8 起它接在 pino 的
   * `formatters.log` 上**（见 `common/logging/logger.module.ts`），因此 deny-list
   * **现在真的会拦**应用写出的每一条日志记录。这**不**意味着本字段可以放松：
   * ① 脱敏只认**键名**，`metadata` 里套一层业务对象的 `email` 字段靠的是键级规则
   * （`key.includes('email')`），字段名一变就漏；② 审计行是**落库**的，日志那条防线
   * 管不到它。所以这条约束仍然靠**调用点自觉 + code review**，日志脱敏只是第二道网。
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * 审计落库（C7 / §9；Ruling 1：本任务交付**最小**实现，Task 8 只消费不重建）。
 *
 * ## 边界：这里只做「写一行」，不做别的
 *
 * 刻意**不**包含：outbox 事件、邮件/通知、读取接口、批量写入、日志复制。
 * 审计的**写入路径**必须有且只有一条，否则「审计是否可靠」就要按最弱的那条来判断。
 * Task 8 会加 outbox 与 mailer，但那是**别的**表、别的模块；它消费本服务，
 * 不得再实现一份写审计的代码。
 *
 * ## 为什么表在 `audit` schema 且本服务不做 append-only 检查
 *
 * append-only 是**数据库角色**的权限事实（`audit` schema 只有 SELECT + INSERT，
 * UPDATE/DELETE 被显式撤销，见 `infra/db/apply-grants.sql`），由
 * `tests/integration/db/append-only.test.ts` 守着。在应用层再写一遍「不许 UPDATE」
 * 只是把同一个不变式表达两次，且应用层那份是**可被绕过的**——真正的防线必须在库里。
 *
 * ## `traceId` 为什么在这里取而不是让调用方传
 *
 * 调用方（`AuthService`）在多处写审计，每处都记得传 traceId 是一次「漏一层就断链」的
 * 参数透传。`currentContext()` 由 ALS 在异步边界上自动继承，取到的一定是**本次请求**的 id。
 * 上下文之外（启动期、定时任务、队列消费）取不到，此时落 `null` 而**不是**抛错——
 * 审计的可用性不该被「有没有请求上下文」绑架。
 *
 * ## 错误处理：**不吞**（已裁定的接受风险 R3）
 *
 * 写审计失败会让整个操作失败。理由是审计的用途是事后追责与合规：如果「写不进去也能继续」，
 * 那么一个被静默破坏的审计表在需要它之前不会有人发现。这与「日志」（写不进去就算了）
 * 是两类东西，别看错。代价如实记录：审计库不可用时**登录会 500**，审计表因此是登录路径的
 * 可用性依赖。
 *
 * **P2 / Task 2 已落地**（P0 的原文保留作来路）：P0 在这里写着「**持久修法在 P2**：让审计行
 * 加入业务事务（在有事务的地方），而不是退化成吞掉异常。**复访触发条件：P2 账本落地时**
 * ——那是第一个审计必须与业务同生共死的地方，届时本取舍按『事务内写』重新实现」。
 * 触发条件**已经到达**：账本（P2）是会回滚的，而**一个会回滚、审计行却留下的账本，其审计
 * 轨迹在撒谎**——审计里会留下一次从未发生过的资金变动，而设计 §13.2 要求「审计日志可完整
 * 重建任一次资金变动的链路」。预检 C.16 实测了这条机制：事务**外**写审计时账本回滚后仍剩
 * 1 行，事务**内**写时 0 行。`record` 因此有了第二个参数 `tx`。
 *
 * **现在的规则（不是风格要求）：账本路径必须传 `tx`。** 其余路径（登录失败、登出、制品清理
 * 失败）天然不在事务里，它们没有「与谁同生共死」的对象，传不传都行。
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 写入一行审计。
   *
   * ## `tx` 为什么是可选参数
   *
   * 有些路径**天然不在事务里**（登录失败、登出、定时任务），把它们一律塞进事务只是
   * 仪式。因此签名是 `tx?`：传了就用调用方的事务，不传就用本服务自己的客户端。
   *
   * ## ★ 但「可选」不是本方法的类型层缺口 —— `PrismaService` 那一侧被**否定约束**挡住
   *
   * 旧注释在这里写着「可选性的代价是『忘传』不会在类型层被发现（`PrismaService` 与
   * `Prisma.TransactionClient` 结构上兼容，类型挡不住）」。那半句**是对的**，
   * 但它描述的缺口**不是**「传错对象」：真正需要挡住的是
   * `record(input, this.prisma)` —— 一个**看起来在事务里、其实不在**的调用。
   *
   * P2 的裁定 C-1 与 P3/Task 1 的实测（后者推翻了前者所依赖的前提）把这件事量清了：
   *
   * ```
   * '$transaction' extends keyof Prisma.TransactionClient  === true
   *   （Prisma 7.10.0 的 denylist 是 ["$connect","$disconnect","$on","$use","$extends"]；
   *     Prisma ≤6 把 `$transaction` 放在里面 ⇒ 计划 D1 那句「它没有 $transaction」今天不成立）
   * const tx: Prisma.TransactionClient = prismaService;     ← **编译通过**
   * ```
   *
   * ⇒ **「必填」本身不是机器判据**，裸的 `Prisma.TransactionClient` 也不是：TS 的结构化
   * 判定不惩罚多出来的成员，`PrismaService` 因此满足它。唯一的结构差异在 denylist 里
   * 那五个成员上——`PrismaService` **有** `$connect`，事务客户端**没有**：
   *
   * ```
   * const bad: Prisma.TransactionClient & { readonly $connect?: never } = prismaService;
   *   ⇒ TS2322: Types of property '$connect' are incompatible.
   *      Type '() => Promise<void>' is not assignable to type 'undefined'.
   * 真实 $transaction 回调的 tx、以及 Prisma.TransactionClient 本身 ⇒ **编译通过**
   * ```
   *
   * 于是「把 `this.prisma` 当 `tx` 传」是一行红波浪线，而「忘了传 `tx`」（那条被刻意
   * 允许的形状，见上面第一段）不受影响。见证在
   * `tests/unit/db/transaction-client-guard.test.ts`（拒绝面 + 验收对照各一条），
   * 判别力由探针 D-A1 实测。
   *
   * 行为层的守卫**一条都没撤**：`tests/integration/audit/rollback.test.ts` 的第一条，
   * 以及账本路径上的另一条（`tests/integration/ledger/postings.test.ts` 的
   * 「账本回滚后审计 0 行」）。谁把 `post` 里的 `tx` 去掉，那两条会给出「审计行留下了」的
   * 明确红灯——类型层那条约束管的是**另一个**失误（传错对象）。
   */
  async record(
    input: AuditRecordInput,
    tx?: Prisma.TransactionClient & { readonly $connect?: never },
  ): Promise<void> {
    const traceId = currentContext()?.traceId ?? null;
    // 三元而不是 `tx ?? this.prisma` 再取方法：写成 `const client = tx ?? this.prisma`
    // 时两个分支的类型是一个联合，Prisma 的委托签名在联合上仍然可解析，但**读的人**
    // 要自己去确认这两个分支是不是同一个东西。这里保留三元的形状，让「同一份 data」
    // 这件事在视觉上只有一个判断点。
    const data = {
      actorId: input.actorId ?? null,
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId ?? null,
      traceId,
      metadata: (input.metadata ?? null) as never,
    };
    if (tx) await tx.auditLog.create({ data });
    else await this.prisma.auditLog.create({ data });
  }
}
