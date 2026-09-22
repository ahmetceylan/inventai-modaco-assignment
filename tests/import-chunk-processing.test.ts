import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ImportChunkStatus, ImportJobStatus, type Prisma } from '../src/generated/prisma/client.js';
import { type prisma as PrismaClientInstance } from '../src/config/prisma.js';
import type { ImportRetryPolicy } from '../src/ingestion/import-chunk-retry.js';

interface VendorData {
  sku: string;
  name: string;
  category: string;
  basePrice: string;
  stockQuantity: string;
  [key: string]: string;
}

interface SourceRow {
  rowNumber: number;
  data: VendorData;
}

describe('Prepared Product chunk processing', () => {
  const originalStoragePath = process.env.IMPORT_STORAGE_PATH;
  let app!: Express;
  let prisma!: typeof PrismaClientInstance;
  let processor!: typeof import('../src/ingestion/process-import-chunk.js');
  let persistence!: typeof import('../src/ingestion/persist-import-chunk.js');
  let state!: typeof import('../src/ingestion/import-chunk-state.js');
  let reader!: typeof import('../src/ingestion/read-import-chunk.js');
  let storagePath!: string;
  const retryPolicy: ImportRetryPolicy = {
    maxAttempts: 3,
    baseDelaySeconds: 5,
    maxDelaySeconds: 300,
    lockTimeoutSeconds: 60,
  };

  beforeAll(async () => {
    storagePath = await mkdtemp(join(tmpdir(), 'modaco-processing-'));
    process.env.IMPORT_STORAGE_PATH = storagePath;

    vi.resetModules();
    const [processorModule, persistenceModule, stateModule, readerModule, prismaModule, appModule] =
      await Promise.all([
        import('../src/ingestion/process-import-chunk.js'),
        import('../src/ingestion/persist-import-chunk.js'),
        import('../src/ingestion/import-chunk-state.js'),
        import('../src/ingestion/read-import-chunk.js'),
        import('../src/config/prisma.js'),
        import('../src/app.js'),
      ]);
    processor = processorModule;
    persistence = persistenceModule;
    state = stateModule;
    reader = readerModule;
    prisma = prismaModule.prisma;
    app = appModule.createApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.importJob.deleteMany();
    await prisma.promotion.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    const entries = await readdir(storagePath);
    await Promise.all(
      entries.map((entry) => rm(join(storagePath, entry), { recursive: true, force: true })),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(storagePath, { recursive: true, force: true });
    restoreEnvironment('IMPORT_STORAGE_PATH', originalStoragePath);
  });

  const createJob = (overrides: Partial<Prisma.ImportJobUncheckedCreateInput> = {}) => {
    return prisma.importJob.create({
      data: {
        originalFileName: 'prepared.csv',
        storagePath: 'raw.csv',
        pricingRuleVersion: 'v1',
        status: ImportJobStatus.READY,
        totalRows: 0,
        ...overrides,
      },
    });
  };

  const createChunk = async (
    importJobId: string,
    chunkNumber: number,
    rows: SourceRow[],
    overrides: Partial<Prisma.ImportChunkUncheckedCreateInput> = {},
  ) => {
    const relativePath = join(
      'chunks',
      importJobId,
      `${chunkNumber.toString().padStart(6, '0')}.ndjson`,
    );
    const absolutePath = join(storagePath, relativePath);
    await mkdir(join(storagePath, 'chunks', importJobId), { recursive: true });
    await writeFile(absolutePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    return prisma.importChunk.create({
      data: {
        importJobId,
        chunkNumber,
        storagePath: relativePath,
        startRowNumber: rows[0]?.rowNumber ?? 2,
        rowCount: rows.length,
        availableAt: new Date('2020-01-01T00:00:00.000Z'),
        ...overrides,
      },
    });
  };

  it('claims one available PENDING Chunk and starts its READY Job', async () => {
    const job = await createJob({ startedAt: null, totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)]);

    const claimed = await processor.claimPendingImportChunk(job.id);
    const [persistedChunk, persistedJob] = await Promise.all([
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ]);

    expect(claimed?.id).toBe(chunk.id);
    expect(persistedChunk.status).toBe(ImportChunkStatus.PROCESSING);
    expect(persistedChunk.attemptCount).toBe(1);
    expect(persistedChunk.lockedAt).toBeInstanceOf(Date);
    expect(persistedChunk.lockedBy).toMatch(/^local:/);
    expect(persistedJob.status).toBe(ImportJobStatus.PROCESSING);
    expect(persistedJob.startedAt).toBeInstanceOf(Date);
  });

  it('allows only one concurrent claim for the same Chunk', async () => {
    const job = await createJob({ totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)]);

    const claims = await Promise.all([
      processor.claimPendingImportChunk(job.id),
      processor.claimPendingImportChunk(job.id),
    ]);

    expect(claims.filter((claim) => claim?.id === chunk.id)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  it('does not claim a Chunk before availableAt', async () => {
    const job = await createJob({ totalRows: 1 });
    await createChunk(job.id, 0, [validRow(2)], {
      availableAt: new Date('2100-01-01T00:00:00.000Z'),
    });

    await expect(processor.claimPendingImportChunk(job.id)).resolves.toBeNull();
  });

  it('schedules retryable failures without changing Job counters', async () => {
    const claimedAt = new Date('2030-01-01T00:00:00.000Z');
    const failedAt = new Date('2030-01-01T00:00:01.000Z');
    const nextAvailableAt = new Date('2030-01-01T00:00:06.000Z');
    const job = await createJob({ totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)]);
    const claimed = await processor.claimPendingImportChunk(job.id, claimedAt, retryPolicy);

    expect(claimed).not.toBeNull();
    await state.handleChunkFailure(
      claimed!,
      new processor.ChunkProcessingError(
        'TEMPORARY_DATABASE_FAILURE',
        'Temporary database failure',
      ),
      'retryable',
      failedAt,
      retryPolicy,
    );

    const [persistedChunk, persistedJob, failureCount] = await Promise.all([
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.importFailure.count({ where: { importChunkId: chunk.id } }),
    ]);
    expect(persistedChunk).toMatchObject({
      status: ImportChunkStatus.PENDING,
      availableAt: nextAvailableAt,
      lockedAt: null,
      lockedBy: null,
      lastError: 'Temporary database failure',
      completedAt: null,
    });
    expect(persistedJob).toMatchObject({
      status: ImportJobStatus.PROCESSING,
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
    });
    expect(failureCount).toBe(0);

    await expect(
      processor.claimPendingImportChunk(job.id, new Date('2030-01-01T00:00:05.999Z'), retryPolicy),
    ).resolves.toBeNull();
    await expect(
      processor.claimPendingImportChunk(job.id, nextAvailableAt, retryPolicy),
    ).resolves.toMatchObject({
      id: chunk.id,
      attemptCount: 2,
    });
  });

  it('makes the final failed attempt terminal exactly once', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const job = await createJob({ totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)], {
      attemptCount: retryPolicy.maxAttempts - 1,
    });
    const claimed = await processor.claimPendingImportChunk(job.id, now, retryPolicy);
    const error = new processor.ChunkProcessingError(
      'TEMPORARY_DATABASE_FAILURE',
      'Temporary database failure',
    );

    const first = await state.handleChunkFailure(claimed!, error, 'retryable', now, retryPolicy);
    const repeated = await state.handleChunkFailure(claimed!, error, 'retryable', now, retryPolicy);

    expect(first).toMatchObject({ outcome: 'failed', jobFailed: true });
    expect(repeated).toEqual({ outcome: 'ownership_lost' });
    await expect(
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
    ).resolves.toMatchObject({
      status: ImportChunkStatus.FAILED,
      lockedAt: null,
      lockedBy: null,
      completedAt: now,
    });
    await expect(
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: ImportJobStatus.FAILED,
      completedAt: now,
    });
    await expect(prisma.importFailure.count({ where: { importChunkId: chunk.id } })).resolves.toBe(
      1,
    );
  });

  it.each([
    ImportJobStatus.PENDING,
    ImportJobStatus.FAILED,
    ImportJobStatus.CANCELLED,
    ImportJobStatus.COMPLETED,
  ])('does not claim Chunks for a %s Job', async (status) => {
    const job = await createJob({ status, totalRows: 1 });
    await createChunk(job.id, 0, [validRow(2)]);

    await expect(processor.claimPendingImportChunk(job.id)).resolves.toBeNull();
  });

  it('does not recover a recent PROCESSING lock', async () => {
    const now = new Date('2030-01-01T00:01:00.000Z');
    const lockedAt = new Date('2030-01-01T00:00:30.000Z');
    const job = await createJob({ status: ImportJobStatus.PROCESSING, totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)], {
      status: ImportChunkStatus.PROCESSING,
      attemptCount: 1,
      lockedAt,
      lockedBy: 'recent-worker',
    });

    await state.recoverStaleImportChunks(now, retryPolicy);

    await expect(
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
    ).resolves.toMatchObject({
      status: ImportChunkStatus.PROCESSING,
      lockedAt,
      lockedBy: 'recent-worker',
    });
  });

  it('recovers an expired PROCESSING lock without changing counters', async () => {
    const now = new Date('2030-01-01T00:02:00.000Z');
    const job = await createJob({ status: ImportJobStatus.PROCESSING, totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)], {
      status: ImportChunkStatus.PROCESSING,
      attemptCount: 1,
      lockedAt: new Date('2030-01-01T00:00:00.000Z'),
      lockedBy: 'expired-worker',
    });

    await state.recoverStaleImportChunks(now, retryPolicy);

    const [persistedChunk, persistedJob] = await Promise.all([
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ]);
    expect(persistedChunk).toMatchObject({
      status: ImportChunkStatus.PENDING,
      availableAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: 'Recovered after the previous worker lock expired',
    });
    expect(persistedJob).toMatchObject({
      status: ImportJobStatus.PROCESSING,
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
    });
  });

  it('fails an expired lock that exhausted its attempts', async () => {
    const now = new Date('2030-01-01T00:02:00.000Z');
    const job = await createJob({ status: ImportJobStatus.PROCESSING, totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)], {
      status: ImportChunkStatus.PROCESSING,
      attemptCount: retryPolicy.maxAttempts,
      lockedAt: new Date('2030-01-01T00:00:00.000Z'),
      lockedBy: 'expired-worker',
    });

    await state.recoverStaleImportChunks(now, retryPolicy);
    await state.recoverStaleImportChunks(now, retryPolicy);

    const [persistedChunk, persistedJob, failures] = await Promise.all([
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.importFailure.findMany({ where: { importChunkId: chunk.id } }),
    ]);
    expect(persistedChunk).toMatchObject({
      status: ImportChunkStatus.FAILED,
      lockedAt: null,
      lockedBy: null,
      completedAt: now,
    });
    expect(persistedJob).toMatchObject({
      status: ImportJobStatus.FAILED,
      completedAt: now,
      processedRows: 0,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorCode).toBe('STALE_LOCK_ATTEMPTS_EXHAUSTED');
  });

  it('allows only one concurrent recovery to mutate an expired lock', async () => {
    const now = new Date('2030-01-01T00:02:00.000Z');
    const job = await createJob({ status: ImportJobStatus.PROCESSING, totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)], {
      status: ImportChunkStatus.PROCESSING,
      attemptCount: 1,
      lockedAt: new Date('2030-01-01T00:00:00.000Z'),
      lockedBy: 'expired-worker',
    });

    await Promise.all([
      state.recoverStaleImportChunks(now, retryPolicy),
      state.recoverStaleImportChunks(now, retryPolicy),
    ]);

    await expect(
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
    ).resolves.toMatchObject({
      status: ImportChunkStatus.PENDING,
      lockedAt: null,
      lockedBy: null,
      attemptCount: 1,
    });
    await expect(prisma.importFailure.count({ where: { importChunkId: chunk.id } })).resolves.toBe(
      0,
    );
  });

  it('bounds stale-lock recovery to 100 Chunks per invocation', async () => {
    const now = new Date('2030-01-01T00:02:00.000Z');
    const job = await createJob({ status: ImportJobStatus.PROCESSING, totalRows: 101 });
    await prisma.importChunk.createMany({
      data: Array.from({ length: 101 }, (_, chunkNumber) => ({
        importJobId: job.id,
        chunkNumber,
        storagePath: `chunks/${job.id}/${chunkNumber}.ndjson`,
        startRowNumber: chunkNumber + 2,
        rowCount: 1,
        status: ImportChunkStatus.PROCESSING,
        attemptCount: 1,
        lockedAt: new Date('2030-01-01T00:00:00.000Z'),
        lockedBy: `worker-${chunkNumber}`,
      })),
    });

    await state.recoverStaleImportChunks(now, retryPolicy);

    const [pending, processing] = await Promise.all([
      prisma.importChunk.count({
        where: { importJobId: job.id, status: ImportChunkStatus.PENDING },
      }),
      prisma.importChunk.count({
        where: { importJobId: job.id, status: ImportChunkStatus.PROCESSING },
      }),
    ]);
    expect(pending).toBe(100);
    expect(processing).toBe(1);
  });

  it('creates Categories and Products, applies v1 pricing, and completes the Job', async () => {
    const job = await createJob({ totalRows: 2 });
    const chunk = await createChunk(job.id, 0, [
      validRow(2, { sku: ' SKU-1 ', basePrice: '10.005' }),
      validRow(3, { sku: 'SKU-2', name: ' Shirt ', category: ' Clothing ' }),
    ]);

    const result = await processor.processNextImportChunk({ jobId: job.id });
    const [products, categories, persistedChunk, persistedJob] = await Promise.all([
      prisma.product.findMany({ orderBy: { sku: 'asc' } }),
      prisma.category.findMany({ orderBy: { name: 'asc' } }),
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ]);

    expect(result).toMatchObject({ succeededRows: 2, failedRows: 0 });
    expect(
      products.map(({ sku, name, basePrice, stockQuantity }) => ({
        sku,
        name,
        basePrice: basePrice.toFixed(2),
        stockQuantity,
      })),
    ).toEqual([
      { sku: 'SKU-1', name: 'Product', basePrice: '10.01', stockQuantity: 10 },
      { sku: 'SKU-2', name: 'Shirt', basePrice: '100.00', stockQuantity: 10 },
    ]);
    expect(categories.map(({ name }) => name)).toEqual(['Accessories', 'Clothing']);
    expect(persistedChunk).toMatchObject({
      status: ImportChunkStatus.COMPLETED,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    });
    expect(persistedChunk.completedAt).toBeInstanceOf(Date);
    expect(persistedJob).toMatchObject({
      status: ImportJobStatus.COMPLETED,
      processedRows: 2,
      succeededRows: 2,
      failedRows: 0,
    });
    expect(persistedJob.completedAt).toBeInstanceOf(Date);
  });

  it('upserts an existing Product by SKU', async () => {
    const oldCategory = await prisma.category.create({ data: { name: 'Old' } });
    await prisma.product.create({
      data: {
        sku: 'SKU-1',
        name: 'Old name',
        categoryId: oldCategory.id,
        basePrice: '1.00',
        stockQuantity: 1,
      },
    });
    const job = await createJob({ totalRows: 1 });
    await createChunk(job.id, 0, [
      validRow(2, {
        name: 'Updated',
        category: 'New',
        basePrice: '25.50',
        stockQuantity: '7',
      }),
    ]);

    await processor.processNextImportChunk({ jobId: job.id });

    const product = await prisma.product.findUniqueOrThrow({
      where: { sku: 'SKU-1' },
      include: { category: true },
    });
    expect(product).toMatchObject({
      name: 'Updated',
      stockQuantity: 7,
      category: { name: 'New' },
    });
    expect(product.basePrice.toFixed(2)).toBe('25.50');
    await expect(prisma.product.count({ where: { sku: 'SKU-1' } })).resolves.toBe(1);
  });

  it('creates one Category for multiple valid rows that share it', async () => {
    const job = await createJob({ totalRows: 25 });
    const rows = Array.from({ length: 25 }, (_, index) =>
      validRow(index + 2, { sku: `SKU-${index}`, category: 'Shared' }),
    );
    await createChunk(job.id, 0, rows);

    await processor.processNextImportChunk({ jobId: job.id });

    await expect(prisma.category.count({ where: { name: 'Shared' } })).resolves.toBe(1);
    await expect(prisma.product.count()).resolves.toBe(25);
  });

  it('persists valid rows and records each invalid row in one transaction', async () => {
    const job = await createJob({ totalRows: 7 });
    await createChunk(job.id, 0, [
      validRow(2, { sku: 'SKU-1' }),
      validRow(3, { sku: ' SKU-1 ' }),
      validRow(4, { sku: '   ' }),
      validRow(5, { sku: 'SKU-5', name: ' ' }),
      validRow(6, { sku: 'SKU-6', category: '' }),
      validRow(7, { sku: 'SKU-7', basePrice: '-1.00' }),
      validRow(8, { sku: 'SKU-8', stockQuantity: '-1' }),
    ]);

    await processor.processNextImportChunk({ jobId: job.id });

    const [failures, persistedJob] = await Promise.all([
      prisma.importFailure.findMany({
        where: { importJobId: job.id },
        orderBy: { rowNumber: 'asc' },
      }),
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ]);
    expect(failures.map(({ errorCode }) => errorCode)).toEqual([
      'DUPLICATE_SKU_IN_CHUNK',
      'INVALID_SKU',
      'INVALID_PRODUCT_NAME',
      'INVALID_CATEGORY',
      'INVALID_BASE_PRICE',
      'INVALID_STOCK_QUANTITY',
    ]);
    expect(failures.every(({ importChunkId }) => importChunkId !== null)).toBe(true);
    await expect(prisma.product.count()).resolves.toBe(1);
    expect(persistedJob).toMatchObject({
      status: ImportJobStatus.COMPLETED_WITH_ERRORS,
      processedRows: 7,
      succeededRows: 1,
      failedRows: 6,
    });
    expect(persistedJob.processedRows).toBe(persistedJob.succeededRows + persistedJob.failedRows);
  });

  it('leaves the Job PROCESSING while another Chunk remains pending', async () => {
    const job = await createJob({ totalRows: 2 });
    await createChunk(job.id, 0, [validRow(2, { sku: 'SKU-1' })]);
    await createChunk(job.id, 1, [validRow(3, { sku: 'SKU-2' })]);

    await processor.processNextImportChunk({ jobId: job.id });

    const persistedJob = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(persistedJob.status).toBe(ImportJobStatus.PROCESSING);
    expect(persistedJob.completedAt).toBeNull();
    expect(persistedJob.processedRows).toBe(1);

    await processor.processNextImportChunk({ jobId: job.id });

    await expect(
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: ImportJobStatus.COMPLETED,
      processedRows: 2,
      succeededRows: 2,
      failedRows: 0,
    });
  });

  it('does not process a completed Chunk again', async () => {
    const job = await createJob({ totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)]);
    await processor.processNextImportChunk({ jobId: job.id });
    const beforeRetry = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });

    await expect(processor.processNextImportChunk({ jobId: job.id })).resolves.toBeNull();
    await expect(prisma.product.count()).resolves.toBe(1);
    await expect(
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      processedRows: beforeRetry.processedRows,
      succeededRows: beforeRetry.succeededRows,
      failedRows: beforeRetry.failedRows,
    });
    await expect(prisma.importFailure.count({ where: { importChunkId: chunk.id } })).resolves.toBe(
      0,
    );
  });

  it('fences a stale worker after another owner reclaims the Chunk', async () => {
    const claimedAt = new Date('2030-01-01T00:00:00.000Z');
    const job = await createJob({ totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2, { sku: 'FENCED-SKU' })]);
    const staleClaim = await processor.claimPendingImportChunk(job.id, claimedAt, retryPolicy);
    const rows = await reader.readChunkRows(staleClaim!);
    const currentWorkerId = 'current-worker';

    const reclaimed = await prisma.importChunk.update({
      where: { id: chunk.id },
      data: {
        lockedBy: currentWorkerId,
        lockedAt: new Date('2030-01-01T00:02:00.000Z'),
        attemptCount: { increment: 1 },
      },
    });

    await expect(
      persistence.persistProcessedChunk(staleClaim!, rows, new Date('2030-01-01T00:02:01.000Z')),
    ).rejects.toBeInstanceOf(processor.ChunkOwnershipLostError);

    const [afterStaleWorker, persistedJob] = await Promise.all([
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ]);
    expect(afterStaleWorker).toMatchObject({
      status: ImportChunkStatus.PROCESSING,
      lockedBy: currentWorkerId,
      attemptCount: reclaimed.attemptCount,
    });
    expect(persistedJob).toMatchObject({
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
    });
    await expect(prisma.product.count({ where: { sku: 'FENCED-SKU' } })).resolves.toBe(0);

    await persistence.persistProcessedChunk(
      {
        ...staleClaim!,
        workerId: currentWorkerId,
        attemptCount: reclaimed.attemptCount,
      },
      rows,
      new Date('2030-01-01T00:02:02.000Z'),
    );

    await expect(prisma.product.count({ where: { sku: 'FENCED-SKU' } })).resolves.toBe(1);
    await expect(
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: ImportJobStatus.COMPLETED,
      processedRows: 1,
      succeededRows: 1,
    });
  });

  it('does not let an in-flight Chunk overwrite a FAILED Job', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const job = await createJob({ totalRows: 2 });
    const failedChunk = await createChunk(job.id, 0, [validRow(2, { sku: 'FAILED-SKU' })]);
    const inFlightChunk = await createChunk(job.id, 1, [validRow(3, { sku: 'IN-FLIGHT-SKU' })]);
    const failedClaim = await processor.claimPendingImportChunk(job.id, now, retryPolicy);
    const inFlightClaim = await processor.claimPendingImportChunk(job.id, now, retryPolicy);
    const inFlightRows = await reader.readChunkRows(inFlightClaim!);

    await state.handleChunkFailure(
      failedClaim!,
      new processor.ChunkProcessingError('MALFORMED_NDJSON', 'Prepared chunk is malformed'),
      'non-retryable',
      now,
      retryPolicy,
    );

    await expect(
      persistence.persistProcessedChunk(inFlightClaim!, inFlightRows, now),
    ).rejects.toMatchObject({
      code: 'IMPORT_JOB_NOT_PROCESSABLE',
    });
    await state.handleChunkFailure(
      inFlightClaim!,
      new processor.ChunkProcessingError(
        'IMPORT_JOB_NOT_PROCESSABLE',
        'Import job is no longer processable',
      ),
      'non-retryable',
      now,
      retryPolicy,
    );

    const [persistedJob, chunks] = await Promise.all([
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.importChunk.findMany({
        where: { id: { in: [failedChunk.id, inFlightChunk.id] } },
        orderBy: { chunkNumber: 'asc' },
      }),
    ]);
    expect(persistedJob).toMatchObject({
      status: ImportJobStatus.FAILED,
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
    });
    expect(chunks.map(({ status }) => status)).toEqual([
      ImportChunkStatus.FAILED,
      ImportChunkStatus.FAILED,
    ]);
    await expect(prisma.product.count()).resolves.toBe(0);
  });

  it('fails unsupported pricing versions without Product writes', async () => {
    const job = await createJob({ totalRows: 1, pricingRuleVersion: 'v2' });
    const chunk = await createChunk(job.id, 0, [validRow(2)]);

    const error = await processor
      .processNextImportChunk({ jobId: job.id })
      .catch((caught: unknown) => caught);
    const [persistedChunk, persistedJob, failure] = await Promise.all([
      prisma.importChunk.findUniqueOrThrow({ where: { id: chunk.id } }),
      prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.importFailure.findFirstOrThrow({ where: { importJobId: job.id } }),
    ]);

    expect(error).toBeInstanceOf(processor.ChunkProcessingError);
    expect(persistedChunk.status).toBe(ImportChunkStatus.FAILED);
    expect(persistedJob.status).toBe(ImportJobStatus.FAILED);
    expect(failure.errorCode).toBe('UNSUPPORTED_PRICING_RULE');
    await expect(prisma.product.count()).resolves.toBe(0);
  });

  it('fails malformed NDJSON without exposing raw exceptions', async () => {
    const job = await createJob({ totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)]);
    await writeFile(join(storagePath, chunk.storagePath), '{"rowNumber":2,"data":');

    await expect(processor.processNextImportChunk({ jobId: job.id })).rejects.toBeInstanceOf(
      processor.ChunkProcessingError,
    );

    const failure = await prisma.importFailure.findFirstOrThrow({
      where: { importJobId: job.id },
    });
    expect(failure).toMatchObject({
      importChunkId: chunk.id,
      errorCode: 'MALFORMED_NDJSON',
      errorMessage: 'Prepared chunk contains invalid NDJSON',
    });
    expect(failure.errorMessage).not.toContain('SyntaxError');
    expect(failure.errorMessage).not.toContain(storagePath);
  });

  it('fails safely when the Chunk file is missing', async () => {
    const job = await createJob({ totalRows: 1 });
    const chunk = await createChunk(job.id, 0, [validRow(2)]);
    await rm(join(storagePath, chunk.storagePath));

    await expect(processor.processNextImportChunk({ jobId: job.id })).rejects.toBeInstanceOf(
      processor.ChunkProcessingError,
    );

    const persistedChunk = await prisma.importChunk.findUniqueOrThrow({
      where: { id: chunk.id },
    });
    expect(persistedChunk).toMatchObject({
      status: ImportChunkStatus.FAILED,
      lockedAt: null,
      lockedBy: null,
      lastError: 'Prepared chunk file is unavailable',
    });
  });

  it('rolls back Product writes and counters when persistence fails', async () => {
    const job = await createJob({
      totalRows: 1,
      processedRows: 2_147_483_647,
      succeededRows: 2_147_483_647,
    });
    await createChunk(job.id, 0, [
      validRow(2, { sku: 'ROLLBACK-SKU', category: 'Rollback Category' }),
    ]);

    await expect(processor.processNextImportChunk({ jobId: job.id })).rejects.toBeInstanceOf(
      processor.ChunkProcessingError,
    );

    const persistedJob = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(persistedJob).toMatchObject({
      status: ImportJobStatus.FAILED,
      processedRows: 2_147_483_647,
      succeededRows: 2_147_483_647,
      failedRows: 0,
    });
    await expect(prisma.product.count({ where: { sku: 'ROLLBACK-SKU' } })).resolves.toBe(0);
    await expect(prisma.category.count({ where: { name: 'Rollback Category' } })).resolves.toBe(0);
  });

  it('exposes completed counters and timestamps without internal Chunk details', async () => {
    const job = await createJob({ totalRows: 1 });
    await createChunk(job.id, 0, [validRow(2)]);
    await processor.processNextImportChunk({ jobId: job.id });

    const response = await request(app).get(`/imports/${job.id}`);
    const body = JSON.parse(response.text) as {
      data: {
        status: string;
        totalRows: number | null;
        processedRows: number;
        succeededRows: number;
        failedRows: number;
        completedAt: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      status: 'COMPLETED',
      totalRows: 1,
      processedRows: 1,
      succeededRows: 1,
      failedRows: 0,
    });
    expect(body.data.completedAt).toEqual(expect.any(String));
    expect(response.text).not.toContain('lockedBy');
    expect(response.text).not.toContain('storagePath');
  });
});

const validRow = (rowNumber: number, overrides: Partial<VendorData> = {}): SourceRow => {
  return {
    rowNumber,
    data: {
      sku: 'SKU-1',
      name: 'Product',
      category: 'Accessories',
      basePrice: '100.00',
      stockQuantity: '10',
      ...overrides,
    },
  };
};

const restoreEnvironment = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
};
