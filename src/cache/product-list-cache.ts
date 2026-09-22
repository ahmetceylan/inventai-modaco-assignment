import { env } from '../config/env.js';
import { mapProduct, type ProductResponse } from '../products/product.mapper.js';
import type { ProductListQuery } from '../products/product.schemas.js';
import { listProducts } from '../products/product.service.js';
import {
  parseCacheVersion,
  productListCacheKey,
  productListScope,
  productListVersionKey,
  type ProductListScope,
} from './product-cache-keys.js';
import {
  redisProductCacheStore,
  type ProductCacheStore,
} from './product-cache-store.js';
import { isProductResponse, isRecord } from './product-cache-validation.js';

const CACHE_SCHEMA_VERSION = 1;

export interface ProductListResponse {
  data: ProductResponse[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

interface ProductListCacheEntry extends ProductListResponse {
  schemaVersion: 1;
}

interface ProductListCacheDependencies {
  store: ProductCacheStore;
  ttlSeconds: number;
  maxPage: number;
  loadProducts: (
    query: ProductListQuery,
    evaluationTime: Date,
  ) => Promise<ProductListResponse>;
}

const isNonNegativeSafeInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
};

const parseCacheEntry = (
  serialized: string,
  query: ProductListQuery,
): ProductListResponse | null => {
  let value: unknown;

  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }

  if (
    !isRecord(value) ||
    value.schemaVersion !== CACHE_SCHEMA_VERSION ||
    !Array.isArray(value.data) ||
    !value.data.every(isProductResponse) ||
    !isRecord(value.pagination)
  ) {
    return null;
  }

  const { page, pageSize, totalItems, totalPages } = value.pagination;
  if (
    page !== query.page ||
    pageSize !== query.pageSize ||
    !isNonNegativeSafeInteger(totalItems) ||
    !isNonNegativeSafeInteger(totalPages) ||
    totalPages !== Math.ceil(totalItems / query.pageSize) ||
    value.data.length > query.pageSize
  ) {
    return null;
  }

  return {
    data: value.data,
    pagination: { page, pageSize, totalItems, totalPages },
  };
};

const scopeFields = (scope: ProductListScope, page: number): Record<string, string | number> => {
  return {
    scope: scope.type,
    ...(scope.type === 'category' ? { categoryId: scope.categoryId } : {}),
    page,
  };
};

const logCacheFailure = (
  event: string,
  scope: ProductListScope,
  page: number,
): void => {
  console.error(JSON.stringify({ event, ...scopeFields(scope, page) }));
};

const deleteBestEffort = async (
  store: ProductCacheStore,
  cacheKey: string,
  scope: ProductListScope,
  page: number,
): Promise<void> => {
  try {
    await store.delete(cacheKey);
  } catch {
    logCacheFailure('product_list_cache_delete_failed', scope, page);
  }
};

const readOrInitializeVersion = async (
  store: ProductCacheStore,
  versionKey: string,
): Promise<number | null> => {
  const current = await store.get(versionKey);
  const parsed = parseCacheVersion(current);
  if (parsed !== null) {
    return parsed;
  }

  if (current !== null) {
    await store.delete(versionKey);
  }
  await store.initializeVersion(versionKey);
  return parseCacheVersion(await store.get(versionKey));
};

export const createProductListReader = (
  dependencies: ProductListCacheDependencies,
): ((query: ProductListQuery, evaluationTime: Date) => Promise<ProductListResponse>) => {
  const inFlight = new Map<string, Promise<ProductListResponse>>();

  return async (query, evaluationTime) => {
    if (query.page > dependencies.maxPage) {
      return dependencies.loadProducts(query, evaluationTime);
    }

    const scope = productListScope(query);
    const versionKey = productListVersionKey(scope);
    let version: number | null = null;

    try {
      version = await readOrInitializeVersion(dependencies.store, versionKey);
    } catch {
      logCacheFailure('product_list_cache_version_read_failed', scope, query.page);
    }

    if (version === null) {
      return dependencies.loadProducts(query, evaluationTime);
    }

    const cacheKey = productListCacheKey(query, scope, version);
    try {
      const serialized = await dependencies.store.get(cacheKey);
      if (serialized !== null) {
        const cached = parseCacheEntry(serialized, query);
        if (cached !== null) {
          return cached;
        }
        await deleteBestEffort(dependencies.store, cacheKey, scope, query.page);
      }
    } catch {
      logCacheFailure('product_list_cache_read_failed', scope, query.page);
    }

    const existing = inFlight.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }

    const loading = (async () => {
      const response = await dependencies.loadProducts(query, evaluationTime);

      try {
        const currentVersion = parseCacheVersion(await dependencies.store.get(versionKey));
        if (currentVersion !== version) {
          return response;
        }

        const entry: ProductListCacheEntry = {
          schemaVersion: CACHE_SCHEMA_VERSION,
          ...response,
        };
        await dependencies.store.setIfVersionMatches({
          versionKey,
          version,
          cacheKey,
          payload: JSON.stringify(entry),
          ttlSeconds: dependencies.ttlSeconds,
        });
      } catch {
        logCacheFailure('product_list_cache_write_failed', scope, query.page);
      }

      return response;
    })();
    inFlight.set(cacheKey, loading);

    try {
      return await loading;
    } finally {
      if (inFlight.get(cacheKey) === loading) {
        inFlight.delete(cacheKey);
      }
    }
  };
};

const loadProductList = async (
  query: ProductListQuery,
  evaluationTime: Date,
): Promise<ProductListResponse> => {
  const result = await listProducts(query, evaluationTime);

  return {
    data: result.products.map(mapProduct),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalItems: result.totalItems,
      totalPages: Math.ceil(result.totalItems / query.pageSize),
    },
  };
};

export const getProductList = createProductListReader({
  store: redisProductCacheStore,
  ttlSeconds: env.PRODUCT_LIST_CACHE_TTL_SECONDS,
  maxPage: env.PRODUCT_LIST_CACHE_MAX_PAGE,
  loadProducts: loadProductList,
});
