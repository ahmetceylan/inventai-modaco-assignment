import { prisma } from '../config/prisma.js';
import { DiscountType, Prisma } from '../generated/prisma/client.js';
import { explainProductsByEffectivePrice } from '../products/product-effective-price.query.js';
import { assignPromotion, createPromotion } from '../promotions/promotion.service.js';
import {
  DEFAULT_FLASH_SALE_PRODUCTS,
  MAX_FLASH_SALE_PRODUCTS,
  PERF_CATEGORY_NAME,
  PERF_PRODUCT_SKU_PREFIX,
  PERF_PROMOTION_NAME,
  PRODUCT_SEED_BATCH_SIZE,
} from './constants.js';
import {
  assertAllowedFlags,
  parseFlags,
  PerfArgumentError,
  readBooleanFlag,
  readPositiveInteger,
} from './args.js';
import { assertReservedCleanupTarget, reservedCleanupTarget } from './reserved-cleanup.js';

export interface SeedFlashSaleOptions {
  products: number;
  cleanup: boolean;
  explain: boolean;
}

export interface SeedFlashSaleResult {
  categoryId: string;
  productCount: number;
  promotionId: string;
  createdPromotion: boolean;
  queryPlan?: string;
}

export const parseSeedFlashSaleOptions = (argv: string[]): SeedFlashSaleOptions => {
  const flags = parseFlags(argv);
  assertAllowedFlags(flags, ['products', 'cleanup', 'explain']);

  return {
    products: readPositiveInteger(
      flags,
      'products',
      DEFAULT_FLASH_SALE_PRODUCTS,
      MAX_FLASH_SALE_PRODUCTS,
    ),
    cleanup: readBooleanFlag(flags, 'cleanup'),
    explain: readBooleanFlag(flags, 'explain'),
  };
};

export const formatPerfSku = (index: number): string => {
  return `${PERF_PRODUCT_SKU_PREFIX}${String(index).padStart(6, '0')}`;
};

const ensureCategory = async (): Promise<{ id: string }> => {
  return prisma.category.upsert({
    where: { name: PERF_CATEGORY_NAME },
    create: { name: PERF_CATEGORY_NAME },
    update: {},
    select: { id: true },
  });
};

const seedProducts = async (categoryId: string, products: number): Promise<number> => {
  for (let start = 1; start <= products; start += PRODUCT_SEED_BATCH_SIZE) {
    const end = Math.min(start + PRODUCT_SEED_BATCH_SIZE - 1, products);
    const data = [];
    for (let index = start; index <= end; index += 1) {
      data.push({
        name: `Perf Product ${String(index).padStart(6, '0')}`,
        sku: formatPerfSku(index),
        basePrice: (10 + (index % 90)).toFixed(2),
        stockQuantity: 1 + (index % 100),
        categoryId,
      });
    }

    await prisma.product.createMany({
      data,
      skipDuplicates: true,
    });
  }

  return prisma.product.count({
    where: { sku: { startsWith: PERF_PRODUCT_SKU_PREFIX } },
  });
};

const ensurePromotion = async (
  categoryId: string,
): Promise<{ promotionId: string; createdPromotion: boolean }> => {
  const existing = await prisma.promotion.findFirst({
    where: {
      name: PERF_PROMOTION_NAME,
      cancelledAt: null,
    },
    select: { id: true, categoryId: true, productId: true },
  });

  if (existing?.categoryId === categoryId && existing.productId === null) {
    return { promotionId: existing.id, createdPromotion: false };
  }

  if (existing !== null && existing.categoryId === null && existing.productId === null) {
    const assigned = await assignPromotion(existing.id, { type: 'CATEGORY', id: categoryId });
    return { promotionId: assigned.id, createdPromotion: false };
  }

  const created = await createPromotion({
    name: PERF_PROMOTION_NAME,
    discountType: DiscountType.PERCENTAGE,
    value: new Prisma.Decimal('50.00'),
    startAt: new Date('2020-01-01T00:00:00.000Z'),
    endAt: new Date('2099-01-01T00:00:00.000Z'),
  });
  const assigned = await assignPromotion(created.id, { type: 'CATEGORY', id: categoryId });
  return { promotionId: assigned.id, createdPromotion: true };
};

export const cleanupFlashSaleData = async (): Promise<void> => {
  const target = reservedCleanupTarget();
  assertReservedCleanupTarget(target);

  const category = await prisma.category.findUnique({
    where: { name: target.categoryName },
    select: { id: true, name: true },
  });

  await prisma.promotion.deleteMany({
    where: { name: target.promotionName },
  });

  if (category === null) {
    await prisma.product.deleteMany({
      where: { sku: { startsWith: target.skuPrefix } },
    });
    return;
  }

  if (category.name !== target.categoryName) {
    throw new PerfArgumentError('Refusing to delete a Category outside the reserved performance name');
  }

  const foreignProducts = await prisma.product.count({
    where: {
      categoryId: category.id,
      NOT: { sku: { startsWith: target.skuPrefix } },
    },
  });

  if (foreignProducts > 0) {
    throw new PerfArgumentError(
      'Refusing to delete PERF_ACCESSORIES because it contains non-performance Products',
    );
  }

  await prisma.product.deleteMany({
    where: { sku: { startsWith: target.skuPrefix } },
  });
  await prisma.category.delete({
    where: { id: category.id },
  });
};

export const seedFlashSale = async (
  options: SeedFlashSaleOptions,
): Promise<SeedFlashSaleResult | { cleaned: true }> => {
  if (options.cleanup) {
    await cleanupFlashSaleData();
    return { cleaned: true };
  }

  const category = await ensureCategory();
  const productCount = await seedProducts(category.id, options.products);
  const promotion = await ensurePromotion(category.id);
  const result: SeedFlashSaleResult = {
    categoryId: category.id,
    productCount,
    promotionId: promotion.promotionId,
    createdPromotion: promotion.createdPromotion,
  };

  if (options.explain) {
    const plan = await explainProductsByEffectivePrice({
      categoryId: category.id,
      order: 'asc',
      evaluationTime: new Date(),
      offset: 0,
      limit: 20,
    });
    result.queryPlan = plan.map((row) => row['QUERY PLAN']).join('\n');
  }

  return result;
};

export const formatSeedFlashSaleReport = (
  result: SeedFlashSaleResult | { cleaned: true },
): string => {
  if ('cleaned' in result) {
    return 'cleanup=completed\nscope=PERF_ACCESSORIES,PERFR-,PERF_FLASH_SALE';
  }

  return [
    `categoryId=${result.categoryId}`,
    `productCount=${result.productCount}`,
    `promotionId=${result.promotionId}`,
    `createdPromotion=${result.createdPromotion}`,
    'productUpdateOnPromotion=none',
    ...(result.queryPlan === undefined ? [] : ['queryPlanCaptured=true']),
  ].join('\n');
};
