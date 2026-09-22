import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { ImportChunkStatus, ImportJobStatus, Prisma } from '../generated/prisma/client.js';
import {
  ChunkProcessingError,
  type ClaimedImportChunk,
  type ParsedChunkRows,
  type ValidProductRow,
} from './process-import-chunk.types.js';

type Transaction = Prisma.TransactionClient;

const lockProcessableImportJob = async (
  transaction: Transaction,
  importJobId: string,
): Promise<void> => {
  await transaction.$queryRaw`
    SELECT "id"
    FROM "ImportJob"
    WHERE "id" = ${importJobId}::uuid
    FOR UPDATE
  `;
  const job = await transaction.importJob.findUniqueOrThrow({
    where: { id: importJobId },
    select: { status: true },
  });

  if (job.status !== ImportJobStatus.PROCESSING) {
    throw new ChunkProcessingError(
      'CHUNK_PERSISTENCE_FAILED',
      'Import job is no longer processable',
    );
  }
};

const resolveCategoryIds = async (
  transaction: Transaction,
  rows: ValidProductRow[],
): Promise<Map<string, string>> => {
  const categoryNames = [...new Set(rows.map(({ category }) => category))];

  if (categoryNames.length === 0) {
    return new Map();
  }

  await transaction.category.createMany({
    data: categoryNames.map((name) => ({ name })),
    skipDuplicates: true,
  });
  const categories = await transaction.category.findMany({
    where: { name: { in: categoryNames } },
    select: { id: true, name: true },
  });

  return new Map(categories.map(({ id, name }) => [name, id]));
};

