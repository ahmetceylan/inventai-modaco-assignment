import { createWriteStream } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  DEFAULT_VENDOR_OUTPUT,
  DEFAULT_VENDOR_ROWS,
  MAX_VENDOR_ROWS,
  PERF_VENDOR_CATEGORY_COUNT,
  PERF_VENDOR_CATEGORY_PREFIX,
  PERF_VENDOR_SKU_PREFIX,
} from './constants.js';
import {
  assertAllowedFlags,
  parseFlags,
  PerfArgumentError,
  readBooleanFlag,
  readPositiveInteger,
  type FlagMap,
} from './args.js';
import { resolveInsideCwd } from './paths.js';
import { createRssTracker, formatBytes } from './rss.js';

export interface GenerateVendorOptions {
  rows: number;
  output: string;
  force: boolean;
  seed: number;
}

export interface GenerateVendorResult {
  outputPath: string;
  rows: number;
  fileSizeBytes: number;
  durationMs: number;
  peakRssBytes: number;
}

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
};

export const formatVendorSku = (index: number): string => {
  return `${PERF_VENDOR_SKU_PREFIX}${String(index).padStart(7, '0')}`;
};

export const formatVendorCategory = (index: number): string => {
  return `${PERF_VENDOR_CATEGORY_PREFIX}${String(index % PERF_VENDOR_CATEGORY_COUNT).padStart(2, '0')}`;
};

export const formatVendorRow = (index: number, random: () => number): string => {
  const price = (1 + (index % 10_000) / 100).toFixed(2);
  const stock = 1 + Math.floor(random() * 500);
  return `${formatVendorSku(index)},Vendor Product ${String(index).padStart(7, '0')},${formatVendorCategory(index)},${price},${stock}\n`;
};

export const parseGenerateVendorOptions = (argv: string[]): GenerateVendorOptions => {
  const flags = parseFlags(argv);
  assertAllowedFlags(flags, ['rows', 'output', 'force', 'seed']);

  return {
    rows: readPositiveInteger(flags, 'rows', DEFAULT_VENDOR_ROWS, MAX_VENDOR_ROWS),
    output: resolveInsideCwd(readOptionalOutput(flags)),
    force: readBooleanFlag(flags, 'force'),
    seed: readPositiveInteger(flags, 'seed', 1, 2_147_483_647),
  };
};

const readOptionalOutput = (flags: FlagMap): string => {
  const value = flags.get('output');
  if (value === undefined) {
    return DEFAULT_VENDOR_OUTPUT;
  }
  if (value === true) {
    throw new PerfArgumentError('--output requires a value');
  }
  return value;
};

export const generateVendorCsv = async (
  options: GenerateVendorOptions,
): Promise<GenerateVendorResult> => {
  const rss = createRssTracker();
  const started = Date.now();

  try {
    await access(options.output);
    if (!options.force) {
      throw new PerfArgumentError(
        `Refusing to overwrite ${options.output}. Pass --force to replace it.`,
      );
    }
  } catch (error) {
    if (error instanceof PerfArgumentError) {
      throw error;
    }
  }

  await mkdir(dirname(options.output), { recursive: true });

  const random = mulberry32(options.seed);
  let nextIndex = 1;
  const source = new Readable({
    read() {
      if (nextIndex === 1) {
        this.push('sku,name,category,basePrice,stockQuantity\n');
      }

      if (nextIndex > options.rows) {
        this.push(null);
        return;
      }

      const chunkSize = Math.min(1_000, options.rows - nextIndex + 1);
      let chunk = '';
      for (let offset = 0; offset < chunkSize; offset += 1) {
        chunk += formatVendorRow(nextIndex, random);
        nextIndex += 1;
      }
      rss.sample();
      this.push(chunk);
    },
  });

  await pipeline(source, createWriteStream(options.output));
  const file = await stat(options.output);

  return {
    outputPath: options.output,
    rows: options.rows,
    fileSizeBytes: file.size,
    durationMs: Date.now() - started,
    peakRssBytes: rss.peakBytes(),
  };
};

export const formatGenerateVendorReport = (result: GenerateVendorResult): string => {
  return [
    `output=${result.outputPath}`,
    `rows=${result.rows}`,
    `fileSize=${formatBytes(result.fileSizeBytes)}`,
    `durationMs=${result.durationMs}`,
    `peakRss=${formatBytes(result.peakRssBytes)}`,
  ].join('\n');
};
