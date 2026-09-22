import { prisma } from '../config/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { HttpError } from '../http/errors.js';
import { type CreatePromotionInput, type PromotionTarget } from './promotion.schemas.js';

const overlapConstraintNames = [
  'no_overlapping_product_promotions',
  'no_overlapping_category_promotions',
] as const;

export const promotionSelect = {
  id: true,
  name: true,
  discountType: true,
  value: true,
  startAt: true,
  endAt: true,
  cancelledAt: true,
  productId: true,
  categoryId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PromotionSelect;

export type PromotionRecord = Prisma.PromotionGetPayload<{ select: typeof promotionSelect }>;

export const createPromotion = (input: CreatePromotionInput): Promise<PromotionRecord> => {
  return prisma.promotion.create({
    data: input,
    select: promotionSelect,
  });
};

export const assignPromotion = async (
  promotionId: string,
  target: PromotionTarget,
): Promise<PromotionRecord> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await prisma.$transaction(async (transaction) => {
        const promotion = await transaction.promotion.findUnique({
          where: { id: promotionId },
          select: promotionSelect,
        });

        if (promotion === null) {
          throw new HttpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
        }

        if (promotion.cancelledAt !== null) {
          throw new HttpError(409, 'PROMOTION_CANCELLED', 'Cancelled promotion cannot be assigned');
        }

        const sameTarget =
          (target.type === 'PRODUCT' &&
            promotion.productId === target.id &&
            promotion.categoryId === null) ||
          (target.type === 'CATEGORY' &&
            promotion.categoryId === target.id &&
            promotion.productId === null);

        if (sameTarget) {
          return promotion;
        }

        if (promotion.productId !== null || promotion.categoryId !== null) {
          throw new HttpError(
            409,
            'PROMOTION_ALREADY_ASSIGNED',
            'Promotion is already assigned to a different target',
          );
        }

        await assertTargetExists(transaction, target);

        const overlap = await transaction.promotion.findFirst({
          where: {
            id: { not: promotion.id },
            cancelledAt: null,
            startAt: { lt: promotion.endAt },
            endAt: { gt: promotion.startAt },
            ...(target.type === 'PRODUCT' ? { productId: target.id } : { categoryId: target.id }),
          },
          select: { id: true },
        });

        if (overlap !== null) {
          throw promotionConflictError();
        }

        return transaction.promotion.update({
          where: { id: promotion.id },
          data: target.type === 'PRODUCT' ? { productId: target.id } : { categoryId: target.id },
          select: promotionSelect,
        });
      });
    } catch (error) {
      if (isPromotionOverlapConstraintError(error)) {
        throw promotionConflictError();
      }

      // Simultaneous GiST exclusion checks can deadlock. Retry the complete small
      // transaction once so the winner becomes visible to the overlap pre-check.
      if (attempt === 0 && isPrismaWriteConflict(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('Promotion assignment retry exhausted');
};

export const cancelPromotion = async (promotionId: string): Promise<PromotionRecord> => {
  return prisma.$transaction(async (transaction) => {
    const promotion = await transaction.promotion.findUnique({
      where: { id: promotionId },
      select: promotionSelect,
    });

    if (promotion === null) {
      throw new HttpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
    }

    if (promotion.cancelledAt !== null) {
      return promotion;
    }

    await transaction.promotion.updateMany({
      where: {
        id: promotion.id,
        cancelledAt: null,
      },
      data: {
        cancelledAt: new Date(),
      },
    });

    const cancelled = await transaction.promotion.findUnique({
      where: { id: promotion.id },
      select: promotionSelect,
    });

    if (cancelled === null) {
      throw new HttpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
    }

    return cancelled;
  });
};

const assertTargetExists = async (
  transaction: Prisma.TransactionClient,
  target: PromotionTarget,
): Promise<void> => {
  if (target.type === 'PRODUCT') {
    const product = await transaction.product.findUnique({
      where: { id: target.id },
      select: { id: true },
    });

    if (product === null) {
      throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    return;
  }

  const category = await transaction.category.findUnique({
    where: { id: target.id },
    select: { id: true },
  });

  if (category === null) {
    throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  }
};

const promotionConflictError = (): HttpError => {
  return new HttpError(
    409,
    'PROMOTION_CONFLICT',
    'Promotion overlaps another promotion at the same target',
  );
};

const isPromotionOverlapConstraintError = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2039') {
    return false;
  }

  const adapterError = error.meta?.driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null || !('cause' in adapterError)) {
    return false;
  }

  const cause = adapterError.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause) || !('message' in cause)) {
    return false;
  }

  const message = cause.message;
  if (cause.code !== '23P01' || typeof message !== 'string') {
    return false;
  }

  return overlapConstraintNames.some((name) => message.includes(`exclusion constraint "${name}"`));
};

const isPrismaWriteConflict = (error: unknown): boolean => {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
};
