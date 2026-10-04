import { describe, it, expect } from 'vitest';
import { envSchema } from '@vca/api/config/env.schema.js';

describe('启动守卫', () => {
  it('校验器对缺失密钥抛错，确保引导期失败而非运行期', () => {
    expect(() => envSchema.parse({})).toThrow();
  });
});
