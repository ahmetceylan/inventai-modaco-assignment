import { Prisma } from '../generated/prisma/client.js';

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const MAX_PRODUCT_PRICE = new Prisma.Decimal('9999999999.99');

export class UnsupportedPricingRuleError extends Error {}

export const assertSupportedPricingRuleVersion = (pricingRuleVersion: string): void => {
  if (pricingRuleVersion !== 'v1') {
    throw new UnsupportedPricingRuleError(
      `Unsupported pricing rule version: ${pricingRuleVersion}`,
    );
  }
};

export const applyV1PricingRule = (vendorBasePrice: string): Prisma.Decimal | null => {
  const value = vendorBasePrice.trim();

  if (!DECIMAL_PATTERN.test(value)) {
    return null;
  }

  const decimal = new Prisma.Decimal(value);
  if (decimal.isNegative()) {
    return null;
  }

  const normalized = decimal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return normalized.gt(MAX_PRODUCT_PRICE) ? null : normalized;
};

export const applyImportPricingRule = (
  pricingRuleVersion: string,
  vendorBasePrice: string,
): Prisma.Decimal | null => {
  assertSupportedPricingRuleVersion(pricingRuleVersion);
  return applyV1PricingRule(vendorBasePrice);
};
