import { prisma } from '../config/prisma.js';
import { type Prisma } from '../generated/prisma/client.js';
import {
  calculateEffectivePrice,
  type PricePromotion,
} from '../pricing/calculate-effective-price.js';
import {
  mapEffectivePriceRows,
  queryProductsByEffectivePrice,
} from './product-effective-price.query.js';
import { type ProductListQuery } from './product.schemas.js';

export const productSelect = {
  id: true,
  name: true,
  sku: true,
  basePrice: true,
  stockQuantity: true,
  createdAt: true,
  updatedAt: true,
  category: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.ProductSelect;

export type ProductRecord = Prisma.ProductGetPayload<{ select: typeof productSelect }>;
export type PricedProductRecord = ProductRecord & { effectivePrice: Prisma.Decimal };

export interface ProductPage {
  products: PricedProductRecord[];
  totalItems: number;
}

const productPromotionSelect = {
  id: true,
  discountType: true,
  value: true,
  startAt: true,
  productId: true,
} satisfies Prisma.PromotionSelect;

const categoryPromotionSelect = {
  id: true,
  discountType: true,
  value: true,
  startAt: true,
  categoryId: true,
} satisfies Prisma.PromotionSelect;

export const listProducts = async (
  query: ProductListQuery,
  evaluationTime: Date,
): Promise<ProductPage> => {
  const where: Prisma.ProductWhereInput =
    query.categoryId === undefined ? {} : { categoryId: query.categoryId };

  if (query.sort === 'effectivePrice') {
    const [totalItems, rows] = await prisma.$transaction([
      prisma.product.count({ where }),
      queryProductsByEffectivePrice({
        ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
        order: query.order ?? 'asc',
        evaluationTime,
        offset: (query.page - 1) * query.pageSize,
        limit: query.pageSize,
      }),
    ]);

    return {
      products: mapEffectivePriceRows(rows),
      totalItems,
    };
  }

  const [totalItems, products] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { id: 'asc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: productSelect,
    }),
  ]);

  return {
    products: await enrichProductsWithPricing(products, evaluationTime),
    totalItems,
  };
};

export const getProductById = async (
  id: string,
  evaluationTime: Date,
): Promise<PricedProductRecord | null> => {
  const product = await prisma.product.findUnique({
    where: { id },
    select: productSelect,
  });

  if (product === null) {
    return null;
  }

  const [pricedProduct] = await enrichProductsWithPricing([product], evaluationTime);
  return pricedProduct ?? null;
};

const enrichProductsWithPricing = async (
  products: ProductRecord[],
  evaluationTime: Date,
): Promise<PricedProductRecord[]> => {
  if (products.length === 0) {
    return [];
  }

  const productIds = products.map(({ id }) => id);
  const categoryIds = [...new Set(products.map(({ category }) => category.id))];
  const activeAtEvaluationTime = {
    cancelledAt: null,
    startAt: { lte: evaluationTime },
    endAt: { gt: evaluationTime },
  } satisfies Prisma.PromotionWhereInput;

  const [productPromotions, categoryPromotions] = await Promise.all([
    prisma.promotion.findMany({
      where: {
        ...activeAtEvaluationTime,
        productId: { in: productIds },
      },
      select: productPromotionSelect,
      orderBy: [{ startAt: 'desc' }, { id: 'asc' }],
    }),
    prisma.promotion.findMany({
      where: {
        ...activeAtEvaluationTime,
        categoryId: { in: categoryIds },
      },
      select: categoryPromotionSelect,
      orderBy: [{ startAt: 'desc' }, { id: 'asc' }],
    }),
  ]);

  const productPromotionByTarget = new Map<string, PricePromotion>();
  const categoryPromotionByTarget = new Map<string, PricePromotion>();

  // Assignment rules should prevent duplicates. Keeping the first row from the
  // explicit ordering gives deterministic fallback behavior for legacy or
  // concurrently-created overlapping data until database exclusion constraints exist.
  for (const promotion of productPromotions) {
    if (promotion.productId !== null && !productPromotionByTarget.has(promotion.productId)) {
      productPromotionByTarget.set(promotion.productId, promotion);
    }
  }

  for (const promotion of categoryPromotions) {
    if (promotion.categoryId !== null && !categoryPromotionByTarget.has(promotion.categoryId)) {
      categoryPromotionByTarget.set(promotion.categoryId, promotion);
    }
  }

  return products.map((product) => {
    const promotion =
      productPromotionByTarget.get(product.id) ??
      categoryPromotionByTarget.get(product.category.id) ??
      null;

    return {
      ...product,
      effectivePrice: calculateEffectivePrice(product.basePrice, promotion),
    };
  });
};
