import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../db/prisma.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
// 同上：经 `audit` 模块的对外接口取服务，不深引 `audit.service.js`。
// （接口的入参类型 `AuditRecordInput` 同样在 `../audit/index.js` 上导出，本文件构造字面量时
// 用不到它，故不 import——不留未使用的导入。）
import { AuditService } from '../audit/index.js';
import type { LoginDto, RegisterDto } from './dto.js';
/**
 * 登录失败时用来「空跑一次」的 Argon2id 哈希。
 *
 * 它是**形状合法、口令未知**的常量：`verify` 会对它做一次完整的 Argon2id 计算，
 * 然后必然返回 false（没有人知道它的原像；即便知道，也不影响任何账号，
 * 因为它不属于任何用户）。成本参数与真实哈希**逐位相同**——这正是重点：
 * 计时侧信道来自「算力开销的差异」，不是来自「结果的真假」。
 *
 * 写成模块级常量而不是每次 `login` 现算：现算会让「用户不存在」这条路径
 * **更慢**（多一次哈希），把侧信道反过来（反而能区分），而且白烧一次 CPU。
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** 敏感操作要求「最近 15 分钟内完成过认证」（C13）。 */
export const RECENT_AUTH_WINDOW_MS = 15 * 60_000;

/**
 * 是否是 Prisma 的**唯一约束冲突**（`P2002`）。
 *
 * 为什么按 `code` 而不是 `instanceof PrismaClientKnownRequestError`：跨 Prisma 版本的类身份
 * 与打包边界都是额外假设，而 `code` 是 Prisma 对外文档化的**稳定契约**（`P2002` =
 * unique constraint failed）。代价如实记录：一个恰好带 `code: 'P2002'` 的**非 Prisma**
 * 异常也会被映射成 409——把未知错误报成 409 而不是 500 的风险，远小于把已知的输入冲突
 * 报成 500（后者会误导监控、且让调用方无法自助纠正）。
 *
 * `register` 的**预检查**（`findUnique`）不能被它取代：预检查在**算出 Argon2id 哈希之前**
 * 拦住绝大多数重复注册（哈希是这条路径上最贵的一步）。本函数处理的是预检查与 `create`
 * 之间那条**竞态窗口**——两个并发请求同时通过预检查时，必有一个的 `create` 撞上约束。
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * 认证编排（C13 / §4.2）。
 *
 * ## 三条不变式，改任何一条前先读这里
 *
 * 1. **登录路径恒定时间**：用户不存在时仍然执行一次口令校验（见 `login`）。
 *    经典的退化成 `if (!user) return null` —— 那让「该邮箱是否注册」变成一次计时测量，
 *    实测差异在毫秒量级、上百次采样即可稳定区分。`tests/integration/auth/auth-pipeline.test.ts`
 *    里有一条用固定 60ms 开销把这个结构性差异放大后断言的用例。
 * 2. **登录失败只有一种外部表现**：401 `邮箱或密码不正确`。不区分「用户不存在」与
 *   「口令错误」，也不因为「哈希损坏」变成 500（那同样是存在性信号）。
 * 3. **审计不吞错**：`AuditService.record` 抛出即整个操作失败。这是**已裁定的接受风险**（R3），
 *    不是待办：验收 13.2 要求能重建任何资金流动与制品访问的完整链条，**没写下来的东西无法重建**，
 *    所以宁可不可用也不静默。代价如实记录：审计库不可用时登录/注册会 500，
 *    审计表因此成为登录路径的**可用性依赖**。
 *    **持久修法（P2，不在本阶段实现）**：让审计行**加入业务事务**（在有事务的地方），
 *    而不是退化成吞掉异常——届时登录不再因为一次独立的审计写失败而整体失败。
 *    在那之前**不要**在这里加 `try/catch` 吞掉审计异常。
 *
 * ## 注册端点仍是**账号枚举 oracle**：这是一个**已裁定的接受风险**（R1），不是待办
 *
 * 重复邮箱返回 409 `该邮箱无法注册`，攻击者据此可判定某邮箱是否已注册
 * （登录端点已做到恒定时间，但注册端点在时间上不可能恒定——它要么建用户要么不建）。
 * **裁定：接受，不改对外契约。** 理由：真正的缓解是「统一响应 + 邮件找回」，
 * 而本阶段没有 password-reset / magic-link 流程（§2.2 出范围，C16 也禁止为堵这个洞
 * 去投机实现找回流程）；在没有找回流程的前提下枚举出一个地址**并不通向账号接管**，
 * 且 Task 7 的注册限流（`RATE_LIMITS.register` = 3 次/小时/IP）把速率压到单 IP
 * 每小时 3 个邮箱——代价如实记在这里，不淡化。
 *
 * **复访触发条件：password reset 或 magic-link 落地时必须重新评估**
 * （届时「枚举出邮箱」才第一次接到一条真实的攻击路径）。
 * 届时的正确动作是改 Task 7 的限流表或引入统一响应 + 邮件确认，
 * 不是在本服务里悄悄加一条分支。
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private meta(req: Request) {
    return { ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') };
  }

  async register(dto: RegisterDto, req: Request): Promise<{ userId: string; sessionId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      // 不区分「邮箱已存在」与其它失败原因之外的细节，避免账号枚举（R1，见类注释）
      throw new ConflictException('该邮箱无法注册');
    }

    let user;
    try {
      user = await this.prisma.user.create({
        data: { email: dto.email, passwordHash: await this.passwords.hash(dto.password) },
      });
    } catch (err) {
      // **check-then-create 的竞态**（修复轮 2）。两个并发注册同时通过上面的预检查时，
      // 必有一个的 `create` 撞上 `user.email` 的唯一约束并抛 Prisma `P2002`——
      // 而 `P2002` **不是** `HttpException`，Nest 会把它当未预期错误回
      // `500 Internal server error`。那正是三件事同时发生：
      // ① 客户端可**触发**的输入错误被报成服务端故障；② 与 409 契约不一致（同一原因两种状态码）；
      // ③ 凭空制造 500，而监控按 500 告警——本节开头那条「审计不吞错」的取舍会让 500 更响。
      // 因此在这里把它映射成与预检查**逐字相同**的 409：同因同果，且不泄露是哪一条路径。
      if (isUniqueViolation(err)) throw new ConflictException('该邮箱无法注册');
      throw err;
    }

    const { sessionId } = await this.sessions.create(user.id, this.meta(req));
    await this.audit.record({ actorId: user.id, action: 'auth.register', resource: 'User', resourceId: user.id });
    return { userId: user.id, sessionId };
  }

  async login(dto: LoginDto, req: Request): Promise<{ userId: string; sessionId: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // 恒定时间：即使用户不存在也执行一次哈希校验，避免计时侧信道
    const ok = user?.passwordHash
      ? await this.passwords.verify(user.passwordHash, dto.password)
      : await this.passwords.verify(DUMMY_PASSWORD_HASH, dto.password);
    if (!user || !ok) {
      // metadata 刻意**不含**邮箱：失败审计的用途是「谁在什么时候试过」，而邮箱是 PII，
      // 在撞库场景下它本身就是攻击者的输入。
      //
      // **不要**在这里写「日志里能看到被掩码的邮箱」（修复轮 2 更正上一版的错误说法）：
      // pino 的 `req` 序列化器只输出 `{method,url}`，`redact.ts` 的 `maskEmail`/`redact`
      // **当前没有任何调用方**，因此登录失败的邮箱在**任何地方都不存在**——
      // 不是在日志里被掩码了，而是压根没记。这是 C11 下的正确取舍：关联一次失败尝试
      // 用的是 `traceId`（审计行与同一请求的日志行都带它），不需要把 PII 复制一份。
      // 若将来真的需要按邮箱做关联分析，正确动作是显式 `maskEmail(dto.email)` 放进
      // `metadata`（掩码后才落库），而不是想当然地认为它已经在日志里。
      await this.audit.record({ action: 'auth.login_failed', resource: 'User' });
      throw new UnauthorizedException('邮箱或密码不正确');
    }
    const { sessionId } = await this.sessions.create(user.id, this.meta(req));
    await this.audit.record({ actorId: user.id, action: 'auth.login', resource: 'User', resourceId: user.id });
    return { userId: user.id, sessionId };
  }

  /**
   * 登出。**刻意不因为「认证已久」而拒绝**——这是**已裁定的接受风险**（R2），不是待办。
   *
   * 会话的 `authAt` 超过 15 分钟时，`requireRecentAuth` 为假，这里**仍然**销毁会话
   * 并清 cookie，但把「认证已久」写进审计（`metadata.recentAuth`）。
   *
   * 为什么不拒绝：登出的唯一作用是**结束**会话。拒绝一个 16 分钟前登录的用户登出，
   * 会把他留在一个他自己也关不掉的活动会话里——那是**伪装成管控的安全倒退**，
   * 且用户侧没有任何补救手段（除了等 cookie 过期或手动清 cookie）。
   * C13 的 15 分钟窗口针对的是**授予访问**或**销毁数据**的操作（改密、改邮箱、删号，
   * 见 `SessionService.requireRecentAuth`，后续任务使用），不是**降低暴露面**的操作。
   *
   * **复访触发条件：** 若将来出现「登出本身会造成状态损失」的设计（例如登出即轮换
   * 全设备密钥、或登出会写不可逆的离线状态），这条取舍需要重新裁定。
   */
  async logout(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const session = await this.sessions.verify(sessionId);
    const recent = await this.sessions.requireRecentAuth(sessionId, RECENT_AUTH_WINDOW_MS);
    await this.sessions.destroy(sessionId);
    // `resourceId` 传**用户**而不是 `sessionId`（修复轮 2 修复）：会话 id 是完整的
    // bearer 凭证，而 `audit_log` 是 append-only、UPDATE/DELETE 被撤销的表——
    // 写进去就**永久留档**（C11）。会话此刻已被销毁，因此不存在「活的凭证被读走」，
    // 但「一条再也删不掉的凭证记录」本身就是 C11 禁止的持久化，而且
    // 把令牌从 `metadata` 挪到 `resourceId` 只是换了字段，暴露面一模一样。
    // 归属人由 `actorId` 承载（此处取自 verify 的结果，会话已销毁后仍可归因）。
    await this.audit.record({
      actorId: session?.userId ?? null,
      action: 'auth.logout',
      resource: 'Session',
      resourceId: session?.userId ?? null,
      metadata: { recentAuth: recent },
    });
  }

  async me(sessionId: string | undefined) {
    const s = sessionId ? await this.sessions.verify(sessionId) : null;
    if (!s) throw new UnauthorizedException('未登录');
    const user = await this.prisma.user.findUnique({
      where: { id: s.userId },
      select: { id: true, email: true, role: true, creditScore: true },
    });
    // 会话有效但用户已不存在（账号被删、或数据被清理）。**必须抛 401，不能返回 undefined**：
    // Nest 在处理器返回 `undefined` 时会回 `200` + **空响应体**——调用方拿到的是
    // 「成功但没有内容」，而不是「你的会话已失效」。两者的客户端行为完全不同
    // （前者会渲染一个空白页面并继续认为自己已登录），而这里正是唯一能区分的地方。
    // 它同时是「会话是指向用户的引用，不是用户本身」这条事实的落点：
    // 服务端会话能被即时撤销（删 Redis 键），但用户记录也可能先于会话消失。
    if (!user) throw new UnauthorizedException('未登录');
    return user;
  }
}
