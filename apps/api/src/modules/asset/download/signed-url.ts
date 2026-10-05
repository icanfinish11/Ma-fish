import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 签名下载票据（P1 / Task 8；规格 D10）。
 *
 * ## 载荷与被签的字符串
 *
 * ```
 * assetVersionId | userId | expiresAt | nonce        ← 逐字拼接，顺序即协议
 * signature = base64url(HMAC-SHA256(secret, 上面那一行))
 * ```
 *
 * 四个字段**全部**在签名覆盖范围内：少签一个（例如不签 `userId`）就等于允许把一张
 * 「给 alice 的票」改成「给 bob 的票」——而票据是**无会话**使用的（见下），
 * 签名是它唯一的凭证。
 *
 * ## 为什么票据可以无会话使用（`userId` 不是「必须带着同一个会话」的意思）
 *
 * `userId` 的作用有三个，都不是「要求请求方再出示会话」：①它是被签字段，因此票据
 * 不可被改成别人的；②它是审计里的当事人（谁下载的）；③它是**判定是否仍然有权**的输入
 * （兑换时会再走一次 `checkAccess`）。而「单次使用」「≤5 分钟」「每次下载写审计」
 * 是威胁 #3 指名的那三条控制。要求会话会把签名 URL 退化成普通鉴权接口——
 * 那样「把链接交给下载工具/浏览器直开」这件事就不成立了，而它正是签名 URL 的全部意义。
 *
 * ## 这个文件只做纯函数：不含 Redis、不含数据库、不含 HTTP
 *
 * 因此它可以被单测穷举（畸形输入、超长输入、逐字段篡改），而「首次使用即消费」
 * 那一条（需要原子 `SET NX`）住在 `nonce-store.ts`，两者的接线在
 * `download.service.ts`。
 *
 * ## C11：这里没有任何一行日志
 *
 * 签名、nonce、整条 URL 都是凭证。本模块**不写日志**（连错误路径也不写），
 * 调用方在写审计时只能放**有界的理由分类**，不能把票据本身带进去。
 */

/**
 * 票据有效期（秒）。规格 D10 / 威胁 #3 要求 **≤ 300**。
 *
 * 这个数在**两侧**都被检查：签发时用它算 `expiresAt`，校验时拒绝任何
 * `expiresAt - now > 300` 的票据（`inspectTicket` 的 `ttl_too_long`）。
 * 只在一侧检查的话，把常数改大就会静默地把窗口放宽——上界因此不是一句注释，
 * 而是 `tests/unit/asset/signed-url.test.ts` 里会变红的那条用例。
 */
export const DOWNLOAD_TTL_SECONDS = 300;

/**
 * 下载端点的路径（`AssetController` 的 `@Get('download')`）。
 *
 * 这里是**字面量**、控制器里是**装饰器**，两处必须一致。漂移的表现是下载链接 404，
 * 而钉住它的不是这段注释：单测的往返用例与 `tests/integration/asset/signed-download.test.ts`
 * 都打这条真实路径，路径一旦不一致，那些用例立刻红。
 */
export const DOWNLOAD_PATH = '/assets/download';

/** 签名：base64url 编码的 32 字节 HMAC-SHA256。 */
const SIGNATURE_CHARS = 43;

/** nonce：base64url 编码的 16 字节（128 位）随机数。 */
const NONCE_CHARS = 22;

/** 任何被签字段的长度上界。它让「校验」这件事对**任意长**的客户端输入都是有界的。 */
const MAX_FIELD_CHARS = 64;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * 版本 id 与当事人 id 的形状：UUID。
 *
 * 这条形状判据不是格式洁癖，它承担一件事：**畸形票据在碰到数据库之前就被拒**。
 * 一个非 UUID 的 `assetVersionId` 打到 Postgres 会以 `22P02`（uuid 语法）失败，
 * 而那在 HTTP 上是一次 500——一次由**客户端**输入造成的 500 正是要消灭的形态。
 *
 * **导出**是因为同一个形状还有第二个边界：路由参数 `:versionId`（`AssetController`）。
 * 两处各写一份正则才是真正的问题——漂移的方向是「路径参数放行了票据拒掉的形状」，
 * 而那种漂移不会有任何东西报错。这里因此是**唯一**的 UUID 判据来源；
 * 它住在这个文件里而不是新建一个 `ids.ts`：今天只有「票据载荷」与「路径参数」
 * 两个消费者，而它们都在本模块内（C16：不为两个消费者建一层抽象）。
 */
