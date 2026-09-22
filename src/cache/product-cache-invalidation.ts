import {
  categoryPromotionVersionKey,
  productListVersionKey,
  productVersionKey,
} from './product-cache-keys.js';
import { runRedisOperation } from './redis-client.js';

export interface InvalidationContext {
  jobId?: string;
  chunkId?: string;
}

export interface ProductCacheInvalidator {
  invalidateProduct: (productId: string) => Promise<void>;
  invalidateCategory: (categoryId: string) => Promise<void>;
  invalidateProducts: (productIds: string[], context?: InvalidationContext) => Promise<void>;
  invalidateListings: (
    categoryIds: string[],
    context?: InvalidationContext,
  ) => Promise<void>;
  invalidateIngestion: (
    productIds: string[],
    categoryIds: string[],
    context?: InvalidationContext,
  ) => Promise<void>;
}

const logInvalidationFailure = (
  targetType:
    | 'product'
    | 'category'
    | 'product_batch'
    | 'product_list'
    | 'ingestion_cache',
  targetId?: string,
  context: InvalidationContext = {},
): void => {
  console.error(
    JSON.stringify({
      event: 'product_cache_invalidation_failed',
      targetType,
      ...(targetId === undefined ? {} : { targetId }),
      ...context,
    }),
  );
};

const listingVersionKeys = (categoryIds: string[]): string[] => {
  return [
    productListVersionKey({ type: 'global' }),
    ...[...new Set(categoryIds)].map((categoryId) =>
      productListVersionKey({ type: 'category', categoryId }),
    ),
  ];
};

const incrementKeys = async (keys: string[]): Promise<boolean> => {
  const uniqueKeys = [...new Set(keys)];
  const result = await runRedisOperation(async (client) => {
    const pipeline = client.multi();
    for (const key of uniqueKeys) {
      pipeline.incr(key);
    }
    await pipeline.exec();
  });

  return result.ok;
};

export const productCacheInvalidator: ProductCacheInvalidator = {
  async invalidateProduct(productId) {
    const result = await runRedisOperation((client) => client.incr(productVersionKey(productId)));
    if (!result.ok) {
      logInvalidationFailure('product', productId);
    }
  },

  async invalidateCategory(categoryId) {
    const result = await runRedisOperation((client) =>
      client.incr(categoryPromotionVersionKey(categoryId)),
    );
    if (!result.ok) {
      logInvalidationFailure('category', categoryId);
    }
  },

  async invalidateProducts(productIds, context = {}) {
    const uniqueProductIds = [...new Set(productIds)];
    if (uniqueProductIds.length === 0) {
      return;
    }

    const succeeded = await incrementKeys(uniqueProductIds.map(productVersionKey));
    if (!succeeded) {
      logInvalidationFailure('product_batch', undefined, context);
    }
  },

  async invalidateListings(categoryIds, context = {}) {
    const succeeded = await incrementKeys(listingVersionKeys(categoryIds));
    if (!succeeded) {
      logInvalidationFailure('product_list', undefined, context);
    }
  },

  async invalidateIngestion(productIds, categoryIds, context = {}) {
    const keys = [
      ...[...new Set(productIds)].map(productVersionKey),
      ...listingVersionKeys(categoryIds),
    ];
    const succeeded = await incrementKeys(keys);
    if (!succeeded) {
      logInvalidationFailure('ingestion_cache', undefined, context);
    }
  },
};
