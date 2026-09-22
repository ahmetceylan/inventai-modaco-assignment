import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductDetailReader } from '../src/cache/product-detail-cache.js';
import {
  categoryPromotionVersionKey,
  productDetailCacheKey,
  productVersionKey,
} from '../src/cache/product-cache-keys.js';
import type { ProductCacheStore, VersionedCacheWrite } from '../src/cache/product-cache-store.js';
import type { ProductResponse } from '../src/products/product.mapper.js';

const productId = '10000000-0000-4000-8000-000000000001';
const otherProductId = '20000000-0000-4000-8000-000000000002';
const categoryId = '30000000-0000-4000-8000-000000000003';
const evaluationTime = new Date('2030-07-01T00:00:00.000Z');

const product: ProductResponse = {
  id: productId,
  name: 'Sunglasses',
  sku: 'SUN-001',
  basePrice: '100.00',
  effectivePrice: '80.00',
  stockQuantity: 10,
  category: { id: categoryId, name: 'Accessories' },
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-02T00:00:00.000Z',
};

class TestCacheStore implements ProductCacheStore {
  readonly values = new Map<string, string>();
  readonly writes: VersionedCacheWrite[] = [];

  get = vi.fn((key: string) => Promise.resolve(this.values.get(key) ?? null));
  mGet = vi.fn((keys: string[]) =>
    Promise.resolve(keys.map((key) => this.values.get(key) ?? null)),
  );
  delete = vi.fn((key: string) => {
    this.values.delete(key);
    return Promise.resolve();
  });
  initializeVersion = vi.fn((key: string) => {
    if (!this.values.has(key)) {
      this.values.set(key, '1');
    }
    return Promise.resolve();
  });
  setIfVersionsMatch = vi.fn((write: VersionedCacheWrite) => {
    if (
      this.values.get(write.productVersionKey) !== String(write.productVersion) ||
      this.values.get(write.categoryVersionKey) !== String(write.categoryVersion)
    ) {
      return Promise.resolve(false);
    }

    this.writes.push(write);
    this.values.set(write.cacheKey, write.payload);
    return Promise.resolve(true);
  });
  setIfVersionMatches = vi.fn(() => Promise.resolve(false));
}

const cachedEnvelope = (
  data: ProductResponse = product,
  productVersion = 1,
  categoryVersion = 1,
): string => {
  return JSON.stringify({
    schemaVersion: 1,
    productVersion,
    categoryVersion,
    categoryId: data.category.id,
    data,
  });
};

