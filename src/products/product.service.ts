import { prisma } from '../config/prisma.js';
import { type Prisma } from '../generated/prisma/client.js';
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

export interface ProductPage {
  products: ProductRecord[];
  totalItems: number;
}

export async function listProducts(query: ProductListQuery): Promise<ProductPage> {
  const where: Prisma.ProductWhereInput =
    query.categoryId === undefined ? {} : { categoryId: query.categoryId };

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

  return { products, totalItems };
}

export function getProductById(id: string): Promise<ProductRecord | null> {
  return prisma.product.findUnique({
    where: { id },
    select: productSelect,
  });
}
