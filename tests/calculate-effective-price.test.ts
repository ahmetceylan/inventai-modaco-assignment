import { describe, expect, it } from 'vitest';
import { DiscountType, Prisma } from '../src/generated/prisma/client.js';
import { calculateEffectivePrice } from '../src/pricing/calculate-effective-price.js';

function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('calculateEffectivePrice', () => {
  it('returns the base price when there is no promotion', () => {
    const result = calculateEffectivePrice(decimal('100.00'), null);

    expect(result.toFixed(2)).toBe('100.00');
  });

  it('calculates a percentage discount', () => {
    const result = calculateEffectivePrice(decimal('100.00'), {
      discountType: DiscountType.PERCENTAGE,
      value: decimal('20.00'),
    });

    expect(result.toFixed(2)).toBe('80.00');
  });

  it('calculates a fixed discount', () => {
    const result = calculateEffectivePrice(decimal('100.00'), {
      discountType: DiscountType.FIXED,
      value: decimal('12.34'),
    });

    expect(result.toFixed(2)).toBe('87.66');
  });

  it('returns zero when a fixed discount equals the base price', () => {
    const result = calculateEffectivePrice(decimal('10.00'), {
      discountType: DiscountType.FIXED,
      value: decimal('10.00'),
    });

    expect(result.toFixed(2)).toBe('0.00');
  });

  it('floors a fixed discount greater than the base price at zero', () => {
    const result = calculateEffectivePrice(decimal('10.00'), {
      discountType: DiscountType.FIXED,
      value: decimal('20.00'),
    });

    expect(result.toFixed(2)).toBe('0.00');
  });

  it.each([
    ['99.99', '15.00', '84.99'],
    ['0.01', '50.00', '0.01'],
  ])('rounds %s with %s percent half-up to %s', (basePrice, percentage, expected) => {
    const result = calculateEffectivePrice(decimal(basePrice), {
      discountType: DiscountType.PERCENTAGE,
      value: decimal(percentage),
    });

    expect(result.toFixed(2)).toBe(expected);
  });

  it('retains precision beyond JavaScript safe integers', () => {
    const result = calculateEffectivePrice(decimal('9007199254740991.99'), {
      discountType: DiscountType.FIXED,
      value: decimal('0.01'),
    });

    expect(result.toFixed(2)).toBe('9007199254740991.98');
  });

  it('does not mutate the input Decimal values', () => {
    const basePrice = decimal('99.99');
    const value = decimal('15.00');
    const baseBefore = basePrice.toString();
    const valueBefore = value.toString();

    const result = calculateEffectivePrice(basePrice, {
      discountType: DiscountType.PERCENTAGE,
      value,
    });

    expect(basePrice.toString()).toBe(baseBefore);
    expect(value.toString()).toBe(valueBefore);
    expect(result).not.toBe(basePrice);
  });
});
