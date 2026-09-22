import { UnsupportedPricingRuleError } from './import-pricing-rule.js';
import { logImportChunkEvent } from './import-chunk-logger.js';
import { classifyChunkFailure, type FailureClassification } from './import-chunk-retry.js';
import { claimPendingImportChunk, handleChunkFailure } from './import-chunk-state.js';
import { persistProcessedChunk } from './persist-import-chunk.js';
import {
  ChunkOwnershipLostError,
  ChunkProcessingError,
  type ProcessChunkOptions,
  type ProcessChunkResult,
} from './process-import-chunk.types.js';
import { readChunkRows } from './read-import-chunk.js';

const normalizeChunkError = (
  error: unknown,
  classification: FailureClassification,
): ChunkProcessingError => {
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

  if (classification === 'retryable') {
    const prismaCode =
      typeof error === 'object' &&
      error !== null &&
      (('code' in error && typeof error.code === 'string' && error.code.startsWith('P')) ||
        ('errorCode' in error &&
          typeof error.errorCode === 'string' &&
          error.errorCode.startsWith('P')));

    return prismaCode
      ? new ChunkProcessingError('TEMPORARY_DATABASE_FAILURE', 'Temporary database failure')
      : new ChunkProcessingError('TEMPORARY_FILESYSTEM_FAILURE', 'Temporary filesystem failure');
  }

  return new ChunkProcessingError('CHUNK_PERSISTENCE_FAILED', 'Import chunk processing failed');
};

const logOwnershipLost = (error: ChunkOwnershipLostError): void => {
  const { chunk } = error;
  logImportChunkEvent('chunk_ownership_lost', {
    jobId: chunk.importJobId,
    chunkId: chunk.id,
    chunkNumber: chunk.chunkNumber,
    attemptCount: chunk.attemptCount,
    workerId: chunk.workerId,
  });
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
    if (error instanceof ChunkOwnershipLostError) {
      logOwnershipLost(error);
      return null;
    }

    const classification = classifyChunkFailure(error);
    const chunkError = normalizeChunkError(error, classification);
    const transition = await handleChunkFailure(chunk, chunkError, classification);

    if (transition.outcome === 'ownership_lost') {
      return null;
    }

    throw chunkError;
  }
};

export { claimPendingImportChunk, ChunkOwnershipLostError, ChunkProcessingError };
export type { ProcessChunkOptions, ProcessChunkResult };
