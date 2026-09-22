import { randomUUID } from 'node:crypto';
import {
  productCacheInvalidator,
  type ProductCacheInvalidator,
} from '../cache/product-cache-invalidation.js';
import { prisma } from '../config/prisma.js';
import { ImportChunkStatus, ImportJobStatus, Prisma } from '../generated/prisma/client.js';
import { logImportChunkEvent } from './import-chunk-logger.js';
import {
  ChunkOwnershipLostError,
  ChunkProcessingError,
  type ClaimedImportChunk,
  type ParsedChunkRows,
  type ValidProductRow,
} from './process-import-chunk.types.js';

type Transaction = Prisma.TransactionClient;

interface PersistenceResult {
  jobStatus: ImportJobStatus | null;
  productIds: string[];
  categoryIds: string[];
}

interface UpsertedProducts {
  productIds: string[];
  categoryIds: string[];
}

const ownershipWhere = (chunk: ClaimedImportChunk) => {
  return {
    id: chunk.id,
    status: ImportChunkStatus.PROCESSING,
    lockedBy: chunk.workerId,
    attemptCount: chunk.attemptCount,
  } as const;
};

const requireChunkOwnership = async (
  transaction: Transaction,
  chunk: ClaimedImportChunk,
  now: Date,
): Promise<void> => {
  const result = await transaction.importChunk.updateMany({
    where: ownershipWhere(chunk),
    data: { lockedAt: now },
  });

  if (result.count !== 1) {
    throw new ChunkOwnershipLostError(chunk);
  }
};

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
      'IMPORT_JOB_NOT_PROCESSABLE',
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
): Promise<UpsertedProducts> => {
  if (rows.length === 0) {
    return { productIds: [], categoryIds: [] };
  }

  const skus = rows.map(({ sku }) => sku);
  const previousProducts = await transaction.product.findMany({
    where: { sku: { in: skus } },
    select: { categoryId: true },
  });
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

  const products = await transaction.product.findMany({
    where: { sku: { in: skus } },
    select: { id: true, categoryId: true },
  });
  return {
    productIds: products.map(({ id }) => id),
    categoryIds: [
      ...new Set([
        ...previousProducts.map(({ categoryId }) => categoryId),
        ...products.map(({ categoryId }) => categoryId),
      ]),
    ],
  };
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
    where: ownershipWhere(chunk),
    data: {
      status: ImportChunkStatus.COMPLETED,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt,
    },
  });

  if (result.count !== 1) {
    throw new ChunkOwnershipLostError(chunk);
  }
};

const updateImportJobProgress = async (
  transaction: Transaction,
  chunk: ClaimedImportChunk,
  rows: ParsedChunkRows,
  completedAt: Date,
): Promise<ImportJobStatus | null> => {
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
    return null;
  }

  const failedChunks = await transaction.importChunk.count({
    where: {
      importJobId: chunk.importJobId,
      status: ImportChunkStatus.FAILED,
    },
  });
  const status =
    failedChunks > 0
      ? ImportJobStatus.FAILED
      : job.failedRows === 0
        ? ImportJobStatus.COMPLETED
        : ImportJobStatus.COMPLETED_WITH_ERRORS;
  const updated = await transaction.importJob.updateMany({
    where: {
      id: chunk.importJobId,
      status: ImportJobStatus.PROCESSING,
    },
    data: { status, completedAt },
  });

  return updated.count === 1 ? status : null;
};

export const persistProcessedChunk = async (
  chunk: ClaimedImportChunk,
  rows: ParsedChunkRows,
  now: Date = new Date(),
  cacheInvalidator: ProductCacheInvalidator = productCacheInvalidator,
): Promise<void> => {
  const result = await prisma.$transaction<PersistenceResult>(
    async (transaction) => {
      await requireChunkOwnership(transaction, chunk, now);
      await lockProcessableImportJob(transaction, chunk.importJobId);

      const categoryIds = await resolveCategoryIds(transaction, rows.validRows);
      const upsertedProducts = await upsertProducts(
        transaction,
        rows.validRows,
        categoryIds,
      );
      await saveInvalidRows(transaction, chunk, rows);
      await completeChunk(transaction, chunk, now);

      return {
        jobStatus: await updateImportJobProgress(transaction, chunk, rows, now),
        ...upsertedProducts,
      };
    },
    { timeout: 30_000 },
  );

  try {
    await cacheInvalidator.invalidateIngestion(
      result.productIds,
      result.categoryIds,
      {
        jobId: chunk.importJobId,
        chunkId: chunk.id,
      },
    );
  } catch {
    console.error(
      JSON.stringify({
        event: 'product_cache_invalidation_failed',
        targetType: 'ingestion_cache',
        jobId: chunk.importJobId,
        chunkId: chunk.id,
      }),
    );
  }

  logImportChunkEvent('chunk_completed', {
    jobId: chunk.importJobId,
    chunkId: chunk.id,
    chunkNumber: chunk.chunkNumber,
    attemptCount: chunk.attemptCount,
    workerId: chunk.workerId,
  });

  if (
    result.jobStatus === ImportJobStatus.COMPLETED ||
    result.jobStatus === ImportJobStatus.COMPLETED_WITH_ERRORS
  ) {
    logImportChunkEvent('job_completed', { jobId: chunk.importJobId });
  } else if (result.jobStatus === ImportJobStatus.FAILED) {
    logImportChunkEvent('job_failed', { jobId: chunk.importJobId });
  }
};
