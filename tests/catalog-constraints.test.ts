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

  it('rejects a zero or negative promotion value', async () => {
    const zeroError = await prisma.promotion
      .create({
        data: {
          name: 'Zero value',
          discountType: DiscountType.FIXED,
          value: '0.00',
          startAt,
          endAt,
        },
      })
      .catch((caught: unknown) => caught);

    const negativeError = await prisma.promotion
      .create({
        data: {
          name: 'Negative value',
          discountType: DiscountType.PERCENTAGE,
          value: '-1.00',
          startAt,
          endAt,
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(zeroError, 'promotion_valid_value');
    expectCheckConstraint(negativeError, 'promotion_valid_value');
  });

  it('rejects a promotion whose endAt is not later than startAt', async () => {
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
