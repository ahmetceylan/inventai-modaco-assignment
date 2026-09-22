import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { ImportChunkStatus, ImportJobStatus, Prisma } from '../generated/prisma/client.js';
import { logImportChunkEvent } from './import-chunk-logger.js';
import {
  calculateRetryDelaySeconds,
  importRetryPolicy,
  type FailureClassification,
  type ImportRetryPolicy,
} from './import-chunk-retry.js';
import { ChunkProcessingError, type ClaimedImportChunk } from './process-import-chunk.types.js';

const STALE_RECOVERY_LIMIT = 100;
const STALE_RECOVERY_MESSAGE = 'Recovered after the previous worker lock expired';
const STALE_EXHAUSTED_CODE = 'STALE_LOCK_ATTEMPTS_EXHAUSTED';
const STALE_EXHAUSTED_MESSAGE = 'Stale chunk exhausted the maximum processing attempts';

interface StaleChunk {
  id: string;
  importJobId: string;
  chunkNumber: number;
  attemptCount: number;
  lockedAt: Date;
  lockedBy: string;
}

export type FailureTransition =
  | { outcome: 'retry_scheduled'; nextAvailableAt: Date }
  | { outcome: 'failed'; jobFailed: boolean }
  | { outcome: 'ownership_lost' };

const ownershipWhere = (chunk: ClaimedImportChunk) => {
  return {
    id: chunk.id,
    status: ImportChunkStatus.PROCESSING,
    lockedBy: chunk.workerId,
    attemptCount: chunk.attemptCount,
  } as const;
};

export const handleChunkFailure = async (
  chunk: ClaimedImportChunk,
  error: ChunkProcessingError,
  classification: FailureClassification,
  now: Date = new Date(),
  policy: ImportRetryPolicy = importRetryPolicy,
): Promise<FailureTransition> => {
  const transition = await prisma.$transaction<FailureTransition>(async (transaction) => {
    if (classification === 'retryable' && chunk.attemptCount < policy.maxAttempts) {
      const delaySeconds = calculateRetryDelaySeconds(
        chunk.attemptCount,
        policy.baseDelaySeconds,
        policy.maxDelaySeconds,
      );
      const nextAvailableAt = new Date(now.getTime() + delaySeconds * 1_000);
      const updated = await transaction.importChunk.updateMany({
        where: ownershipWhere(chunk),
        data: {
          status: ImportChunkStatus.PENDING,
          availableAt: nextAvailableAt,
          lockedAt: null,
          lockedBy: null,
          lastError: error.message,
          completedAt: null,
        },
      });

      return updated.count === 1
        ? { outcome: 'retry_scheduled', nextAvailableAt }
        : { outcome: 'ownership_lost' };
    }

    const updated = await transaction.importChunk.updateMany({
      where: ownershipWhere(chunk),
      data: {
        status: ImportChunkStatus.FAILED,
        lockedAt: null,
        lockedBy: null,
        lastError: error.message,
        completedAt: now,
      },
    });

    if (updated.count !== 1) {
      return { outcome: 'ownership_lost' };
    }

    await transaction.importFailure.create({
      data: {
        importJobId: chunk.importJobId,
        importChunkId: chunk.id,
        rowNumber: error.rowNumber,
        errorCode: error.code,
        errorMessage: error.message,
      },
    });
    const failedJob = await transaction.importJob.updateMany({
      where: {
        id: chunk.importJobId,
        status: ImportJobStatus.PROCESSING,
      },
      data: {
        status: ImportJobStatus.FAILED,
        completedAt: now,
      },
    });

    return { outcome: 'failed', jobFailed: failedJob.count === 1 };
  });

  if (transition.outcome === 'retry_scheduled') {
    logImportChunkEvent('chunk_retry_scheduled', {
      jobId: chunk.importJobId,
      chunkId: chunk.id,
      chunkNumber: chunk.chunkNumber,
      attemptCount: chunk.attemptCount,
      workerId: chunk.workerId,
      nextAvailableAt: transition.nextAvailableAt.toISOString(),
      errorCode: error.code,
    });
  } else if (transition.outcome === 'failed') {
    logImportChunkEvent('chunk_failed', {
      jobId: chunk.importJobId,
      chunkId: chunk.id,
      chunkNumber: chunk.chunkNumber,
      attemptCount: chunk.attemptCount,
      workerId: chunk.workerId,
      errorCode: error.code,
    });
    if (transition.jobFailed) {
      logImportChunkEvent('job_failed', { jobId: chunk.importJobId });
    }
  } else {
    logImportChunkEvent('chunk_ownership_lost', {
      jobId: chunk.importJobId,
      chunkId: chunk.id,
      chunkNumber: chunk.chunkNumber,
      attemptCount: chunk.attemptCount,
      workerId: chunk.workerId,
      errorCode: error.code,
    });
  }

  return transition;
};

