import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductListReader, type ProductListResponse } from '../src/cache/product-list-cache.js';
import {
  productListCacheKey,
  productListScope,
  productListVersionKey,
  productVersionKey,
} from '../src/cache/product-cache-keys.js';
import { productCacheInvalidator } from '../src/cache/product-cache-invalidation.js';
import { redisProductCacheStore } from '../src/cache/product-cache-store.js';
import { closeRedisClient, runRedisOperation } from '../src/cache/redis-client.js';
import { parseProductListQuery } from '../src/products/product.schemas.js';

const categoryId = '70000000-0000-4000-8000-000000000001';
const productId = '60000000-0000-4000-8000-000000000001';
const query = parseProductListQuery({});
const versionKey = productListVersionKey({ type: 'global' });
const categoryVersionKey = productListVersionKey({ type: 'category', categoryId });
const cacheKey = productListCacheKey(query, productListScope(query), 1);
const cacheKeys = [versionKey, categoryVersionKey, productVersionKey(productId), cacheKey];
const response: ProductListResponse = {
  data: [],
  pagination: {
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  },
};

const redisDescribe = process.env.RUN_REDIS_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

redisDescribe('Product listing cache with real Redis', () => {
  beforeEach(async () => {
    const result = await runRedisOperation((client) => client.del(cacheKeys));
    expect(result.ok).toBe(true);
  });

  afterAll(async () => {
    await runRedisOperation((client) => client.del(cacheKeys));
    await closeRedisClient();
  });

  it('serves repeated requests from Redis with the configured TTL', async () => {
    const loadProducts = vi.fn(() => Promise.resolve(response));
    const read = createProductListReader({
      store: redisProductCacheStore,
      ttlSeconds: 15,
      maxPage: 5,
      loadProducts,
    });

    await expect(read(query, new Date())).resolves.toEqual(response);
    await expect(read(query, new Date())).resolves.toEqual(response);
    const ttl = await runRedisOperation((client) => client.ttl(cacheKey));

    expect(loadProducts).toHaveBeenCalledTimes(1);
    expect(ttl).toMatchObject({ ok: true });
    if (ttl.ok) {
      expect(ttl.value).toBeGreaterThan(0);
      expect(ttl.value).toBeLessThanOrEqual(15);
    }
  });

  it('increments listing versions without deleting listing entries', async () => {
    const read = createProductListReader({
      store: redisProductCacheStore,
      ttlSeconds: 15,
      maxPage: 5,
      loadProducts: () => Promise.resolve(response),
    });
    await read(query, new Date());

    await productCacheInvalidator.invalidateListings([categoryId, categoryId]);

    await expect(redisProductCacheStore.get(cacheKey)).resolves.not.toBeNull();
    await expect(redisProductCacheStore.get(versionKey)).resolves.toBe('2');
    await expect(redisProductCacheStore.get(categoryVersionKey)).resolves.toBe('1');
  });

  it('deduplicates ingestion Product and Category versions in one invalidation', async () => {
    await productCacheInvalidator.invalidateIngestion(
      [productId, productId],
      [categoryId, categoryId],
    );

    await expect(redisProductCacheStore.get(productVersionKey(productId))).resolves.toBe('1');
    await expect(redisProductCacheStore.get(versionKey)).resolves.toBe('1');
    await expect(redisProductCacheStore.get(categoryVersionKey)).resolves.toBe('1');
  });

  it('bounds stale listing data by TTL when invalidation is unavailable', async () => {
    let currentResponse = response;
    const loadProducts = vi.fn(() => Promise.resolve(currentResponse));
    const read = createProductListReader({
      store: redisProductCacheStore,
      ttlSeconds: 1,
      maxPage: 5,
      loadProducts,
    });

    await read(query, new Date());
    currentResponse = {
      ...response,
      pagination: { ...response.pagination, totalItems: 1, totalPages: 1 },
    };
    await expect(read(query, new Date())).resolves.toEqual(response);
    await vi.waitFor(
      async () => {
        await expect(redisProductCacheStore.get(cacheKey)).resolves.toBeNull();
      },
      { timeout: 2_500, interval: 100 },
    );
    await expect(read(query, new Date())).resolves.toEqual(currentResponse);
  });
});
