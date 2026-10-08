import type { Client } from 'pg';

/**
 * 等到**服务端**真的有一条语句卡在锁上（`wait_event_type = 'Lock'`）且它的文本匹配 `pattern`，
 * 返回那一句的原文。
 *
 * ## 为什么是本仓库的既定形状，而不是 `sleep`
 *
 * 这个函数的技术来自 P3 / Task 4 的 `tests/integration/ledger/account-lock-order.test.ts`
 * （那里第一版用的是 `sleep 150`，在 `pnpm test` 的满载下红过一次：竞争者自己成了死锁
 * 牺牲者、测试文件耗时 57 s）。根因是那句 sleep **量错了对象**——事件循环拥塞时
 * 「先发起」与「服务端先开始等待」不是同一件事。
 * ⇒ 判据改成**服务端的事实**：`pg_stat_activity` 里那条等待真的出现了，才继续往下走。
 * 于是「谁先开始等待」由构造保证，而不是由机器有多忙决定。
 *
 * ## 超时**抛错**（而不是返回一个可以让用例继续的值）
 *
 * 等不到锁说明**构造没成立**（时序前提不满足），不是断言失败。继续跑只会得到一条
 * 指向错误原因的红灯 —— 因此这里响亮地抛，并把**此刻实际**在等的语句原样带出来：
 * 「构造失败」四个字若没有证据，下一个人只能自己重跑一遍才知道那一笔卡在哪一句上。
 *
 * ## 为什么观察者要用**同一个角色**的连接
 *
 * `pg_stat_activity` 的 `query` 与 `wait_event_type` 只对**本会话属主**可见；
 * 观察者与 Prisma 都用 `app_user` 才看得见，否则读到的是 NULL 而已
 * （Task 4 的注释逐字，本文件照抄这条纪律）。
 */
export async function waitForBlockedStatement(
  client: Client,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await client.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    const hit = r.rows.map((row) => row.query).filter((sql) => pattern.test(sql));
    if (hit.length > 0) return hit[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const all = await client.query<{ query: string; wait_event_type: string | null }>(
    `SELECT query, wait_event_type FROM pg_stat_activity WHERE datname = current_database()`,
  );
  const waiting = all.rows.filter((r) => r.wait_event_type === 'Lock').map((r) => r.query);
  throw new Error(
    `${String(timeoutMs)} ms 内没有观察到匹配 ${String(pattern)} 的等锁语句 —— ` +
      '这条用例的时序前提不成立（构造失败，不是断言失败）。' +
      `此刻**实际**在等锁的语句：${JSON.stringify(waiting)}`,
  );
}

/** 一条等锁环的读数（`pg_blocking_pids` 给的服务端事实）。 */
export interface BlockingCycle {
  /** 两条互相阻塞的连接的 pid。 */
  readonly pids: readonly [number, number];
  /** 它们各自的语句（截断，供断言与失败信息用）。 */
  readonly queries: readonly [string, string];
}

/**
 * 等到**两条连接互相阻塞**（= 死锁环真的形成了），返回它们的 pid 与语句。
 *
 * ## 为什么这是「环形成了」的**可执行**判据，而不是推断
 * `pg_blocking_pids(pid)` 是 PostgreSQL 自己给出的「谁挡着我」——
 * 两边互为对方的 blocker，就是一个货真价实的环（不是「大概交错到了」）。
 * 用它当构造见证，比「命令红了 ⇒ 大概是死锁」强一层：**没有环就没有这一条**。
 *
 * 与 `waitForBlockedStatement` 同一纪律：超时**抛错**（构造失败，不是断言失败），
 * 并把此刻的等待图原样打出来。轮询间隔 25 ms，而 `deadlock_timeout` 是 1 s ——
 * 因此环在被 PostgreSQL 打破之前有充足的机会被看见。
 */
export async function waitForBlockingCycle(
  client: Client,
  patternA: RegExp,
  patternB: RegExp,
  timeoutMs = 5_000,
): Promise<BlockingCycle> {
  const deadline = Date.now() + timeoutMs;
  let last: Array<{ pid: number; blockers: number[]; q: string }> = [];
  while (Date.now() < deadline) {
    const r = await client.query<{ pid: number; blockers: number[]; q: string }>(
      `SELECT pid, pg_blocking_pids(pid) AS blockers,
              left(regexp_replace(query, '\\s+', ' ', 'g'), 120) AS q
         FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    last = r.rows;
    const a = r.rows.find((row) => patternA.test(row.q));
    const b = r.rows.find((row) => patternB.test(row.q));
    if (a !== undefined && b !== undefined && a.blockers.includes(b.pid) && b.blockers.includes(a.pid)) {
      return { pids: [a.pid, b.pid], queries: [a.q, b.q] };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `${String(timeoutMs)} ms 内没有观察到两条连接**互相**阻塞（` +
      `A=${String(patternA)} B=${String(patternB)}）—— 这条用例的时序前提不成立（构造失败，不是断言失败）。` +
      `此刻的等待图：${JSON.stringify(last)}`,
  );
}
