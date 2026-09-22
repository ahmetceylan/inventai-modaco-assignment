import { type PricedProductRecord } from './product.service.js';

export interface ProductResponse {
  id: string;
  name: string;
  sku: string;
  basePrice: string;
  effectivePrice: string;
  stockQuantity: number;
  category: {
    id: string;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
}

export const mapProduct = (product: PricedProductRecord): ProductResponse => {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    basePrice: product.basePrice.toFixed(2),
    effectivePrice: product.effectivePrice.toFixed(2),
    stockQuantity: product.stockQuantity,
    category: product.category,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
};
