import 'dotenv/config';
import { closeSharedResources } from '../config/close-shared-resources.js';
import { PerfArgumentError } from './args.js';
import { formatReadLoadReport, parseReadLoadOptions, runReadLoad } from './read-load.js';

const main = async (): Promise<void> => {
  const options = parseReadLoadOptions(process.argv.slice(2));
  if (options.scenarios.includes('fallback')) {
    console.log(
      'scenario=fallback requires the API process to run with Redis unavailable; this command does not stop Redis',
    );
  }

  const samples = await runReadLoad(options);
  console.log(formatReadLoadReport(samples));
};

void main()
  .catch((error: unknown) => {
    if (error instanceof PerfArgumentError) {
      console.error(error.message);
    } else {
      console.error('Read-load smoke test failed');
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSharedResources();
  });
