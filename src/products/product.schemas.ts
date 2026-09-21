import { validationError } from '../http/errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProductListQuery {
  page: number;
  pageSize: number;
  categoryId?: string;
  sort?: 'effectivePrice';
  order?: 'asc' | 'desc';
}

function parsePositiveInteger(value: unknown, field: string, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw validationError([{ field, message: 'Must be a positive integer' }]);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw validationError([{ field, message: 'Must be a positive integer' }]);
  }

  return parsed;
}

export function parseProductListQuery(query: Record<string, unknown>): ProductListQuery {
  const page = parsePositiveInteger(query.page, 'page', 1);
  const pageSize = parsePositiveInteger(query.pageSize, 'pageSize', 20);

  if (pageSize > 100) {
    throw validationError([{ field: 'pageSize', message: 'Must be between 1 and 100' }]);
  }

  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    throw validationError([{ field: 'page', message: 'Is too large' }]);
  }

  const categoryId = query.categoryId;

  if (
    categoryId !== undefined &&
    (typeof categoryId !== 'string' || !UUID_PATTERN.test(categoryId))
  ) {
    throw validationError([{ field: 'categoryId', message: 'Must be a valid UUID' }]);
  }

  const sort = query.sort;
  const order = query.order;

  if (sort === undefined && order !== undefined) {
    throw validationError([{ field: 'order', message: 'Requires sort=effectivePrice' }]);
  }

  if (sort !== undefined && sort !== 'effectivePrice') {
    throw validationError([{ field: 'sort', message: 'Must be effectivePrice' }]);
  }

  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    throw validationError([{ field: 'order', message: 'Must be asc or desc' }]);
  }

  return {
    page,
    pageSize,
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(sort === 'effectivePrice' ? { sort, order: order ?? 'asc' } : {}),
  };
}

export function parseProductId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw validationError([{ field: 'id', message: 'Must be a valid UUID' }]);
  }

  return id;
}
