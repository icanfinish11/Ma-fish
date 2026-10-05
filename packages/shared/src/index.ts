/** 唯一允许跨端共享的东西：DTO 与类型。禁止放业务逻辑。 */

export const ROLES = {
  USER: 'USER',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

/** 金额单位「分」，永不使用浮点（Global Constraints C3）。 */
export type Cents = bigint;

/** MVP 单一币种，字段预留以便未来扩展（§5.3）。 */
export type Currency = 'CNY';

/**
 * 主键生成（C4）。放在本包**不违反**上面「禁止放业务逻辑」的约束：
 * 它是与领域无关的标识符原语，而非业务规则；服务端与将来的 worker 都必须
 * 产出**同一种** id，各写一份实现才是真正的问题。
 *
 * ## ⚠️ 约束：这个导出**只能在 Node 侧** import（最终评审的 Minor 记录，不是缺陷）
 *
 * `ids.ts` 用的是 `node:crypto` 的 `randomBytes`，而它是从**本入口文件**再导出的：
 * 于是 P1 的前端只要 `import { ROLES } from '@vca/shared'`（这类 DTO/类型正是它**该**用的
 * 东西），打包器就会顺着这张图去解析 `node:crypto`——在没有 node 内建 polyfill 的浏览器
 * 构建里，结果是构建期解析失败或运行期抛错（具体形态取决于打包器与它的 polyfill 策略；
 * **据实说明：这里没有实测**，因为 P0 还没有任何浏览器产物）。报错位置会指向本入口，
 * 而根因在 `ids.ts`——那正是「留给下一阶段的陷阱」。
 * P1 的前端一旦 `import { ROLES } from '@vca/shared'`（这类 DTO/类型是它**该**用的东西），
 * 就会连带把 `ids.ts` 拉进图里而构建失败——一个留给下一阶段的陷阱。
 *
 * 现在的处置是**记录**而不是拆分：P0 里没有任何浏览器产物（C16：不建投机性抽象），
 * 而拆分的形状取决于 P1 真实的前端需求（子路径导出 `@vca/shared/ids`？还是把 `uuidv7`
 * 挪进服务端包？）。**P1 建前端时**必须在二者中选一个，且判据是「前端 import 本包不能
 * 引入 `node:crypto`」。在那之前，本注释就是这条约束的唯一登记处。
 */
export { uuidv7 } from './ids.js';
