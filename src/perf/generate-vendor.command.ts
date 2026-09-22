import 'dotenv/config';
import { PerfArgumentError } from './args.js';
import {
  formatGenerateVendorReport,
  generateVendorCsv,
  parseGenerateVendorOptions,
} from './generate-vendor.js';

const main = async (): Promise<void> => {
  const result = await generateVendorCsv(parseGenerateVendorOptions(process.argv.slice(2)));
  console.log(formatGenerateVendorReport(result));
};

void main().catch((error: unknown) => {
  if (error instanceof PerfArgumentError) {
    console.error(error.message);
  } else {
    console.error('Vendor CSV generation failed');
  }
  process.exitCode = 1;
});
