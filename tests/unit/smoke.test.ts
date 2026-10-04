import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { ROLES } from '@vca/shared';
import { createTestApp } from '../helpers/app.js';

describe('骨架', () => {
  it('shared 包可解析', () => {
    expect(ROLES.ADMIN).toBe('ADMIN');
  });

  it('api 引导后健康检查返回 200', async () => {
    const app = await createTestApp();
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    await app.close();
  });
});
