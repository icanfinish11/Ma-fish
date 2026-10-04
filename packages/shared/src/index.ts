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
 */
export { uuidv7 } from './ids.js';
