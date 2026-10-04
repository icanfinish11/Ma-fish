import { describe, it, expect } from 'vitest';
import { PasswordService } from '@vca/api/modules/auth/password.service.js';

describe('密码哈希（§4.2 Argon2id）', () => {
  const svc = new PasswordService();

  it('使用 m=19456,t=2,p=1 的 Argon2id 参数', async () => {
    const h = await svc.hash('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('正确密码校验通过，错误密码不通过', async () => {
    const h = await svc.hash('s3cret-passphrase');
    await expect(svc.verify(h, 's3cret-passphrase')).resolves.toBe(true);
    await expect(svc.verify(h, 'wrong')).resolves.toBe(false);
  });

  it('相同密码两次哈希不同（含随机 salt）', async () => {
    expect(await svc.hash('same')).not.toBe(await svc.hash('same'));
  });

  /**
   * 损坏/伪造的哈希必须**返回 false 而不是抛错**（C14 的边界）。
   *
   * 为什么这条必须有：`verify` 的调用方是 `AuthService.login`，它要处理「用户不存在」
   * 与「哈希损坏」两种失败，且两者的外部表现必须一致（都是 401，不能靠异常类型区分）。
   * 若 `verify` 把 `@node-rs/argon2` 的解析错误抛出去，损坏行会在登录路径上变成 500，
   * 这既是可用性问题，也是一个可被探测的**存在性信号**（500 vs 401 泄露该邮箱已注册）。
   */
  it('哈希格式损坏时返回 false 而非抛错（登录路径不许把失败暴露成 500）', async () => {
    await expect(svc.verify('not-a-hash', 'whatever')).resolves.toBe(false);
    await expect(svc.verify('', 'whatever')).resolves.toBe(false);
    // 形状合法但内容被篡改：同样是校验失败，不是异常
    const good = await svc.hash('original');
    await expect(svc.verify(`${good}x`, 'original')).resolves.toBe(false);
  });
});
