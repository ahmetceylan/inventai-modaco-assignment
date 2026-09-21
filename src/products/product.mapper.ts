import { type ProductRecord } from './product.service.js';

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

export function mapProduct(product: ProductRecord): ProductResponse {
  const basePrice = product.basePrice.toFixed(2);

  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    basePrice,
    effectivePrice: basePrice,
    stockQuantity: product.stockQuantity,
    category: product.category,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
