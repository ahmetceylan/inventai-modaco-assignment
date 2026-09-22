import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFlags, PerfArgumentError, readPositiveInteger } from '../src/perf/args.js';
import {
  DEFAULT_VENDOR_ROWS,
  PERF_CATEGORY_NAME,
  PERF_PRODUCT_SKU_PREFIX,
  PERF_PROMOTION_NAME,
} from '../src/perf/constants.js';
import {
  formatVendorRow,
  generateVendorCsv,
  parseGenerateVendorOptions,
} from '../src/perf/generate-vendor.js';
import { parseIngestionBenchmarkOptions } from '../src/perf/ingestion.js';
import { percentile } from '../src/perf/percentiles.js';
import { resolveInsideCwd } from '../src/perf/paths.js';
import { parseReadLoadOptions } from '../src/perf/read-load.js';
import {
  assertReservedCleanupTarget,
  ReservedCleanupError,
  reservedCleanupTarget,
} from '../src/perf/reserved-cleanup.js';
import { parseSeedFlashSaleOptions } from '../src/perf/seed-flash-sale.js';

const originalCwd = process.cwd();
let workspace: string | undefined;

afterEach(async () => {
  process.chdir(originalCwd);
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

const useTempWorkspace = async (): Promise<string> => {
  workspace = await mkdtemp(join(tmpdir(), 'modaco-perf-'));
  process.chdir(workspace);
  return workspace;
};

describe('Performance tool correctness', () => {
  it('parses default vendor generation options', () => {
    expect(parseGenerateVendorOptions([])).toMatchObject({
      rows: DEFAULT_VENDOR_ROWS,
      force: false,
      seed: 1,
    });
  });

  it('rejects unsafe performance arguments', () => {
    expect(() => parseGenerateVendorOptions(['--rows=0'])).toThrow(PerfArgumentError);
    expect(() => parseGenerateVendorOptions(['--output=../outside.csv'])).toThrow(PerfArgumentError);
    expect(() => parseSeedFlashSaleOptions(['--products=-1'])).toThrow(PerfArgumentError);
    expect(() => parseIngestionBenchmarkOptions(['--concurrency=0'])).toThrow(PerfArgumentError);
    expect(() => parseReadLoadOptions(['--duration=0'])).toThrow(PerfArgumentError);
    expect(() => parseFlags(['rows=5'])).toThrow(PerfArgumentError);
    expect(() => readPositiveInteger(parseFlags(['--concurrency=8']), 'concurrency', 1, 4)).toThrow(
      PerfArgumentError,
    );
    expect(() => resolveInsideCwd('/tmp/outside.csv')).toThrow(PerfArgumentError);
  });

  it('writes the requested deterministic row count', async () => {
    await useTempWorkspace();
    const first = await generateVendorCsv(
      parseGenerateVendorOptions(['--rows=25', '--output=./tmp/perf/a.csv', '--seed=7']),
    );
    const second = await generateVendorCsv(
      parseGenerateVendorOptions(['--rows=25', '--output=./tmp/perf/b.csv', '--seed=7']),
    );
    const firstText = await readFile(first.outputPath, 'utf8');
    const secondText = await readFile(second.outputPath, 'utf8');
    const lines = firstText.trimEnd().split('\n');

    expect(first.rows).toBe(25);
    expect(lines).toHaveLength(26);
    expect(lines[0]).toBe('sku,name,category,basePrice,stockQuantity');
    expect(lines[1]).toMatch(/^PERFV-0000001,Vendor Product 0000001,PERF_CAT_01,1\.01,\d+$/);
    expect(firstText).toBe(secondText);
    expect(first.outputPath.endsWith('/tmp/perf/a.csv')).toBe(true);
  });

  it('does not overwrite an existing file without --force', async () => {
    await useTempWorkspace();
    await generateVendorCsv(parseGenerateVendorOptions(['--rows=2', '--output=./keep.csv']));

    await expect(
      generateVendorCsv(parseGenerateVendorOptions(['--rows=2', '--output=./keep.csv'])),
    ).rejects.toBeInstanceOf(PerfArgumentError);

    const forced = await generateVendorCsv(
      parseGenerateVendorOptions(['--rows=3', '--output=./keep.csv', '--force']),
    );
    const text = await readFile(forced.outputPath, 'utf8');

    expect(forced.rows).toBe(3);
    expect(text.trimEnd().split('\n')).toHaveLength(4);
  });

  it('scopes cleanup to reserved performance identifiers', () => {
    const target = reservedCleanupTarget();

    expect(target).toEqual({
      categoryName: PERF_CATEGORY_NAME,
      skuPrefix: PERF_PRODUCT_SKU_PREFIX,
      promotionName: PERF_PROMOTION_NAME,
    });
    expect(() => assertReservedCleanupTarget(target)).not.toThrow();
    expect(() =>
      assertReservedCleanupTarget({
        ...target,
        categoryName: 'Accessories',
      }),
    ).toThrow(ReservedCleanupError);
    expect(() =>
      assertReservedCleanupTarget({
        ...target,
        skuPrefix: 'SKU-',
      }),
    ).toThrow(ReservedCleanupError);
  });

  it('calculates nearest-rank percentiles', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99)).toBe(10);
  });

  it('does not run performance commands from the normal test script', async () => {
    const packageJson = JSON.parse(await readFile(join(originalCwd, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe('vitest run');
    expect(packageJson.scripts.test).not.toContain('perf:');
    expect(formatVendorRow(1, () => 0.5)).toContain('PERFV-0000001');
  });
});
