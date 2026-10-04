import { randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUIDv7：48 位毫秒时间戳 + 版本/变体 + 随机位。
 *
 * 主键用 v7 是为了同时拿到两个性质（C4）：
 * - **不可猜**：剩余位来自 CSPRNG，猜不到「下一个 id」（v4 也有，但 v4 无序）；
 * - **时间有序**：字典序 = 生成顺序，B-tree 索引因此是追加写而非随机写。
 *
 * ## 为什么需要模块级状态（`lastMs` / `seq`）
 *
 * 只用 `Date.now()` 无法保证同一毫秒内的顺序，也无法保证唯一：两次调用时间戳相同、
 * 随机位又有碰撞概率。故把时间戳之后的 12 位（`rand_a`）让给单调计数器。
 *
 * ## 计数器回绕必须「借未来的毫秒」，不能模回绕（Ruling 1）
 *
 * 12 位计数器在一个毫秒内最多容纳 4096 个 id。写满之后若把 `seq` 简单模回 0：
 * - 第 4097 个 id 的 `(时间戳, 计数器)` 与第 1 个**相同**，只剩随机位兜底 ⇒ 唯一性不再是
 *   结构性的，而是概率性的；
 * - 且它的字典序**小于**前一个 id ⇒ 时间序性质被破坏，而时间序正是整个方案存在的理由。
 *
 * 标准做法（ULID monotonic factory 同款）：回绕时把**虚拟毫秒**加一，`seq` 归零。
 * 于是 `(lastMs, seq)` 每次调用都严格字典序递增，「唯一」由该前缀直接保证，与随机位无关。
 * 代价：持续超过 4096 个/毫秒的写入会让 `lastMs` 领先真实时钟；真实时钟追上来之前，
 * id 的时间戳会略微超前。这是该方案的固有取舍，也是它能同时满足唯一 + 单调的原因。
 *
 * ## 时钟回拨
 *
 * `now <= lastMs` 的分支同时覆盖「同一毫秒」与「时钟被 NTP 回拨」：两者都走 `lastMs`，
 * 绝不产生比已发出 id 更小的 id。
 */
const MAX_SEQ = 0xfff; // 12 位计数器上限

let lastMs = -1;
let seq = 0;

export function uuidv7(): string {
  const now = Date.now();

  if (now > lastMs) {
    lastMs = now;
    seq = 0;
  } else {
    seq += 1;
    if (seq > MAX_SEQ) {
      // 计数器写满：借下一个毫秒，而不是模回 0（见文件头注释）
      lastMs += 1;
      seq = 0;
    }
  }

  const bytes = randomBytes(16);
  const ts = lastMs; // 注意用 lastMs：回绕时它已被推进，now 仍是真实时钟

  // 48 位时间戳（big-endian）。`& 0xff` 会先 ToInt32 截断，故分数部分自动丢弃；
  // 1.7e12 毫秒在 2^48 之内，六个字节足够表达。
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  // rand_a 的 12 位（byte6 低半字节 + byte7）换成计数器高/低位
  bytes[6] = (bytes[6]! & 0xf0) | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  // version = 7（byte6 高半字节）
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant = 10xx（byte8 高两位）
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
