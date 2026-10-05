/**
 * 制品密钥环（P1 / Task 2，规格 D5 / C10 + 控制器裁定 R5）。
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
 * ## 环里必须能装**多个**密钥，否则轮换在部署层不可达（R5）
 *
 * 上一版的入参是**单个** `ARTIFACT_MASTER_KEY`，于是环里恰好只有活动 keyId 这一个条目。
 * 后果很具体：轮换到 v2 必然**替换掉**环里唯一的键，旧制品（头里写着 v1）立刻变成
 * 「未知 keyId ⇒ 拒绝」——「旧制品按其 keyId 继续可读」这条要求**在格式上成立、
 * 在部署上不成立**。今天的环境面因此是一个 JSON 映射：
 *
 * ```
 * ARTIFACT_KEYS={"v1":"<base64(32 字节)>","v2":"<base64(32 字节)>"}
 * ARTIFACT_ACTIVE_KEY_ID=v2
 * ```
 *
 * 于是「已退役但仍在环中」的 keyId 有了表达方式：Task 3 的「未知 keyId ⇒ 不回退」
 * 与「已退役的 keyId ⇒ 仍能解密」两条用例各自都有数据来源。
 *
 * ## `active ∈ keys` 在**构造期**就校验（R5，fail-fast）
 *
 * 上一版只校验了两个变量**各自存在**，因此应用可以带着一个「环里根本没有的
 * `ARTIFACT_ACTIVE_KEY_ID`」正常启动，直到某个请求走到 `new ChunkEncryptor(...)` 才失败
 * ——那是运行期、且在一次上传已经开始之后。现在 `createKeyRing` 构造期就抛，
 * 报错直接点名「活动 keyId 不在环里」并列出环中有哪些 keyId（keyId 不是密钥，
 * 它逐字写在每份制品头里，可以出现在报错中）。
 *
 * 骨架的 `env.schema.ts` 另有一道**同一判据**的引导期校验（schema 层无法表达跨字段约束时
 * 由它兜住）；本模块是第二道，因为本模块可以被非 NestJS 的调用方直接使用
 * （探针、脚本、将来的 worker），不能假设别人替它校验过。
 *
 * ## 密钥材料的三条纪律
 *
 * 1. **不外泄到文本**：所有报错只带**变量名与 keyId**，绝不带密钥内容、也绝不带
 *    那个 base64 片段（C11）。keyId 不是密钥，因此可以出现在报错里。
 * 2. **不外泄到调用方手里**：`keyFor` 返回的是**拷贝**。环是密钥字节的唯一持有者，
 *    否则任何一个拿到返回值并改写它的调用方都会让全进程后续加密用错字节。
 * 3. **畸形输入一律拒绝**：不是合法 base64、解出来不是 32 字节，都抛错——
 *    静默地丢一个「解不出来」的键，等价于悄悄把它退役。
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
 * AES-256 的密钥长度：32 字节。
 *
 * 刻意**不**把它做成导出的 `KEY_BYTES`（上一版有过，随后因无人读取而删除）：唯一需要
 * 这个数字的地方是下面这条长度判据，多一个导出常量只是多一处要同步的字面量（C16）。
 */
const KEY_BYTES = 32;

/**
 * keyId 的形状。**与 `apps/api/src/config/env.schema.ts` 里 `ARTIFACT_ACTIVE_KEY_ID`
 * 的正则逐字相同**——两处都必须存在（一个是引导期 schema、一个是模块自己的一道），
 * 由 `tests/unit/asset/key-ring.test.ts` 的用例钉住「两处一致」，免得它们各自漂移。
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * base64 的**严格**判据。
 *
 * 为什么不用「`Buffer.from(s,'base64')` 解完长度对得上」这一条：Node 的 base64 解码器
 * 会**静默忽略非法字符**，于是 `'A'.repeat(44) + '!!!'` 这种串也能解出 32 字节并被放行。
 * 先按字母表与填充逐字校验，再解码，才能让「运维把 JSON 写坏了」这件事响亮。
 *
 * 同时接受标准（`+` `/`）与 URL-safe（`-` `_`）字母表，以及有无填充两种形态：
 * 环境变量经 docker-compose / k8s ConfigMap 传递时这两种变体都常见，而它们解出的字节相同。
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** `ARTIFACT_KEYS` 的解析结果：要么是一份形如 `{keyId: 32 字节}` 的映射，要么是一句可执行的错误。 */
export type ArtifactKeysResult =
  | { ok: true; keys: Map<string, Buffer> }
  | { ok: false; error: string };

