import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { DiscountType } from '../src/generated/prisma/client.js';

interface ProductJson {
  id: string;
  basePrice: string;
  effectivePrice: string;
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

interface ErrorJson {
  error: {
    code: string;
  };
}

const categoryIds = {
  first: '70000000-0000-4000-8000-000000000001',
  second: '70000000-0000-4000-8000-000000000002',
} as const;

const productIds = {
  first: '71000000-0000-4000-8000-000000000001',
  second: '72000000-0000-4000-8000-000000000002',
  third: '73000000-0000-4000-8000-000000000003',
  fourth: '74000000-0000-4000-8000-000000000004',
  fifth: '75000000-0000-4000-8000-000000000005',
} as const;

const evaluationTime = new Date('2030-07-01T00:00:00.000Z');
const activeStart = new Date('2030-06-01T00:00:00.000Z');
const activeEnd = new Date('2030-08-01T00:00:00.000Z');

function parseBody<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function clearDatabase(): Promise<void> {
  await prisma.promotion.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
}

async function seedProducts(): Promise<void> {
  await prisma.category.createMany({
    data: [
      { id: categoryIds.first, name: 'First category' },
      { id: categoryIds.second, name: 'Second category' },
    ],
  });
  await prisma.product.createMany({
    data: [
      {
        id: productIds.first,
        name: 'First',
        sku: 'SORT-001',
        basePrice: '100.00',
        stockQuantity: 1,
        categoryId: categoryIds.first,
      },
      {
        id: productIds.second,
        name: 'Second',
        sku: 'SORT-002',
        basePrice: '50.00',
        stockQuantity: 1,
        categoryId: categoryIds.first,
      },
      {
        id: productIds.third,
        name: 'Third',
        sku: 'SORT-003',
        basePrice: '99.99',
        stockQuantity: 1,
        categoryId: categoryIds.first,
      },
      {
        id: productIds.fourth,
        name: 'Fourth',
        sku: 'SORT-004',
        basePrice: '200.00',
        stockQuantity: 1,
        categoryId: categoryIds.second,
      },
      {
        id: productIds.fifth,
        name: 'Fifth',
        sku: 'SORT-005',
        basePrice: '10.00',
        stockQuantity: 1,
        categoryId: categoryIds.second,
      },
    ],
  });
}

interface PromotionSeed {
  id?: string;
  productId?: string;
  categoryId?: string;
  discountType?: DiscountType;
  value?: string;
  startAt?: Date;
  endAt?: Date;
  cancelledAt?: Date;
}

async function seedPromotion(overrides: PromotionSeed): Promise<void> {
  await prisma.promotion.create({
    data: {
      id: overrides.id,
      name: 'Sorting promotion',
      discountType: overrides.discountType ?? DiscountType.PERCENTAGE,
      value: overrides.value ?? '20.00',
      startAt: overrides.startAt ?? activeStart,
      endAt: overrides.endAt ?? activeEnd,
      cancelledAt: overrides.cancelledAt,
      productId: overrides.productId,
      categoryId: overrides.categoryId,
    },
  });
}

describe('GET /products effective-price sorting', () => {
  const app = createApp();

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(evaluationTime.getTime());
    await clearDatabase();
    await seedProducts();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('defaults effective-price sorting to ascending', async () => {
    const response = await request(app).get('/products').query({ sort: 'effectivePrice' });
    const body = parseBody<ProductListJson>(response.text);

    expect(response.status).toBe(200);
    expect(body.data.map(({ id }) => id)).toEqual([
      productIds.fifth,
      productIds.second,
      productIds.third,
      productIds.first,
      productIds.fourth,
    ]);
  });

  it('supports explicit ascending order', async () => {
    const response = await request(app)
      .get('/products')
      .query({ sort: 'effectivePrice', order: 'asc' });
    const body = parseBody<ProductListJson>(response.text);

    expect(response.status).toBe(200);
    expect(body.data[0]?.id).toBe(productIds.fifth);
    expect(body.data.at(-1)?.id).toBe(productIds.fourth);
  });

  it('supports descending order with Product ID as an ascending tie-breaker', async () => {
    await prisma.product.updateMany({
      where: { id: { in: [productIds.first, productIds.second] } },
      data: { basePrice: '100.00' },
    });

    const response = await request(app)
      .get('/products')
      .query({ categoryId: categoryIds.first, sort: 'effectivePrice', order: 'desc' });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.map(({ id }) => id)).toEqual([
      productIds.first,
      productIds.second,
      productIds.third,
    ]);
  });

  it('returns the base price when a Product has no Promotion', async () => {
    const response = await request(app).get('/products').query({ sort: 'effectivePrice' });
    const body = parseBody<ProductListJson>(response.text);
    const product = body.data.find(({ id }) => id === productIds.third);

    expect(product).toMatchObject({
      basePrice: '99.99',
      effectivePrice: '99.99',
    });
  });

  it('orders by an active Product Promotion', async () => {
    await seedPromotion({
      productId: productIds.fourth,
      discountType: DiscountType.FIXED,
      value: '195.00',
    });

    const response = await request(app).get('/products').query({ sort: 'effectivePrice' });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data[0]).toMatchObject({
      id: productIds.fourth,
      effectivePrice: '5.00',
    });
  });

