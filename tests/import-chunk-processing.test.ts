import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ImportChunkStatus, ImportJobStatus, type Prisma } from '../src/generated/prisma/client.js';
import { type prisma as PrismaClientInstance } from '../src/config/prisma.js';

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
  let storagePath!: string;

  beforeAll(async () => {
    storagePath = await mkdtemp(join(tmpdir(), 'modaco-processing-'));
    process.env.IMPORT_STORAGE_PATH = storagePath;

    vi.resetModules();
    const [processorModule, prismaModule, appModule] = await Promise.all([
      import('../src/ingestion/process-import-chunk.js'),
      import('../src/config/prisma.js'),
      import('../src/app.js'),
    ]);
    processor = processorModule;
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
  });

  it('does not process a completed Chunk again', async () => {
    const job = await createJob({ totalRows: 1 });
    await createChunk(job.id, 0, [validRow(2)]);
    await processor.processNextImportChunk({ jobId: job.id });

    await expect(processor.processNextImportChunk({ jobId: job.id })).resolves.toBeNull();
    await expect(prisma.product.count()).resolves.toBe(1);
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
