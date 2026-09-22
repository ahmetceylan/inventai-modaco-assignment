import { UnsupportedPricingRuleError } from './import-pricing-rule.js';
import {
  claimPendingImportChunk,
  markChunkFailed,
  persistProcessedChunk,
} from './persist-import-chunk.js';
import {
  ChunkProcessingError,
  type ProcessChunkOptions,
  type ProcessChunkResult,
} from './process-import-chunk.types.js';
import { readChunkRows } from './read-import-chunk.js';

const normalizeChunkError = (error: unknown): ChunkProcessingError => {
  if (error instanceof ChunkProcessingError) {
    return error;
  }

  if (error instanceof UnsupportedPricingRuleError) {
    return new ChunkProcessingError(
      'UNSUPPORTED_PRICING_RULE',
      'Import job uses an unsupported pricing rule version',
    );
  }

  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return new ChunkProcessingError('CHUNK_FILE_NOT_FOUND', 'Prepared chunk file is unavailable');
  }

  return new ChunkProcessingError('CHUNK_PERSISTENCE_FAILED', 'Import chunk processing failed');
};

export const processNextImportChunk = async (
  options: ProcessChunkOptions = {},
): Promise<ProcessChunkResult | null> => {
  const chunk = await claimPendingImportChunk(options.jobId);

  if (chunk === null) {
    return null;
  }

  try {
    const rows = await readChunkRows(chunk);
    await persistProcessedChunk(chunk, rows);

    return {
      chunkId: chunk.id,
      importJobId: chunk.importJobId,
      succeededRows: rows.validRows.length,
      failedRows: rows.invalidRows.length,
    };
  } catch (error) {
    const chunkError = normalizeChunkError(error);
    await markChunkFailed(chunk, chunkError);
    throw chunkError;
  }
};

export { claimPendingImportChunk, ChunkProcessingError };
export type { ProcessChunkOptions, ProcessChunkResult };
