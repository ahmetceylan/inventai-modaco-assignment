import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  categoryPromotionVersionKey,
  productDetailCacheKey,
  productVersionKey,
} from '../src/cache/product-cache-keys.js';
import { runRedisOperation } from '../src/cache/redis-client.js';
import { prisma } from '../src/config/prisma.js';
import { DiscountType } from '../src/generated/prisma/client.js';

interface ProductJson {
  id: string;
  name: string;
  sku: string;
  basePrice: string;
  effectivePrice: string;
  stockQuantity: number;
  category: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
}

interface ProductListJson {
  data: ProductJson[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

interface ProductDetailJson {
  data: ProductJson;
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    details: unknown[];
  };
}

function parseBody<T>(text: string): T {
  return JSON.parse(text) as T;
}

const categoryIds = {
  accessories: '00000000-0000-4000-8000-000000000001',
  clothing: '00000000-0000-4000-8000-000000000002',
  empty: '00000000-0000-4000-8000-000000000003',
} as const;

const productIds = {
  first: '10000000-0000-4000-8000-000000000001',
  second: '20000000-0000-4000-8000-000000000002',
  third: '30000000-0000-4000-8000-000000000003',
} as const;

async function clearCatalog(): Promise<void> {
  await prisma.promotion.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
}

async function seedCatalog(): Promise<void> {
  await prisma.category.createMany({
    data: [
      { id: categoryIds.accessories, name: 'Accessories' },
      { id: categoryIds.clothing, name: 'Clothing' },
      { id: categoryIds.empty, name: 'Empty' },
    ],
  });

  await prisma.product.createMany({
    data: [
      {
        id: productIds.third,
        name: 'Third',
        sku: 'SKU-003',
        basePrice: '30.00',
        stockQuantity: 3,
        categoryId: categoryIds.accessories,
      },
      {
        id: productIds.first,
        name: 'First',
        sku: 'SKU-001',
        basePrice: '1234567890.10',
        stockQuantity: 1,
        categoryId: categoryIds.accessories,
      },
      {
        id: productIds.second,
        name: 'Second',
        sku: 'SKU-002',
        basePrice: '20.25',
        stockQuantity: 2,
        categoryId: categoryIds.clothing,
      },
    ],
  });
}

interface PromotionSeed {
  discountType?: DiscountType;
  value?: string;
  startAt?: Date;
  endAt?: Date;
  cancelledAt?: Date;
  productId?: string;
  categoryId?: string;
  id?: string;
}

async function seedPromotion(overrides: PromotionSeed = {}): Promise<void> {
  await prisma.promotion.create({
    data: {
      id: overrides.id,
      name: 'Pricing promotion',
      discountType: overrides.discountType ?? DiscountType.PERCENTAGE,
      value: overrides.value ?? '20.00',
      startAt: overrides.startAt ?? new Date('2030-06-01T00:00:00.000Z'),
      endAt: overrides.endAt ?? new Date('2030-08-01T00:00:00.000Z'),
      cancelledAt: overrides.cancelledAt,
      productId: overrides.productId,
      categoryId: overrides.categoryId,
    },
  });
}

describe('Product read endpoints', () => {
  const app = createApp();

  beforeEach(async () => {
    await runRedisOperation((client) =>
      client.del([
        ...Object.values(productIds).flatMap((id) => [
          productDetailCacheKey(id),
          productVersionKey(id),
        ]),
        ...Object.values(categoryIds).map(categoryPromotionVersionKey),
      ]),
    );
    await clearCatalog();
    await seedCatalog();
  });

  afterEach(clearCatalog);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('GET /products', () => {
    it('returns the default first page in deterministic ID order', async () => {
      const response = await request(app).get('/products');
      const body = parseBody<ProductListJson>(response.text);

      expect(response.status).toBe(200);
      expect(body.data.map((product) => product.id)).toEqual([
        productIds.first,
        productIds.second,
        productIds.third,
      ]);
      expect(body.pagination).toEqual({
        page: 1,
        pageSize: 20,
        totalItems: 3,
        totalPages: 1,
      });
    });

    it('includes category and preserves decimal prices as strings', async () => {
      const response = await request(app).get('/products');
      const body = parseBody<ProductListJson>(response.text);

      expect(response.status).toBe(200);
      expect(body.data[0]).toMatchObject({
        id: productIds.first,
        basePrice: '1234567890.10',
        effectivePrice: '1234567890.10',
        category: {
          id: categoryIds.accessories,
          name: 'Accessories',
        },
      });
      expect(body.data[0]?.createdAt).toEqual(expect.any(String));
      expect(body.data[0]?.updatedAt).toEqual(expect.any(String));
    });

    it('filters by category before pagination', async () => {
      const response = await request(app)
        .get('/products')
        .query({ categoryId: categoryIds.accessories, pageSize: 1 });
      const body = parseBody<ProductListJson>(response.text);

      expect(response.status).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.id).toBe(productIds.first);
      expect(body.pagination).toEqual({
        page: 1,
        pageSize: 1,
        totalItems: 2,
        totalPages: 2,
      });
    });

    it('returns the requested page with correct metadata', async () => {
      const response = await request(app).get('/products').query({ page: 2, pageSize: 2 });
      const body = parseBody<ProductListJson>(response.text);

      expect(response.status).toBe(200);
      expect(body.data.map((product) => product.id)).toEqual([productIds.third]);
      expect(body.pagination).toEqual({
        page: 2,
        pageSize: 2,
        totalItems: 3,
        totalPages: 2,
      });
    });

    it.each(['0', '-1', '1.5', 'text'])('rejects invalid page %s', async (page) => {
      const response = await request(app).get('/products').query({ page });
      const body = parseBody<ErrorJson>(response.text);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it.each(['0', '-1', '1.5', 'text'])('rejects invalid pageSize %s', async (pageSize) => {
      const response = await request(app).get('/products').query({ pageSize });
      const body = parseBody<ErrorJson>(response.text);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a pageSize above 100', async () => {
      const response = await request(app).get('/products').query({ pageSize: 101 });
      const body = parseBody<ErrorJson>(response.text);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an invalid category UUID', async () => {
      const response = await request(app).get('/products').query({ categoryId: 'invalid' });
      const body = parseBody<ErrorJson>(response.text);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns an empty page for a valid category without products', async () => {
      const response = await request(app).get('/products').query({ categoryId: categoryIds.empty });
      const body = parseBody<ProductListJson>(response.text);

      expect(response.status).toBe(200);
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        page: 1,
        pageSize: 20,
        totalItems: 0,
        totalPages: 0,
      });
    });
  });

  describe('GET /products/:id', () => {
    it('returns an existing product with category and unchanged effective price', async () => {
      const response = await request(app).get(`/products/${productIds.first}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        id: productIds.first,
        name: 'First',
        sku: 'SKU-001',
        basePrice: '1234567890.10',
        effectivePrice: '1234567890.10',
        stockQuantity: 1,
        category: {
          id: categoryIds.accessories,
          name: 'Accessories',
        },
      });
    });

    it('returns 404 for an unknown valid UUID', async () => {
      const response = await request(app).get('/products/ffffffff-ffff-4fff-8fff-ffffffffffff');
      const body = parseBody<ErrorJson>(response.text);

      expect(response.status).toBe(404);
      expect(body).toEqual({
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: 'Product not found',
          details: [],
        },
      });
    });

    it('returns 400 for an invalid UUID', async () => {
      const response = await request(app).get('/products/not-a-uuid');
      const body = parseBody<ErrorJson>(response.text);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('effective price resolution', () => {
    const evaluationTime = new Date('2030-07-01T00:00:00.000Z');
    const activeStart = new Date('2030-06-01T00:00:00.000Z');
    const activeEnd = new Date('2030-08-01T00:00:00.000Z');

    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(evaluationTime.getTime());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns the base price when no Promotion is active', async () => {
      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(response.status).toBe(200);
      expect(body.data.basePrice).toBe('20.25');
      expect(body.data.effectivePrice).toBe('20.25');
    });

    it('applies an active Product Promotion', async () => {
      await seedPromotion({ productId: productIds.second });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('16.20');
    });

    it('applies an active Category Promotion', async () => {
      await seedPromotion({
        categoryId: categoryIds.accessories,
        value: '10.00',
      });

      const response = await request(app).get(`/products/${productIds.third}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('27.00');
    });

    it('gives a Product Promotion precedence over a Category Promotion', async () => {
      await seedPromotion({
        categoryId: categoryIds.clothing,
        discountType: DiscountType.FIXED,
        value: '1.00',
      });
      await seedPromotion({
        productId: productIds.second,
        value: '20.00',
      });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('16.20');
    });

    it('uses a Product Promotion even when the Category Promotion is more advantageous', async () => {
      await seedPromotion({
        categoryId: categoryIds.clothing,
        value: '90.00',
      });
      await seedPromotion({
        productId: productIds.second,
        discountType: DiscountType.FIXED,
        value: '1.00',
      });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('19.25');
    });

    it('ignores a future Promotion', async () => {
      await seedPromotion({
        productId: productIds.second,
        startAt: new Date('2030-07-01T00:00:00.001Z'),
        endAt: activeEnd,
      });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('20.25');
    });

    it('ignores an expired Promotion', async () => {
      await seedPromotion({
        productId: productIds.second,
        startAt: activeStart,
        endAt: new Date('2030-06-30T23:59:59.999Z'),
      });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('20.25');
    });

    it('ignores a cancelled Promotion', async () => {
      await seedPromotion({
        productId: productIds.second,
        cancelledAt: new Date('2030-06-15T00:00:00.000Z'),
      });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('20.25');
    });

    it('treats a Promotion as active exactly at startAt', async () => {
      await seedPromotion({
        productId: productIds.second,
        startAt: evaluationTime,
        endAt: activeEnd,
      });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('16.20');
    });

    it('treats a Promotion as inactive exactly at endAt', async () => {
      await seedPromotion({
        productId: productIds.second,
        startAt: activeStart,
        endAt: evaluationTime,
      });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('20.25');
    });

    it('floors a fixed discount at zero', async () => {
      await seedPromotion({
        productId: productIds.second,
        discountType: DiscountType.FIXED,
        value: '100.00',
      });

      const response = await request(app).get(`/products/${productIds.second}`);
      const body = parseBody<ProductDetailJson>(response.text);

      expect(body.data.effectivePrice).toBe('0.00');
    });

    it('batch-resolves prices for multiple Products in one page', async () => {
      await seedPromotion({
        productId: productIds.first,
        discountType: DiscountType.FIXED,
        value: '10.00',
      });
      await seedPromotion({
        categoryId: categoryIds.accessories,
        value: '10.00',
      });
      await seedPromotion({
        categoryId: categoryIds.clothing,
        value: '20.00',
      });

      const response = await request(app).get('/products');
      const body = parseBody<ProductListJson>(response.text);
      const prices = new Map(body.data.map((product) => [product.id, product.effectivePrice]));

      expect(prices).toEqual(
        new Map([
          [productIds.first, '1234567880.10'],
          [productIds.second, '16.20'],
          [productIds.third, '27.00'],
        ]),
      );
    });

    it('returns the same effective price from listing and detail at one evaluation time', async () => {
      await seedPromotion({
        productId: productIds.second,
        value: '15.00',
      });

      const listResponse = await request(app).get('/products');
      const detailResponse = await request(app).get(`/products/${productIds.second}`);
      const listBody = parseBody<ProductListJson>(listResponse.text);
      const detailBody = parseBody<ProductDetailJson>(detailResponse.text);
      const listed = listBody.data.find(({ id }) => id === productIds.second);

      expect(listed?.effectivePrice).toBe('17.21');
      expect(detailBody.data.effectivePrice).toBe(listed?.effectivePrice);
    });
  });
});
