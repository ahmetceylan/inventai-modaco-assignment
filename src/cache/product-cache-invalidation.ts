import { categoryPromotionVersionKey, productVersionKey } from './product-cache-keys.js';
import { runRedisOperation } from './redis-client.js';

export interface InvalidationContext {
  jobId?: string;
  chunkId?: string;
}

export interface ProductCacheInvalidator {
  invalidateProduct: (productId: string) => Promise<void>;
  invalidateCategory: (categoryId: string) => Promise<void>;
  invalidateProducts: (productIds: string[], context?: InvalidationContext) => Promise<void>;
}

const logInvalidationFailure = (
  targetType: 'product' | 'category' | 'product_batch',
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

    const result = await runRedisOperation(async (client) => {
      const pipeline = client.multi();
      for (const productId of uniqueProductIds) {
        pipeline.incr(productVersionKey(productId));
      }
      await pipeline.exec();
    });

    if (!result.ok) {
      logInvalidationFailure('product_batch', undefined, context);
    }
  },
};
