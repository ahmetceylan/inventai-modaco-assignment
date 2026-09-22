import { DiscountType, Prisma } from '../generated/prisma/client.js';
import { validationError, type ErrorDetail } from '../http/errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;

export interface CreatePromotionInput {
  name: string;
  discountType: DiscountType;
  value: Prisma.Decimal;
  startAt: Date;
  endAt: Date;
}

export type PromotionTarget = { type: 'PRODUCT'; id: string } | { type: 'CATEGORY'; id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown, field: string, details: ErrorDetail[]): Date | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: 'Must be a valid timestamp with an explicit timezone' });
    return undefined;
  }

  const match = TIMESTAMP_PATTERN.exec(value);

  if (match === null) {
    details.push({ field, message: 'Must be a valid timestamp with an explicit timezone' });
    return undefined;
  }

  const [, year, month, day, hour, minute, second, fraction = '', zone, offsetHour, offsetMinute] =
    match;
  const localTimestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0')),
  );
  const localDate = new Date(localTimestamp);
  const hasValidComponents =
    localDate.getUTCFullYear() === Number(year) &&
    localDate.getUTCMonth() === Number(month) - 1 &&
    localDate.getUTCDate() === Number(day) &&
    localDate.getUTCHours() === Number(hour) &&
    localDate.getUTCMinutes() === Number(minute) &&
    localDate.getUTCSeconds() === Number(second);
  const hasValidOffset = zone === 'Z' || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59);
  const parsed = new Date(value);

  if (!hasValidComponents || !hasValidOffset || Number.isNaN(parsed.getTime())) {
    details.push({ field, message: 'Must be a valid timestamp' });
    return undefined;
  }

  return parsed;
}

function parseValue(
  value: unknown,
  discountType: DiscountType | undefined,
  details: ErrorDetail[],
): Prisma.Decimal | undefined {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    details.push({
      field: 'value',
      message: 'Must be a decimal string with up to 2 decimal places',
    });
    return undefined;
  }

  const decimal = new Prisma.Decimal(value);

  if (decimal.lte(0)) {
    details.push({ field: 'value', message: 'Must be greater than zero' });
  } else if (discountType === DiscountType.PERCENTAGE && decimal.gt(100)) {
    details.push({ field: 'value', message: 'Must not exceed 100 for a percentage discount' });
  } else if (decimal.gt('9999999999.99')) {
    details.push({ field: 'value', message: 'Exceeds the supported decimal range' });
  }

  return decimal;
}

export function parseCreatePromotionBody(body: unknown): CreatePromotionInput {
  if (!isRecord(body)) {
    throw validationError([{ field: 'body', message: 'Must be a JSON object' }]);
  }

  const details: ErrorDetail[] = [];
  const allowedFields = new Set(['name', 'discountType', 'value', 'startAt', 'endAt']);

  for (const field of Object.keys(body)) {
    if (!allowedFields.has(field)) {
      details.push({ field, message: 'Is not allowed' });
    }
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';

  if (name === '') {
    details.push({ field: 'name', message: 'Must be a non-empty string' });
  }

  const discountType =
    body.discountType === DiscountType.PERCENTAGE || body.discountType === DiscountType.FIXED
      ? body.discountType
      : undefined;

  if (discountType === undefined) {
    details.push({ field: 'discountType', message: 'Must be PERCENTAGE or FIXED' });
  }

  const value = parseValue(body.value, discountType, details);
  const startAt = parseTimestamp(body.startAt, 'startAt', details);
  const endAt = parseTimestamp(body.endAt, 'endAt', details);

  if (startAt !== undefined && endAt !== undefined && startAt >= endAt) {
    details.push({ field: 'endAt', message: 'Must be later than startAt' });
  }

  if (
    details.length > 0 ||
    discountType === undefined ||
    value === undefined ||
    startAt === undefined ||
    endAt === undefined
  ) {
    throw validationError(details);
  }

  return { name, discountType, value, startAt, endAt };
}

export function parsePromotionTarget(body: unknown): PromotionTarget {
  if (!isRecord(body)) {
    throw validationError([{ field: 'body', message: 'Must be a JSON object' }]);
  }

  const keys = Object.keys(body);
  const hasProductId = Object.hasOwn(body, 'productId');
  const hasCategoryId = Object.hasOwn(body, 'categoryId');

  if (
    keys.some((field) => field !== 'productId' && field !== 'categoryId') ||
    hasProductId === hasCategoryId
  ) {
    throw validationError([
      { field: 'target', message: 'Exactly one of productId or categoryId must be provided' },
    ]);
  }

  if (hasProductId) {
    return { type: 'PRODUCT', id: parseUuid(body.productId, 'productId') };
  }

  return { type: 'CATEGORY', id: parseUuid(body.categoryId, 'categoryId') };
}

export function parsePromotionId(value: unknown): string {
  return parseUuid(value, 'id');
}

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw validationError([{ field, message: 'Must be a valid UUID' }]);
  }

  return value;
}
