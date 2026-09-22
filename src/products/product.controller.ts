import { type Request, type Response } from 'express';
import { getProductDetailById } from '../cache/product-detail-cache.js';
import { getProductList } from '../cache/product-list-cache.js';
import { HttpError } from '../http/errors.js';
import { parseProductId, parseProductListQuery } from './product.schemas.js';

export const listProductController = async (req: Request, res: Response): Promise<void> => {
  const query = parseProductListQuery(req.query);
  const evaluationTime = new Date(Date.now());
  const result = await getProductList(query, evaluationTime);

  res.status(200).json(result);
};

export const getProductController = async (req: Request, res: Response): Promise<void> => {
  const id = parseProductId(req.params.id);
  const evaluationTime = new Date(Date.now());
  const product = await getProductDetailById(id, evaluationTime);

  if (product === null) {
    throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  }

  res.status(200).json({ data: product });
};
