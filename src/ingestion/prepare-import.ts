import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CsvError, parse } from 'csv-parse';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { ImportJobStatus, Prisma } from '../generated/prisma/client.js';
import { resolveContainedPath, StoragePathEscapeError } from './import-storage-path.js';

const REQUIRED_HEADERS = ['sku', 'name', 'category', 'basePrice', 'stockQuantity'] as const;

interface ClaimedImportJob {
  id: string;
  storagePath: string;
}

interface ChunkRow {
  rowNumber: number;
  data: Record<string, string>;
}

export interface PrepareImportResult {
  jobId: string;
  totalRows: number;
  chunkCount: number;
  fileChecksum: string;
}

export interface PrepareImportOptions {
  jobId?: string;
}

export class ImportJobClaimError extends Error {}

export class ImportPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly rowNumber: number | null = null,
  ) {
    super(message);
  }
}

const resolveStoragePath = (storedPath: string): string => {
  try {
    return resolveContainedPath(env.IMPORT_STORAGE_PATH, storedPath);
  } catch (error) {
    if (error instanceof StoragePathEscapeError) {
      throw new ImportPreparationError(
        'IMPORT_PREPARATION_FAILED',
        'Import storage reference is invalid',
      );
    }

    throw error;
  }
};

const chunkDirectoryFor = (jobId: string): string => {
  return resolveStoragePath(join('chunks', jobId));
};

const validateHeaders = (record: string[]): string[] => {
  const headers = record.map((header) => header.trim());

  if (headers.length === 0 || headers.every((header) => header === '')) {
    throw new ImportPreparationError('EMPTY_CSV', 'CSV file is empty', 1);
  }

  if (new Set(headers).size !== headers.length) {
    throw new ImportPreparationError('DUPLICATE_CSV_HEADER', 'CSV header names must be unique', 1);
  }

  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new ImportPreparationError(
      'INVALID_CSV_HEADER',
      `CSV is missing required headers: ${missingHeaders.join(', ')}`,
      1,
    );
  }

  return headers;
};

const asStringRecord = (record: unknown): string[] => {
  if (!Array.isArray(record) || !record.every((value) => typeof value === 'string')) {
    throw new ImportPreparationError('MALFORMED_CSV', 'CSV file is malformed');
  }

  return record;
};

const mapRow = (headers: string[], values: string[], rowNumber: number): ChunkRow => {
  return {
    rowNumber,
    data: Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
  };
};

const publishChunk = async (
  jobId: string,
  chunkNumber: number,
  rows: ChunkRow[],
): Promise<void> => {
  const finalName = `${chunkNumber.toString().padStart(6, '0')}.ndjson`;
  const temporaryName = `.${finalName}.${randomUUID()}.tmp`;
  const storedPath = join('chunks', jobId, finalName);
  const temporaryPath = resolveStoragePath(join('chunks', jobId, temporaryName));
  const finalPath = resolveStoragePath(storedPath);
  const contents = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, finalPath);
  } catch {
    await rm(temporaryPath, { force: true });
    throw new ImportPreparationError(
      'CHUNK_WRITE_FAILED',
      'A prepared chunk could not be written',
      rows[0]?.rowNumber ?? null,
    );
  }

  try {
    await prisma.importChunk.create({
      data: {
        importJobId: jobId,
        chunkNumber,
        storagePath: storedPath,
        startRowNumber: rows[0]!.rowNumber,
        rowCount: rows.length,
      },
    });
  } catch {
    throw new ImportPreparationError(
      'IMPORT_PREPARATION_FAILED',
      'Prepared chunk state could not be persisted',
      rows[0]?.rowNumber ?? null,
    );
  }
};

const normalizePreparationError = (error: unknown): ImportPreparationError => {
  if (error instanceof ImportPreparationError) {
    return error;
  }

  if (error instanceof CsvError) {
    const line = typeof error.lines === 'number' && error.lines >= 1 ? error.lines : null;
    return new ImportPreparationError('MALFORMED_CSV', 'CSV file is malformed', line);
  }

  return new ImportPreparationError('IMPORT_PREPARATION_FAILED', 'Import preparation failed');
};

const markPreparationFailed = async (
  jobId: string,
  error: ImportPreparationError,
): Promise<void> => {
  await rm(chunkDirectoryFor(jobId), { recursive: true, force: true });

  await prisma.$transaction([
    prisma.importChunk.deleteMany({ where: { importJobId: jobId } }),
    prisma.importFailure.create({
      data: {
        importJobId: jobId,
        importChunkId: null,
        rowNumber: error.rowNumber,
        errorCode: error.code,
        errorMessage: error.message,
      },
    }),
    prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: ImportJobStatus.FAILED,
        completedAt: new Date(),
      },
    }),
  ]);
};

