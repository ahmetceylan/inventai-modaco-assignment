import 'dotenv/config';
import { prisma } from '../config/prisma.js';
import { parseImportJobId } from './import.schemas.js';
import { ChunkProcessingError, processNextImportChunk } from './process-import-chunk.js';

const readRequestedJobId = (args: string[]): string | undefined => {
  if (args.length === 0) {
    return undefined;
  }

  if (args.length !== 1 || !args[0]?.startsWith('--job-id=')) {
    throw new Error('Usage: ingestion:process [--job-id=<uuid>]');
  }

  const value = args[0].slice('--job-id='.length);

  try {
    return parseImportJobId(value);
  } catch {
    throw new Error('--job-id must be a valid UUID');
  }
};

const main = async (): Promise<void> => {
  const jobId = readRequestedJobId(process.argv.slice(2));
  const result = await processNextImportChunk({
    ...(jobId === undefined ? {} : { jobId }),
  });

  if (result === null) {
    console.log('No available import chunk');
    return;
  }

  console.log(
    `Processed import chunk ${result.chunkId}: ${result.succeededRows} succeeded, ${result.failedRows} failed`,
  );
};

void main()
  .catch((error: unknown) => {
    if (error instanceof ChunkProcessingError) {
      console.error(`Import chunk failed with ${error.code}: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error('Import chunk processing command failed');
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
