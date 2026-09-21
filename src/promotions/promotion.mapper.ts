import { type PromotionRecord } from './promotion.service.js';

export interface PromotionResponse {
  id: string;
  name: string;
  discountType: string;
  value: string;
  startAt: string;
  endAt: string;
  cancelledAt: string | null;
  target: { type: 'PRODUCT' | 'CATEGORY'; id: string } | null;
  createdAt: string;
  updatedAt: string;
}

export function mapPromotion(promotion: PromotionRecord): PromotionResponse {
  const target =
    promotion.productId !== null
      ? { type: 'PRODUCT' as const, id: promotion.productId }
      : promotion.categoryId !== null
        ? { type: 'CATEGORY' as const, id: promotion.categoryId }
        : null;

  return {
    id: promotion.id,
    name: promotion.name,
    discountType: promotion.discountType,
    value: promotion.value.toFixed(2),
    startAt: promotion.startAt.toISOString(),
    endAt: promotion.endAt.toISOString(),
    cancelledAt: promotion.cancelledAt?.toISOString() ?? null,
    target,
    createdAt: promotion.createdAt.toISOString(),
    updatedAt: promotion.updatedAt.toISOString(),
  };
}
