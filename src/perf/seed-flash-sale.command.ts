import 'dotenv/config';
import { closeSharedResources } from '../config/close-shared-resources.js';
import { PerfArgumentError } from './args.js';
import { ReservedCleanupError } from './reserved-cleanup.js';
import {
  formatSeedFlashSaleReport,
  parseSeedFlashSaleOptions,
  seedFlashSale,
} from './seed-flash-sale.js';

const main = async (): Promise<void> => {
  const result = await seedFlashSale(parseSeedFlashSaleOptions(process.argv.slice(2)));
  console.log(formatSeedFlashSaleReport(result));
  if ('queryPlan' in result && result.queryPlan !== undefined) {
    console.log('\nQUERY PLAN\n');
    console.log(result.queryPlan);
  }
};

void main()
  .catch((error: unknown) => {
    if (error instanceof PerfArgumentError || error instanceof ReservedCleanupError) {
      console.error(error.message);
    } else {
      console.error('Flash-sale seed failed');
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSharedResources();
  });
