import { Router } from 'express';
import {
  assignPromotionController,
  cancelPromotionController,
  createPromotionController,
} from './promotion.controller.js';

export const promotionRouter = Router();

promotionRouter.post('/promotions', createPromotionController);
promotionRouter.post('/promotions/:id/assign', assignPromotionController);
promotionRouter.post('/promotions/:id/cancel', cancelPromotionController);
