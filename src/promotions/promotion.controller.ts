import { type Request, type Response } from 'express';
import { mapPromotion } from './promotion.mapper.js';
import {
  parseCreatePromotionBody,
  parsePromotionId,
  parsePromotionTarget,
} from './promotion.schemas.js';
import { assignPromotion, cancelPromotion, createPromotion } from './promotion.service.js';

export async function createPromotionController(req: Request, res: Response): Promise<void> {
  const input = parseCreatePromotionBody(req.body as unknown);
  const promotion = await createPromotion(input);

  res.status(201).json({ data: mapPromotion(promotion) });
}

export async function assignPromotionController(req: Request, res: Response): Promise<void> {
  const promotionId = parsePromotionId(req.params.id);
  const target = parsePromotionTarget(req.body as unknown);
  const promotion = await assignPromotion(promotionId, target);

  res.status(200).json({ data: mapPromotion(promotion) });
}

export async function cancelPromotionController(req: Request, res: Response): Promise<void> {
  const promotionId = parsePromotionId(req.params.id);
  const promotion = await cancelPromotion(promotionId);

  res.status(200).json({ data: mapPromotion(promotion) });
}
