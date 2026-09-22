import 'dotenv/config';
import { closeSharedResources } from '../config/close-shared-resources.js';
import { parseImportJobId } from './import.schemas.js';
import {
  ImportJobClaimError,
  ImportPreparationError,
  prepareNextImport,
} from './prepare-import.js';

const readRequestedJobId = (args: string[]): string | undefined => {
  if (args.length === 0) {
    return undefined;
  }

  if (args.length !== 1 || !args[0]?.startsWith('--job-id=')) {
    throw new ImportJobClaimError('Usage: ingestion:prepare [--job-id=<uuid>]');
  }

  const value = args[0].slice('--job-id='.length);

  try {
    return parseImportJobId(value);
  } catch {
    throw new ImportJobClaimError('--job-id must be a valid UUID');
  }
};

const main = async (): Promise<void> => {
  const jobId = readRequestedJobId(process.argv.slice(2));
  const result = await prepareNextImport({ ...(jobId === undefined ? {} : { jobId }) });

  if (result === null) {
    console.log('No pending import job available');
    return;
  }

  console.log(
    `Prepared import job ${result.jobId}: ${result.totalRows} rows in ${result.chunkCount} chunks`,
  );
};

void main()
  .catch((error: unknown) => {
    if (error instanceof ImportJobClaimError) {
      console.error(error.message);
    } else if (error instanceof ImportPreparationError) {
      console.error(`Import preparation failed with ${error.code}: ${error.message}`);
    } else {
      console.error('Import preparation command failed');
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSharedResources();
  });
