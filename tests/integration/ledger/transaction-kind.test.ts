import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { uuidv7 } from '@vca/shared';
import { AuditService } from '@vca/api/modules/audit/audit.service.js';
import { AdminDirectory } from '@vca/api/modules/auth/admin-directory.service.js';
import { PrismaService } from '@vca/api/db/prisma.service.js';
import { LedgerService } from '@vca/api/modules/ledger/ledger.service.js';
import { ledgerErrorToHttp } from '@vca/api/modules/ledger/ledger-error-map.js';
import { TRANSACTION_KINDS, type TransactionKind } from '@vca/api/modules/ledger/core/types.js';
import { IdempotencyKeyReusedError, UnknownTransactionKindError } from '@vca/api/modules/ledger/core/errors.js';
import { ACCOUNT_KINDS } from '@vca/api/modules/ledger/core/account-kind.js';
import { startPostgres, type TestPg } from '../../helpers/db.js';

/**
 * 交易 `kind` 的执行者：**真服务路径**上的两档（P3 / Task 4；D5 / 控制器裁定 ⑦）。
 *
 * ## 这个文件补的是单元用例补不上的那一半
 * `tests/unit/ledger/transaction-kind.test.ts` 判的是**那个函数**（纯、无 I/O）。
 * 而预检 §D.1 的 `[E3]` 说的是**服务路径**上的事实：
 * ```
 * [E3] 用一个 §8.2 之外的 kind 过账 ⇒ 成功（没有任何东西拦住它）
 * [E3] 库里 kind = NOT_A_KIND 的行数 = 1
 * ```
 * 那个「成功」走的正是 `LedgerService.postLegs`。因此这里的三件事只能在真库上判：
 *   1. **拒绝面**：非法 kind 经真实服务被拒、库里**不留行**、且 HTTP 翻译表给出 422；
 *   2. **顺序**（判别性）：同键 + 同腿 + 非法 kind ⇒ 报的是 **kind**，不是 409 幂等冲突
 *      ——证明执行者在幂等判定**之前**（把那一行挪到 `findUnique` 之后，这条就红）；
 *   3. **验收面**：§8.2 的六个 kind 在**同一条路径**上照旧可用（少了它，一个「什么都拒」
 *      的实现也能让前两条变绿）。
 *
 * 三条用例都用**手工构造的腿**（`postLegs` 那扇门）：`kind` 在 HTTP 边界上根本不存在
 * （六个原语各自硬编码自己的 kind），因此「传错 kind」只可能是**我们自己的代码**干的——
 * 而这条路径正是那件事唯一能发生的形状。
 */
const available = (userId: string) => ({ kind: ACCOUNT_KINDS.USER_AVAILABLE, ownerUserId: userId }) as const;
const frozen = (userId: string) => ({ kind: ACCOUNT_KINDS.USER_FROZEN, ownerUserId: userId }) as const;
const topupRef = { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null } as const;

let pg: TestPg;
let prisma: PrismaService;
let ledger: LedgerService;

beforeAll(async () => {
  pg = await startPostgres();
  prisma = new PrismaService(pg.appUri);
  await prisma.$connect();
  ledger = new LedgerService(prisma, new AuditService(prisma), new AdminDirectory(prisma));
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => undefined);
  await pg?.stop();
});

/**
 * 建出一个用户的两个账户 + 系统注入端，并返回 `postLegs` 需要的三个账户 id。
 * 一条 100 分的充值 + 一次 1 分的冻结/解冻往返（后者只为把 `USER_FROZEN` 那一行建出来）。
 */
async function seededAccounts(userId: string) {
  await prisma.$transaction((tx) =>
    ledger.post(tx, {
      kind: TRANSACTION_KINDS.TOPUP,
      idempotencyKey: `kind-seed:${userId}`,
      moves: [{ from: topupRef, to: available(userId), amount: 100n }],
    }),
  );
  await prisma.$transaction((tx) =>
    ledger.post(tx, {
      kind: TRANSACTION_KINDS.FREEZE,
      idempotencyKey: `kind-seed-freeze:${userId}`,
      moves: [{ from: available(userId), to: frozen(userId), amount: 1n }],
    }),
  );
  const rows = await prisma.ledgerAccount.findMany({
    where: { OR: [{ ownerUserId: userId }, { kind: ACCOUNT_KINDS.EXTERNAL_TOPUP, ownerUserId: null }] },
    select: { id: true, kind: true },
  });
  const idOf = (kind: string): string => {
    const row = rows.find((r) => r.kind === kind);
    if (!row) throw new Error(`构造失败：账户 ${kind} 不存在（这一步的时序前提不成立）`);
    return row.id;
  };
  return { available: idOf(ACCOUNT_KINDS.USER_AVAILABLE), topup: idOf(ACCOUNT_KINDS.EXTERNAL_TOPUP) };
}

/** 一条平衡的腿集：借系统注入端（天然为负）1 分、贷用户可用 1 分。 */
function balancedLegs(ids: { available: string; topup: string }, amount = 1n) {
  return [
    { accountId: ids.topup, amount: -amount },
    { accountId: ids.available, amount },
  ];
}

