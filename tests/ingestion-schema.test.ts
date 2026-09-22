import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ImportChunkStatus, ImportJobStatus, Prisma } from '../src/generated/prisma/client.js';
import { createPrismaClient } from './prisma.js';

const expectCheckConstraint = (error: unknown, constraint: string): void => {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(constraint);
};

describe('durable ingestion persistence', () => {
  let prisma!: ReturnType<typeof createPrismaClient>;

  beforeAll(() => {
    prisma = createPrismaClient();
  });

  afterEach(async () => {
    await prisma.importJob.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const createJob = (overrides: Partial<Prisma.ImportJobUncheckedCreateInput> = {}) => {
    return prisma.importJob.create({
      data: {
        originalFileName: 'vendor-products.csv',
        storagePath: 'imports/job/vendor-products.csv',
        pricingRuleVersion: 'pricing-v1',
        ...overrides,
      },
    });
  };

  const createChunk = (
    importJobId: string,
    overrides: Partial<Prisma.ImportChunkUncheckedCreateInput> = {},
  ) => {
    return prisma.importChunk.create({
      data: {
        importJobId,
        chunkNumber: 0,
        storagePath: 'imports/job/chunks/0.csv',
        startRowNumber: 1,
        rowCount: 1_000,
        ...overrides,
      },
    });
  };

  it('defaults a Job to PENDING with zero counters and unknown total rows', async () => {
    const job = await createJob();

    expect(job).toMatchObject({
      status: ImportJobStatus.PENDING,
      totalRows: null,
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
      fileChecksum: null,
    });
  });

  it('allows duplicate and null file checksums', async () => {
    const [first, second, withoutChecksum] = await Promise.all([
      createJob({ fileChecksum: 'sha256:same' }),
      createJob({ fileChecksum: 'sha256:same' }),
      createJob({ fileChecksum: null }),
    ]);

    expect(first.fileChecksum).toBe(second.fileChecksum);
    expect(withoutChecksum.fileChecksum).toBeNull();
  });

  it('defaults a Chunk to PENDING with zero attempts', async () => {
    const job = await createJob();

    const chunk = await createChunk(job.id);

    expect(chunk.status).toBe(ImportChunkStatus.PENDING);
    expect(chunk.attemptCount).toBe(0);
    expect(chunk.availableAt).toBeInstanceOf(Date);
  });

  it('requires chunk numbers to be unique within one Job', async () => {
    const job = await createJob();
    await createChunk(job.id, { chunkNumber: 3 });

    const error = await createChunk(job.id, { chunkNumber: 3 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('allows different Jobs to use the same chunk number', async () => {
    const [firstJob, secondJob] = await Promise.all([createJob(), createJob()]);

    const [firstChunk, secondChunk] = await Promise.all([
      createChunk(firstJob.id, { chunkNumber: 7 }),
      createChunk(secondJob.id, { chunkNumber: 7 }),
    ]);

    expect(firstChunk.chunkNumber).toBe(secondChunk.chunkNumber);
  });

  it.each([
    ['totalRows', 'import_job_total_rows_non_negative'],
    ['processedRows', 'import_job_processed_rows_non_negative'],
    ['succeededRows', 'import_job_succeeded_rows_non_negative'],
    ['failedRows', 'import_job_failed_rows_non_negative'],
  ] as const)('rejects a negative Job %s counter', async (field, constraint) => {
    const error = await createJob({ [field]: -1 }).catch((caught: unknown) => caught);

    expectCheckConstraint(error, constraint);
  });

  it.each([
    ['chunkNumber', -1, 'import_chunk_number_non_negative'],
    ['startRowNumber', 0, 'import_chunk_start_row_number_positive'],
    ['rowCount', -1, 'import_chunk_row_count_non_negative'],
    ['attemptCount', -1, 'import_chunk_attempt_count_non_negative'],
  ] as const)('rejects invalid Chunk %s', async (field, value, constraint) => {
    const job = await createJob();

    const error = await createChunk(job.id, { [field]: value }).catch((caught: unknown) => caught);

    expectCheckConstraint(error, constraint);
  });

  it('rejects a non-positive failure row number', async () => {
    const job = await createJob();

    const error = await prisma.importFailure
      .create({
        data: {
          importJobId: job.id,
          rowNumber: 0,
          errorCode: 'INVALID_ROW',
          errorMessage: 'Row could not be parsed',
        },
      })
      .catch((caught: unknown) => caught);

    expectCheckConstraint(error, 'import_failure_row_number_positive');
  });

  it('records a Job-level failure without a Chunk', async () => {
    const job = await createJob();

    const failure = await prisma.importFailure.create({
      data: {
        importJobId: job.id,
        errorCode: 'INVALID_FILE',
        errorMessage: 'Required header is missing',
      },
    });

    expect(failure.importJobId).toBe(job.id);
    expect(failure.importChunkId).toBeNull();
    expect(failure.rowNumber).toBeNull();
  });

  it('records a row failure for a Job and Chunk', async () => {
    const job = await createJob();
    const chunk = await createChunk(job.id);

    const failure = await prisma.importFailure.create({
      data: {
        importJobId: job.id,
        importChunkId: chunk.id,
        rowNumber: 42,
        sku: 'SKU-42',
        rawData: { sku: 'SKU-42', price: 'invalid' },
        errorCode: 'INVALID_PRICE',
        errorMessage: 'Price must be a decimal value',
      },
    });

    expect(failure).toMatchObject({
      importJobId: job.id,
      importChunkId: chunk.id,
      rowNumber: 42,
      sku: 'SKU-42',
    });
  });

  it('cascades Chunk and Failure deletion when a Job is deleted', async () => {
    const job = await createJob();
    const chunk = await createChunk(job.id);
    const failure = await prisma.importFailure.create({
      data: {
        importJobId: job.id,
        importChunkId: chunk.id,
        errorCode: 'INVALID_ROW',
        errorMessage: 'Row could not be processed',
      },
    });

    await prisma.importJob.delete({ where: { id: job.id } });

    const [persistedChunk, persistedFailure] = await Promise.all([
      prisma.importChunk.findUnique({ where: { id: chunk.id } }),
      prisma.importFailure.findUnique({ where: { id: failure.id } }),
    ]);
    expect(persistedChunk).toBeNull();
    expect(persistedFailure).toBeNull();
  });

  it('preserves a Failure and clears its Chunk reference when the Chunk is deleted', async () => {
    const job = await createJob();
    const chunk = await createChunk(job.id);
    const failure = await prisma.importFailure.create({
      data: {
        importJobId: job.id,
        importChunkId: chunk.id,
        rowNumber: 10,
        errorCode: 'INVALID_ROW',
        errorMessage: 'Row could not be processed',
      },
    });

    await prisma.importChunk.delete({ where: { id: chunk.id } });

    const persistedFailure = await prisma.importFailure.findUnique({
      where: { id: failure.id },
    });
    expect(persistedFailure?.importJobId).toBe(job.id);
    expect(persistedFailure?.importChunkId).toBeNull();
  });
});
