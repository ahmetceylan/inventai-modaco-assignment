import type { ProductListQuery } from '../products/product.schemas.js';

export type ProductListScope =
  | { type: 'global' }
  | { type: 'category'; categoryId: string };

export const productDetailCacheKey = (productId: string): string => {
  return `cache:product-detail:${productId}`;
};

export const productVersionKey = (productId: string): string => {
  return `cache:product-version:${productId}`;
};

export const categoryPromotionVersionKey = (categoryId: string): string => {
  return `cache:category-promotion-version:${categoryId}`;
};

export const productListScope = (query: ProductListQuery): ProductListScope => {
  return query.categoryId === undefined
    ? { type: 'global' }
    : { type: 'category', categoryId: query.categoryId.toLowerCase() };
};

export const productListVersionKey = (scope: ProductListScope): string => {
  return scope.type === 'global'
    ? 'cache:product-list-version:global'
    : `cache:product-list-version:category:${scope.categoryId}`;
};

export const productListCacheKey = (
  query: ProductListQuery,
  scope: ProductListScope,
  listingVersion: number,
): string => {
  const scopeValue =
    scope.type === 'global' ? 'global' : `category:${scope.categoryId}`;
  const sort = query.sort ?? 'default';
  const order = query.sort === undefined ? 'default' : (query.order ?? 'asc');

  return [
    'cache:product-list:v1',
    scopeValue,
    String(listingVersion),
    `page=${query.page}`,
    `pageSize=${query.pageSize}`,
    `sort=${sort}`,
    `order=${order}`,
  ].join(':');
};

export const parseCacheVersion = (value: string | null): number | null => {
  if (value === null || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
};
