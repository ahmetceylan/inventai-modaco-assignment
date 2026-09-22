import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DiscountType } from '../src/generated/prisma/client.js';
import { createPrismaClient } from './prisma.js';

const startAt = new Date('2026-09-21T10:00:00.000Z');
const endAt = new Date('2026-09-21T12:00:00.000Z');

function expectCheckConstraint(error: unknown, constraint: string): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(constraint);
}

describe('catalog check constraints', () => {
  let prisma!: ReturnType<typeof createPrismaClient>;

  beforeAll(() => {
    prisma = createPrismaClient();
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Promotion", "Product", "Category" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createCategory() {
    return prisma.category.create({
      data: { name: `category-${randomUUID()}` },
    });
  }

  async function createProduct(
    categoryId: string,
    overrides: { basePrice?: string; stockQuantity?: number } = {},
  ) {
    return prisma.product.create({
      data: {
        name: 'Test product',
        sku: `sku-${randomUUID()}`,
        basePrice: overrides.basePrice ?? '10.00',
        stockQuantity: overrides.stockQuantity ?? 1,
        categoryId,
      },
    });
  }

  it('accepts a product with a zero base price', async () => {
    const category = await createCategory();

    const product = await createProduct(category.id, { basePrice: '0.00' });

    expect(product.basePrice.toString()).toBe('0');
  });

  it('rejects a product with a negative base price', async () => {
    const category = await createCategory();

    const error = await createProduct(category.id, { basePrice: '-0.01' }).catch(
      (caught: unknown) => caught,
    );

    expectCheckConstraint(error, 'product_base_price_non_negative');
  });

  it('accepts a product with zero stock', async () => {
    const category = await createCategory();

    const product = await createProduct(category.id, { stockQuantity: 0 });

    expect(product.stockQuantity).toBe(0);
  });

  it('rejects a product with negative stock', async () => {
    const category = await createCategory();

    const error = await createProduct(category.id, { stockQuantity: -1 }).catch(
      (caught: unknown) => caught,
    );

    expectCheckConstraint(error, 'product_stock_quantity_non_negative');
  });

  it('accepts a valid percentage promotion', async () => {
    const promotion = await prisma.promotion.create({
      data: {
        name: 'Percentage sale',
        discountType: DiscountType.PERCENTAGE,
        value: '25.00',
        startAt,
        endAt,
      },
    });

    expect(promotion.value.toString()).toBe('25');
  });

  it('accepts a percentage promotion with value 100', async () => {
    const promotion = await prisma.promotion.create({
      data: {
        name: 'Maximum percentage',
        discountType: DiscountType.PERCENTAGE,
        value: '100.00',
        startAt,
        endAt,
      },
    });

    expect(promotion.value.toString()).toBe('100');
  });

  it('rejects a percentage promotion above 100', async () => {
    const error = await prisma.promotion
      .create({
        data: {
          name: 'Invalid percentage',
          discountType: DiscountType.PERCENTAGE,
          value: '100.01',
          startAt,
          endAt,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'promotion_valid_value');
  });

  it('rejects a percentage promotion with value zero', async () => {
    const error = await prisma.promotion
      .create({
        data: {
          name: 'Zero percentage',
          discountType: DiscountType.PERCENTAGE,
          value: '0.00',
          startAt,
          endAt,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'promotion_valid_value');
  });

  it('rejects a negative percentage promotion', async () => {
    const error = await prisma.promotion
      .create({
        data: {
          name: 'Negative percentage',
          discountType: DiscountType.PERCENTAGE,
          value: '-1.00',
          startAt,
          endAt,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'promotion_valid_value');
  });

  it('accepts a fixed discount greater than zero', async () => {
    const promotion = await prisma.promotion.create({
      data: {
        name: 'Fixed sale',
        discountType: DiscountType.FIXED,
        value: '5.00',
        startAt,
        endAt,
      },
    });

    expect(promotion.value.toString()).toBe('5');
  });

  it('accepts a fixed discount larger than a representative Product price', async () => {
    const category = await createCategory();
    const product = await createProduct(category.id, { basePrice: '10.00' });

    const promotion = await prisma.promotion.create({
      data: {
        name: 'Large fixed discount',
        discountType: DiscountType.FIXED,
        value: '100.00',
        startAt,
        endAt,
        productId: product.id,
      },
    });

    expect(promotion.value.toString()).toBe('100');
  });

  it('rejects a fixed discount with value zero', async () => {
    const error = await prisma.promotion
      .create({
        data: {
          name: 'Zero fixed discount',
          discountType: DiscountType.FIXED,
          value: '0.00',
          startAt,
          endAt,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'promotion_valid_value');
  });

  it('rejects a negative fixed discount', async () => {
    const error = await prisma.promotion
      .create({
        data: {
          name: 'Negative fixed discount',
          discountType: DiscountType.FIXED,
          value: '-1.00',
          startAt,
          endAt,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'promotion_valid_value');
  });

  it('accepts a promotion whose startAt is before endAt', async () => {
    const promotion = await prisma.promotion.create({
      data: {
        name: 'Valid dates',
        discountType: DiscountType.FIXED,
        value: '5.00',
        startAt,
        endAt,
      },
    });

    expect(promotion.startAt).toEqual(startAt);
    expect(promotion.endAt).toEqual(endAt);
  });

  it('rejects a promotion whose startAt equals endAt', async () => {
    const error = await prisma.promotion
      .create({
        data: {
          name: 'Invalid dates',
          discountType: DiscountType.FIXED,
          value: '5.00',
          startAt,
          endAt: startAt,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'promotion_valid_dates');
  });

  it('rejects a promotion whose startAt is after endAt', async () => {
    const error = await prisma.promotion
      .create({
        data: {
          name: 'Reversed dates',
          discountType: DiscountType.FIXED,
          value: '5.00',
          startAt: endAt,
          endAt: startAt,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'promotion_valid_dates');
  });

  it('accepts an unassigned promotion', async () => {
    const promotion = await prisma.promotion.create({
      data: {
        name: 'Unassigned',
        discountType: DiscountType.PERCENTAGE,
        value: '10.00',
        startAt,
        endAt,
      },
    });

    expect(promotion.productId).toBeNull();
    expect(promotion.categoryId).toBeNull();
  });

  it('accepts a product-targeted promotion', async () => {
    const category = await createCategory();
    const product = await createProduct(category.id);

    const promotion = await prisma.promotion.create({
      data: {
        name: 'Product sale',
        discountType: DiscountType.FIXED,
        value: '2.00',
        startAt,
        endAt,
        productId: product.id,
      },
    });

    expect(promotion.productId).toBe(product.id);
    expect(promotion.categoryId).toBeNull();
  });

  it('accepts a category-targeted promotion', async () => {
    const category = await createCategory();

    const promotion = await prisma.promotion.create({
      data: {
        name: 'Category sale',
        discountType: DiscountType.PERCENTAGE,
        value: '15.00',
        startAt,
        endAt,
        categoryId: category.id,
      },
    });

    expect(promotion.categoryId).toBe(category.id);
    expect(promotion.productId).toBeNull();
  });

  it('rejects a promotion targeting both a product and a category', async () => {
    const category = await createCategory();
    const product = await createProduct(category.id);

    const error = await prisma.promotion
      .create({
        data: {
          name: 'Dual target',
          discountType: DiscountType.FIXED,
          value: '3.00',
          startAt,
          endAt,
          productId: product.id,
          categoryId: category.id,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'promotion_single_target');
  });
});