const upsertProducts = async (
  transaction: Transaction,
  rows: ValidProductRow[],
  categoryIds: Map<string, string>,
): Promise<void> => {
  if (rows.length === 0) {
    return;
  }

  const values = rows.map((row) => {
    const categoryId = categoryIds.get(row.category);

    if (categoryId === undefined) {
      throw new ChunkProcessingError(
        'CHUNK_PERSISTENCE_FAILED',
        'A Product category could not be resolved',
        row.rowNumber,
      );
    }

    return Prisma.sql`(
      ${randomUUID()}::uuid,
      ${row.name},
      ${row.sku},
      ${row.basePrice.toFixed(2)}::decimal(12, 2),
      ${row.stockQuantity},
      ${categoryId}::uuid,
      CURRENT_TIMESTAMP
    )`;
  });

  await transaction.$executeRaw`
    INSERT INTO "Product" (
      "id",
      "name",
      "sku",
      "basePrice",
      "stockQuantity",
      "categoryId",
      "updatedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("sku") DO UPDATE SET
      "name" = EXCLUDED."name",
      "basePrice" = EXCLUDED."basePrice",
      "stockQuantity" = EXCLUDED."stockQuantity",
      "categoryId" = EXCLUDED."categoryId",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
};

const saveInvalidRows = async (
  transaction: Transaction,
  chunk: ClaimedImportChunk,
  rows: ParsedChunkRows,
): Promise<void> => {
  if (rows.invalidRows.length === 0) {
    return;
  }

  await transaction.importFailure.createMany({
    data: rows.invalidRows.map((failure) => ({
      importJobId: chunk.importJobId,
      importChunkId: chunk.id,
      rowNumber: failure.rowNumber,
      sku: failure.sku,
      rawData: failure.rawData,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
    })),
  });
};

const completeChunk = async (
  transaction: Transaction,
  chunk: ClaimedImportChunk,
  completedAt: Date,
): Promise<void> => {
  const result = await transaction.importChunk.updateMany({
    where: {
      id: chunk.id,
      status: ImportChunkStatus.PROCESSING,
      lockedBy: chunk.workerId,
    },
    data: {
      status: ImportChunkStatus.COMPLETED,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt,
    },
  });

  if (result.count !== 1) {
    throw new ChunkProcessingError(
      'CHUNK_PERSISTENCE_FAILED',
      'Import chunk claim is no longer valid',
    );
  }
};

const updateImportJobProgress = async (
  transaction: Transaction,
  chunk: ClaimedImportChunk,
  rows: ParsedChunkRows,
  completedAt: Date,
): Promise<void> => {
  const job = await transaction.importJob.update({
    where: { id: chunk.importJobId },
    data: {
      processedRows: { increment: chunk.rowCount },
      succeededRows: { increment: rows.validRows.length },
      failedRows: { increment: rows.invalidRows.length },
    },
    select: { failedRows: true },
  });
  const remainingChunks = await transaction.importChunk.count({
    where: {
      importJobId: chunk.importJobId,
      status: { in: [ImportChunkStatus.PENDING, ImportChunkStatus.PROCESSING] },
    },
  });

  if (remainingChunks > 0) {
    return;
  }

  await transaction.importJob.update({
    where: { id: chunk.importJobId },
    data: {
      status:
        job.failedRows === 0 ? ImportJobStatus.COMPLETED : ImportJobStatus.COMPLETED_WITH_ERRORS,
      completedAt,
    },
  });
};

export const persistProcessedChunk = async (
  chunk: ClaimedImportChunk,
  rows: ParsedChunkRows,
): Promise<void> => {
  await prisma.$transaction(
    async (transaction) => {
      await lockProcessableImportJob(transaction, chunk.importJobId);
      const categoryIds = await resolveCategoryIds(transaction, rows.validRows);

      await upsertProducts(transaction, rows.validRows, categoryIds);
      await saveInvalidRows(transaction, chunk, rows);

      const completedAt = new Date();
      await completeChunk(transaction, chunk, completedAt);
      await updateImportJobProgress(transaction, chunk, rows, completedAt);
    },
    { timeout: 30_000 },
  );
};

export const markChunkFailed = async (
  chunk: ClaimedImportChunk,
  error: ChunkProcessingError,
): Promise<void> => {
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT "id"
      FROM "ImportJob"
      WHERE "id" = ${chunk.importJobId}::uuid
      FOR UPDATE
    `;
    const failedAt = new Date();

    await transaction.importChunk.update({
      where: { id: chunk.id },
      data: {
        status: ImportChunkStatus.FAILED,
        lockedAt: null,
        lockedBy: null,
        lastError: error.message,
        completedAt: failedAt,
      },
    });
    await transaction.importFailure.create({
      data: {
        importJobId: chunk.importJobId,
        importChunkId: chunk.id,
        rowNumber: error.rowNumber,
        errorCode: error.code,
        errorMessage: error.message,
      },
    });
    await transaction.importJob.update({
      where: { id: chunk.importJobId },
      data: {
        status: ImportJobStatus.FAILED,
        completedAt: failedAt,
      },
    });
  });
};

export const claimPendingImportChunk = async (
  requestedJobId?: string,
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
        AND chunk."availableAt" <= CURRENT_TIMESTAMP
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
        storagePath: true,
        rowCount: true,
        importJob: {
          select: {
            pricingRuleVersion: true,
          },
        },
      },
    });
    const lockedAt = new Date();

    await transaction.importChunk.update({
      where: { id: chunk.id },
      data: {
        status: ImportChunkStatus.PROCESSING,
        lockedAt,
        lockedBy: workerId,
        attemptCount: { increment: 1 },
      },
    });
    const updatedJobs = await transaction.$executeRaw`
      UPDATE "ImportJob"
      SET
        "status" = 'PROCESSING'::"ImportJobStatus",
        "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${chunk.importJobId}::uuid
        AND "status" IN ('READY'::"ImportJobStatus", 'PROCESSING'::"ImportJobStatus")
    `;

    if (updatedJobs !== 1) {
      throw new ChunkProcessingError('CHUNK_CLAIM_FAILED', 'Import chunk could not be claimed');
    }

    return {
      id: chunk.id,
      importJobId: chunk.importJobId,
      storagePath: chunk.storagePath,
      rowCount: chunk.rowCount,
      pricingRuleVersion: chunk.importJob.pricingRuleVersion,
      workerId,
    };
  });
};
