import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ImportJobStatus, type Prisma } from '../src/generated/prisma/client.js';
import { type prisma as PrismaClientInstance } from '../src/config/prisma.js';

interface NdjsonRow {
  rowNumber: number;
  data: Record<string, string>;
}

describe('Import CSV preparation', () => {
  const originalEnvironment = {
    storagePath: process.env.IMPORT_STORAGE_PATH,
    chunkSize: process.env.IMPORT_CHUNK_SIZE,
  };
  let app!: Express;
  let prisma!: typeof PrismaClientInstance;
  let preparation!: typeof import('../src/ingestion/prepare-import.js');
  let storagePath!: string;

  beforeAll(async () => {
    storagePath = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'modaco-preparation-')),
    );
    process.env.IMPORT_STORAGE_PATH = storagePath;
    process.env.IMPORT_CHUNK_SIZE = '2';

    vi.resetModules();
    const [preparationModule, prismaModule, appModule] = await Promise.all([
      import('../src/ingestion/prepare-import.js'),
      import('../src/config/prisma.js'),
      import('../src/app.js'),
    ]);
    preparation = preparationModule;
    prisma = prismaModule.prisma;
    app = appModule.createApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.importJob.deleteMany();
    const entries = await readdir(storagePath);
    await Promise.all(
      entries.map((entry) => rm(join(storagePath, entry), { recursive: true, force: true })),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(storagePath, { recursive: true, force: true });
    restoreEnvironment('IMPORT_STORAGE_PATH', originalEnvironment.storagePath);
    restoreEnvironment('IMPORT_CHUNK_SIZE', originalEnvironment.chunkSize);
  });

  const createUploadedJob = async (
    csv: string | Buffer,
    overrides: Partial<Prisma.ImportJobUncheckedCreateInput> = {},
  ) => {
    const storedName = `${randomUUID()}.csv`;
    const rawBytes = typeof csv === 'string' ? Buffer.from(csv) : csv;
    await writeFile(join(storagePath, storedName), rawBytes);

    const job = await prisma.importJob.create({
      data: {
        originalFileName: 'vendor-products.csv',
        storagePath: storedName,
        pricingRuleVersion: 'pricing-v1',
        ...overrides,
      },
    });

    return { job, rawBytes, rawPath: join(storagePath, storedName) };
  };

  it('claims one PENDING Job and changes it to PREPARING', async () => {
    const { job } = await createUploadedJob(validCsv());

    const claimed = await preparation.claimPendingImportJob(job.id);
    const persisted = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });

    expect(claimed).toEqual({ id: job.id, storagePath: job.storagePath });
    expect(persisted.status).toBe(ImportJobStatus.PREPARING);
    expect(persisted.startedAt).toBeInstanceOf(Date);
  });

  it('allows only one concurrent claim for the same PENDING Job', async () => {
    const { job } = await createUploadedJob(validCsv());

    const claims = await Promise.all([
      preparation.claimPendingImportJob(),
      preparation.claimPendingImportJob(),
    ]);

    expect(claims.filter((claim) => claim?.id === job.id)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  it('returns null when no PENDING Job is available', async () => {
    await expect(preparation.prepareNextImport()).resolves.toBeNull();
  });

  it('does not process a requested Job that is not PENDING', async () => {
    const { job } = await createUploadedJob(validCsv(), {
      status: ImportJobStatus.READY,
    });

    const error = await preparation
      .prepareNextImport({ jobId: job.id })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(preparation.ImportJobClaimError);
    expect((error as Error).message).toContain('not PENDING');
    await expect(prisma.importChunk.count()).resolves.toBe(0);
  });

  it('reports an unknown requested Job clearly', async () => {
    const error = await preparation
      .prepareNextImport({ jobId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(preparation.ImportJobClaimError);
    expect((error as Error).message).toContain('was not found');
  });

  it('parses quoted CSV, preserves extra columns, and publishes deterministic chunks', async () => {
    const csv = [
      'sku,name,category,basePrice,stockQuantity,note',
      'SKU-1,"Bag, Large",Accessories,100.00,10,"quoted ""value"""',
      'SKU-2,Shirt,Clothing,50.00,5,plain',
      'SKU-3,Shoes,Footwear,80.00,3,last',
      'SKU-4,Hat,Accessories,20.00,8,fourth',
      'SKU-5,Socks,Clothing,10.00,12,fifth',
      '',
    ].join('\r\n');
    const { job, rawBytes } = await createUploadedJob(csv);
    const productCountBefore = await prisma.product.count();

    const result = await preparation.prepareNextImport({ jobId: job.id });
    const persisted = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    const chunks = await prisma.importChunk.findMany({
      where: { importJobId: job.id },
      orderBy: { chunkNumber: 'asc' },
    });
    const chunkDirectory = join(storagePath, 'chunks', job.id);
    const files = await readdir(chunkDirectory);
    const firstChunkRows = await readNdjson(join(chunkDirectory, '000000.ndjson'));
    const finalChunkRows = await readNdjson(join(chunkDirectory, '000002.ndjson'));

    expect(result).toMatchObject({ jobId: job.id, totalRows: 5, chunkCount: 3 });
    expect(
      chunks.map(({ chunkNumber, startRowNumber, rowCount }) => ({
        chunkNumber,
        startRowNumber,
        rowCount,
      })),
    ).toEqual([
      { chunkNumber: 0, startRowNumber: 2, rowCount: 2 },
      { chunkNumber: 1, startRowNumber: 4, rowCount: 2 },
      { chunkNumber: 2, startRowNumber: 6, rowCount: 1 },
    ]);
    expect(chunks.map(({ storagePath: path }) => path)).toEqual([
      `chunks/${job.id}/000000.ndjson`,
      `chunks/${job.id}/000001.ndjson`,
      `chunks/${job.id}/000002.ndjson`,
    ]);
    expect(files.sort()).toEqual(['000000.ndjson', '000001.ndjson', '000002.ndjson']);
    expect(firstChunkRows[0]).toEqual({
      rowNumber: 2,
      data: {
        sku: 'SKU-1',
        name: 'Bag, Large',
        category: 'Accessories',
        basePrice: '100.00',
        stockQuantity: '10',
        note: 'quoted "value"',
      },
    });
    expect(finalChunkRows).toEqual([
      {
        rowNumber: 6,
        data: {
          sku: 'SKU-5',
          name: 'Socks',
          category: 'Clothing',
          basePrice: '10.00',
          stockQuantity: '12',
          note: 'fifth',
        },
      },
    ]);
    expect(persisted).toMatchObject({
      status: ImportJobStatus.READY,
      totalRows: 5,
      fileChecksum: createHash('sha256').update(rawBytes).digest('hex'),
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
      completedAt: null,
    });
    await expect(prisma.product.count()).resolves.toBe(productCountBefore);
  });

  it('supports LF line endings', async () => {
    const { job } = await createUploadedJob(validCsv('\n'));

    const result = await preparation.prepareNextImport({ jobId: job.id });

    expect(result?.totalRows).toBe(1);
  });

  it.each([
    [
      'missing required headers',
      'sku,name,category,basePrice\nSKU-1,Bag,Accessories,10.00\n',
      'INVALID_CSV_HEADER',
    ],
    [
      'duplicate headers',
      'sku,name,name,category,basePrice,stockQuantity\nSKU-1,Bag,Bag,Accessories,10.00,1\n',
      'DUPLICATE_CSV_HEADER',
    ],
    ['an empty file', '', 'EMPTY_CSV'],
    ['a header-only file', 'sku,name,category,basePrice,stockQuantity\n', 'CSV_HAS_NO_DATA_ROWS'],
    [
      'malformed quoted CSV',
      'sku,name,category,basePrice,stockQuantity\nSKU-1,"Bag,Accessories,10.00,1\n',
      'MALFORMED_CSV',
    ],
  ])('fails preparation for %s', async (_case, csv, errorCode) => {
    const { job, rawPath } = await createUploadedJob(csv);

    const error = await preparation
      .prepareNextImport({ jobId: job.id })
      .catch((caught: unknown) => caught);
    const persisted = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    const failures = await prisma.importFailure.findMany({ where: { importJobId: job.id } });

    expect(error).toBeInstanceOf(preparation.ImportPreparationError);
    expect(persisted.status).toBe(ImportJobStatus.FAILED);
    expect(persisted.completedAt).toBeInstanceOf(Date);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      importChunkId: null,
      errorCode,
    });
    await expect(prisma.importChunk.count({ where: { importJobId: job.id } })).resolves.toBe(0);
    await expect(access(rawPath)).resolves.toBeUndefined();
  });

  it('removes partial chunk files and records when preparation fails', async () => {
    const { job, rawPath } = await createUploadedJob(
      [
        'sku,name,category,basePrice,stockQuantity',
        'SKU-1,Bag,Accessories,10.00,1',
        'SKU-2,Shirt,Clothing,20.00,2',
        'SKU-3,Hat,Accessories,5.00,3',
      ].join('\n'),
    );
    const createChunk = prisma.importChunk.create.bind(prisma.importChunk);
    vi.spyOn(prisma.importChunk, 'create')
      .mockImplementationOnce((args) => createChunk(args))
      .mockRejectedValueOnce(new Error('simulated chunk persistence failure'));

    await expect(preparation.prepareNextImport({ jobId: job.id })).rejects.toBeInstanceOf(
      preparation.ImportPreparationError,
    );

    const failures = await prisma.importFailure.findMany({ where: { importJobId: job.id } });
    expect(failures[0]?.errorCode).toBe('IMPORT_PREPARATION_FAILED');
    await expect(prisma.importChunk.count({ where: { importJobId: job.id } })).resolves.toBe(0);
    await expect(access(join(storagePath, 'chunks', job.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(rawPath)).resolves.toBeUndefined();
  });

  it('keeps internal preparation details out of the status endpoint', async () => {
    const { job } = await createUploadedJob('');
    await preparation.prepareNextImport({ jobId: job.id }).catch(() => undefined);

    const response = await request(app).get(`/imports/${job.id}`);
    const body = JSON.parse(response.text) as { data: { status: string } };

    expect(response.status).toBe(200);
    expect(body.data.status).toBe('FAILED');
    expect(response.text).not.toContain('storagePath');
    expect(response.text).not.toContain(storagePath);
    expect(response.text).not.toContain('EMPTY_CSV');
  });

  it('keeps a moderate generated file bounded by the configured chunk size', async () => {
    const rows = Array.from(
      { length: 101 },
      (_, index) => `SKU-${index},Product ${index},Category,10.00,1`,
    );
    const { job } = await createUploadedJob(
      ['sku,name,category,basePrice,stockQuantity', ...rows].join('\n'),
    );

    const result = await preparation.prepareNextImport({ jobId: job.id });
    const chunks = await prisma.importChunk.findMany({ where: { importJobId: job.id } });

    expect(result).toMatchObject({ totalRows: 101, chunkCount: 51 });
    expect(Math.max(...chunks.map(({ rowCount }) => rowCount))).toBeLessThanOrEqual(2);
    expect(chunks.reduce((sum, { rowCount }) => sum + rowCount, 0)).toBe(101);
  });
});

const validCsv = (lineEnding = '\r\n'): string => {
  return ['sku,name,category,basePrice,stockQuantity', 'SKU-1,Bag,Accessories,100.00,10', ''].join(
    lineEnding,
  );
};

const readNdjson = async (path: string): Promise<NdjsonRow[]> => {
  const contents = await readFile(path, 'utf8');
  return contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as NdjsonRow);
};

const restoreEnvironment = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
};