export const recoverStaleImportChunks = async (
  now: Date = new Date(),
  policy: ImportRetryPolicy = importRetryPolicy,
): Promise<void> => {
  const staleBefore = new Date(now.getTime() - policy.lockTimeoutSeconds * 1_000);
  const events = await prisma.$transaction(async (transaction) => {
    const candidates = await transaction.$queryRaw<StaleChunk[]>`
      SELECT
        chunk."id",
        chunk."importJobId",
        chunk."chunkNumber",
        chunk."attemptCount",
        chunk."lockedAt",
        chunk."lockedBy"
      FROM "ImportChunk" AS chunk
      INNER JOIN "ImportJob" AS job
        ON job."id" = chunk."importJobId"
      WHERE chunk."status" = 'PROCESSING'::"ImportChunkStatus"
        AND chunk."lockedAt" < ${staleBefore}
        AND chunk."lockedBy" IS NOT NULL
        AND job."status" = 'PROCESSING'::"ImportJobStatus"
      ORDER BY chunk."lockedAt" ASC, chunk."id" ASC
      FOR UPDATE OF chunk SKIP LOCKED
      LIMIT ${STALE_RECOVERY_LIMIT}
    `;
    const recovered: StaleChunk[] = [];
    const exhausted: Array<StaleChunk & { jobFailed: boolean }> = [];

    for (const chunk of candidates) {
      const currentOwnership = {
        id: chunk.id,
        status: ImportChunkStatus.PROCESSING,
        lockedAt: chunk.lockedAt,
        lockedBy: chunk.lockedBy,
        attemptCount: chunk.attemptCount,
      } as const;

      if (chunk.attemptCount < policy.maxAttempts) {
        const updated = await transaction.importChunk.updateMany({
          where: currentOwnership,
          data: {
            status: ImportChunkStatus.PENDING,
            availableAt: now,
            lockedAt: null,
            lockedBy: null,
            lastError: STALE_RECOVERY_MESSAGE,
            completedAt: null,
          },
        });
        if (updated.count === 1) {
          recovered.push(chunk);
        }
        continue;
      }

      const updated = await transaction.importChunk.updateMany({
        where: currentOwnership,
        data: {
          status: ImportChunkStatus.FAILED,
          lockedAt: null,
          lockedBy: null,
          lastError: STALE_EXHAUSTED_MESSAGE,
          completedAt: now,
        },
      });
      if (updated.count !== 1) {
        continue;
      }

      await transaction.importFailure.create({
        data: {
          importJobId: chunk.importJobId,
          importChunkId: chunk.id,
          errorCode: STALE_EXHAUSTED_CODE,
          errorMessage: STALE_EXHAUSTED_MESSAGE,
        },
      });
      const failedJob = await transaction.importJob.updateMany({
        where: {
          id: chunk.importJobId,
          status: ImportJobStatus.PROCESSING,
        },
        data: {
          status: ImportJobStatus.FAILED,
          completedAt: now,
        },
      });
      exhausted.push({ ...chunk, jobFailed: failedJob.count === 1 });
    }

    return { recovered, exhausted };
  });

  for (const chunk of events.recovered) {
    logImportChunkEvent('stale_chunk_recovered', {
      jobId: chunk.importJobId,
      chunkId: chunk.id,
      chunkNumber: chunk.chunkNumber,
      attemptCount: chunk.attemptCount,
      workerId: chunk.lockedBy,
      nextAvailableAt: now.toISOString(),
    });
  }
  for (const chunk of events.exhausted) {
    logImportChunkEvent('stale_chunk_exhausted', {
      jobId: chunk.importJobId,
      chunkId: chunk.id,
      chunkNumber: chunk.chunkNumber,
      attemptCount: chunk.attemptCount,
      workerId: chunk.lockedBy,
      errorCode: STALE_EXHAUSTED_CODE,
    });
    if (chunk.jobFailed) {
      logImportChunkEvent('job_failed', { jobId: chunk.importJobId });
    }
  }
};

