/**
 * **行锁的全局顺序**：一组 id 去重后按**字节**升序（P3 / Task 4；C35 / 控制器裁定 ⑧）。
 *
 * ## 这个判据为什么必须只有一份实现
 * 它有两个调用方，而它们住在**不同的模块**里：
 *   * `modules/exchange/core/lock-order.ts` 的 `lockOrder`（**资产行**；Task 3 交付，Task 7/8 施加）；
 *   * `modules/ledger/ledger.service.ts` 的 `lockAccountRows`（**账户行**；Task 4 施加）。
 * `ledger → exchange` 的 import 被 `no-cross-module-internals` 直接拒（跨模块只走 `index.ts`），
 * 而那份约束正是「模块可拆分」的本体 ⇒ 不做这次提取，唯一可行的写法就是**各排一次序**。
 * 两份「逐字相同」的实现在评审里看不出问题，而它们会在**第一次有人只改一边**时分开——
 * 而分开的后果只在真并发下现身（ABBA 死锁）。因此顺序判据被提到 `common/db/`：
 * 两个调用方 import **同一个函数**（`lockOrder` 是它的资产侧具名包装）。
 *
 * ## 为什么是字节序，而不是「数值序」或 locale 序
 * id 是 UUIDv7 的十六进制小写定长字符串。定长 ⇒ 字典序 = 字节序；而它们**同时**是时间有序的
 * （C4：UUIDv7 含时间序）⇒ 按它排序顺带让「先创建的行先被锁」，争用时的一致性更好
 * （不是正确性要求，只是让两类死锁在日志里更容易读）。
 * **绝不要**用 `localeCompare`（它受 locale 影响，而锁序必须是全进程一致的）。
 *
 * ## 「先取全部行锁、再动任何一行」
 * C35 的后半句是承重的：把这一组 id 排好序**之后**才允许开始取锁，而取的过程中
 * 不得插入任何别的写动作。`assertLockOrderHeld`（exchange 侧）是这条纪律在**资产**上的
 * 运行期判据；**账户**侧的判据是那条 `SELECT … ORDER BY id FOR UPDATE` 本身
 * （一条语句取完，见 `LedgerService.lockAccountRows`）。
 *
 * ## 它为什么在 `common/db/` 而不是某一边的 `core/`
 * 它是「行锁」这件事的基础设施事实（PostgreSQL 的行锁与 ABBA），不是交换的知识、也不是
 * 账本的知识。放在任何一边都会让另一边为了一个纯函数产生一条跨模块依赖。
 */
export function rowLockOrder(ids: readonly string[]): readonly string[] {
  // `new Set` 先去重：同一行在一次事务里被引用两次（例如两条腿落在同一个账户上）
  // 只该锁一次，否则 `assertLockOrderHeld([a], [a])` 之后还要再锁一次同样的行。
  // 比较写成三元而不是 `a.localeCompare(b)`：理由见文件头（唯一纪律落点是
  // `tests/unit/db/lock-order.test.ts` 里那条大小写混合的用例）。
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
