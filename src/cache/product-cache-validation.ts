import type { ProductResponse } from '../products/product.mapper.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_PATTERN = /^\d+\.\d{2}$/;

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

export const isProductResponse = (value: unknown): value is ProductResponse => {
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