const claimAvailableImportChunk = async (
  requestedJobId: string | undefined,
  now: Date,
): Promise<ClaimedImportChunk | null> => {
  const workerId = `local:${process.pid}:${randomUUID()}`;

  return prisma.$transaction(async (transaction) => {
    const requestedFilter =
      requestedJobId === undefined
        ? Prisma.empty
        : Prisma.sql`AND chunk."importJobId" = ${requestedJobId}::uuid`;
    const candidates = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT chunk."id"
      FROM "ImportChunk" AS chunk
      INNER JOIN "ImportJob" AS job
        ON job."id" = chunk."importJobId"
      WHERE chunk."status" = 'PENDING'::"ImportChunkStatus"
        AND chunk."availableAt" <= ${now}
        AND job."status" IN ('READY'::"ImportJobStatus", 'PROCESSING'::"ImportJobStatus")
        ${requestedFilter}
      ORDER BY chunk."availableAt" ASC, chunk."chunkNumber" ASC, chunk."id" ASC
      FOR UPDATE OF chunk SKIP LOCKED
      LIMIT 1
    `;
    const candidate = candidates[0];

    if (candidate === undefined) {
      return null;
    }

    const chunk = await transaction.importChunk.findUniqueOrThrow({
      where: { id: candidate.id },
      select: {
        id: true,
        importJobId: true,
        chunkNumber: true,
        storagePath: true,
        rowCount: true,
        attemptCount: true,
        importJob: {
          select: {
            pricingRuleVersion: true,
          },
        },
      },
    });
    const claimed = await transaction.importChunk.update({
      where: { id: chunk.id },
      data: {
        status: ImportChunkStatus.PROCESSING,
        lockedAt: now,
        lockedBy: workerId,
        attemptCount: { increment: 1 },
      },
      select: { attemptCount: true },
    });
    const updatedJobs = await transaction.$executeRaw`
      UPDATE "ImportJob"
      SET
        "status" = 'PROCESSING'::"ImportJobStatus",
        "startedAt" = COALESCE("startedAt", ${now}),
        "updatedAt" = ${now}
      WHERE "id" = ${chunk.importJobId}::uuid
        AND "status" IN ('READY'::"ImportJobStatus", 'PROCESSING'::"ImportJobStatus")
    `;

    if (updatedJobs !== 1) {
      throw new ChunkProcessingError('CHUNK_CLAIM_FAILED', 'Import chunk could not be claimed');
    }

    return {
      id: chunk.id,
      importJobId: chunk.importJobId,
      chunkNumber: chunk.chunkNumber,
      storagePath: chunk.storagePath,
      rowCount: chunk.rowCount,
      pricingRuleVersion: chunk.importJob.pricingRuleVersion,
      workerId,
      attemptCount: claimed.attemptCount,
    };
  });
};

export const claimPendingImportChunk = async (
  requestedJobId?: string,
  now: Date = new Date(),
  policy: ImportRetryPolicy = importRetryPolicy,
): Promise<ClaimedImportChunk | null> => {
  await recoverStaleImportChunks(now, policy);
  const chunk = await claimAvailableImportChunk(requestedJobId, now);

  if (chunk !== null) {
    logImportChunkEvent('chunk_claimed', {
      jobId: chunk.importJobId,
      chunkId: chunk.id,
      chunkNumber: chunk.chunkNumber,
      attemptCount: chunk.attemptCount,
      workerId: chunk.workerId,
    });
  }

  return chunk;
};
