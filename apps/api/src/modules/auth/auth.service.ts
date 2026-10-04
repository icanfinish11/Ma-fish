import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../db/prisma.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { AuditService } from '../audit/audit.service.js';
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
 * 3. **审计不吞错**：`AuditService.record` 抛出即整个操作失败（理由见该服务注释）。
 *    需要留意的后果：审计库不可用时登录会 500——这是**刻意**的取舍，
 *    审计断了就没法追责，宁可不可用也不静默。
 *
 * ## 已知的**未收紧**之处（据实记录，未擅自改 brief）
 *
 * 注册路径的重复邮箱返回 409 `该邮箱无法注册`。这**确实是**一个账号枚举信号：
 * 攻击者可以用注册端点判定某个邮箱是否已注册（对比登录端点——那里已经做到恒定时间，
 * 但注册端点在时间上不可能恒定，因为它要么建用户要么不建）。
 *
 * 之所以没擅自改成「一律 202 + 异步发信」：那会改变对外契约（brief 与 Task 7 的
 * CSRF/限流测试都按 409 写），且真正的缓解手段是限流（Task 7 的 `RATE_LIMITS.register`
 * 为 3 次/小时/IP）而不是换个状态码。留着 409 的**代价**如实写在这里：
 * 单 IP 每小时仍可探测 3 个邮箱。若判定不可接受，正确的动作是改 Task 7 的限流表或
 * 引入「注册成功/已存在」的统一响应 + 邮件确认，而不是在本任务里悄悄加一条分支。
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
      // 不区分「邮箱已存在」与其它失败原因之外的细节，避免账号枚举
      throw new ConflictException('该邮箱无法注册');
    }
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash: await this.passwords.hash(dto.password) },
    });
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
      // metadata 刻意**不含**邮箱：失败审计的用途是「谁在什么时候试过」，
      // 而邮箱是 PII 且（在撞库场景下）本身就是攻击者输入。需要关联分析时，
      // 用 `traceId` 回到该请求的日志——那里邮箱已被 `redact` 掩码成 `a***@example.com`（C11）。
      await this.audit.record({ action: 'auth.login_failed', resource: 'User' });
      throw new UnauthorizedException('邮箱或密码不正确');
    }
    const { sessionId } = await this.sessions.create(user.id, this.meta(req));
    await this.audit.record({ actorId: user.id, action: 'auth.login', resource: 'User', resourceId: user.id });
    return { userId: user.id, sessionId };
  }

  /**
   * 登出。**刻意不因为「认证已久」而拒绝**（C13 的一处刻意取舍，见下）。
   *
   * 会话的 `authAt` 超过 15 分钟时，`requireRecentAuth` 为假，这里**仍然**销毁会话
   * 并清 cookie，但把「认证已久」写进审计。
   *
   * 为什么不拒绝：登出的唯一作用是**结束**会话。拒绝一个 16 分钟前登录的用户登出，
   * 会把他留在一个他自己也关不掉的活动会话里——比「允许关掉」危险得多，
   * 且用户侧没有任何补救手段（除了等 cookie 过期或手动清 cookie）。
   * C13 的「敏感操作要求最近 15 分钟内认证」针对的是**改密、改邮箱、删号**这类
   * 会改变账号状态的操作（后续任务），不是「结束本次会话」。
   */
  async logout(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const session = await this.sessions.verify(sessionId);
    const recent = await this.sessions.requireRecentAuth(sessionId, RECENT_AUTH_WINDOW_MS);
    await this.sessions.destroy(sessionId);
    await this.audit.record({
      actorId: session?.userId ?? null,
      action: 'auth.logout',
      resource: 'Session',
      resourceId: sessionId,
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
    return user;
  }
}