export const UUID_IDENTIFIER = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `expiresAt` 的文本形状：无前导零的十进制整数（`1e9` / `+1` / ` 1` / `1.0` 全部拒绝）。 */
const DECIMAL = /^(?:0|[1-9][0-9]{0,9})$/;

/**
 * 一张下载票据。
 *
 * 字段名与规格 D10 的载荷逐字一致（`assetVersionId | userId | expiresAt | nonce`）——
 * 改名的代价是签名载荷与文档对不上，而两者对不上时没有任何东西会报错。
 */
export interface DownloadTicket {
  assetVersionId: string;
  userId: string;
  /** Unix 秒（整数）。用秒而不是毫秒：它与 TTL 的口径一致，且不会与 JS 的 Date 混淆。 */
  expiresAt: number;
  nonce: string;
  signature: string;
}

/**
 * 校验结论。`verifyTicket` 只回布尔；**理由**给审计与响应码用。
 *
 * 为什么要有它（而不是只有布尔）：下载失败必须写一行审计（D10），而一行写着
 * 「失败了」、不写**为什么**的审计在排障时没有价值。四种理由都是有界取值，
 * 因此它们可以安全地进 append-only 的表（C11：不放票据本身）。
 */
export type TicketVerdict = 'ok' | 'malformed' | 'bad_signature' | 'expired' | 'ttl_too_long';

