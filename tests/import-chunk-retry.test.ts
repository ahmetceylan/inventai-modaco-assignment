import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  calculateRetryDelaySeconds,
  classifyChunkFailure,
} from '../src/ingestion/import-chunk-retry.js';
import { UnsupportedPricingRuleError } from '../src/ingestion/import-pricing-rule.js';
import { ChunkProcessingError } from '../src/ingestion/process-import-chunk.types.js';

describe('Import chunk retry policy', () => {
  it('uses the base delay for the first retry', () => {
    expect(calculateRetryDelaySeconds(1, 5, 300)).toBe(5);
  });

  it('grows retry delays exponentially', () => {
    expect(calculateRetryDelaySeconds(2, 5, 300)).toBe(10);
    expect(calculateRetryDelaySeconds(3, 5, 300)).toBe(20);
  });

  it('caps retry delays at the configured maximum', () => {
    expect(calculateRetryDelaySeconds(20, 5, 300)).toBe(300);
  });

  it('classifies known temporary Prisma failures as retryable', () => {
    const error = new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: Prisma.prismaVersion.client,
    });

    expect(classifyChunkFailure(error)).toBe('retryable');
  });

  it('classifies known temporary filesystem failures as retryable', () => {
    expect(classifyChunkFailure(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toBe(
      'retryable',
    );
  });

  it.each([
    new ChunkProcessingError('MALFORMED_NDJSON', 'Malformed'),
    new ChunkProcessingError('CHUNK_FILE_NOT_FOUND', 'Missing'),
    new UnsupportedPricingRuleError('Unsupported'),
    new Error('Unknown'),
  ])('classifies %s as non-retryable', (error) => {
    expect(classifyChunkFailure(error)).toBe('non-retryable');
  });
});