export const claimPendingImportJob = async (
  requestedJobId?: string,
): Promise<ClaimedImportJob | null> => {
  const claimed = await prisma.$transaction(async (transaction) => {
    const requestedFilter =
      requestedJobId === undefined ? Prisma.empty : Prisma.sql`AND "id" = ${requestedJobId}::uuid`;
    const candidates = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ImportJob"
      WHERE "status" = 'PENDING'::"ImportJobStatus"
      ${requestedFilter}
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const candidate = candidates[0];

    if (candidate === undefined) {
      return null;
    }

    const job = await transaction.importJob.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { id: true, storagePath: true, startedAt: true },
    });

    await transaction.importJob.update({
      where: { id: job.id },
      data: {
        status: ImportJobStatus.PREPARING,
        ...(job.startedAt === null ? { startedAt: new Date() } : {}),
      },
    });

    return { id: job.id, storagePath: job.storagePath };
  });

  if (claimed !== null || requestedJobId === undefined) {
    return claimed;
  }

  const requestedJob = await prisma.importJob.findUnique({
    where: { id: requestedJobId },
    select: { status: true },
  });

  if (requestedJob === null) {
    throw new ImportJobClaimError(`Import job ${requestedJobId} was not found`);
  }

  throw new ImportJobClaimError(
    `Import job ${requestedJobId} is ${requestedJob.status}, not PENDING`,
  );
};

const prepareClaimedImportJob = async (job: ClaimedImportJob): Promise<PrepareImportResult> => {
  const rawPath = resolveStoragePath(job.storagePath);
  const chunkDirectory = chunkDirectoryFor(job.id);
  await rm(chunkDirectory, { recursive: true, force: true });
  await mkdir(chunkDirectory, { recursive: true });

  const checksum = createHash('sha256');
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      checksum.update(chunk);
      callback(null, chunk);
    },
  });
  const parser = parse({
    bom: true,
    skip_empty_lines: true,
  });
  const source = createReadStream(rawPath);
  const pipelinePromise = pipeline(source, hashingStream, parser);
  let headers: string[] | null = null;
  let pendingRows: ChunkRow[] = [];
  let totalRows = 0;
  let chunkCount = 0;

  try {
    for await (const parsedRecord of parser) {
      const record = asStringRecord(parsedRecord);

      if (headers === null) {
        headers = validateHeaders(record);
        continue;
      }

      totalRows += 1;
      pendingRows.push(mapRow(headers, record, totalRows + 1));

      if (pendingRows.length === env.IMPORT_CHUNK_SIZE) {
        await publishChunk(job.id, chunkCount, pendingRows);
        pendingRows = [];
        chunkCount += 1;
      }
    }

    await pipelinePromise;
  } catch (error) {
    source.destroy();
    hashingStream.destroy();
    parser.destroy();
    await pipelinePromise.catch(() => undefined);
    throw error;
  }

  if (headers === null) {
    throw new ImportPreparationError('EMPTY_CSV', 'CSV file is empty');
  }

  if (totalRows === 0) {
    throw new ImportPreparationError(
      'CSV_HAS_NO_DATA_ROWS',
      'CSV file contains a header but no data rows',
    );
  }

  if (pendingRows.length > 0) {
    await publishChunk(job.id, chunkCount, pendingRows);
    chunkCount += 1;
  }

  const fileChecksum = checksum.digest('hex');
  const updated = await prisma.importJob.updateMany({
    where: {
      id: job.id,
      status: ImportJobStatus.PREPARING,
    },
    data: {
      status: ImportJobStatus.READY,
      totalRows,
      fileChecksum,
      processedRows: 0,
      succeededRows: 0,
      failedRows: 0,
      completedAt: null,
    },
  });

  if (updated.count !== 1) {
    throw new ImportPreparationError(
      'IMPORT_PREPARATION_FAILED',
      'Import job could not be marked ready',
    );
  }

  return {
    jobId: job.id,
    totalRows,
    chunkCount,
    fileChecksum,
  };
};

export const prepareNextImport = async (
  options: PrepareImportOptions = {},
): Promise<PrepareImportResult | null> => {
  const job = await claimPendingImportJob(options.jobId);

  if (job === null) {
    return null;
  }

  try {
    return await prepareClaimedImportJob(job);
  } catch (error) {
    const preparationError = normalizePreparationError(error);
    await markPreparationFailed(job.id, preparationError);
    throw preparationError;
  }
};
