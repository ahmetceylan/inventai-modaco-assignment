import { DiscountType, Prisma } from '../generated/prisma/client.js';

export interface PricePromotion {
  discountType: DiscountType;
  value: Prisma.Decimal;
}

export function calculateEffectivePrice(
  basePrice: Prisma.Decimal,
  promotion: PricePromotion | null,
): Prisma.Decimal {
  if (promotion === null) {
    return basePrice.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  const discounted =
    promotion.discountType === DiscountType.PERCENTAGE
      ? basePrice.mul(new Prisma.Decimal(1).minus(promotion.value.div(100)))
      : basePrice.minus(promotion.value);
  const nonNegative = discounted.isNegative() ? new Prisma.Decimal(0) : discounted;

  return nonNegative.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
