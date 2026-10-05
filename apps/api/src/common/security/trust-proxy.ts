/**
 * `trust proxy` 的取值来源与解析（最终评审 I-6）。
 *
 * ## 为什么必须有这个文件：一个无条件的 `trust proxy = 1` 是「部署假设」而不是配置
 *
 * `bootstrap.ts` 此前**无条件**写 `app.set('trust proxy', 1)`，也就是「永远信任一跳
 * `X-Forwarded-For`」。这句话在「应用只能从受信反代进来」时是对的，而它恰好是**唯一**
 * 让 IP 维度限流成立的前提：express 只在信任对端时才采信 XFF，否则 `req.ip` 就是 socket 对端。
 * 一旦应用被直连（没有那层反代、或反代配错），任何客户端都能自带
 * `X-Forwarded-For: <随机 IP>`，于是「注册 3 次/小时、按 IP」这条**唯一的**注册防线
 * 变成「只要换一个头就行」——而 `infra/nginx/nginx.conf` 在本仓库里**并不存在**，
 * 也就是说那条「受信反代」是部署侧的口头承诺，没有任何东西在检查它。
 *
 * 因此取值改成**显式配置**（`TRUST_PROXY`），默认取**最窄**的一档 `loopback`：
 * - 只有 socket 对端是回环地址（同机 Nginx，即 `infra/docker-compose.yml` 那种形态）时才采信 XFF；
 * - 远端的直连客户端**伪造不了**它——它的 socket 对端不是回环地址；
 * - 代价如实记录：反代若在**另一台机器/另一个容器网段**，默认值下所有请求都会以反代的 IP
 *   计入限流桶（表现为「全站共用一个配额」）。那时必须显式把它设成反代的网段或跳数，
 *   而不是靠一个谁都没写下来的部署假设。
 *
 * ## 为什么在这里**校验**而不是交给 express
 *
 * express 收到字符串时会用 `proxy-addr` 编译它，而 `proxyaddr.compile(['prox'])`
 * **在请求处理时才抛**（`invalid IP address: prox`）——那意味着一个拼错的变量会让
 * **每个请求** 500，而不是让进程起不来。能在启动期发现的事实不要留到运行期，
 * 与 `env.schema.ts` / `assertTimeoutOrdering()` 是同一条既有标准。
 */

/** 默认值：只信任回环地址上的反代（最窄、且远端伪造不了的那一档）。 */
export const DEFAULT_TRUST_PROXY = 'loopback';

/**
 * `app.set('trust proxy', value)` 可接受的取值形状（与 express 的 `compileTrust` 对齐）：
 * `false` / `true` / 跳数 / 网段（`proxy-addr` 的关键字、IP 或 CIDR）列表。
 */
export type TrustProxyValue = boolean | number | string[];

/** `proxy-addr` 认识的三个关键字（内置网段名）。 */
const SUBNET_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** 形如 `1.2.3.4` 或 `1.2.3.0/24`。 */
function isIpv4OrCidr(entry: string): boolean {
  const [addr, bits] = entry.split('/');
  if (!addr || !/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return false;
  if (addr.split('.').some((octet) => Number(octet) > 255)) return false;
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 32);
}

/** 形如 `::1` 或 `fe80::/10`（只做**形状**校验：十六进制组与 `:`，不展开缩写形式）。 */
function isIpv6OrCidr(entry: string): boolean {
  const [addr, bits] = entry.split('/');
  if (!addr || !addr.includes(':') || !/^[0-9a-f:]+$/.test(addr)) return false;
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128);
}

/**
 * 把 `TRUST_PROXY` 的原始字符串解析成 express 能直接用的值。
 *
 * 无法解析时**抛错**（启动期失败，而不是每个请求失败）。取值一览：
 * - 未设置 ⇒ {@link DEFAULT_TRUST_PROXY}（`loopback`）；
 * - `false` / `off` / `none` ⇒ `false`（谁都不信：反代在后端网络里时 `req.ip` 会是反代的 IP，
 *   限流桶随之被合并——这是**安全**的一侧，另一侧才是被 XFF 绕过）；
 * - `true` / `all` ⇒ `true`（**信任所有**，只在「应用除反代外不可达」时才正确，慎用）；
 * - 非负整数 ⇒ 信任的**跳数**（与旧的硬编码 `1` 同一个语义，但现在是写出来的）；
 * - 关键字 / IP / CIDR，可用逗号分隔 ⇒ 直接交给 express 的 `proxy-addr`。
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyValue {
  const normalized = (raw ?? DEFAULT_TRUST_PROXY).trim().toLowerCase();

  if (normalized === 'false' || normalized === 'off' || normalized === 'none') return false;
  if (normalized === 'true' || normalized === 'all') return true;
  if (/^\d+$/.test(normalized)) return Number(normalized);

  const entries = normalized.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;

  for (const entry of entries) {
    if (SUBNET_KEYWORDS.has(entry) || isIpv4OrCidr(entry) || isIpv6OrCidr(entry)) continue;
    throw new Error(
      `TRUST_PROXY 的取值无法解析：「${raw}」\n` +
        '  可接受：false / true / 跳数（如 1）/ 网段（loopback、linklocal、uniquelocal、' +
        'IP 或 CIDR，可逗号分隔）。\n' +
        `  不设它时的默认值是 ${DEFAULT_TRUST_PROXY}（只信任同机反代）。\n` +
        '  这里刻意在**启动期**报错：交给 express 的话，拼错的取值会在**每个请求**上抛' +
        '（`proxy-addr` 编译失败），表现为全站 500 而不是一次起不来。',
    );
  }
  return entries;
}
