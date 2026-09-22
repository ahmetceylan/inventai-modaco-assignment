import { prisma } from '../config/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { type PricedProductRecord } from './product.service.js';

interface EffectivePriceRow {
  id: string;
  name: string;
  sku: string;
  basePrice: Prisma.Decimal | string;
  effectivePrice: Prisma.Decimal | string;
  stockQuantity: number;
  categoryId: string;
  categoryName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EffectivePriceQuery {
  categoryId?: string;
  order: 'asc' | 'desc';
  evaluationTime: Date;
  offset: number;
  limit: number;
}

export const queryProductsByEffectivePrice = ({
  categoryId,
  order,
  evaluationTime,
  offset,
  limit,
}: EffectivePriceQuery): Prisma.PrismaPromise<EffectivePriceRow[]> => {
  const categoryFilter =
    categoryId === undefined
      ? Prisma.empty
      : Prisma.sql`AND product."categoryId" = ${categoryId}::uuid`;
  const sortDirection = order === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;

  // Effective price must be calculated and sorted across the full filtered
  // result set before pagination
  return prisma.$queryRaw<EffectivePriceRow[]>`
    SELECT
      product."id",
      product."name",
      product."sku",
      product."basePrice" AS "basePrice",
      product."stockQuantity" AS "stockQuantity",
      product."createdAt" AS "createdAt",
      product."updatedAt" AS "updatedAt",
      category."id" AS "categoryId",
      category."name" AS "categoryName",
      ROUND(
        GREATEST(
          CASE
            WHEN product_promotion."discountType" = 'PERCENTAGE' THEN
              product."basePrice" * (1 - product_promotion."value" / 100)
            WHEN product_promotion."discountType" = 'FIXED' THEN
              product."basePrice" - product_promotion."value"
            WHEN category_promotion."discountType" = 'PERCENTAGE' THEN
              product."basePrice" * (1 - category_promotion."value" / 100)
            WHEN category_promotion."discountType" = 'FIXED' THEN
              product."basePrice" - category_promotion."value"
            ELSE product."basePrice"
          END,
          0
        ),
        2
      ) AS "effectivePrice"
    FROM "Product" AS product
    INNER JOIN "Category" AS category
      ON category."id" = product."categoryId"
    LEFT JOIN LATERAL (
      SELECT
        promotion."id",
        promotion."discountType",
        promotion."value",
        promotion."startAt"
      FROM "Promotion" AS promotion
      WHERE promotion."productId" = product."id"
        AND promotion."cancelledAt" IS NULL
        AND promotion."startAt" <= ${evaluationTime}
        AND ${evaluationTime} < promotion."endAt"
      ORDER BY promotion."startAt" DESC, promotion."id" ASC
      LIMIT 1
    ) AS product_promotion ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        promotion."id",
        promotion."discountType",
        promotion."value",
        promotion."startAt"
      FROM "Promotion" AS promotion
      WHERE promotion."categoryId" = product."categoryId"
        AND promotion."cancelledAt" IS NULL
        AND promotion."startAt" <= ${evaluationTime}
        AND ${evaluationTime} < promotion."endAt"
      ORDER BY promotion."startAt" DESC, promotion."id" ASC
      LIMIT 1
    ) AS category_promotion ON TRUE
    WHERE TRUE
      ${categoryFilter}
    ORDER BY "effectivePrice" ${sortDirection}, product."id" ASC
    OFFSET ${offset}
    LIMIT ${limit}
  `;
};

export const mapEffectivePriceRows = (rows: EffectivePriceRow[]): PricedProductRecord[] => {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    basePrice: toDecimal(row.basePrice),
    effectivePrice: toDecimal(row.effectivePrice),
    stockQuantity: row.stockQuantity,
    category: {
      id: row.categoryId,
      name: row.categoryName,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
};

const toDecimal = (value: Prisma.Decimal | string): Prisma.Decimal => {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
};
