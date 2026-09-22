import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductDetailReader } from '../src/cache/product-detail-cache.js';
import { productCacheInvalidator } from '../src/cache/product-cache-invalidation.js';
import {
  categoryPromotionVersionKey,
  productDetailCacheKey,
  productVersionKey,
} from '../src/cache/product-cache-keys.js';
import { redisProductCacheStore } from '../src/cache/product-cache-store.js';
import { closeRedisClient, runRedisOperation } from '../src/cache/redis-client.js';
import type { ProductResponse } from '../src/products/product.mapper.js';

const productId = '60000000-0000-4000-8000-000000000001';
const categoryId = '70000000-0000-4000-8000-000000000001';
const cacheKeys = [
  productDetailCacheKey(productId),
  productVersionKey(productId),
  categoryPromotionVersionKey(categoryId),
];
const product: ProductResponse = {
  id: productId,
  name: 'Redis Product',
  sku: 'REDIS-001',
  basePrice: '100.00',
  effectivePrice: '75.00',
  stockQuantity: 5,
  category: { id: categoryId, name: 'Redis Category' },
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-02T00:00:00.000Z',
};

const redisDescribe = process.env.RUN_REDIS_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

redisDescribe('Product detail cache with real Redis', () => {
  beforeEach(async () => {
    const result = await runRedisOperation((client) => client.del(cacheKeys));
    expect(result.ok).toBe(true);
  });

  afterAll(async () => {
    await runRedisOperation((client) => client.del(cacheKeys));
    await closeRedisClient();
  });

  it('serves the second request from Redis with the configured TTL', async () => {
    const loadProduct = vi.fn(() => Promise.resolve(product));
    const read = createProductDetailReader({
      store: redisProductCacheStore,
      ttlSeconds: 30,
      loadIdentity: () => Promise.resolve({ categoryId }),
      loadProduct,
    });

    await expect(read(productId, new Date())).resolves.toEqual(product);
    await expect(read(productId, new Date())).resolves.toEqual(product);
    const ttl = await runRedisOperation((client) => client.ttl(productDetailCacheKey(productId)));

    expect(loadProduct).toHaveBeenCalledTimes(1);
    expect(ttl).toMatchObject({ ok: true });
    if (ttl.ok) {
      expect(ttl.value).toBeGreaterThan(0);
      expect(ttl.value).toBeLessThanOrEqual(30);
    }
  });

  it('expires the cached response at the configured TTL', async () => {
    const loadProduct = vi.fn(() => Promise.resolve(product));
    const read = createProductDetailReader({
      store: redisProductCacheStore,
      ttlSeconds: 1,
      loadIdentity: () => Promise.resolve({ categoryId }),
      loadProduct,
    });

    await read(productId, new Date());
    await vi.waitFor(
      async () => {
        const cached = await redisProductCacheStore.get(productDetailCacheKey(productId));
        expect(cached).toBeNull();
      },
      { timeout: 2_500, interval: 100 },
    );
    await read(productId, new Date());

    expect(loadProduct).toHaveBeenCalledTimes(2);
  });

  it('bounds stale data by TTL when invalidation is unavailable', async () => {
    let currentProduct = product;
    const loadProduct = vi.fn(() => Promise.resolve(currentProduct));
    const read = createProductDetailReader({
      store: redisProductCacheStore,
      ttlSeconds: 1,
      loadIdentity: () => Promise.resolve({ categoryId }),
      loadProduct,
    });

    await expect(read(productId, new Date())).resolves.toEqual(product);
    currentProduct = { ...product, effectivePrice: '70.00' };
    await expect(read(productId, new Date())).resolves.toEqual(product);
    await vi.waitFor(
      async () => {
        const cached = await redisProductCacheStore.get(productDetailCacheKey(productId));
        expect(cached).toBeNull();
      },
      { timeout: 2_500, interval: 100 },
    );
    await expect(read(productId, new Date())).resolves.toEqual(currentProduct);
  });

  it('invalidates a Category logically without deleting Product entries', async () => {
    const read = createProductDetailReader({
      store: redisProductCacheStore,
      ttlSeconds: 30,
      loadIdentity: () => Promise.resolve({ categoryId }),
      loadProduct: () => Promise.resolve(product),
    });
    await read(productId, new Date());

    await productCacheInvalidator.invalidateCategory(categoryId);

    await expect(
      redisProductCacheStore.get(productDetailCacheKey(productId)),
    ).resolves.not.toBeNull();
    await expect(redisProductCacheStore.get(categoryPromotionVersionKey(categoryId))).resolves.toBe(
      '2',
    );
  });
});
