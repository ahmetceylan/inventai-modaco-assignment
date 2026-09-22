import { env } from '../config/env.js';
import { mapProduct, type ProductResponse } from '../products/product.mapper.js';
import { getProductById, getProductCacheIdentity } from '../products/product.service.js';
import {
  categoryPromotionVersionKey,
  parseCacheVersion,
  productDetailCacheKey,
  productVersionKey,
} from './product-cache-keys.js';
import { redisProductCacheStore, type ProductCacheStore } from './product-cache-store.js';

const CACHE_SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_PATTERN = /^\d+\.\d{2}$/;

interface ProductDetailCacheEntry {
  schemaVersion: 1;
  productVersion: number;
  categoryVersion: number;
  categoryId: string;
  data: ProductResponse;
}

interface VersionSnapshot {
  productVersion: number;
  categoryVersion: number;
}

interface ProductDetailCacheDependencies {
  store: ProductCacheStore;
  ttlSeconds: number;
  loadIdentity(productId: string): Promise<{ categoryId: string } | null>;
  loadProduct(productId: string, evaluationTime: Date): Promise<ProductResponse | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

const isProductResponse = (value: unknown): value is ProductResponse => {
  if (!isRecord(value) || !isRecord(value.category)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    UUID_PATTERN.test(value.id) &&
    typeof value.name === 'string' &&
    typeof value.sku === 'string' &&
    typeof value.basePrice === 'string' &&
    PRICE_PATTERN.test(value.basePrice) &&
    typeof value.effectivePrice === 'string' &&
    PRICE_PATTERN.test(value.effectivePrice) &&
    typeof value.stockQuantity === 'number' &&
    Number.isSafeInteger(value.stockQuantity) &&
    value.stockQuantity >= 0 &&
    typeof value.category.id === 'string' &&
    UUID_PATTERN.test(value.category.id) &&
    typeof value.category.name === 'string' &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt)
  );
};

const parseCacheEntry = (
  serialized: string,
  requestedProductId: string,
): ProductDetailCacheEntry | null => {
  let value: unknown;

  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }

  if (
    !isRecord(value) ||
    value.schemaVersion !== CACHE_SCHEMA_VERSION ||
    parseCacheVersion(
      typeof value.productVersion === 'number' ? String(value.productVersion) : null,
    ) === null ||
    parseCacheVersion(
      typeof value.categoryVersion === 'number' ? String(value.categoryVersion) : null,
    ) === null ||
    typeof value.categoryId !== 'string' ||
    !UUID_PATTERN.test(value.categoryId) ||
    !isProductResponse(value.data) ||
    value.data.id !== requestedProductId ||
    value.data.category.id !== value.categoryId
  ) {
    return null;
  }

  return value as unknown as ProductDetailCacheEntry;
};

const logCacheFailure = (event: string, productId: string): void => {
  console.error(JSON.stringify({ event, productId }));
};

const deleteBestEffort = async (
  store: ProductCacheStore,
  key: string,
  productId: string,
): Promise<void> => {
  try {
    await store.delete(key);
  } catch {
    logCacheFailure('product_cache_delete_failed', productId);
  }
};

const readVersions = async (
  store: ProductCacheStore,
  productId: string,
  categoryId: string,
): Promise<VersionSnapshot | null> => {
  const [productValue, categoryValue] = await store.mGet([
    productVersionKey(productId),
    categoryPromotionVersionKey(categoryId),
  ]);
  const productVersion = parseCacheVersion(productValue ?? null);
  const categoryVersion = parseCacheVersion(categoryValue ?? null);

  return productVersion === null || categoryVersion === null
    ? null
    : { productVersion, categoryVersion };
};

const readOrInitializeVersions = async (
  store: ProductCacheStore,
  productId: string,
  categoryId: string,
): Promise<VersionSnapshot | null> => {
  const keys = [productVersionKey(productId), categoryPromotionVersionKey(categoryId)];
  const values = await store.mGet(keys);

  for (const [index, value] of values.entries()) {
    if (parseCacheVersion(value ?? null) !== null) {
      continue;
    }

    const key = keys[index];
    if (key === undefined) {
      return null;
    }
    if (value !== null && value !== undefined) {
      await store.delete(key);
    }
    await store.initializeVersion(key);
  }

  return readVersions(store, productId, categoryId);
};

