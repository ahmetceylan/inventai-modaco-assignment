import { createReadStream } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { env } from '../config/env.js';
import {
  applyImportPricingRule,
  assertSupportedPricingRuleVersion,
} from './import-pricing-rule.js';
import {
  ChunkProcessingError,
  type ClaimedImportChunk,
  type InvalidProductRow,
  type ParsedChunkRows,
  type ValidProductRow,
} from './process-import-chunk.types.js';

const MAX_STOCK_QUANTITY = 2_147_483_647;

const resolveChunkPath = (storedPath: string): string => {
  const absolutePath = resolve(env.IMPORT_STORAGE_PATH, storedPath);
  const relativePath = relative(env.IMPORT_STORAGE_PATH, absolutePath);

  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new ChunkProcessingError('CHUNK_FILE_NOT_FOUND', 'Prepared chunk file is unavailable');
  }

  return absolutePath;
};

const isStringRecord = (value: unknown): value is Record<string, string> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((field) => typeof field === 'string')
  );
};

const parseNdjsonEnvelope = (line: string): { rowNumber: number; data: Record<string, string> } => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new ChunkProcessingError('MALFORMED_NDJSON', 'Prepared chunk contains invalid NDJSON');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('rowNumber' in parsed) ||
    !('data' in parsed) ||
    !Number.isInteger(parsed.rowNumber) ||
    typeof parsed.rowNumber !== 'number' ||
    parsed.rowNumber < 1 ||
    !isStringRecord(parsed.data)
  ) {
    throw new ChunkProcessingError(
      'MALFORMED_NDJSON',
      'Prepared chunk contains an invalid row envelope',
    );
  }

  return { rowNumber: parsed.rowNumber, data: parsed.data };
};

const invalidRow = (
  rowNumber: number,
  data: Record<string, string>,
  errorCode: string,
  errorMessage: string,
  sku: string | null = null,
): InvalidProductRow => {
  return { rowNumber, sku, rawData: data, errorCode, errorMessage };
};

const validateProductRow = (
  rowNumber: number,
  data: Record<string, string>,
  pricingRuleVersion: string,
  acceptedSkus: Set<string>,
): ValidProductRow | InvalidProductRow => {
  const sku = (data.sku ?? '').trim();
  const name = (data.name ?? '').trim();
  const category = (data.category ?? '').trim();

  if (sku === '') {
    return invalidRow(rowNumber, data, 'INVALID_SKU', 'SKU must not be empty');
  }

  if (name === '') {
    return invalidRow(
      rowNumber,
      data,
      'INVALID_PRODUCT_NAME',
      'Product name must not be empty',
      sku,
    );
  }

  if (category === '') {
    return invalidRow(rowNumber, data, 'INVALID_CATEGORY', 'Category must not be empty', sku);
  }

  const basePrice = applyImportPricingRule(pricingRuleVersion, data.basePrice ?? '');
  if (basePrice === null) {
    return invalidRow(
      rowNumber,
      data,
      'INVALID_BASE_PRICE',
      'Base price must be a non-negative decimal',
      sku,
    );
  }

  const stockValue = (data.stockQuantity ?? '').trim();
  const stockQuantity = Number(stockValue);
  if (
    !/^(0|[1-9]\d*)$/.test(stockValue) ||
    !Number.isSafeInteger(stockQuantity) ||
    stockQuantity > MAX_STOCK_QUANTITY
  ) {
    return invalidRow(
      rowNumber,
      data,
      'INVALID_STOCK_QUANTITY',
      'Stock quantity must be a non-negative integer',
      sku,
    );
  }

  if (acceptedSkus.has(sku)) {
    return invalidRow(
      rowNumber,
      data,
      'DUPLICATE_SKU_IN_CHUNK',
      'SKU appears more than once in this chunk',
      sku,
    );
  }

  acceptedSkus.add(sku);
  return { rowNumber, sku, name, category, basePrice, stockQuantity };
};

export const readChunkRows = async (chunk: ClaimedImportChunk): Promise<ParsedChunkRows> => {
  assertSupportedPricingRuleVersion(chunk.pricingRuleVersion);

  const input = createReadStream(resolveChunkPath(chunk.storagePath));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const validRows: ValidProductRow[] = [];
  const invalidRows: InvalidProductRow[] = [];
  const acceptedSkus = new Set<string>();
  let lineCount = 0;

  for await (const line of lines) {
    if (line === '') {
      throw new ChunkProcessingError('MALFORMED_NDJSON', 'Prepared chunk contains an empty line');
    }

    lineCount += 1;
    const { rowNumber, data } = parseNdjsonEnvelope(line);
    const result = validateProductRow(rowNumber, data, chunk.pricingRuleVersion, acceptedSkus);

    if ('errorCode' in result) {
      invalidRows.push(result);
    } else {
      validRows.push(result);
    }
  }

  if (lineCount !== chunk.rowCount) {
    throw new ChunkProcessingError(
      'MALFORMED_NDJSON',
      'Prepared chunk row count does not match its metadata',
    );
  }

  return { validRows, invalidRows };
};