/** 生成一个 nonce（128 位 CSPRNG，URL 安全，因此可以原样进查询串）。 */
export function createNonce(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * 被签的那一行字符串。
 *
 * 用 `|` 而不是 JSON：四个字段的取值集合里都不含 `|`（UUID 是 hex 与 `-`、
 * nonce 与签名是 base64url、`expiresAt` 是十进制），因此拼接**不会**产生歧义
 * （「两个不同的载荷拼出同一行」是不可能的）。换成 JSON 只会让签名载荷依赖
 * 序列化的实现细节（键序、转义），而那是会随库升级漂移的东西。
 */
export function canonicalPayload(ticket: Omit<DownloadTicket, 'signature'>): string {
  return `${ticket.assetVersionId}|${ticket.userId}|${String(ticket.expiresAt)}|${ticket.nonce}`;
}

/** 算出签名（hex 之外的 base64url：它可以直接进 URL，不需要百分号转义）。 */
export function signTicket(ticket: Omit<DownloadTicket, 'signature'>, secret: string): string {
  return createHmac('sha256', secret).update(canonicalPayload(ticket)).digest('base64url');
}

/**
 * 判定一张票据，并给出**理由**。
 *
 * 判定顺序是刻意的：
 *
 * 1. **形状**（`malformed`）——形状不对的输入连比都不该比：一个 4 KiB 的「签名」
 *    与一个数组型的 `nonce` 都在这一步出局，比较的次数与输入长度因此有界；
 * 2. **签名**（`bad_signature`）——先确认这确实是**我们签的**东西，再谈它是否过期。
 *    反过来的话，一个伪造的载荷会拿到「已过期」这个理由，而那是在用一句关于
 *    **我们自己的票据**的结论去描述一个攻击者编出来的串；
 * 3. **过期**（`expired`）；
 * 4. **TTL 上界**（`ttl_too_long`）——只有拿着密钥的人能走到这一步，因此它不是
 *    面向攻击者的检查，而是让「≤300 秒」这条要求**两侧都成立**的落点。
 *
 * `now` 由调用方传入（不读进程时钟）：单测因此可以精确地踩过期的边界，
 * 而边界恰好是这类代码最容易差一位的地方。
 */
export function inspectTicket(ticket: DownloadTicket, secret: string, now: number): TicketVerdict {
  if (!Number.isSafeInteger(now) || now < 0) return 'malformed';
  if (!isWellFormed(ticket)) return 'malformed';

  const computed = signTicket(ticket, secret);
  if (!constantTimeEquals(computed, ticket.signature)) return 'bad_signature';

  if (ticket.expiresAt <= now) return 'expired';
  if (ticket.expiresAt - now > DOWNLOAD_TTL_SECONDS) return 'ttl_too_long';
  return 'ok';
}

/** 规格 D10 的布尔视图：只有「形状、签名、期限、上界」四关全过才是 `true`。 */
export function verifyTicket(ticket: DownloadTicket, secret: string, now: number): boolean {
  return inspectTicket(ticket, secret, now) === 'ok';
}

/**
 * 把票据拼成**相对**路径 `/assets/download?...`。
 *
 * ## 为什么是相对路径，而不是绝对 URL
 *
 * 本进程不知道自己的对外 origin：反代在哪、TLS 终止在哪、对外域名是什么，都不是
 * 它能验证的事实。用请求的 `Host` 头去拼绝对 URL 会把这件事交给一个**调用方可以设置**
 * 的值（Host 头注入），而代价只是一次 302/复制粘贴的便利。真要绝对 URL，
 * 就该有一个显式的 `PUBLIC_BASE_URL` 配置项——今天的部署不需要它，
 * 因此不加（C16：不为不存在的调用方预埋配置）。
 */
export function buildDownloadPath(ticket: DownloadTicket): string {
  const query = new URLSearchParams({
    assetVersionId: ticket.assetVersionId,
    userId: ticket.userId,
    expiresAt: String(ticket.expiresAt),
    nonce: ticket.nonce,
    signature: ticket.signature,
  });
  return `${DOWNLOAD_PATH}?${query.toString()}`;
}

/**
 * 解析查询串里的票据（**客户端输入的那一侧**）。
 *
 * 判据是「严格」：缺少任一字段、字段是数组（`?nonce=a&nonce=b`）、是嵌套对象
 * （`?nonce[x]=1`，Express 的 extended 查询解析器会造出这种形状）、空串、
 * 形状不对——一律 `null`，绝不「取第一个」或「转成字符串再说」。
 *
 * 为什么不抛错而是回 `null`：这条路径完全由调用方输入驱动，一次抛出就是一次 500
 * （D10 明确要求畸形输入被**拒绝**而不是变成未捕获异常）。判据集中在这里，
 * 控制器因此只有一条「null ⇒ 403 + 审计」的分支。
 */
export function parseTicketQuery(query: unknown): DownloadTicket | null {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return null;
  const q = query as Record<string, unknown>;

  const assetVersionId = singleString(q['assetVersionId']);
  const userId = singleString(q['userId']);
  const expiresAtText = singleString(q['expiresAt']);
  const nonce = singleString(q['nonce']);
  const signature = singleString(q['signature']);
  if (
    assetVersionId === null ||
    userId === null ||
    expiresAtText === null ||
    nonce === null ||
    signature === null
  ) {
    return null;
  }
  if (!DECIMAL.test(expiresAtText)) return null;

  const ticket: DownloadTicket = { assetVersionId, userId, expiresAt: Number(expiresAtText), nonce, signature };
  return isWellFormed(ticket) ? ticket : null;
}

/** 每个字段都必须是**单个**字符串；数组/对象/数字一律不算。 */
function singleString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 形状判据：四个被签字段 + 签名的取值集合都被限死。
 *
 * `expiresAt` 用 `Number.isSafeInteger` 而不是 `Number.isInteger`：后者对
 * `1e21` 也返回 true，而那样的值在 `expiresAt - now` 里会变成浮点近似——
 * 一张「永远不过期」的票据正是从这里漏出去的。
 */
function isWellFormed(ticket: DownloadTicket): boolean {
  if (typeof ticket !== 'object' || ticket === null) return false;
  const { assetVersionId, userId, expiresAt, nonce, signature } = ticket;
  if (typeof assetVersionId !== 'string' || assetVersionId.length > MAX_FIELD_CHARS || !UUID_IDENTIFIER.test(assetVersionId)) {
    return false;
  }
  if (typeof userId !== 'string' || userId.length > MAX_FIELD_CHARS || !UUID_IDENTIFIER.test(userId)) return false;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) return false;
  if (typeof nonce !== 'string' || nonce.length !== NONCE_CHARS || !BASE64URL.test(nonce)) return false;
  if (typeof signature !== 'string' || signature.length !== SIGNATURE_CHARS || !BASE64URL.test(signature)) {
    return false;
  }
  return true;
}

/**
 * 常量时间比较（规格 D10 明写的要求）。
 *
 * 长度先比：它**不是**秘密（签名长度固定为 43 字符，载荷长度由载荷本身决定），
 * 而 `timingSafeEqual` 要求两个 Buffer 等长（不等长时它会**抛**）。
 * 内容比较用 `timingSafeEqual`——它比较的是**全部**字节，不会在第一个不同的字节上短路。
 *
 * 判别力由结构判据给出（`tests/unit/asset/signed-url.test.ts` 的最后两条）：
 * 常量时间与 `===` 在外部行为上完全相同，行为断言区分不了它们，因此判据只能落在
 * 「源码里调用了这个原语」上，并用一条变异探针证明那条断言会红。
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
