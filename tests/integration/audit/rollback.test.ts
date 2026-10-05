import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 审计与业务写入的**原子性**（P2 / Task 2；P0 把这条留给 P2 的原文见
 * `audit.service.ts` 的「持久修法在 P2」一段；预检 C.16 实测了机制）。
 *
 * 两条用例必须**成对**存在：只写第一条时，「怎么都不写审计」的实现也能骗过它；
 * 只写第二条时，无法区分「同事务」与「事务外但恰好没写」。两条各钉住一个方向。
 */
const ROLLBACK_ACTION = 'probe.audit_rollback';
const COMMIT_ACTION = 'probe.audit_commit';

describe('审计与业务同生共死（P2 前置 A）', () => {
  let pg: TestPg;
  let prisma: PrismaService;
  let audit: AuditService;

  beforeAll(async () => {
    pg = await startPostgres();
    prisma = new PrismaService(pg.appUri);
    await prisma.$connect();
    audit = new AuditService(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    await pg?.stop();
  });

  it('传了 tx：业务回滚后审计行是 0 行（预检 C.16 实测：事务外写时是 1 行）', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.record({ actorId: null, action: ROLLBACK_ACTION, resource: 'Probe' }, tx);
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');

    expect(
      await prisma.auditLog.count({ where: { action: ROLLBACK_ACTION } }),
      '账本回滚了、审计行却留下了：审计轨迹在撒谎（这正是 P0 留给 P2 修的那条）',
    ).toBe(0);
  });

  it('对照（不传 tx）：审计行独立提交并留下 1 行 —— 记录这条取舍本身', async () => {
    await expect(
      prisma.$transaction(async () => {
        await audit.record({ actorId: null, action: COMMIT_ACTION, resource: 'Probe' });
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');

    // 这条不是「期望的行为」，而是**被记录下来的事实**：不传 tx 时审计与业务不同生共死。
    // 它的价值在于让下面那句话可验证——「账本路径必须传 tx」不是风格要求。
    expect(await prisma.auditLog.count({ where: { action: COMMIT_ACTION } })).toBe(1);
  });
});
