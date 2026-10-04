import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/** §4.2：Argon2id，m=19456 KiB, t=2, p=1（OWASP 推荐参数）。 */
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * 口令哈希（C14 / §4.2）。
 *
 * ## 为什么是 `@node-rs/argon2` 而不是 `argon2` / `bcrypt`
 *
 * 参数（m=19456 KiB, t=2, p=1）与 OWASP 的 Argon2id 建议逐位一致，实现必须能**如实**
 * 把它们写进哈希串——`$argon2id$v=19$m=19456,t=2,p=1$…` 这串就是参数的可审计凭据。
 * `@node-rs/argon2` 是预编译产物（无需本机 C/C++ 工具链，CI 与 Windows 本地一致），
 * 且接口是同步签名之外的纯函数，没有可变的全局状态。
 *
 * ## 两个方法刻意保持的形状
 *
 * 1. `hash` **不加盐参数**：盐由实现每次生成 16 字节 CSPRNG 随机值并写进哈希串。
 *    绝不允许调用方传入盐——那正是「同一口令得到同一哈希」的来源。
 * 2. `verify` **把异常收敛成 `false`**：调用方（`AuthService.login`）必须区分不清
 *    「哈希损坏」与「口令不匹配」，否则登录路径会以 500/401 的差异泄露「该邮箱已注册」。
 *    收敛在这里而不是调用方，是因为「哪些异常算校验失败」属于本服务的知识。
 *
 * ## 一处**已裁定的接受风险**（R4）：测试无法区分 `p=1` 与「库默认值」
 *
 * 本文件**显式**声明了 `parallelism: 1`（上面的 `PARAMS`），而 `m`/`t`/`p` 三者在源码中
 * 逐位显式、哈希串本身就是可审计凭据——**实现是对的**。被记录的是**测试能力的边界**：
 * `@node-rs/argon2` 的默认并行度恰好也是 1，因此「删掉 `parallelism: 1`」不会让断言变红
 * （实测：哈希串仍是 `…m=19456,t=2,p=1$…`）。`m` 与 `t` 可被可靠捕获（把 `t` 改成 1
 * 用例立刻变红）。
 *
 * **裁定：接受并记录，不为造一条能变红的断言去改产品公开面**（把 `PARAMS` 导出仅供测试
 * 断言属于为测试改设计）。**复访触发条件：** 升级 `@node-rs/argon2` 且默认并行度变化时，
 * 或将来要求把该断言提升为「逐位证明」时——届时正确动作是让 `PasswordService` 暴露
 * 一个只读的参数视图，而不是在测试里复刻一份 `PARAMS`。
 */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, PARAMS);
  }

  async verify(passwordHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(passwordHash, plain, PARAMS);
    } catch {
      // 哈希格式损坏等情况一律视为校验失败，不泄露内部状态
      return false;
    }
  }
}
