import 'dotenv/config';
import { PerfArgumentError } from './args.js';
import {
  closeIngestionBenchmark,
  formatIngestionBenchmarkReport,
  parseIngestionBenchmarkOptions,
  runIngestionBenchmark,
} from './ingestion.js';

const main = async (): Promise<void> => {
  const result = await runIngestionBenchmark(parseIngestionBenchmarkOptions(process.argv.slice(2)));
  console.log(formatIngestionBenchmarkReport(result));
};

void main()
  .catch((error: unknown) => {
    if (error instanceof PerfArgumentError) {
      console.error(error.message);
    } else {
      console.error('Ingestion benchmark failed');
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeIngestionBenchmark();
  });
