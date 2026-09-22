import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DiscountType, type Prisma } from '../src/generated/prisma/client.js';
import { createPrismaClient } from './prisma.js';

const firstRange = {
  startAt: new Date('2040-01-01T00:00:00.000Z'),
  endAt: new Date('2040-02-01T00:00:00.000Z'),
};
const overlappingRange = {
  startAt: new Date('2040-01-15T00:00:00.000Z'),
  endAt: new Date('2040-02-15T00:00:00.000Z'),
};
const adjacentRange = {
  startAt: firstRange.endAt,
  endAt: new Date('2040-03-01T00:00:00.000Z'),
};
const laterRange = {
  startAt: new Date('2040-03-01T00:00:00.000Z'),
  endAt: new Date('2040-04-01T00:00:00.000Z'),
};

function expectExclusionConstraint(error: unknown, constraint: string): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('23P01');
  expect((error as Error).message).toContain(constraint);
}

function expectConcurrentDatabaseRejection(error: unknown, constraint: string): void {
  expect(error).toBeInstanceOf(Error);

  if (error instanceof Error && 'code' in error && error.code === 'P2034') {
    expect(error.message).toContain('write conflict or a deadlock');
    return;
  }

  expectExclusionConstraint(error, constraint);
}

describe('Promotion overlap exclusion constraints', () => {
  let prisma!: ReturnType<typeof createPrismaClient>;
  let categoryIds!: [string, string];
  let productIds!: [string, string];

  beforeAll(() => {
    prisma = createPrismaClient();
  });

  beforeEach(async () => {
    const categories = await Promise.all([
      prisma.category.create({ data: { name: `category-${randomUUID()}` } }),
      prisma.category.create({ data: { name: `category-${randomUUID()}` } }),
    ]);
    categoryIds = [categories[0].id, categories[1].id];

    const products = await Promise.all(
      categories.map((category) =>
        prisma.product.create({
          data: {
            name: 'Constraint test product',
            sku: `sku-${randomUUID()}`,
            basePrice: '100.00',
            stockQuantity: 1,
            categoryId: category.id,
          },
        }),
      ),
    );
    productIds = [products[0]!.id, products[1]!.id];
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Promotion", "Product", "Category" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function createPromotion(
    target: { productId: string } | { categoryId: string },
    range: { startAt: Date; endAt: Date },
    overrides: Partial<Prisma.PromotionUncheckedCreateInput> = {},
  ) {
    return prisma.promotion.create({
      data: {
        name: `promotion-${randomUUID()}`,
        discountType: DiscountType.FIXED,
        value: '10.00',
        ...range,
        ...target,
        ...overrides,
      },
    });
  }

  it('rejects overlapping Promotions for the same Product', async () => {
    await createPromotion({ productId: productIds[0] }, firstRange);

    const error = await createPromotion({ productId: productIds[0] }, overlappingRange).catch(
      (caught: unknown) => caught,
    );

    expectExclusionConstraint(error, 'no_overlapping_product_promotions');
  });

  it('accepts non-overlapping Promotions for the same Product', async () => {
    await createPromotion({ productId: productIds[0] }, firstRange);

    const promotion = await createPromotion({ productId: productIds[0] }, laterRange);

    expect(promotion.productId).toBe(productIds[0]);
  });

  it('accepts adjacent Promotions for the same Product', async () => {
    await createPromotion({ productId: productIds[0] }, firstRange);

    const promotion = await createPromotion({ productId: productIds[0] }, adjacentRange);

    expect(promotion.productId).toBe(productIds[0]);
  });

  it('accepts overlapping Promotions for different Products', async () => {
    await createPromotion({ productId: productIds[0] }, firstRange);

    const promotion = await createPromotion({ productId: productIds[1] }, overlappingRange);

    expect(promotion.productId).toBe(productIds[1]);
  });

  it('ignores an overlapping cancelled Product Promotion', async () => {
    await createPromotion({ productId: productIds[0] }, firstRange, {
      cancelledAt: new Date('2039-12-01T00:00:00.000Z'),
    });

    const promotion = await createPromotion({ productId: productIds[0] }, overlappingRange);

    expect(promotion.cancelledAt).toBeNull();
  });

  it('rejects overlapping Promotions for the same Category', async () => {
    await createPromotion({ categoryId: categoryIds[0] }, firstRange);

    const error = await createPromotion({ categoryId: categoryIds[0] }, overlappingRange).catch(
      (caught: unknown) => caught,
    );

    expectExclusionConstraint(error, 'no_overlapping_category_promotions');
  });

  it('accepts non-overlapping Promotions for the same Category', async () => {
    await createPromotion({ categoryId: categoryIds[0] }, firstRange);

    const promotion = await createPromotion({ categoryId: categoryIds[0] }, laterRange);

    expect(promotion.categoryId).toBe(categoryIds[0]);
  });

  it('accepts adjacent Promotions for the same Category', async () => {
    await createPromotion({ categoryId: categoryIds[0] }, firstRange);

    const promotion = await createPromotion({ categoryId: categoryIds[0] }, adjacentRange);

    expect(promotion.categoryId).toBe(categoryIds[0]);
  });

  it('accepts overlapping Promotions for different Categories', async () => {
    await createPromotion({ categoryId: categoryIds[0] }, firstRange);

    const promotion = await createPromotion({ categoryId: categoryIds[1] }, overlappingRange);

    expect(promotion.categoryId).toBe(categoryIds[1]);
  });

  it('ignores an overlapping cancelled Category Promotion', async () => {
    await createPromotion({ categoryId: categoryIds[0] }, firstRange, {
      cancelledAt: new Date('2039-12-01T00:00:00.000Z'),
    });

    const promotion = await createPromotion({ categoryId: categoryIds[0] }, overlappingRange);

    expect(promotion.cancelledAt).toBeNull();
  });

  it('accepts overlapping Product and Category Promotions', async () => {
    await createPromotion({ productId: productIds[0] }, firstRange);

    const promotion = await createPromotion({ categoryId: categoryIds[0] }, overlappingRange);

    expect(promotion.categoryId).toBe(categoryIds[0]);
  });

  it.each([
    ['Product', 'productId', 'no_overlapping_product_promotions'],
    ['Category', 'categoryId', 'no_overlapping_category_promotions'],
  ] as const)(
    'allows exactly one concurrent overlapping %s assignment',
    async (_scope, targetField, constraint) => {
      const targetId = targetField === 'productId' ? productIds[0] : categoryIds[0];
      const promotions = await Promise.all([
        createPromotionWithoutTarget(firstRange),
        createPromotionWithoutTarget(overlappingRange),
      ]);

      const results = await Promise.allSettled(
        promotions.map((promotion) =>
          prisma.promotion.update({
            where: { id: promotion.id },
            data: { [targetField]: targetId },
          }),
        ),
      );

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expectConcurrentDatabaseRejection(rejected[0]?.reason, constraint);

      const assigned = await prisma.promotion.count({
        where: {
          [targetField]: targetId,
          cancelledAt: null,
          startAt: { lt: overlappingRange.endAt },
          endAt: { gt: firstRange.startAt },
        },
      });
      expect(assigned).toBe(1);
    },
  );

  function createPromotionWithoutTarget(range: { startAt: Date; endAt: Date }) {
    return prisma.promotion.create({
      data: {
        name: `concurrent-${randomUUID()}`,
        discountType: DiscountType.PERCENTAGE,
        value: '10.00',
        ...range,
      },
    });
  }
});
