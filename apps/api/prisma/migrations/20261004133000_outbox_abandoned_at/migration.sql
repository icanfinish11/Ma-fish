-- 修复轮 1 / Fix 1：outbox 事件的**放弃**终止标记。
--
-- 背景：消费者按 `attempts` 判定重试上限，到顶后把事件移出待处理集合（`processed_at` 非空）。
-- 但 `processed_at` 单独存在时区分不出「投递成功」与「试了 N 次后放弃」——运维会把一封
-- 其实没发出去的邮件读成已投递。故补一列显式的终止标记。
--
-- 时区表示沿用 C6 的全仓约定：`TIMESTAMPTZ(3)`（与同表其余时间列一致）。
-- 幂等：本列可空、无默认值，对既有行只是补 NULL（等价于「不是被放弃的」），
-- 因此不需要数据回填，也不改变任何既有查询的结果。
ALTER TABLE "notify"."outbox_events" ADD COLUMN "abandoned_at" TIMESTAMPTZ(3);
