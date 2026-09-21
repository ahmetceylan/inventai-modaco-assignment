import { Router } from 'express';
import { getProductController, listProductController } from './product.controller.js';

export const productRouter = Router();

productRouter.get('/products', listProductController);
productRouter.get('/products/:id', getProductController);