describe('交易 kind 的执行者（真库 + 真服务；D5 / 控制器裁定 ⑦）', () => {
  it('★ 非法 kind 经**真实服务路径**被拒：`UnknownTransactionKindError`，库里不留行，HTTP 是 422', async () => {
    const userId = uuidv7();
    const ids = await seededAccounts(userId);
    const key = `kind-bad:${uuidv7()}`;

    // 通过**类型断言**构造「我们的代码传错了一个值」——这正是那个执行者要挡的形状
    // （`kind` 不是 HTTP 入参，因此不会有调用方能从边界上把它塞进来）。
    const error = await prisma
      .$transaction((tx) =>
        ledger.postLegs(tx, {
          kind: 'NOT_A_KIND' as TransactionKind,
          idempotencyKey: key,
          legs: balancedLegs(ids),
        }),
      )
      .then(() => null, (e: unknown) => e);

    expect(
      error,
      '★ 这一条就是预检 [E3] 的复现：没有执行者时这次过账会**成功**（库里多一行 kind = NOT_A_KIND）。',
    ).toBeInstanceOf(UnknownTransactionKindError);

    // 拒绝面三条独立判据（同一查询形状的**接受对侧**在下面那条「六个 kind」用例里）：
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(
      await prisma.ledgerTransaction.count({ where: { kind: 'NOT_A_KIND' } }),
      '非法 kind 的那一行**不能**落库（预检实测：修之前库里 kind = NOT_A_KIND 的行数 = 1）。',
    ).toBe(0);

    // HTTP 那一档：同一条链路的末端（`ledgerErrorToHttp` 是唯一出口）。
    const mapped = ledgerErrorToHttp(error);
    expect(mapped, '这一档没有被翻译（返回 null ⇒ 500，责任方就分不开了）').toBeInstanceOf(HttpException);
    expect(mapped?.getStatus()).toBe(422);
    const body = mapped?.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('LEDGER_UNKNOWN_TRANSACTION_KIND');
    expect(Object.keys(body), `响应体里混进了别的字段：${JSON.stringify(body)}`).toEqual(['code']);
  }, 120_000);

  it('★ 顺序（判别性）：同键 + **同腿** + 非法 kind ⇒ 报 kind，**不是** 409 幂等冲突', async () => {
    // 为什么需要这一条：上面那条与下面那条都分不开「执行者在幂等判定之前还是之后」——
    // 把 `assertTransactionKind` 挪到 `findUnique` **之后**，它们照样绿（那时键还不存在 /
    // 或腿本来就没冲突）。唯一能分开两处的观测量是**顺序**，而这里让幂等键**真的存在**且
    // 腿**逐条相同**：有那个执行者 ⇒ 报 kind（结构错误先报）；挪到后面 ⇒ 走到幂等判定，
    // 同键同腿同……kind 不同 ⇒ `IdempotencyKeyReusedError`。
    // 这条顺序不是任意的：一笔 kind 就是错的请求不该被当成「一次重放 / 冲突」来回答。
    const userId = uuidv7();
    const ids = await seededAccounts(userId);
    const key = `kind-order:${uuidv7()}`;
    const legs = balancedLegs(ids, 2n);

    const first = await prisma.$transaction((tx) =>
      ledger.postLegs(tx, { kind: TRANSACTION_KINDS.TOPUP, idempotencyKey: key, legs }),
    );
    expect(first.created).toBe(true);

    const error = await prisma
      .$transaction((tx) =>
        ledger.postLegs(tx, { kind: 'NOT_A_KIND' as TransactionKind, idempotencyKey: key, legs }),
      )
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownTransactionKindError);
    expect(error, '被当成了幂等冲突 ⇒ 执行者在幂等判定之后（顺序错了）').not.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );

    // 库里那一笔一字未动（不是「报错但写坏了」），且**接受对侧**在同一条路径上成立：
    // 同键 + 同腿 + **合法** kind ⇒ 真的重放（created:false、同一个 transactionId）。
    // 没有这一句，上面那个「被拒」也可能只是「这个键怎么都拒」。
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    const replay = await prisma.$transaction((tx) =>
      ledger.postLegs(tx, { kind: TRANSACTION_KINDS.TOPUP, idempotencyKey: key, legs }),
    );
    expect(replay).toEqual({ transactionId: first.transactionId, created: false });
  }, 120_000);

  it('验收面：§8.2 的六个 kind 在**同一条服务路径**上照旧可用（每个都真的落账）', async () => {
    const userId = uuidv7();
    const ids = await seededAccounts(userId);
    const created: string[] = [];
    for (const kind of Object.values(TRANSACTION_KINDS)) {
      const result = await prisma.$transaction((tx) =>
        ledger.postLegs(tx, {
          kind,
          idempotencyKey: `kind-ok:${kind}:${uuidv7()}`,
          legs: balancedLegs(ids),
        }),
      );
      expect(result.created, `${kind} 被误拒了`).toBe(true);
      created.push(kind);
    }
    // 六个都真的过了一遍（不是「一个也没跑」）：
    expect(created).toEqual(Object.values(TRANSACTION_KINDS));
    expect(await prisma.ledgerTransaction.count({ where: { kind: { in: [...created] } } })).toBeGreaterThanOrEqual(6);
  }, 120_000);
});
