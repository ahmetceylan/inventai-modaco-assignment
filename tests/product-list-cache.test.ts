import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductListReader, type ProductListResponse } from '../src/cache/product-list-cache.js';
import {
  productListCacheKey,
  productListScope,
  productListVersionKey,
} from '../src/cache/product-cache-keys.js';
import type {
  ProductCacheStore,
  VersionedCacheWrite,
} from '../src/cache/product-cache-store.js';
import type { ProductResponse } from '../src/products/product.mapper.js';
import { parseProductListQuery, type ProductListQuery } from '../src/products/product.schemas.js';

const categoryId = '30000000-0000-4000-8000-000000000003';
const evaluationTime = new Date('2030-07-01T00:00:00.000Z');
const defaultQuery = parseProductListQuery({});

const products: ProductResponse[] = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'First',
    sku: 'LIST-001',
    basePrice: '100.00',
    effectivePrice: '80.00',
    stockQuantity: 10,
    category: { id: categoryId, name: 'Accessories' },
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-02T00:00:00.000Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    name: 'Second',
    sku: 'LIST-002',
    basePrice: '50.00',
    effectivePrice: '45.00',
    stockQuantity: 5,
    category: { id: categoryId, name: 'Accessories' },
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-02T00:00:00.000Z',
  },
];

const responseFor = (
  query: ProductListQuery,
  data: ProductResponse[] = products,
): ProductListResponse => {
  return {
    data,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalItems: data.length,
      totalPages: Math.ceil(data.length / query.pageSize),
    },
  };
};

class TestCacheStore implements ProductCacheStore {
  readonly values = new Map<string, string>();
  readonly writes: Array<{
    versionKey: string;
    version: number;
    cacheKey: string;
    payload: string;
    ttlSeconds: number;
  }> = [];

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
  setIfVersionsMatch = vi.fn((_write: VersionedCacheWrite) => Promise.resolve(false));
  setIfVersionMatches = vi.fn(
    (write: {
      versionKey: string;
      version: number;
      cacheKey: string;
      payload: string;
      ttlSeconds: number;
    }) => {
      if (this.values.get(write.versionKey) !== String(write.version)) {
        return Promise.resolve(false);
      }

      this.writes.push(write);
      this.values.set(write.cacheKey, write.payload);
      return Promise.resolve(true);
    },
  );
}

const createDependencies = (store = new TestCacheStore()) => {
  const loadProducts = vi.fn((query: ProductListQuery) =>
    Promise.resolve(responseFor(query)),
  );
  const read = createProductListReader({
    store,
    ttlSeconds: 15,
    maxPage: 5,
    loadProducts,
  });

  return { store, loadProducts, read };
};

const cacheKeyFor = (query: ProductListQuery, version = 1): string => {
  return productListCacheKey(query, productListScope(query), version);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Product listing cache keys', () => {
  it('normalizes implicit and explicit defaults to one key', () => {
    const explicit = parseProductListQuery({ page: '1', pageSize: '20' });

    expect(cacheKeyFor(defaultQuery)).toBe(cacheKeyFor(explicit));
  });

  it('uses different keys for different pages', () => {
    const secondPage = parseProductListQuery({ page: '2' });

    expect(cacheKeyFor(defaultQuery)).not.toBe(cacheKeyFor(secondPage));
  });

  it('uses different keys and versions for filtered and unfiltered scopes', () => {
    const filtered = parseProductListQuery({ categoryId });
    const globalScope = productListScope(defaultQuery);
    const categoryScope = productListScope(filtered);

    expect(cacheKeyFor(defaultQuery)).not.toBe(cacheKeyFor(filtered));
    expect(productListVersionKey(globalScope)).toBe('cache:product-list-version:global');
    expect(productListVersionKey(categoryScope)).toBe(
      `cache:product-list-version:category:${categoryId}`,
    );
  });

  it('uses different keys for ascending and descending effective-price sorting', () => {
    const ascending = parseProductListQuery({ sort: 'effectivePrice', order: 'asc' });
    const descending = parseProductListQuery({ sort: 'effectivePrice', order: 'desc' });

    expect(cacheKeyFor(ascending)).not.toBe(cacheKeyFor(descending));
  });
});