/**
 * 解析 `ARTIFACT_KEYS`（JSON `{ keyId: base64(32B) }`）。
 *
 * **返回一句错误而不是抛错**：同一个判据有两个使用者（引导期 schema 与构造期
 * `createKeyRing`），两边需要把消息接到各自的报错口径里。做成「返回错误」而不是
 * 「抛错 + 捕获再改写」，是为了让两边的调用的确是同一个函数、同一条判据。
 *
 * 报错里**只**出现字段名与 keyId（C11）：keyId 逐字写在每份制品头里，不是秘密；
 * base64 片段是密钥材料，一个字都不出现。
 */
export function parseArtifactKeys(raw: unknown): ArtifactKeysResult {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return {
      ok: false,
      error: '必须显式给出（JSON 映射 {keyId: base64(32 字节)}）：轮换要能同时持有新旧密钥，没有默认值',
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    // 只报「不是合法 JSON」，不把原文回显进消息：原文里就是密钥材料（C11）。
    return { ok: false, error: '不是合法的 JSON（形状是 {"<keyId>":"<base64 的 32 字节>"}）' };
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return { ok: false, error: '必须是 JSON **对象**（{keyId: base64(32 字节)}），不是数组或标量' };
  }

  const record = decoded as Record<string, unknown>;
  const ids = Object.keys(record);
  if (ids.length === 0) {
    return { ok: false, error: '环是空的（至少要有 ARTIFACT_ACTIVE_KEY_ID 指向的那一个密钥）' };
  }

  const keys = new Map<string, Buffer>();
  for (const keyId of ids) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      // 这里可以回显 keyId：它不是密钥。回显它反而让「哪个条目写坏了」一眼可见。
      return { ok: false, error: `keyId ${JSON.stringify(keyId)} 形状非法（1..64 位 ASCII 标识符，字母或数字开头）` };
    }
    const value = record[keyId];
    if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
      return { ok: false, error: `keyId ${JSON.stringify(keyId)} 的值不是合法的 base64 字符串` };
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== KEY_BYTES) {
      return { ok: false, error: `keyId ${JSON.stringify(keyId)} 解出 ${bytes.length} 字节，AES-256 需要 ${KEY_BYTES} 字节` };
    }
    keys.set(keyId, bytes);
  }
  return { ok: true, keys };
}

/**
 * 从环境构造密钥环。
 *
 * @throws 缺 `ARTIFACT_KEYS` / 不是合法 JSON / keyId 形状非法 / 值不是 base64 /
 *   解出的密钥不是 32 字节 / 缺 `ARTIFACT_ACTIVE_KEY_ID` / **活动 keyId 不在环中**时抛错。
 */
export function createKeyRing(env: {
  ARTIFACT_KEYS?: string;
  ARTIFACT_ACTIVE_KEY_ID?: string;
}): KeyRing {
  const parsed = parseArtifactKeys(env?.ARTIFACT_KEYS);
  if (!parsed.ok) {
    throw new Error(`ARTIFACT_KEYS ${parsed.error}`);
  }
  const keys = parsed.keys;

  const activeKeyId = typeof env?.ARTIFACT_ACTIVE_KEY_ID === 'string' ? env.ARTIFACT_ACTIVE_KEY_ID : '';
  if (activeKeyId.length === 0) {
    throw new Error('缺少 ARTIFACT_ACTIVE_KEY_ID：必须显式指定当前写入使用的 keyId（D5，无默认值）');
  }
  // fail-fast（R5）：上一版只校验存在性，于是进程可以带着一个环里没有的活动 keyId 启动，
  // 直到 `new ChunkEncryptor(...)` 才失败——那时一次上传已经开始。这里在构造期就拦下。
  if (!keys.has(activeKeyId)) {
    throw new Error(
      `ARTIFACT_ACTIVE_KEY_ID=${JSON.stringify(activeKeyId)} 不在 ARTIFACT_KEYS 的环里` +
        `（环中有：${[...keys.keys()].map((id) => JSON.stringify(id)).join(', ')}）。` +
        '这会让每一次写入都在加密时才发现取不到活动键，故在引导期直接拒绝（D5）',
    );
  }

  // 环内部保存的**唯一**一份密钥字节。`Object.freeze` 挡不住 Buffer 内容被改写，
  // 因此防线是「不把这份缓冲交出去」——`keyFor` 每次都回拷贝。同理这个 Map 不出现在
  // 返回值里，调用方无法拿到条目本身。
  return {
    activeKeyId: () => activeKeyId,
    keyFor: (keyId: string): Buffer => {
      const key = keys.get(keyId);
      if (key === undefined) {
        throw new Error(
          `未知的制品 keyId：${JSON.stringify(keyId)}（环中有 ${[...keys.keys()].map((id) => JSON.stringify(id)).join(', ')}）。` +
            '绝不回退到默认键：轮换后按 keyId 取不到密钥必须拒绝（D5）',
        );
      }
      return Buffer.from(key);
    },
  };
}
