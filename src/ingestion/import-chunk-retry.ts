import { env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';

const RETRYABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);
const RETRYABLE_SYSTEM_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ESTALE',
  'ETIMEDOUT',
]);

export type FailureClassification = 'retryable' | 'non-retryable';

export interface ImportRetryPolicy {
  maxAttempts: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  lockTimeoutSeconds: number;
}

export const importRetryPolicy: ImportRetryPolicy = {
  maxAttempts: env.IMPORT_MAX_ATTEMPTS,
  baseDelaySeconds: env.IMPORT_RETRY_BASE_DELAY_SECONDS,
  maxDelaySeconds: env.IMPORT_RETRY_MAX_DELAY_SECONDS,
  lockTimeoutSeconds: env.IMPORT_LOCK_TIMEOUT_SECONDS,
};

export const calculateRetryDelaySeconds = (
  attemptCount: number,
  baseDelaySeconds: number,
  maxDelaySeconds: number,
): number => {
  return Math.min(baseDelaySeconds * 2 ** Math.max(0, attemptCount - 1), maxDelaySeconds);
};

export const classifyChunkFailure = (error: unknown): FailureClassification => {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    RETRYABLE_PRISMA_CODES.has(error.code)
  ) {
    return 'retryable';
  }

  if (
    error instanceof Prisma.PrismaClientInitializationError &&
    error.errorCode !== undefined &&
    RETRYABLE_PRISMA_CODES.has(error.errorCode)
  ) {
    return 'retryable';
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_SYSTEM_CODES.has(error.code)
  ) {
    return 'retryable';
  }

  return 'non-retryable';
};
