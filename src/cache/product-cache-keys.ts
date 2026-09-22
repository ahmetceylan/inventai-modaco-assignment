export const productDetailCacheKey = (productId: string): string => {
  return `cache:product-detail:${productId}`;
};

export const productVersionKey = (productId: string): string => {
  return `cache:product-version:${productId}`;
};

export const categoryPromotionVersionKey = (categoryId: string): string => {
  return `cache:category-promotion-version:${categoryId}`;
};

export const parseCacheVersion = (value: string | null): number | null => {
  if (value === null || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
};
