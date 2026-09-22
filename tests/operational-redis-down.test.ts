import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import * as redisClient from '../src/cache/redis-client.js';

interface ProductListJson {
  data: unknown[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Redis-down operational fallback', () => {
  const app = createApp();

  it('keeps liveness and Product listing available when Redis operations fail', async () => {
    vi.spyOn(redisClient, 'runRedisOperation').mockResolvedValue({ ok: false });

    const health = await request(app).get('/health');
    const products = await request(app).get('/products');
    const body = JSON.parse(products.text) as ProductListJson;

    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
    expect(products.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.page).toBe(1);
    expect(health.text).not.toContain('REDIS_URL');
    expect(products.text).not.toContain('redis://');
  });
});
