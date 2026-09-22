import type { Prisma } from '../generated/prisma/client.js';

export interface ClaimedImportChunk {
  id: string;
  importJobId: string;
  storagePath: string;
  rowCount: number;
  pricingRuleVersion: string;
  workerId: string;
}

export interface ValidProductRow {
  rowNumber: number;
  sku: string;
  name: string;
  category: string;
  basePrice: Prisma.Decimal;
  stockQuantity: number;
}

export interface InvalidProductRow {
  rowNumber: number;
  sku: string | null;
  rawData: Record<string, string>;
  errorCode: string;
  errorMessage: string;
}

export interface ParsedChunkRows {
  validRows: ValidProductRow[];
  invalidRows: InvalidProductRow[];
}

export interface ProcessChunkOptions {
  jobId?: string;
}

export interface ProcessChunkResult {
  chunkId: string;
  importJobId: string;
  succeededRows: number;
  failedRows: number;
}

export class ChunkProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly rowNumber: number | null = null,
  ) {
    super(message);
  }
}