const createDependencies = (store = new TestCacheStore()) => {
  const loadIdentity = vi.fn((id: string) =>
    Promise.resolve(id === productId ? { categoryId } : null),
  );
  const loadProduct = vi.fn((id: string) => Promise.resolve(id === productId ? product : null));
  const read = createProductDetailReader({
    store,
    ttlSeconds: 30,
    loadIdentity,
    loadProduct,
  });

  return { store, loadIdentity, loadProduct, read };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Product detail cache', () => {
  it('loads the first request from PostgreSQL and serves the next from cache', async () => {
    const { read, loadProduct } = createDependencies();

    const first = await read(productId, evaluationTime);
    const second = await read(productId, evaluationTime);

    expect(first).toEqual(product);
    expect(second).toEqual(product);
    expect(loadProduct).toHaveBeenCalledTimes(1);
  });

  it('preserves decimal string formatting on cache hits', async () => {
    const { read } = createDependencies();
    await read(productId, evaluationTime);

    const cached = await read(productId, evaluationTime);

    expect(cached?.basePrice).toBe('100.00');
    expect(cached?.effectivePrice).toBe('80.00');
  });

  it('does not cache 404 results', async () => {
    const { read, loadIdentity, store } = createDependencies();

    await expect(read(otherProductId, evaluationTime)).resolves.toBeNull();
    await expect(read(otherProductId, evaluationTime)).resolves.toBeNull();

    expect(loadIdentity).toHaveBeenCalledTimes(2);
    expect(store.setIfVersionsMatch).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'unknown schema',
      JSON.stringify({
        ...(JSON.parse(cachedEnvelope()) as Record<string, unknown>),
        schemaVersion: 2,
      }),
    ],
  ])('treats %s as a miss and deletes it best-effort', async (_case, serialized) => {
    const dependencies = createDependencies();
    dependencies.store.values.set(productDetailCacheKey(productId), serialized);

    await expect(dependencies.read(productId, evaluationTime)).resolves.toEqual(product);

    expect(dependencies.loadProduct).toHaveBeenCalledTimes(1);
    expect(dependencies.store.delete).toHaveBeenCalledWith(productDetailCacheKey(productId));
  });

  it.each([
    ['missing Product version', null, '1'],
    ['malformed Product version', 'invalid', '1'],
    ['Product version mismatch', '2', '1'],
    ['Category version mismatch', '1', '2'],
  ])('treats %s as a miss', async (_case, currentProductVersion, currentCategoryVersion) => {
    const dependencies = createDependencies();
    dependencies.store.values.set(productDetailCacheKey(productId), cachedEnvelope());
    if (currentProductVersion !== null) {
      dependencies.store.values.set(productVersionKey(productId), currentProductVersion);
    }
    dependencies.store.values.set(categoryPromotionVersionKey(categoryId), currentCategoryVersion);

    await dependencies.read(productId, evaluationTime);

    expect(dependencies.loadProduct).toHaveBeenCalledTimes(1);
  });

  it('writes entries with the configured TTL', async () => {
    const { read, store } = createDependencies();

    await read(productId, evaluationTime);

    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.ttlSeconds).toBe(30);
  });

  it('falls back to PostgreSQL when Redis reads fail', async () => {
    const dependencies = createDependencies();
    dependencies.store.get.mockRejectedValueOnce(new Error('unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(dependencies.read(productId, evaluationTime)).resolves.toEqual(product);

    expect(dependencies.loadProduct).toHaveBeenCalledTimes(1);
  });

  it('does not expose Redis credentials or internal errors in logs', async () => {
    const dependencies = createDependencies();
    dependencies.store.get.mockRejectedValueOnce(
      new Error('redis://user:secret@cache.internal:6379'),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await dependencies.read(productId, evaluationTime);

    const output = log.mock.calls.flat().join(' ');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('cache.internal');
    expect(output).not.toContain('redis://');
  });

  it('returns the Product when the cache write fails', async () => {
    const dependencies = createDependencies();
    dependencies.store.setIfVersionsMatch.mockRejectedValueOnce(new Error('unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(dependencies.read(productId, evaluationTime)).resolves.toEqual(product);
  });

  it('does not write a stale response when versions change during database loading', async () => {
    const dependencies = createDependencies();
    dependencies.loadProduct.mockImplementationOnce(() => {
      dependencies.store.values.set(productVersionKey(productId), '2');
      return Promise.resolve(product);
    });

    await expect(dependencies.read(productId, evaluationTime)).resolves.toEqual(product);

    expect(dependencies.store.setIfVersionsMatch).not.toHaveBeenCalled();
  });

  it('single-flights concurrent misses for the same Product', async () => {
    const dependencies = createDependencies();
    let resolveLoad!: (value: ProductResponse) => void;
    dependencies.loadProduct.mockImplementationOnce(
      () =>
        new Promise<ProductResponse>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const first = dependencies.read(productId, evaluationTime);
    const second = dependencies.read(productId, evaluationTime);
    await vi.waitFor(() => expect(dependencies.loadProduct).toHaveBeenCalledTimes(1));
    resolveLoad(product);

    await expect(Promise.all([first, second])).resolves.toEqual([product, product]);
  });

  it('removes in-flight state after success', async () => {
    const dependencies = createDependencies();
    dependencies.store.setIfVersionsMatch.mockResolvedValue(false);

    await dependencies.read(productId, evaluationTime);
    await dependencies.read(productId, evaluationTime);

    expect(dependencies.loadProduct).toHaveBeenCalledTimes(2);
  });

  it('removes in-flight state after failure', async () => {
    const dependencies = createDependencies();
    dependencies.loadProduct.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(dependencies.read(productId, evaluationTime)).rejects.toThrow(
      'database unavailable',
    );
    await expect(dependencies.read(productId, evaluationTime)).resolves.toEqual(product);

    expect(dependencies.loadProduct).toHaveBeenCalledTimes(2);
  });

  it('loads different Product IDs independently', async () => {
    const store = new TestCacheStore();
    const loadIdentity = vi.fn((id: string) =>
      Promise.resolve({ categoryId: `${id.slice(0, -1)}3` }),
    );
    let resolveFirst!: (value: ProductResponse) => void;
    const productFor = (id: string): ProductResponse => ({
      ...product,
      id,
      category: { ...product.category, id: `${id.slice(0, -1)}3` },
    });
    const loadProduct = vi.fn((id: string): Promise<ProductResponse> => {
      return id === productId
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(productFor(id));
    });
    const read = createProductDetailReader({
      store,
      ttlSeconds: 30,
      loadIdentity,
      loadProduct,
    });

    const first = read(productId, evaluationTime);
    await expect(read(otherProductId, evaluationTime)).resolves.toEqual(productFor(otherProductId));
    resolveFirst(productFor(productId));
    await expect(first).resolves.toEqual(productFor(productId));

    expect(loadProduct).toHaveBeenCalledTimes(2);
  });
});
