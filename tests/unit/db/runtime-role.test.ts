import { describe, it, expect } from 'vitest';
import {
  assertRuntimeDbRole,
  RuntimeDbRoleError,
  type RoleQueryRunner,
} from '@vca/api/db/runtime-role.js';

/**
 * `assertRuntimeDbRole` 的**分支**级验证（最终评审 C-2）。
 *
 * 真库上的判别（app_user 通过 / vca_owner 被拒）由
 * `tests/integration/db/runtime-role.test.ts` 承担；「引导期真的会调用它」由
 * `tests/unit/bootstrap.test.ts` 承担。这里补的是那两处都覆盖不到的**边界分支**——
 * 它们的共同点是「不连库也要有确定结论」，因此用最小替身即可：
 *
 * 1. **审计表还不存在**（迁移还没跑）⇒ `unverifiable` 而不是拒绝启动；
 * 2. **查询超时**（连接被黑洞；`pg` 默认没有连接超时）⇒ 同样 `unverifiable`，
 *    但必须有界——否则一个黑洞地址会把启动永远卡住；
 * 3. **查询返回意外形状** ⇒ **硬失败**（这时连「连上了谁」都不知道，不能猜成合格）；
 * 4. 上报口（生产里是 pino）自己抛错时，**不改变引导方向**。
 */
function clientReturning(rows: unknown): RoleQueryRunner {
  return { $queryRaw: (() => Promise.resolve(rows)) as RoleQueryRunner['$queryRaw'] };
}

const BASE_ROW = {
  role: 'app_user',
  role_is_superuser: false,
  role_bypasses_rls: false,
  audit_table_missing: false,
  can_update_audit: false,
  can_delete_audit: false,
  audit_table_owner: 'vca_owner',
};

describe('运行期数据库角色检查的分支（C-2，不连库）', () => {
  it('审计表不存在时退化为 unverifiable（迁移还没跑不该让应用起不来），但留下上报', async () => {
    const reported: string[] = [];
    const verdict = await assertRuntimeDbRole(
      clientReturning([{ ...BASE_ROW, audit_table_missing: true, can_update_audit: null, can_delete_audit: null }]),
      { onUnverifiable: (_fields, message) => reported.push(message) },
    );

    expect(verdict.status).toBe('unverifiable');
    expect(reported, '「检查没能完成」没有留下任何记录：降级是静默的').toHaveLength(1);
    expect(reported[0]).toContain('audit.audit_logs');
  });

  it('查询超时退化为 unverifiable，且**有界**（不会把启动永远卡住）', async () => {
    const reported: string[] = [];
    // 一个永不 resolve 的替身：正是「连接被黑洞」在客户端侧的形态。
    const neverResolves: RoleQueryRunner = { $queryRaw: (() => new Promise(() => undefined)) as RoleQueryRunner['$queryRaw'] };

    const startedAt = performance.now();
    const verdict = await assertRuntimeDbRole(neverResolves, {
      timeoutMs: 20,
      onUnverifiable: (_fields, message) => reported.push(message),
    });
    const elapsed = performance.now() - startedAt;

    expect(verdict.status).toBe('unverifiable');
    expect(reported[0], '超时的原因没有被写出来').toContain('超时');
    expect(elapsed, '超时上限没有生效：引导会被一个黑洞连接卡住').toBeLessThan(2_000);
  });

  it('返回形状不对时**硬失败**（连「连上了谁」都不知道，不能猜成合格）', async () => {
    await expect(assertRuntimeDbRole(clientReturning([]))).rejects.toBeInstanceOf(RuntimeDbRoleError);
    await expect(assertRuntimeDbRole(clientReturning([{ nope: 1 }]))).rejects.toBeInstanceOf(RuntimeDbRoleError);
  });

  it('上报口自己抛错时不影响结论（记录失败不能变成引导失败）', async () => {
    const verdict = await assertRuntimeDbRole(
      clientReturning([{ ...BASE_ROW, audit_table_missing: true }]),
      {
        onUnverifiable: () => {
          throw new Error('日志器还没装好');
        },
      },
    );

    expect(verdict.status).toBe('unverifiable');
  });

  it('特权角色即使表不存在也拒绝（superuser 能让将来的表级权限失去意义）', async () => {
    await expect(
      assertRuntimeDbRole(clientReturning([{ ...BASE_ROW, role_is_superuser: true, audit_table_missing: true }])),
    ).rejects.toBeInstanceOf(RuntimeDbRoleError);
  });
});
