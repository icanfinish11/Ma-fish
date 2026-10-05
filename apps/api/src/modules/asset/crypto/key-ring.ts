/**
 * 制品密钥环（P1 / Task 2，规格 D5 / C10）。
 *
 * 职责只有一件：**keyId → 32 字节密钥**，且任何取不到密钥的情况都**抛错**。
 *
 * ## 为什么「不回退到默认键」值得单独写一层
 *
 * 轮换的语义是「新增一个 keyId，让新写入用它」。一旦 `keyFor` 在找不到 keyId 时
 * 回退到活动键，轮换就会**静默失效**：新写入的制品头里写着 `v1`，实际却用 `v2` 的字节
 * 加密，而没有任何一层会报错——直到很久以后按 `v1` 去解密才发现解不开（那时数据已经
 * 积了一批）。这类「配置错了但一路绿灯」的形态在本项目里反复出现，因此这里是硬抛，
 * 而不是「回退 + 记一条 warn 日志」：日志没人看，制品的密钥错了却是永久的。
 *
 * 同一理由下，`createKeyRing` 在**构造期**就校验：主密钥必须存在、必须是 64 位 hex。
 * 引导期已经有一道（`env.schema.ts`），这里是第二道——本模块可以被非 NestJS 的调用方
 * 直接使用（探针、脚本、将来的 worker），不能假设别人替它校验过。
 *
 * ## 密钥材料的两条纪律
 *
 * 1. **不外泄到文本**：所有报错只带**变量名与 keyId**，绝不带密钥内容（C11）。
 *    keyId 不是密钥（它逐字写在每份制品头里），因此可以出现在报错里。
 * 2. **不外泄到调用方手里**：`keyFor` 返回的是**拷贝**。环是密钥字节的唯一持有者，
 *    否则任何一个拿到返回值并改写它的调用方都会让全进程后续加密用错字节。
 *
 * ## 已知边界：今天的环里只有一个键（据实记载，不是「已支持轮换」）
 *
 * `createKeyRing` 的入参（规格给的形状）是**单个** `ARTIFACT_MASTER_KEY` + `ACTIVE_KEY_ID`，
 * 因此环里恰好只有活动 keyId 这一个条目：它能表达「新写入用哪把钥匙」，
 * **还不能**表达「同时持有 v1 与 v2 以便读旧制品」。读取端要真正支持轮换，
 * 需要环境里能表达多个密钥（例如 `ARTIFACT_KEYS=v1:<hex>,v2:<hex>`），
 * 那是 D5 尚未落地的部分。这里**刻意不预先造那个形状**（C16：不建空抽象），
 * 只把这条路留成 seam：`KeyRing` 是接口，`createKeyRing` 只是它的一个实现。
 * 已记入 `task-2-report.md` 的 Concerns。
 */
export interface KeyRing {
  /** 当前**写入**使用的 keyId（它会逐字写进制品文件头）。 */
  activeKeyId(): string;
  /**
   * 取某个 keyId 的密钥（32 字节）。
   *
   * **未知 keyId ⇒ 抛错**，绝不回退到活动键或任何默认值。返回的是拷贝。
   */
  keyFor(keyId: string): Buffer;
}

/**
 * 主密钥的形状：64 位十六进制 ⇒ 32 字节（AES-256）。
 *
 * 刻意**不**再导出一个 `KEY_BYTES = 32` 常量：唯一需要这个数字的地方就是这条正则
 * （`{64}` = 32 字节），多一个常量只是多一处要同步的字面量（C16）。
 */
const KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * 从环境构造密钥环。
 *
 * @throws 缺 `ARTIFACT_MASTER_KEY` / 不是 64 位 hex / 缺 `ARTIFACT_ACTIVE_KEY_ID` 时抛错。
 */
export function createKeyRing(env: {
  ARTIFACT_MASTER_KEY: string;
  ARTIFACT_ACTIVE_KEY_ID: string;
}): KeyRing {
  const activeKeyId = typeof env?.ARTIFACT_ACTIVE_KEY_ID === 'string' ? env.ARTIFACT_ACTIVE_KEY_ID : '';
  if (activeKeyId.length === 0) {
    throw new Error('缺少 ARTIFACT_ACTIVE_KEY_ID：必须显式指定当前写入使用的 keyId（D5，无默认值）');
  }

  const masterKeyHex = typeof env?.ARTIFACT_MASTER_KEY === 'string' ? env.ARTIFACT_MASTER_KEY : '';
  if (!KEY_HEX_PATTERN.test(masterKeyHex)) {
    // 报错里**只**说形状，不说值（C11）：哪怕是「长度不对」这种看似无害的信息，
    // 也没有必要把密钥的前缀写进日志。
    throw new Error(
      `ARTIFACT_MASTER_KEY 必须是 64 位十六进制（32 字节），实际长度 ${masterKeyHex.length} 个字符`,
    );
  }

  // 环内部保存的**唯一**一份密钥字节。`Object.freeze` 挡不住 Buffer 内容被改写，
  // 因此防线是「不把这份缓冲交出去」——`keyFor` 每次都回拷贝。同理这个 Map 不出现在
  // 返回值里，调用方无法拿到条目本身。
  const keys = new Map<string, Buffer>([[activeKeyId, Buffer.from(masterKeyHex, 'hex')]]);

  return {
    activeKeyId: () => activeKeyId,
    keyFor: (keyId: string): Buffer => {
      const key = keys.get(keyId);
      if (key === undefined) {
        throw new Error(
          `未知的制品 keyId：${JSON.stringify(keyId)}（环中只有 ${JSON.stringify(activeKeyId)}）。` +
            '绝不回退到默认键：轮换后按 keyId 取不到密钥必须拒绝（D5）',
        );
      }
      return Buffer.from(key);
    },
  };
}
