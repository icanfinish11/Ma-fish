import { describe, it, expect } from 'vitest';
import {
  assertTimeoutOrdering,
  MAILER_TIMEOUTS,
  MAILER_WORST_CASE_MS,
  TRANSACTION_MAX_WAIT_MS,
  TRANSACTION_TIMEOUT_MS,
} from '@vca/api/common/timeouts.js';
import { MAX_LAST_ERROR_LENGTH } from '@vca/api/modules/notify/outbox.consumer.js';
import { buildSmtpTransportOptions } from '@vca/api/modules/notify/smtp-mailer.js';

/**
 * 修复轮 2 / Fix 2：**超时之间的关系**必须是一条可断言的事实，而不是散落在两处的默认值。
 *
 * ## 为什么需要一个专门的用例（而不是只在集成用例里测行为）
 *
 * 真正的生产数字是分钟级（连接 15 秒 / socket 空闲 20 秒 / 事务 2 分钟），用例不可能真等
 * 那么久，因此集成用例用**同比例缩小**的数字测「慢投递不产生重复」（见
 * `tests/integration/notify/outbox.test.ts` 的「慢投递」两条）。缩小的代价是：
 * 那两条用例证明的是**机制**，不是**参数**。
 *
 * 这个文件补上参数这一半：直接对常量断言，于是
 * - 「事务超时 > 邮件最坏耗时」这条**顺序**在**生产的**数字上就被钉住（改错立即红）；
 * - `assertTimeoutOrdering()` 本身也被调用一次——它是模块求值期就跑的启动期守卫
 *   （`common/timeouts.ts` 末尾），这里再显式跑一次，让「它存在」这件事在测试里可见。
 *
 * ## 为什么还要断言「数字不是极小值」
 *
 * 一个把三项都设成 1ms 的实现照样满足「事务超时 > 最坏耗时」，但它会在真实 SMTP 上
 * 把每一次正常投递都判成失败。因此这里还钉住「连接/socket 预算是秒级以上」这条下限。
 */
describe('超时预算（Fix 2：事务超时必须大于邮件最坏耗时）', () => {
  it('事务超时严格大于邮件投递的最坏耗时估算，且余量足够（默认参数下）', () => {
    expect(
      TRANSACTION_TIMEOUT_MS,
      '事务超时没有大于邮件最坏耗时：一次成功的慢投递会被回滚并重发（重复邮件）',
    ).toBeGreaterThan(MAILER_WORST_CASE_MS);

    // 余量：不只是「大一点点」。真实数字是 6 倍（120s / 20s+15s+15s ⇒ 120s/50s），
    // 这里按 ≥ 2 倍断言，给将来调参留出空间但不允许把关系调成贴边。
    expect(TRANSACTION_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * MAILER_WORST_CASE_MS);
  });

  it('邮件最坏耗时就是三个显式超时之和（不是随便写的常量）', () => {
    expect(MAILER_WORST_CASE_MS).toBe(
      MAILER_TIMEOUTS.connectionMs + MAILER_TIMEOUTS.greetingMs + MAILER_TIMEOUTS.socketMs,
    );
    // 三个超时都必须是有意义的正数：`undefined`/`0` 会让 `SmtpMailer` 的工厂里
    // 那三行赋值失效（回落成 nodemailer 的分钟级默认值，预算就只是文档）。
    for (const [name, value] of Object.entries(MAILER_TIMEOUTS)) {
      expect(value, `${name} 不是一个正数：那一项超时会回落成 nodemailer 的默认值`).toBeGreaterThan(0);
    }
  });

  it('生产预算是秒/分钟级，不是「贴边的极小值」', () => {
    // SMTP 的真实握手/应答是秒级；这些下限防止「把三项都设成 1ms 来让断言通过」。
    expect(MAILER_TIMEOUTS.connectionMs).toBeGreaterThanOrEqual(5_000);
    expect(MAILER_TIMEOUTS.greetingMs).toBeGreaterThanOrEqual(5_000);
    expect(MAILER_TIMEOUTS.socketMs).toBeGreaterThanOrEqual(5_000);
    expect(TRANSACTION_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    // maxWait 是**取连接**的上限（投递之前失败，不产生重复），它必须远小于事务超时，
    // 否则「池子被占满」会被记成「事务超时」——两种故障的运维含义完全不同。
    expect(TRANSACTION_MAX_WAIT_MS).toBeLessThan(TRANSACTION_TIMEOUT_MS);
  });

  it('启动期守卫在当前常量下通过（它若会抛，模块根本加载不到这里）', () => {
    expect(() => assertTimeoutOrdering()).not.toThrow();
  });

  it('交到 nodemailer 手上的键名与取值就是那三个常量（写错键名会回落成 10 分钟默认值）', () => {
    // nodemailer 只认 `connectionTimeout`/`greetingTimeout`/`socketTimeout` 这三个确切的名字；
    // 写成 `socket_timeout` 之类时它**不报错**，只是静默用自己的默认值（socket 空闲 10 分钟），
    // 于是「事务超时 > 邮件最坏耗时」这条预算建立在一个没人验证过的假设上。
    expect(buildSmtpTransportOptions('smtp://mail.internal:587')).toEqual({
      url: 'smtp://mail.internal:587',
      connectionTimeout: MAILER_TIMEOUTS.connectionMs,
      greetingTimeout: MAILER_TIMEOUTS.greetingMs,
      socketTimeout: MAILER_TIMEOUTS.socketMs,
    });
    // 键名集合也要精确：多出来的键（例如把整个常量对象塞进去）在 nodemailer 侧是死配置，
    // 而它会让人误以为「已经配过了」。
    expect(Object.keys(buildSmtpTransportOptions('smtp://x')).sort()).toEqual([
      'connectionTimeout',
      'greetingTimeout',
      'socketTimeout',
      'url',
    ]);
  });

  it('last_error 的长度上界是「列类型之外的预算」，取一个有界的小值', () => {
    expect(MAX_LAST_ERROR_LENGTH).toBeGreaterThan(0);
    // 比 worker 失败行的 300 字符宽（这是落库字段，要求更完整），但绝不是「不设界」。
    expect(MAX_LAST_ERROR_LENGTH).toBeLessThanOrEqual(10_000);
  });
});
