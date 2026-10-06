/**
 * 死锁 / 写冲突的**唯一**判别式与有界重试（P3 / Task 4；C36 / 控制器裁定 ⑧）。
 *
 * ## ★ 两档都要认（预检 §0.4 的实测，逐字）
 * ```
 * [B4]  S1 = {"code":"P2034", … "metaOrigin":"40P01","metaKind":"TransactionWriteConflict"}   ← Prisma 委托（entries.createMany）
 * [B2′] S1 = {"code":"P2010", … "metaOrigin":"40P01"}                                          ← $queryRaw（ownership 的 FOR UPDATE）
 * ```
 * 「**错误码随语句类型变**：经 `$queryRaw` 是 **P2010**，经 Prisma 委托（`createMany`）是
 * **P2034**。两个都带 `cause.originalCode = '40P01'`。⇒ P3 的『可重试』判别式**必须同时认
 * 这两档**，只看 P2034 会漏掉 `$queryRaw` 那条（`ownership.service.ts` 的 `FOR UPDATE`
 * 就是 `$queryRaw`）。」
 * **这条判据的失效方向是「永远不重试」**：漏掉一档时不会有人报错——调用方只是拿到一个
 * 原始的死锁错误，而重试路径一次都没被走到。因此两档各有一次**真死锁**见证
 * （`tests/integration/ledger/account-lock-order.test.ts`：$queryRaw 一档、Prisma 委托一档）。
 *
 * ## 判别式的形状：code 白名单，**不**要求 `originalCode` 在场
 * 两档的 `code` 本身就是「可重试」的信号（P2034 = `TransactionWriteConflict`，
 * P2010 = raw query failed）。`40P01` 是它的**原因**，但 Prisma 到 `@prisma/adapter-pg`
 * 的那条路径上它出现在 `meta.driverAdapterError.cause.originalCode`，
 * **不保证每一档都在场**（P2010 的 `meta` 与 P2034 的 `meta` 形状不同）。
 * 把 `originalCode` 也要求上会让判别式在某个驱动版本上静默变成「永不重试」——
 * 而那正是本文件要防的方向。因此：**按 code 判，fail-closed 到「不重试」只在 code 未知时**。
 *
 * **代价据实记载**（`tests/unit/db/retryable-conflict.test.ts` 有一条用例把它钉住）：
 * `P2010` 是「raw query 失败」**一整类**，因此一条**永久性**的 raw 失败（42P01 表不存在、
 * 42601 语法错）同样会被判为可重试。上界是 `maxAttempts`（只多跑两次），且用尽之后抛出的
 * 是**原错误**（调用方看到的仍是 42P01，不会被伪装成「争用」）。
 *
 * ## 它为什么在 `common/db/` 而不是 `ledger/`
 * 它的第二个调用方是 `exchange`（Task 8 的原子释放会撞上 `ownership` 的 P2010 与账本的
 * P2034）。放在 `ledger` 里会让 `exchange → ledger` 多一条**为了一个纯函数**的依赖，
 * 而它是基础设施层的事实（PostgreSQL 的 SQLSTATE 与 Prisma 的 code），不是账本的知识。
 *
 * ## 依赖自检
 * 零 import、零 I/O、零 Nest、零 Prisma 类型：它判的是**一个对象上的一个字段**。
 */
export function isRetryableConflictError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2034' || code === 'P2010';
}

/** 有界重试的默认次数（含首次）。3 次实测收敛（预检 `[B5]`：第 1 轮失败、重试成功）。 */
export const DEFAULT_MAX_CONFLICT_ATTEMPTS = 3;

/**
 * 有界重试。**不退避**，理由：死锁的受害者在 `deadlock_timeout`（本机 1 s）之后**已经被
 * PostgreSQL 中止**，此时立即重试不会撞上同一个环——那个环已经被打破（预检 `[B5]` 实测：
 * 第 1 轮失败、判为可重试、重试成功）。加退避只会让一次请求多挂 100–500 ms。
 *
 * **幂等是调用方的责任**：本函数只负责「再试一次」，而重试的请求必须是**同一个幂等键**
 * ——否则第二次会真的再付一次，而预检 §0.3 证明了没有人看得见。
 *
 * ## 为什么用尽之后抛的是**原错误**（不包装）
 * 它的 `code` 与 `meta` 是排障的全部线索；包一层会让 `ledgerErrorToHttp` 的判别式与日志里的
 * code 一起失效（与「翻译表不许把陌生错误伪装成已知错误」是同一条纪律）。
 *
 * ## `maxAttempts` 的下界被夹到 1（据实记载：计划没写这一步）
 * `maxAttempts` 是调用方给的数，而循环体一次都不进时 `lastError` 仍是 `undefined`——
 * `throw lastError` 会抛出一个连栈都没有的值。夹到 1 不是宽容，而是保住本函数对调用方的
 * 唯一承诺：**抛出来的永远是它给的那个错误**（见证：单测里 `maxAttempts: 0 / -1` 那一条）。
 */
export async function withBoundedConflictRetry<T>(
  fn: () => Promise<T>,
  options: { readonly maxAttempts?: number; readonly onRetry?: (attempt: number, error: unknown) => void } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_CONFLICT_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      // **不可重试 ⇒ 原样抛出，且不再试**：判别式是 fail-closed 的（未知 code ⇒ false）。
      if (!isRetryableConflictError(error)) throw error;
      lastError = error;
      options.onRetry?.(attempt, error);
    }
  }
  // 次数用尽 ⇒ 把**最后一次**的原错误抛出（不包装）：它的 `code` 与 `meta` 是排障的全部线索，
  // 包一层会让 `ledgerErrorToHttp` 的判别式与日志里的 code 一起失效。
  throw lastError;
}
