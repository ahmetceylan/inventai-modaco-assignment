import { createReadStream } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { closeSharedResources } from '../config/close-shared-resources.js';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { ImportChunkStatus, ImportJobStatus } from '../generated/prisma/client.js';
import { createImportJob, getImportJob } from '../ingestion/import.service.js';
import { resolveContainedPath } from '../ingestion/import-storage-path.js';
import { prepareNextImport } from '../ingestion/prepare-import.js';
import { processNextImportChunk } from '../ingestion/process-import-chunk.js';
import {
  assertAllowedFlags,
  parseFlags,
  PerfArgumentError,
  readPositiveInteger,
  readRequiredString,
} from './args.js';
import { PERF_VENDOR_SKU_PREFIX } from './constants.js';
import { createRssTracker, formatBytes } from './rss.js';

const TERMINAL_STATUSES = new Set<ImportJobStatus>([
  ImportJobStatus.COMPLETED,
  ImportJobStatus.COMPLETED_WITH_ERRORS,
  ImportJobStatus.FAILED,
  ImportJobStatus.CANCELLED,
]);

export interface IngestionBenchmarkOptions {
  file: string;
  concurrency: number;
}

export interface IngestionBenchmarkResult {
  jobId: string;
  inputRows: number;
  chunkSize: number;
  chunkCount: number;
  preparationMs: number;
  processingMs: number;
  rowsPerSecond: number;
  succeededRows: number;
  failedRows: number;
  retryCount: number;
  finalStatus: ImportJobStatus;
  productCount: number;
  peakRssBytes: number;
  maxConcurrentWorkers: number;
}

export const parseIngestionBenchmarkOptions = (argv: string[]): IngestionBenchmarkOptions => {
  const flags = parseFlags(argv);
  assertAllowedFlags(flags, ['file', 'concurrency']);

  return {
    file: readRequiredString(flags, 'file'),
    concurrency: readPositiveInteger(flags, 'concurrency', 1, 4),
  };
};

const stageImportFile = async (sourcePath: string): Promise<{ storedName: string; absolutePath: string }> => {
  await access(sourcePath);
  await mkdir(env.IMPORT_STORAGE_PATH, { recursive: true });
  const storedName = `${randomUUID()}.csv`;
  const absolutePath = resolveContainedPath(env.IMPORT_STORAGE_PATH, storedName);
  await pipeline(createReadStream(sourcePath), createWriteStream(absolutePath));
  return { storedName, absolutePath };
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const processAvailableChunks = async (
  jobId: string,
  concurrency: number,
  rss: { sample: () => void },
): Promise<{ retryCount: number; maxConcurrentWorkers: number }> => {
  let retryCount = 0;
  let maxConcurrentWorkers = 0;
  let active = 0;
  let idleRounds = 0;

  const runOne = async (): Promise<boolean> => {
    active += 1;
    maxConcurrentWorkers = Math.max(maxConcurrentWorkers, active);
    try {
      const result = await processNextImportChunk({ jobId });
      rss.sample();
      return result !== null;
    } catch {
      retryCount += 1;
      rss.sample();
      return true;
    } finally {
      active -= 1;
    }
  };

  while (idleRounds < 5) {
    const job = await getImportJob(jobId);
    if (job !== null && TERMINAL_STATUSES.has(job.status)) {
      break;
    }

    const workers = Array.from({ length: concurrency }, () => runOne());
    const progressed = (await Promise.all(workers)).some(Boolean);

    if (progressed) {
      idleRounds = 0;
      continue;
    }

    idleRounds += 1;
    const waiting = await prisma.importChunk.findFirst({
      where: {
        importJobId: jobId,
        status: { in: [ImportChunkStatus.PENDING, ImportChunkStatus.PROCESSING] },
      },
      orderBy: { availableAt: 'asc' },
      select: { availableAt: true, status: true },
    });

    if (waiting === null) {
      break;
    }

    const delay = Math.min(Math.max(0, waiting.availableAt.getTime() - Date.now()), 1_000);
    await sleep(delay === 0 ? 200 : delay);
  }

  return { retryCount, maxConcurrentWorkers };
};

export const runIngestionBenchmark = async (
  options: IngestionBenchmarkOptions,
): Promise<IngestionBenchmarkResult> => {
  const source = await stat(options.file);
  if (!source.isFile()) {
    throw new PerfArgumentError('--file must point to a CSV file');
  }

  const rss = createRssTracker();
  const staged = await stageImportFile(options.file);
  const job = await createImportJob({
    originalName: basename(options.file),
    storedName: staged.storedName,
    absolutePath: staged.absolutePath,
  });

  const preparationStarted = Date.now();
  const prepared = await prepareNextImport({ jobId: job.id });
  const preparationMs = Date.now() - preparationStarted;
  rss.sample();

  if (prepared === null) {
    throw new PerfArgumentError('Preparation did not claim the created ImportJob');
  }

  const processingStarted = Date.now();
  const processing = await processAvailableChunks(job.id, options.concurrency, rss);
  const processingMs = Date.now() - processingStarted;

  const finished = await getImportJob(job.id);
  if (finished === null) {
    throw new Error('ImportJob disappeared during processing');
  }

  const productCount = await prisma.product.count({
    where: { sku: { startsWith: PERF_VENDOR_SKU_PREFIX } },
  });
  const inputRows = prepared.totalRows;
  const rowsPerSecond = processingMs === 0 ? 0 : (finished.processedRows / processingMs) * 1_000;

  return {
    jobId: finished.id,
    inputRows,
    chunkSize: env.IMPORT_CHUNK_SIZE,
    chunkCount: prepared.chunkCount,
    preparationMs,
    processingMs,
    rowsPerSecond,
    succeededRows: finished.succeededRows,
    failedRows: finished.failedRows,
    retryCount: processing.retryCount,
    finalStatus: finished.status,
    productCount,
    peakRssBytes: rss.peakBytes(),
    maxConcurrentWorkers: processing.maxConcurrentWorkers,
  };
};

export const formatIngestionBenchmarkReport = (result: IngestionBenchmarkResult): string => {
  return [
    `jobId=${result.jobId}`,
    `inputRows=${result.inputRows}`,
    `chunkSize=${result.chunkSize}`,
    `chunkCount=${result.chunkCount}`,
    `preparationMs=${result.preparationMs}`,
    `processingMs=${result.processingMs}`,
    `rowsPerSecond=${result.rowsPerSecond.toFixed(1)}`,
    `succeededRows=${result.succeededRows}`,
    `failedRows=${result.failedRows}`,
    `retryCount=${result.retryCount}`,
    `finalStatus=${result.finalStatus}`,
    `skuPrefix=${PERF_VENDOR_SKU_PREFIX}`,
    `productCount=${result.productCount}`,
    `peakRss=${formatBytes(result.peakRssBytes)}`,
    `maxConcurrentWorkers=${result.maxConcurrentWorkers}`,
  ].join('\n');
};

export const closeIngestionBenchmark = async (): Promise<void> => {
  await closeSharedResources();
};