  it('orders by an active Category Promotion', async () => {
    await seedPromotion({
      categoryId: categoryIds.second,
      value: '50.00',
    });

    const response = await request(app).get('/products').query({ sort: 'effectivePrice' });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.slice(0, 2)).toMatchObject([
      { id: productIds.fifth, effectivePrice: '5.00' },
      { id: productIds.second, effectivePrice: '50.00' },
    ]);
  });

  it('gives Product Promotion precedence over a more advantageous Category Promotion', async () => {
    await seedPromotion({
      categoryId: categoryIds.second,
      value: '50.00',
    });
    await seedPromotion({
      productId: productIds.fourth,
      discountType: DiscountType.FIXED,
      value: '1.00',
    });

    const response = await request(app).get('/products').query({ sort: 'effectivePrice' });
    const body = parseBody<ProductListJson>(response.text);
    const product = body.data.find(({ id }) => id === productIds.fourth);

    expect(product?.effectivePrice).toBe('199.00');
  });

  it('orders percentage and fixed discounts by their calculated results', async () => {
    await seedPromotion({
      productId: productIds.first,
      value: '50.00',
    });
    await seedPromotion({
      productId: productIds.second,
      discountType: DiscountType.FIXED,
      value: '10.00',
    });

    const response = await request(app).get('/products').query({
      categoryId: categoryIds.first,
      sort: 'effectivePrice',
    });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.map(({ id, effectivePrice }) => ({ id, effectivePrice }))).toEqual([
      { id: productIds.second, effectivePrice: '40.00' },
      { id: productIds.first, effectivePrice: '50.00' },
      { id: productIds.third, effectivePrice: '99.99' },
    ]);
  });

  it('sorts a fixed discount greater than base price as zero', async () => {
    await seedPromotion({
      productId: productIds.fourth,
      discountType: DiscountType.FIXED,
      value: '300.00',
    });

    const response = await request(app).get('/products').query({ sort: 'effectivePrice' });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data[0]).toMatchObject({
      id: productIds.fourth,
      effectivePrice: '0.00',
    });
  });

  it('ignores cancelled, future, and expired Promotions', async () => {
    await seedPromotion({
      productId: productIds.first,
      value: '90.00',
      cancelledAt: new Date('2030-06-15T00:00:00.000Z'),
    });
    await seedPromotion({
      productId: productIds.second,
      value: '90.00',
      startAt: new Date('2030-07-01T00:00:00.001Z'),
    });
    await seedPromotion({
      productId: productIds.third,
      value: '90.00',
      startAt: new Date('2030-05-01T00:00:00.000Z'),
      endAt: new Date('2030-06-30T23:59:59.999Z'),
    });

    const response = await request(app).get('/products').query({
      categoryId: categoryIds.first,
      sort: 'effectivePrice',
    });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.map(({ id, effectivePrice }) => ({ id, effectivePrice }))).toEqual([
      { id: productIds.second, effectivePrice: '50.00' },
      { id: productIds.third, effectivePrice: '99.99' },
      { id: productIds.first, effectivePrice: '100.00' },
    ]);
  });

  it('uses half-open startAt and endAt boundaries', async () => {
    await seedPromotion({
      productId: productIds.first,
      value: '90.00',
      startAt: evaluationTime,
    });
    await seedPromotion({
      productId: productIds.second,
      value: '90.00',
      endAt: evaluationTime,
    });

    const response = await request(app).get('/products').query({
      categoryId: categoryIds.first,
      sort: 'effectivePrice',
    });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.map(({ id, effectivePrice }) => ({ id, effectivePrice }))).toEqual([
      { id: productIds.first, effectivePrice: '10.00' },
      { id: productIds.second, effectivePrice: '50.00' },
      { id: productIds.third, effectivePrice: '99.99' },
    ]);
  });

  it('combines category filtering with sorting and matching pagination metadata', async () => {
    const response = await request(app).get('/products').query({
      categoryId: categoryIds.second,
      sort: 'effectivePrice',
    });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.map(({ id }) => id)).toEqual([productIds.fifth, productIds.fourth]);
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 2,
      totalPages: 1,
    });
  });

  it('sorts the full result set before applying pagination', async () => {
    await seedPromotion({
      productId: productIds.fourth,
      discountType: DiscountType.FIXED,
      value: '200.00',
    });

    const response = await request(app).get('/products').query({
      sort: 'effectivePrice',
      page: 1,
      pageSize: 2,
    });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.map(({ id }) => id)).toEqual([productIds.fourth, productIds.fifth]);
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 2,
      totalItems: 5,
      totalPages: 3,
    });
  });

  it('uses Product ID ascending for equal effective prices', async () => {
    await prisma.product.updateMany({
      where: { id: { in: [productIds.first, productIds.second] } },
      data: { basePrice: '100.00' },
    });

    const response = await request(app).get('/products').query({
      categoryId: categoryIds.first,
      sort: 'effectivePrice',
    });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.map(({ id }) => id)).toEqual([
      productIds.third,
      productIds.first,
      productIds.second,
    ]);
  });

  it('matches exact Decimal rounding for 99.99 with a 15 percent discount', async () => {
    await seedPromotion({
      productId: productIds.third,
      value: '15.00',
    });

    const response = await request(app).get('/products').query({
      categoryId: categoryIds.first,
      sort: 'effectivePrice',
    });
    const body = parseBody<ProductListJson>(response.text);
    const product = body.data.find(({ id }) => id === productIds.third);

    expect(product?.effectivePrice).toBe('84.99');
  });

  it('rejects an unsupported sort value', async () => {
    const response = await request(app).get('/products').query({ sort: 'name' });

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response.text).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unsupported order value', async () => {
    const response = await request(app)
      .get('/products')
      .query({ sort: 'effectivePrice', order: 'sideways' });

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response.text).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects order without sort', async () => {
    const response = await request(app).get('/products').query({ order: 'asc' });

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response.text).error.code).toBe('VALIDATION_ERROR');
  });

  it('preserves deterministic ID ordering when sort is omitted', async () => {
    await seedPromotion({
      productId: productIds.fourth,
      discountType: DiscountType.FIXED,
      value: '200.00',
    });

    const response = await request(app).get('/products').query({ page: 1, pageSize: 2 });
    const body = parseBody<ProductListJson>(response.text);

    expect(body.data.map(({ id }) => id)).toEqual([productIds.first, productIds.second]);
  });
});