const sameVersions = (
  first: VersionSnapshot | null,
  second: VersionSnapshot | null,
): first is VersionSnapshot => {
  return (
    first !== null &&
    second !== null &&
    first.productVersion === second.productVersion &&
    first.categoryVersion === second.categoryVersion
  );
};

export const createProductDetailReader = (
  dependencies: ProductDetailCacheDependencies,
): ((productId: string, evaluationTime: Date) => Promise<ProductResponse | null>) => {
  const inFlight = new Map<string, Promise<ProductResponse | null>>();

  const readCached = async (productId: string): Promise<ProductResponse | null> => {
    const cacheKey = productDetailCacheKey(productId);

    try {
      const serialized = await dependencies.store.get(cacheKey);
      if (serialized === null) {
        return null;
      }

      const entry = parseCacheEntry(serialized, productId);
      if (entry === null) {
        await deleteBestEffort(dependencies.store, cacheKey, productId);
        return null;
      }

      const versions = await readVersions(dependencies.store, productId, entry.categoryId);
      return versions !== null &&
        versions.productVersion === entry.productVersion &&
        versions.categoryVersion === entry.categoryVersion
        ? entry.data
        : null;
    } catch {
      logCacheFailure('product_cache_read_failed', productId);
      return null;
    }
  };

  const loadAndCache = async (
    productId: string,
    evaluationTime: Date,
  ): Promise<ProductResponse | null> => {
    const identity = await dependencies.loadIdentity(productId);
    if (identity === null) {
      return null;
    }

    let versionsBefore: VersionSnapshot | null = null;
    try {
      versionsBefore = await readOrInitializeVersions(
        dependencies.store,
        productId,
        identity.categoryId,
      );
    } catch {
      logCacheFailure('product_cache_version_read_failed', productId);
    }

    const product = await dependencies.loadProduct(productId, evaluationTime);
    if (product === null) {
      return null;
    }

    if (product.category.id !== identity.categoryId || versionsBefore === null) {
      return product;
    }

    try {
      const versionsAfter = await readVersions(dependencies.store, productId, product.category.id);
      if (!sameVersions(versionsBefore, versionsAfter)) {
        return product;
      }

      const entry: ProductDetailCacheEntry = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        productVersion: versionsBefore.productVersion,
        categoryVersion: versionsBefore.categoryVersion,
        categoryId: product.category.id,
        data: product,
      };
      await dependencies.store.setIfVersionsMatch({
        productVersionKey: productVersionKey(productId),
        productVersion: versionsBefore.productVersion,
        categoryVersionKey: categoryPromotionVersionKey(product.category.id),
        categoryVersion: versionsBefore.categoryVersion,
        cacheKey: productDetailCacheKey(productId),
        payload: JSON.stringify(entry),
        ttlSeconds: dependencies.ttlSeconds,
      });
    } catch {
      logCacheFailure('product_cache_write_failed', productId);
    }

    return product;
  };

  return async (productId, evaluationTime) => {
    const cached = await readCached(productId);
    if (cached !== null) {
      return cached;
    }

    const existing = inFlight.get(productId);
    if (existing !== undefined) {
      return existing;
    }

    const loading = loadAndCache(productId, evaluationTime);
    inFlight.set(productId, loading);

    try {
      return await loading;
    } finally {
      if (inFlight.get(productId) === loading) {
        inFlight.delete(productId);
      }
    }
  };
};

export const getProductDetailById = createProductDetailReader({
  store: redisProductCacheStore,
  ttlSeconds: env.PRODUCT_DETAIL_CACHE_TTL_SECONDS,
  loadIdentity: getProductCacheIdentity,
  async loadProduct(productId, evaluationTime) {
    const product = await getProductById(productId, evaluationTime);
    return product === null ? null : mapProduct(product);
  },
});
