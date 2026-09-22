import {
  PERF_CATEGORY_NAME,
  PERF_PRODUCT_SKU_PREFIX,
  PERF_PROMOTION_NAME,
} from './constants.js';

export class ReservedCleanupError extends Error {}

export interface CleanupTarget {
  categoryName: string;
  skuPrefix: string;
  promotionName: string;
}

export const reservedCleanupTarget = (): CleanupTarget => {
  return {
    categoryName: PERF_CATEGORY_NAME,
    skuPrefix: PERF_PRODUCT_SKU_PREFIX,
    promotionName: PERF_PROMOTION_NAME,
  };
};

export const assertReservedCleanupTarget = (target: CleanupTarget): void => {
  const expected = reservedCleanupTarget();

  if (
    target.categoryName !== expected.categoryName ||
    target.skuPrefix !== expected.skuPrefix ||
    target.promotionName !== expected.promotionName
  ) {
    throw new ReservedCleanupError('Cleanup target is not limited to reserved performance identifiers');
  }

  if (!target.skuPrefix.startsWith('PERF') || target.skuPrefix.length < 5) {
    throw new ReservedCleanupError('Cleanup SKU prefix is not a reserved performance prefix');
  }
};
