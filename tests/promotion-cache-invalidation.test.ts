import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductCacheInvalidator } from '../src/cache/product-cache-invalidation.js';
import { prisma } from '../src/config/prisma.js';
import { DiscountType, Prisma } from '../src/generated/prisma/client.js';
import {
  assignPromotion,
  cancelPromotion,
  createPromotion,
} from '../src/promotions/promotion.service.js';

const categoryId = '40000000-0000-4000-8000-000000000001';
const productId = '50000000-0000-4000-8000-000000000001';

const createInvalidator = (): ProductCacheInvalidator => {
  return {
    invalidateProduct: vi.fn(() => Promise.resolve()),
    invalidateCategory: vi.fn(() => Promise.resolve()),
    invalidateProducts: vi.fn(() => Promise.resolve()),
    invalidateListings: vi.fn(() => Promise.resolve()),
    invalidateIngestion: vi.fn(() => Promise.resolve()),
  };
};

const createUnassignedPromotion = () => {
  return createPromotion({
    name: 'Cache invalidation promotion',
    discountType: DiscountType.PERCENTAGE,
    value: new Prisma.Decimal('20.00'),
    startAt: new Date('2030-01-01T00:00:00.000Z'),
    endAt: new Date('2030-02-01T00:00:00.000Z'),
  });
};

describe('Promotion cache invalidation', () => {
  beforeEach(async () => {
    await prisma.promotion.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.category.create({ data: { id: categoryId, name: 'Accessories' } });
    await prisma.product.create({
      data: {
        id: productId,
        name: 'Sunglasses',
        sku: 'SUN-CACHE-001',
        basePrice: '100.00',
        stockQuantity: 10,
        categoryId,
      },
    });
  });

  afterEach(async () => {
    await prisma.promotion.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('invalidates Product detail and global/Category listings after Product assignment', async () => {
    const promotion = await createUnassignedPromotion();
    const invalidator = createInvalidator();

    await assignPromotion(promotion.id, { type: 'PRODUCT', id: productId }, invalidator);

    expect(invalidator.invalidateProduct).toHaveBeenCalledWith(productId);
    expect(invalidator.invalidateCategory).not.toHaveBeenCalled();
    expect(invalidator.invalidateListings).toHaveBeenCalledWith([categoryId]);
  });

  it('invalidates Category detail and global/Category listings after Category assignment', async () => {
    const promotion = await createUnassignedPromotion();
    const invalidator = createInvalidator();

    await assignPromotion(promotion.id, { type: 'CATEGORY', id: categoryId }, invalidator);

    expect(invalidator.invalidateCategory).toHaveBeenCalledWith(categoryId);
    expect(invalidator.invalidateProduct).not.toHaveBeenCalled();
    expect(invalidator.invalidateProducts).not.toHaveBeenCalled();
    expect(invalidator.invalidateListings).toHaveBeenCalledWith([categoryId]);
  });

  it.each([
    ['Product', { type: 'PRODUCT' as const, id: productId }, 'invalidateProduct' as const],
    ['Category', { type: 'CATEGORY' as const, id: categoryId }, 'invalidateCategory' as const],
  ])('invalidates a cancelled %s Promotion exactly once', async (_scope, target, method) => {
    const promotion = await createUnassignedPromotion();
    await assignPromotion(promotion.id, target, createInvalidator());
    const invalidator = createInvalidator();

    await cancelPromotion(promotion.id, invalidator);
    await cancelPromotion(promotion.id, invalidator);

    expect(invalidator[method]).toHaveBeenCalledTimes(1);
    expect(invalidator[method]).toHaveBeenCalledWith(target.id);
    expect(invalidator.invalidateListings).toHaveBeenCalledTimes(1);
    expect(invalidator.invalidateListings).toHaveBeenCalledWith([categoryId]);
  });

  it('does not invalidate when creating an unassigned Promotion', async () => {
    const invalidator = createInvalidator();

    await createUnassignedPromotion();

    expect(invalidator.invalidateProduct).not.toHaveBeenCalled();
    expect(invalidator.invalidateCategory).not.toHaveBeenCalled();
    expect(invalidator.invalidateListings).not.toHaveBeenCalled();
  });

  it('does not fail assignment when Redis invalidation fails', async () => {
    const promotion = await createUnassignedPromotion();
    const invalidator = createInvalidator();
    vi.mocked(invalidator.invalidateProduct).mockRejectedValueOnce(new Error('Redis unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      assignPromotion(promotion.id, { type: 'PRODUCT', id: productId }, invalidator),
    ).resolves.toMatchObject({ productId });
  });

  it('does not fail cancellation when Redis invalidation fails', async () => {
    const promotion = await createUnassignedPromotion();
    await assignPromotion(promotion.id, { type: 'CATEGORY', id: categoryId }, createInvalidator());
    const invalidator = createInvalidator();
    vi.mocked(invalidator.invalidateCategory).mockRejectedValueOnce(new Error('Redis unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const cancelled = await cancelPromotion(promotion.id, invalidator);

    expect(cancelled.categoryId).toBe(categoryId);
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
  });

  it('does not fail assignment when listing invalidation fails', async () => {
    const promotion = await createUnassignedPromotion();
    const invalidator = createInvalidator();
    vi.mocked(invalidator.invalidateListings).mockRejectedValueOnce(
      new Error('Redis unavailable'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      assignPromotion(promotion.id, { type: 'CATEGORY', id: categoryId }, invalidator),
    ).resolves.toMatchObject({ categoryId });
  });
});
