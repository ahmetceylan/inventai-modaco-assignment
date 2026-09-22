import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Express } from 'express';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type prisma as PrismaClientInstance } from '../src/config/prisma.js';

interface ImportJobJson {
  id: string;
  status: string;
  originalFileName: string;
  totalRows: number | null;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  pricingRuleVersion: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  statusUrl?: string;
}

interface ImportJobResponseJson {
  data: ImportJobJson;
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    details: unknown[];
  };
}

const parseBody = <T>(response: Response): T => {
  return JSON.parse(response.text) as T;
};

describe('Import upload and status endpoints', () => {
  const originalEnvironment = {
    storagePath: process.env.IMPORT_STORAGE_PATH,
    maxFileSize: process.env.MAX_IMPORT_FILE_SIZE_BYTES,
    pricingRuleVersion: process.env.PRICING_RULE_VERSION,
  };
  let app!: Express;
  let prisma!: typeof PrismaClientInstance;
  let storagePath!: string;

  beforeAll(async () => {
    storagePath = await mkdtemp(join(tmpdir(), 'modaco-imports-'));
    process.env.IMPORT_STORAGE_PATH = storagePath;
    process.env.MAX_IMPORT_FILE_SIZE_BYTES = '65536';
    process.env.PRICING_RULE_VERSION = 'pricing-test-v7';

    vi.resetModules();
    const [{ createApp }, prismaModule] = await Promise.all([
      import('../src/app.js'),
      import('../src/config/prisma.js'),
    ]);
    app = createApp();
    prisma = prismaModule.prisma;
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
    restoreEnvironment('MAX_IMPORT_FILE_SIZE_BYTES', originalEnvironment.maxFileSize);
    restoreEnvironment('PRICING_RULE_VERSION', originalEnvironment.pricingRuleVersion);
  });

  it('streams a valid CSV to disk and creates a PENDING ImportJob', async () => {
    const header = Buffer.from('sku,name,price\n');
    const padding = Buffer.alloc(32 * 1024, 'a');
    const fileContents = Buffer.concat([header, padding]);

    const response = await request(app).post('/imports').attach('file', fileContents, {
      filename: 'vendor-products.csv',
      contentType: 'text/csv',
    });
    const body = parseBody<ImportJobResponseJson>(response);
    const jobs = await prisma.importJob.findMany();

    expect(response.status).toBe(202);
    expect(body.data).toMatchObject({
      status: 'PENDING',
      originalFileName: 'vendor-products.csv',
      totalRows: null,
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
      pricingRuleVersion: 'pricing-test-v7',
      statusUrl: `/imports/${body.data.id}`,
    });
    expect(response.text).not.toContain('storagePath');
    expect(jobs).toHaveLength(1);

    const job = jobs[0]!;
    expect(job.storagePath).toMatch(/^[0-9a-f-]{36}\.csv$/);
    expect(job.storagePath).not.toBe(job.originalFileName);
    await expect(readFile(join(storagePath, job.storagePath))).resolves.toEqual(fileContents);
  });

  it('rejects a missing file without creating a Job', async () => {
    const response = await request(app).post('/imports').field('source', 'vendor');

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response).error.code).toBe('IMPORT_FILE_REQUIRED');
    await expect(prisma.importJob.count()).resolves.toBe(0);
  });

  it('rejects an empty file and removes it from storage', async () => {
    const response = await request(app).post('/imports').attach('file', Buffer.alloc(0), {
      filename: 'empty.csv',
      contentType: 'text/csv',
    });

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response).error.code).toBe('EMPTY_IMPORT_FILE');
    await expect(prisma.importJob.count()).resolves.toBe(0);
    await expect(readdir(storagePath)).resolves.toEqual([]);
  });

  it.each([
    ['unsupported extension', 'vendor-products.txt', 'text/csv'],
    ['unsupported MIME type', 'vendor-products.csv', 'application/pdf'],
  ])('rejects an %s', async (_case, filename, contentType) => {
    const response = await request(app)
      .post('/imports')
      .attach('file', Buffer.from('sku,name\n1,bag\n'), {
        filename,
        contentType,
      });

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response).error.code).toBe('UNSUPPORTED_IMPORT_FILE');
    await expect(prisma.importJob.count()).resolves.toBe(0);
    await expect(readdir(storagePath)).resolves.toEqual([]);
  });

  it('returns 413 and removes a file that exceeds the configured limit', async () => {
    const response = await request(app).post('/imports').attach('file', Buffer.alloc(65_537, 'a'), {
      filename: 'oversized.csv',
      contentType: 'text/csv',
    });

    expect(response.status).toBe(413);
    expect(parseBody<ErrorJson>(response).error.code).toBe('IMPORT_FILE_TOO_LARGE');
    await expect(prisma.importJob.count()).resolves.toBe(0);
    await expect(readdir(storagePath)).resolves.toEqual([]);
  });

  it('rejects more than one file and removes all uploaded files', async () => {
    const response = await request(app)
      .post('/imports')
      .attach('file', Buffer.from('sku\n1\n'), {
        filename: 'first.csv',
        contentType: 'text/csv',
      })
      .attach('file', Buffer.from('sku\n2\n'), {
        filename: 'second.csv',
        contentType: 'text/csv',
      });

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    await expect(prisma.importJob.count()).resolves.toBe(0);
    await expect(readdir(storagePath)).resolves.toEqual([]);
  });

  it('rejects malformed multipart data', async () => {
    const response = await request(app)
      .post('/imports')
      .set('Content-Type', 'multipart/form-data')
      .send('not-a-valid-multipart-body');

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
    await expect(prisma.importJob.count()).resolves.toBe(0);
  });

  it('cannot escape storage with a traversal-style original filename', async () => {
    const response = await request(app).post('/imports').attach('file', Buffer.from('sku\n1\n'), {
      filename: '../../outside.csv',
      contentType: 'text/csv',
    });
    const job = await prisma.importJob.findFirstOrThrow();

    expect(response.status).toBe(202);
    expect(job.originalFileName).toBe('outside.csv');
    expect(join(storagePath, job.storagePath).startsWith(`${storagePath}/`)).toBe(true);
    await expect(readdir(storagePath)).resolves.toEqual([job.storagePath]);
  });

  it('does not overwrite uploads with the same original filename', async () => {
    const [first, second] = await Promise.all([
      request(app).post('/imports').attach('file', Buffer.from('sku\nfirst\n'), {
        filename: 'same.csv',
        contentType: 'text/csv',
      }),
      request(app).post('/imports').attach('file', Buffer.from('sku\nsecond\n'), {
        filename: 'same.csv',
        contentType: 'text/csv',
      }),
    ]);
    const jobs = await prisma.importJob.findMany({ orderBy: { createdAt: 'asc' } });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.storagePath).not.toBe(jobs[1]!.storagePath);
    await expect(readdir(storagePath)).resolves.toHaveLength(2);
  });

  it('removes the stored file when ImportJob persistence fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(prisma.importJob, 'create').mockRejectedValueOnce(
      new Error('simulated persistence failure'),
    );

    const response = await request(app).post('/imports').attach('file', Buffer.from('sku\n1\n'), {
      filename: 'database-failure.csv',
      contentType: 'text/csv',
    });

    expect(response.status).toBe(500);
    expect(parseBody<ErrorJson>(response).error.code).toBe('INTERNAL_ERROR');
    await expect(prisma.importJob.count()).resolves.toBe(0);
    await expect(readdir(storagePath)).resolves.toEqual([]);
  });

  it('returns public status fields for an existing Job', async () => {
    const job = await prisma.importJob.create({
      data: {
        originalFileName: 'status.csv',
        storagePath: 'internal-status.csv',
        pricingRuleVersion: 'pricing-test-v7',
      },
    });

    const response = await request(app).get(`/imports/${job.id}`);
    const body = parseBody<ImportJobResponseJson>(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      id: job.id,
      status: 'PENDING',
      originalFileName: 'status.csv',
      totalRows: null,
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
      pricingRuleVersion: 'pricing-test-v7',
      startedAt: null,
      completedAt: null,
    });
    expect(body.data.createdAt).toEqual(expect.any(String));
    expect(body.data.updatedAt).toEqual(expect.any(String));
    expect(response.text).not.toContain('storagePath');
    expect(response.text).not.toContain('internal-status.csv');
  });

  it('returns 404 for an unknown ImportJob', async () => {
    const response = await request(app).get('/imports/ffffffff-ffff-4fff-8fff-ffffffffffff');

    expect(response.status).toBe(404);
    expect(parseBody<ErrorJson>(response).error.code).toBe('IMPORT_JOB_NOT_FOUND');
  });

  it('returns 400 for an invalid ImportJob UUID', async () => {
    const response = await request(app).get('/imports/not-a-uuid');

    expect(response.status).toBe(400);
    expect(parseBody<ErrorJson>(response).error.code).toBe('VALIDATION_ERROR');
  });
});

const restoreEnvironment = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
};
