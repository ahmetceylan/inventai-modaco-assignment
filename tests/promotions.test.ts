import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';

interface PromotionJson {
  id: string;
  name: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  value: string;
  startAt: string;
  endAt: string;
  cancelledAt: string | null;
  target: { type: 'PRODUCT' | 'CATEGORY'; id: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface PromotionResponseJson {
  data: PromotionJson;
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    details: unknown[];
  };
}

interface CreatePromotionBody {
  name: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  value: unknown;
  startAt: string;
  endAt: string;
  productId?: string;
  categoryId?: string;
}

const categoryIds = {
  first: '40000000-0000-4000-8000-000000000001',
  second: '40000000-0000-4000-8000-000000000002',
} as const;

const productIds = {
  first: '50000000-0000-4000-8000-000000000001',
  second: '50000000-0000-4000-8000-000000000002',
} as const;

const unknownId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const defaultPromotion: CreatePromotionBody = {
  name: 'Summer Sale',
  discountType: 'PERCENTAGE',
  value: '20.00',
  startAt: '2030-06-01T00:00:00.000Z',
  endAt: '2030-07-01T00:00:00.000Z',
};

function parseBody<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

async function clearDatabase(): Promise<void> {
  await prisma.promotion.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
}

async function seedTargets(): Promise<void> {
  await prisma.category.createMany({
    data: [
      { id: categoryIds.first, name: 'Accessories' },
      { id: categoryIds.second, name: 'Clothing' },
    ],
  });
  await prisma.product.createMany({
    data: [
      {
        id: productIds.first,
        name: 'Bag',
        sku: 'PROMO-SKU-001',
        basePrice: '100.00',
        stockQuantity: 10,
        categoryId: categoryIds.first,
      },
      {
        id: productIds.second,
        name: 'Shirt',
        sku: 'PROMO-SKU-002',
        basePrice: '50.00',
        stockQuantity: 5,
        categoryId: categoryIds.second,
      },
    ],
  });
}

describe('Promotion management endpoints', () => {
  const app = createApp();

  beforeEach(async () => {
    await clearDatabase();
    await seedTargets();
  });

  afterEach(clearDatabase);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createPromotion(
    overrides: Partial<CreatePromotionBody> = {},
  ): Promise<PromotionJson> {
    const response = await request(app)
      .post('/promotions')
      .send({ ...defaultPromotion, ...overrides });

    expect(response.status).toBe(201);
    return parseBody<PromotionResponseJson>(response).data;
  }

  describe('POST /promotions', () => {
    it('creates a valid percentage promotion unassigned', async () => {
      const response = await request(app)
        .post('/promotions')
        .send({ ...defaultPromotion, name: '  Summer Sale  ' });
      const body = parseBody<PromotionResponseJson>(response);

      expect(response.status).toBe(201);
      expect(body.data).toMatchObject({
        name: 'Summer Sale',
        discountType: 'PERCENTAGE',
        value: '20.00',
        startAt: defaultPromotion.startAt,
        endAt: defaultPromotion.endAt,
        cancelledAt: null,
        target: null,
      });
      expect(body.data.createdAt).toEqual(expect.any(String));
      expect(body.data.updatedAt).toEqual(expect.any(String));
    });

    it('creates a valid fixed promotion', async () => {
      const promotion = await createPromotion({
        discountType: 'FIXED',
        value: '15.50',
      });

      expect(promotion.discountType).toBe('FIXED');
      expect(promotion.value).toBe('15.50');
      expect(promotion.target).toBeNull();
    });

    it('rejects an empty name', async () => {
      const response = await request(app)
        .post('/promotions')
        .send({ ...defaultPromotion, name: '   ' });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unsupported discount type', async () => {
      const response = await request(app)
        .post('/promotions')
        .send({ ...defaultPromotion, discountType: 'OTHER' });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it.each(['0', '0.00', '-0.01'])('rejects non-positive value %s', async (value) => {
      const response = await request(app)
        .post('/promotions')
        .send({ ...defaultPromotion, value });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a percentage value above 100', async () => {
      const response = await request(app)
        .post('/promotions')
        .send({ ...defaultPromotion, value: '100.01' });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it.each([20, '1e2', '20.001', '.50', '--1'])(
      'rejects malformed decimal value %s',
      async (value) => {
        const response = await request(app)
          .post('/promotions')
          .send({
            ...defaultPromotion,
            value,
          });

        expect(response.status).toBe(400);
        expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
      },
    );

    it('rejects malformed JSON', async () => {
      const response = await request(app)
        .post('/promotions')
        .set('Content-Type', 'application/json')
        .send('{"name":');

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an invalid timestamp', async () => {
      const response = await request(app)
        .post('/promotions')
        .send({ ...defaultPromotion, startAt: '2030-02-30T00:00:00.000Z' });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a date without an explicit timezone', async () => {
      const response = await request(app)
        .post('/promotions')
        .send({ ...defaultPromotion, startAt: '2030-06-01T00:00:00.000' });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it.each(['2030-06-01T00:00:00.000Z', '2030-05-31T23:59:59.000Z'])(
      'rejects endAt %s when it is not later than startAt',
      async (endAt) => {
        const response = await request(app)
          .post('/promotions')
          .send({
            ...defaultPromotion,
            startAt: '2030-06-01T00:00:00.000Z',
            endAt,
          });

        expect(response.status).toBe(400);
        expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
      },
    );

    it.each(['productId', 'categoryId'] as const)(
      'rejects target field %s during creation',
      async (targetField) => {
        const response = await request(app)
          .post('/promotions')
          .send({ ...defaultPromotion, [targetField]: unknownId });

        expect(response.status).toBe(400);
        expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
      },
    );
  });

  describe('POST /promotions/:id/assign', () => {
    it('assigns an unassigned promotion to a Product', async () => {
      const promotion = await createPromotion();
      const response = await request(app)
        .post(`/promotions/${promotion.id}/assign`)
        .send({ productId: productIds.first });

      expect(response.status).toBe(200);
      expect(parseBody<PromotionResponseJson>(response).data.target).toEqual({
        type: 'PRODUCT',
        id: productIds.first,
      });
    });

    it('assigns an unassigned promotion to a Category', async () => {
      const promotion = await createPromotion();
      const response = await request(app)
        .post(`/promotions/${promotion.id}/assign`)
        .send({ categoryId: categoryIds.first });

      expect(response.status).toBe(200);
      expect(parseBody<PromotionResponseJson>(response).data.target).toEqual({
        type: 'CATEGORY',
        id: categoryIds.first,
      });
    });

    it('rejects a body containing both target IDs', async () => {
      const promotion = await createPromotion();
      const response = await request(app).post(`/promotions/${promotion.id}/assign`).send({
        productId: productIds.first,
        categoryId: categoryIds.first,
      });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a body containing no target ID', async () => {
      const promotion = await createPromotion();
      const response = await request(app).post(`/promotions/${promotion.id}/assign`).send({});

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it.each([
      [{ productId: unknownId }, 'PRODUCT_NOT_FOUND'],
      [{ categoryId: unknownId }, 'CATEGORY_NOT_FOUND'],
    ])('returns 404 for an unknown target', async (target, code) => {
      const promotion = await createPromotion();
      const response = await request(app).post(`/promotions/${promotion.id}/assign`).send(target);

      expect(response.status).toBe(404);
      expect(parseBody<ErrorJson>(response).error.code).toBe(code);
    });

    it('returns 404 for an unknown Promotion', async () => {
      const response = await request(app)
        .post(`/promotions/${unknownId}/assign`)
        .send({ productId: productIds.first });

      expect(response.status).toBe(404);
      expect(parseBody<ErrorJson>(response).error.code).toBe('PROMOTION_NOT_FOUND');
    });

    it('returns 400 for an invalid Promotion UUID', async () => {
      const response = await request(app)
        .post('/promotions/not-a-uuid/assign')
        .send({ productId: productIds.first });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for an invalid target UUID', async () => {
      const promotion = await createPromotion();
      const response = await request(app)
        .post(`/promotions/${promotion.id}/assign`)
        .send({ productId: 'not-a-uuid' });

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects assignment of a cancelled Promotion', async () => {
      const promotion = await createPromotion();
      await request(app).post(`/promotions/${promotion.id}/cancel`);

      const response = await request(app)
        .post(`/promotions/${promotion.id}/assign`)
        .send({ productId: productIds.first });

      expect(response.status).toBe(409);
      expect(parseBody<ErrorJson>(response).error.code).toBe('PROMOTION_CANCELLED');
    });

    it('treats repeating assignment to the same target as idempotent', async () => {
      const promotion = await createPromotion();
      const path = `/promotions/${promotion.id}/assign`;
      const first = await request(app).post(path).send({ productId: productIds.first });
      const second = await request(app).post(path).send({ productId: productIds.first });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(parseBody<PromotionResponseJson>(second).data).toEqual(
        parseBody<PromotionResponseJson>(first).data,
      );
    });

    it('returns 409 when assigning to a different target', async () => {
      const promotion = await createPromotion();
      const path = `/promotions/${promotion.id}/assign`;
      await request(app).post(path).send({ productId: productIds.first });

      const response = await request(app).post(path).send({ productId: productIds.second });

      expect(response.status).toBe(409);
      expect(parseBody<ErrorJson>(response).error.code).toBe('PROMOTION_ALREADY_ASSIGNED');
    });

    it('returns 409 for overlapping Product promotions at the same Product', async () => {
      const existing = await createPromotion({
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-06-10T00:00:00.000Z',
      });
      await request(app)
        .post(`/promotions/${existing.id}/assign`)
        .send({ productId: productIds.first });
      const candidate = await createPromotion({
        startAt: '2026-06-05T00:00:00.000Z',
        endAt: '2026-06-15T00:00:00.000Z',
      });

      const response = await request(app)
        .post(`/promotions/${candidate.id}/assign`)
        .send({ productId: productIds.first });

      expect(response.status).toBe(409);
      expect(parseBody<ErrorJson>(response).error.code).toBe('PROMOTION_CONFLICT');
    });

    it('returns 409 for overlapping Category promotions at the same Category', async () => {
      const existing = await createPromotion();
      await request(app)
        .post(`/promotions/${existing.id}/assign`)
        .send({ categoryId: categoryIds.first });
      const candidate = await createPromotion({
        startAt: '2030-06-15T00:00:00.000Z',
        endAt: '2030-08-01T00:00:00.000Z',
      });

      const response = await request(app)
        .post(`/promotions/${candidate.id}/assign`)
        .send({ categoryId: categoryIds.first });

      expect(response.status).toBe(409);
      expect(parseBody<ErrorJson>(response).error.code).toBe('PROMOTION_CONFLICT');
    });

    it.each([
      ['Product', { productId: productIds.first }, { productId: productIds.first }],
      ['Category', { categoryId: categoryIds.first }, { categoryId: categoryIds.first }],
    ] as const)(
      'returns one 409 PROMOTION_CONFLICT for concurrent overlapping %s assignments',
      async (_scope, targetBody, assignedWhere) => {
        const first = await createPromotion({
          startAt: '2040-01-01T00:00:00.000Z',
          endAt: '2040-02-01T00:00:00.000Z',
        });
        const second = await createPromotion({
          startAt: '2040-01-15T00:00:00.000Z',
          endAt: '2040-02-15T00:00:00.000Z',
        });

        const responses = await Promise.all([
          request(app).post(`/promotions/${first.id}/assign`).send(targetBody),
          request(app).post(`/promotions/${second.id}/assign`).send(targetBody),
        ]);
        const success = responses.filter((response) => response.status === 200);
        const conflicts = responses.filter((response) => response.status === 409);

        expect(success).toHaveLength(1);
        expect(conflicts).toHaveLength(1);
        expect(parseBody<ErrorJson>(conflicts[0]!).error).toEqual({
          code: 'PROMOTION_CONFLICT',
          message: 'Promotion overlaps another promotion at the same target',
          details: [],
        });

        const assigned = await prisma.promotion.count({
          where: {
            ...assignedWhere,
            cancelledAt: null,
            startAt: { lt: new Date('2040-02-15T00:00:00.000Z') },
            endAt: { gt: new Date('2040-01-01T00:00:00.000Z') },
          },
        });
        expect(assigned).toBe(1);
      },
    );

    it('allows adjacent ranges under half-open interval semantics', async () => {
      const existing = await createPromotion({
        startAt: '2030-05-01T00:00:00.000Z',
        endAt: '2030-06-01T00:00:00.000Z',
      });
      await request(app)
        .post(`/promotions/${existing.id}/assign`)
        .send({ productId: productIds.first });
      const candidate = await createPromotion({
        startAt: '2030-06-01T00:00:00.000Z',
        endAt: '2030-07-01T00:00:00.000Z',
      });

      const response = await request(app)
        .post(`/promotions/${candidate.id}/assign`)
        .send({ productId: productIds.first });

      expect(response.status).toBe(200);
    });

    it('allows Product and Category promotions to overlap', async () => {
      const productPromotion = await createPromotion();
      await request(app)
        .post(`/promotions/${productPromotion.id}/assign`)
        .send({ productId: productIds.first });
      const categoryPromotion = await createPromotion();

      const response = await request(app)
        .post(`/promotions/${categoryPromotion.id}/assign`)
        .send({ categoryId: categoryIds.first });

      expect(response.status).toBe(200);
    });

    it('ignores cancelled Promotions during overlap checking', async () => {
      const cancelled = await createPromotion();
      await request(app)
        .post(`/promotions/${cancelled.id}/assign`)
        .send({ productId: productIds.first });
      await request(app).post(`/promotions/${cancelled.id}/cancel`);
      const candidate = await createPromotion();

      const response = await request(app)
        .post(`/promotions/${candidate.id}/assign`)
        .send({ productId: productIds.first });

      expect(response.status).toBe(200);
    });

    it('detects overlap between future-scheduled Promotions', async () => {
      const existing = await createPromotion({
        startAt: '2035-01-01T00:00:00.000Z',
        endAt: '2035-02-01T00:00:00.000Z',
      });
      await request(app)
        .post(`/promotions/${existing.id}/assign`)
        .send({ categoryId: categoryIds.second });
      const candidate = await createPromotion({
        startAt: '2035-01-15T00:00:00.000Z',
        endAt: '2035-03-01T00:00:00.000Z',
      });

      const response = await request(app)
        .post(`/promotions/${candidate.id}/assign`)
        .send({ categoryId: categoryIds.second });

      expect(response.status).toBe(409);
      expect(parseBody<ErrorJson>(response).error.code).toBe('PROMOTION_CONFLICT');
    });
  });

  describe('POST /promotions/:id/cancel', () => {
    it('cancels a scheduled Promotion without deleting it', async () => {
      const promotion = await createPromotion();

      const response = await request(app).post(`/promotions/${promotion.id}/cancel`);
      const body = parseBody<PromotionResponseJson>(response);
      const persisted = await prisma.promotion.findUnique({ where: { id: promotion.id } });

      expect(response.status).toBe(200);
      expect(body.data.cancelledAt).toEqual(expect.any(String));
      expect(persisted).not.toBeNull();
      expect(persisted?.cancelledAt?.toISOString()).toBe(body.data.cancelledAt);
    });

    it('is idempotent and preserves the original cancelledAt', async () => {
      const promotion = await createPromotion();
      const path = `/promotions/${promotion.id}/cancel`;
      const first = await request(app).post(path);
      const second = await request(app).post(path);
      const firstBody = parseBody<PromotionResponseJson>(first);
      const secondBody = parseBody<PromotionResponseJson>(second);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(secondBody.data.cancelledAt).toBe(firstBody.data.cancelledAt);
    });

    it('returns 404 for an unknown Promotion', async () => {
      const response = await request(app).post(`/promotions/${unknownId}/cancel`);

      expect(response.status).toBe(404);
      expect(parseBody<ErrorJson>(response).error.code).toBe('PROMOTION_NOT_FOUND');
    });

    it('returns 400 for an invalid UUID', async () => {
      const response = await request(app).post('/promotions/not-a-uuid/cancel');

      expect(response.status).toBe(400);
      expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    });
  });
});
