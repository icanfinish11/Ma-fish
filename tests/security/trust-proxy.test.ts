import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRUST_PROXY,
  parseTrustProxy,
} from '@vca/api/common/security/trust-proxy.js';
import { envSchema } from '@vca/api/config/env.schema.js';

/**
 * `trust proxy` 的取值解析（最终评审 I-6）。
 *
 * ## 这条控制保护的是什么
 *
 * 注册层是「3 次/小时，按 IP」，而**IP 从哪里来**完全取决于 express 的 `trust proxy`：
 * 信任对端时才采信 `X-Forwarded-For`，否则用 socket 对端地址。此前的实现无条件写 `1`
 * （信任一跳），于是「应用只能从受信反代进来」这个前提一旦不成立，
 * 任何客户端换个 XFF 头就换了一个限流桶——而 `infra/nginx/nginx.conf` 在本仓库里
 * **并不存在**，那条前提从来只是部署侧的口头承诺。
 *
 * 这组用例钉住三件事：
 * 1. **默认值是最窄的一档**（`loopback`），且它与 env schema 的默认值是**同一个常量**
 *    （两处各写一份字符串迟早会漂移，而漂移方向决定「直连能不能伪造 XFF」）；
 * 2. 各档取值解析正确（`false` / 跳数 / 网段列表），包括旧行为 `1` 仍然可以**显式**表达；
 * 3. 无法解析的取值**启动期抛错**，而不是留给 express 在**每个请求**上抛
 *    （`proxy-addr` 的编译错误发生在请求处理里 ⇒ 全站 500，而不是一次起不来）。
 */
describe('trust proxy 的取值解析（I-6：IP 维度限流的信任边界）', () => {
  it('未设置时取最窄的默认值 loopback，且与 env schema 的默认值是同一个常量', () => {
    expect(parseTrustProxy(undefined)).toEqual(['loopback']);
    expect(DEFAULT_TRUST_PROXY).toBe('loopback');

    // 单一来源断言：schema 的 `.default(...)` 用的是同一个常量，而不是第二份字面量。
    const parsed = envSchema.parse({
      DATABASE_URL: 'postgresql://app_user:pw@127.0.0.1:5432/vca',
      REDIS_URL: 'redis://127.0.0.1:6379',
      // `MASTER_ENCRYPTION_KEY` 曾在这一行。**已删除**（修复轮 1 / R6）：它被校验却全仓无读取方。
      // 注意从这里删掉它**不会**让本用例变红，因为 zod 的对象 schema 对多余键静默忽略——
      // 也就是说「删掉一个已废弃变量的登记」这件事**没有测试能替你做**，只能靠全仓 grep
      // （`grep -rn MASTER_ENCRYPTION_KEY .env.example apps tests`）。记在这里以示它是有意为之。
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csecret',
      GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
      MAIL_FROM: 'no-reply@example.com',
      SMTP_URL: 'smtp://127.0.0.1:1025',
      // P1 / Task 1 新增（见 tests/helpers/env.ts 的 K9 清单）
      ARTIFACT_STORE_DIR: 'C:\\Temp\\vca-artifacts-fixture',
      ARTIFACT_MAX_UPLOAD_BYTES: '4194304',
      // P1 / Task 2 新增（同上清单）。修复轮 1 起环境面是**密钥环** `ARTIFACT_KEYS`
      // （JSON `{keyId: base64(32 字节)}`），不再是单个 `ARTIFACT_MASTER_KEY`。
      ARTIFACT_KEYS: '{"v1":"q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s="}',
      ARTIFACT_ACTIVE_KEY_ID: 'v1',
    });
    expect(parsed.TRUST_PROXY).toBe(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy(parsed.TRUST_PROXY)).toEqual(parseTrustProxy(undefined));
  });

  it('显式取值：false / true / 跳数 / 网段列表各归各档', () => {
    // 「谁都不信」：直连部署的正确取值（远端无法用 XFF 影响 req.ip）。
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('off')).toBe(false);
    expect(parseTrustProxy('none')).toBe(false);
    expect(parseTrustProxy('  FALSE  ')).toBe(false);

    // 「信任所有」：只在应用除反代外不可达时才对，因此是一个**要写出来**的决定。
    expect(parseTrustProxy('true')).toBe(true);

    // 旧的无条件行为现在必须显式写：跳数 1（且在解析里被归一成**数字**，
    // express 对数字的解释是「信任 N 跳」，与字符串 '1' 的含义完全不同）。
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);

    // 网段/关键字列表（同机之外的反代用这个）。
    expect(parseTrustProxy('loopback,linklocal')).toEqual(['loopback', 'linklocal']);
    expect(parseTrustProxy('10.0.0.0/8')).toEqual(['10.0.0.0/8']);
    expect(parseTrustProxy('172.18.0.0/16,::1')).toEqual(['172.18.0.0/16', '::1']);
  });

  it('无法解析的取值在**启动期**抛错，并指出变量名与可接受的形状', () => {
    // 交给 express 的话，`proxyaddr.compile(['prox'])` 是在请求处理时才抛的：
    // 表现是「每个请求 500」，而不是「进程起不来」。判据因此是这里就抛。
    let thrown: unknown;
    try {
      parseTrustProxy('prox');
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown, '无法解析的取值被静默接受了：它会在每个请求上炸').toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('TRUST_PROXY');
    expect(message, '报错文案里没有可接受的取值，运维只能去读代码').toContain('loopback');

    // 越界的网段与写坏的 CIDR 同样被挡住（false 的宽松解析会让它们变成请求期 500）。
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrowError(/TRUST_PROXY/);
    expect(() => parseTrustProxy('999.1.1.1')).toThrowError(/TRUST_PROXY/);
    expect(() => parseTrustProxy('loopback,')).not.toThrow(); // 尾随逗号是写法的自由度，不是错误
  });
});