describe('Product listing cache behavior', () => {
  it('loads the first eligible request from PostgreSQL and then hits cache', async () => {
    const dependencies = createDependencies();

    const first = await dependencies.read(defaultQuery, evaluationTime);
    const second = await dependencies.read(defaultQuery, evaluationTime);

    expect(first).toEqual(responseFor(defaultQuery));
    expect(second).toEqual(first);
    expect(dependencies.loadProducts).toHaveBeenCalledTimes(1);
  });

  it('preserves effective-price order and pagination metadata', async () => {
    const query = parseProductListQuery({ sort: 'effectivePrice', order: 'desc' });
    const dependencies = createDependencies();
    dependencies.loadProducts.mockResolvedValueOnce(responseFor(query, [...products].reverse()));

    await dependencies.read(query, evaluationTime);
    const cached = await dependencies.read(query, evaluationTime);

    expect(cached.data.map(({ id }) => id)).toEqual([
      products[1]?.id,
      products[0]?.id,
    ]);
    expect(cached.pagination).toEqual(responseFor(query).pagination);
  });

  it('caches an empty valid page', async () => {
    const dependencies = createDependencies();
    dependencies.loadProducts.mockResolvedValueOnce(responseFor(defaultQuery, []));

    await dependencies.read(defaultQuery, evaluationTime);
    await dependencies.read(defaultQuery, evaluationTime);

    expect(dependencies.loadProducts).toHaveBeenCalledTimes(1);
    expect(dependencies.store.writes).toHaveLength(1);
  });

  it('bypasses Redis entirely for pages above the configured maximum', async () => {
    const deepPage = parseProductListQuery({ page: '6' });
    const dependencies = createDependencies();

    await dependencies.read(deepPage, evaluationTime);

    expect(dependencies.loadProducts).toHaveBeenCalledTimes(1);
    expect(dependencies.store.get).not.toHaveBeenCalled();
    expect(dependencies.store.setIfVersionMatches).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'unknown schema',
      JSON.stringify({
        schemaVersion: 2,
        ...responseFor(defaultQuery),
      }),
    ],
  ])('treats %s as a miss', async (_case, serialized) => {
    const dependencies = createDependencies();
    dependencies.store.values.set(productListVersionKey({ type: 'global' }), '1');
    dependencies.store.values.set(cacheKeyFor(defaultQuery), serialized);

    await dependencies.read(defaultQuery, evaluationTime);

    expect(dependencies.loadProducts).toHaveBeenCalledTimes(1);
    expect(dependencies.store.delete).toHaveBeenCalledWith(
      cacheKeyFor(defaultQuery),
    );
  });

  it('does not write a stale result when the version changes during loading', async () => {
    const dependencies = createDependencies();
    dependencies.loadProducts.mockImplementationOnce((query) => {
      dependencies.store.values.set(productListVersionKey({ type: 'global' }), '2');
      return Promise.resolve(responseFor(query));
    });

    await dependencies.read(defaultQuery, evaluationTime);

    expect(dependencies.store.setIfVersionMatches).not.toHaveBeenCalled();
  });

  it('falls back once to PostgreSQL when Redis reads fail', async () => {
    const dependencies = createDependencies();
    dependencies.store.get.mockRejectedValueOnce(new Error('Redis unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await dependencies.read(defaultQuery, evaluationTime);

    expect(dependencies.loadProducts).toHaveBeenCalledTimes(1);
  });

  it('returns the database response when Redis writes fail', async () => {
    const dependencies = createDependencies();
    dependencies.store.setIfVersionMatches.mockRejectedValueOnce(
      new Error('Redis unavailable'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      dependencies.read(defaultQuery, evaluationTime),
    ).resolves.toEqual(responseFor(defaultQuery));
  });

  it('single-flights concurrent identical misses', async () => {
    const dependencies = createDependencies();
    let resolveLoad!: (value: ProductListResponse) => void;
    dependencies.loadProducts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const first = dependencies.read(defaultQuery, evaluationTime);
    const second = dependencies.read(defaultQuery, evaluationTime);
    await vi.waitFor(() =>
      expect(dependencies.loadProducts).toHaveBeenCalledTimes(1),
    );
    resolveLoad(responseFor(defaultQuery));

    await expect(Promise.all([first, second])).resolves.toEqual([
      responseFor(defaultQuery),
      responseFor(defaultQuery),
    ]);
  });

  it('removes in-flight state after success', async () => {
    const dependencies = createDependencies();
    dependencies.store.setIfVersionMatches.mockResolvedValue(false);

    await dependencies.read(defaultQuery, evaluationTime);
    await dependencies.read(defaultQuery, evaluationTime);

    expect(dependencies.loadProducts).toHaveBeenCalledTimes(2);
  });

  it('removes in-flight state after failure', async () => {
    const dependencies = createDependencies();
    dependencies.loadProducts.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(dependencies.read(defaultQuery, evaluationTime)).rejects.toThrow(
      'database unavailable',
    );
    await expect(dependencies.read(defaultQuery, evaluationTime)).resolves.toEqual(
      responseFor(defaultQuery),
    );
  });

  it('loads different normalized queries independently', async () => {
    const dependencies = createDependencies();
    const secondPage = parseProductListQuery({ page: '2' });
    let resolveFirst!: (value: ProductListResponse) => void;
    dependencies.loadProducts.mockImplementation((query) => {
      return query.page === 1
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(responseFor(query));
    });

    const first = dependencies.read(defaultQuery, evaluationTime);
    await expect(
      dependencies.read(secondPage, evaluationTime),
    ).resolves.toEqual(responseFor(secondPage));
    resolveFirst(responseFor(defaultQuery));
    await expect(first).resolves.toEqual(responseFor(defaultQuery));
  });
});
