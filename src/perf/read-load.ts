import { productCacheInvalidator } from '../cache/product-cache-invalidation.js';
import { prisma } from '../config/prisma.js';
import {
  assertAllowedFlags,
  parseFlags,
  PerfArgumentError,
  readOptionalString,
  readPositiveInteger,
} from './args.js';
import {
  MAX_READ_CONCURRENCY,
  MAX_READ_DURATION_SECONDS,
  PERF_CATEGORY_NAME,
  PERF_PRODUCT_SKU_PREFIX,
} from './constants.js';
import { average, percentile } from './percentiles.js';

export type ReadScenario = 'cold' | 'warm' | 'fallback';
export type ReadTarget = 'detail' | 'listing';

export interface ReadLoadOptions {
  url: string;
  durationSeconds: number;
  concurrency: number;
  scenarios: ReadScenario[];
  targets: ReadTarget[];
}

export interface ReadLoadSample {
  target: ReadTarget;
  scenario: ReadScenario;
  totalRequests: number;
  successfulResponses: number;
  errorResponses: number;
  requestsPerSecond: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

const parseList = (value: string | undefined, allowed: readonly string[], fallback: string[]): string[] => {
  const raw = value ?? fallback.join(',');
  const items = raw.split(',').map((item) => item.trim());
  for (const item of items) {
    if (!allowed.includes(item)) {
      throw new PerfArgumentError(`Unsupported value "${item}"`);
    }
  }
  return items;
};

export const parseReadLoadOptions = (argv: string[]): ReadLoadOptions => {
  const flags = parseFlags(argv);
  assertAllowedFlags(flags, ['url', 'duration', 'concurrency', 'scenarios', 'targets']);

  const scenarios = parseList(readOptionalString(flags, 'scenarios'), ['cold', 'warm', 'fallback'], [
    'cold',
    'warm',
  ]) as ReadScenario[];
  const targets = parseList(readOptionalString(flags, 'targets'), ['detail', 'listing'], [
    'detail',
    'listing',
  ]) as ReadTarget[];

  return {
    url: (readOptionalString(flags, 'url') ?? 'http://localhost:3000').replace(/\/$/, ''),
    durationSeconds: readPositiveInteger(flags, 'duration', 10, MAX_READ_DURATION_SECONDS),
    concurrency: readPositiveInteger(flags, 'concurrency', 10, MAX_READ_CONCURRENCY),
    scenarios,
    targets,
  };
};

const loadSeedContext = async (): Promise<{ categoryId: string; productIds: string[] }> => {
  const category = await prisma.category.findUnique({
    where: { name: PERF_CATEGORY_NAME },
    select: { id: true },
  });

  if (category === null) {
    throw new PerfArgumentError('PERF_ACCESSORIES was not found. Run perf:seed-flash-sale first.');
  }

  const products = await prisma.product.findMany({
    where: { sku: { startsWith: PERF_PRODUCT_SKU_PREFIX } },
    select: { id: true },
    orderBy: { sku: 'asc' },
    take: 200,
  });

  if (products.length === 0) {
    throw new PerfArgumentError('No PERFR- Products were found. Run perf:seed-flash-sale first.');
  }

  return {
    categoryId: category.id,
    productIds: products.map(({ id }) => id),
  };
};

const requestPath = (
  target: ReadTarget,
  categoryId: string,
  productIds: string[],
  index: number,
): string => {
  if (target === 'listing') {
    return `/products?categoryId=${categoryId}&sort=effectivePrice&order=asc&page=1&pageSize=20`;
  }

  const productId = productIds[index % productIds.length];
  return `/products/${productId}`;
};

const measure = async (
  options: ReadLoadOptions,
  target: ReadTarget,
  scenario: ReadScenario,
  categoryId: string,
  productIds: string[],
): Promise<ReadLoadSample> => {
  if (scenario === 'cold') {
    await productCacheInvalidator.invalidateListings([categoryId]);
    await productCacheInvalidator.invalidateProducts(productIds);
  }

  if (scenario === 'warm') {
    const warmup = requestPath(target, categoryId, productIds, 0);
    const warmupResponse = await fetch(`${options.url}${warmup}`);
    if (!warmupResponse.ok) {
      throw new PerfArgumentError(`Warm-up request failed with ${warmupResponse.status}`);
    }
  }

  const deadline = Date.now() + options.durationSeconds * 1_000;
  const latencies: number[] = [];
  let successfulResponses = 0;
  let errorResponses = 0;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const path = requestPath(target, categoryId, productIds, nextIndex);
      nextIndex += 1;
      const started = Date.now();
      try {
        const response = await fetch(`${options.url}${path}`);
        latencies.push(Date.now() - started);
        if (response.ok) {
          successfulResponses += 1;
        } else {
          errorResponses += 1;
        }
      } catch {
        latencies.push(Date.now() - started);
        errorResponses += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  const totalRequests = successfulResponses + errorResponses;
  const elapsedSeconds = options.durationSeconds;

  return {
    target,
    scenario,
    totalRequests,
    successfulResponses,
    errorResponses,
    requestsPerSecond: elapsedSeconds === 0 ? 0 : totalRequests / elapsedSeconds,
    averageMs: average(latencies),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
  };
};

export const runReadLoad = async (options: ReadLoadOptions): Promise<ReadLoadSample[]> => {
  const context = await loadSeedContext();
  const samples: ReadLoadSample[] = [];

  for (const target of options.targets) {
    for (const scenario of options.scenarios) {
      samples.push(await measure(options, target, scenario, context.categoryId, context.productIds));
    }
  }

  return samples;
};

export const formatReadLoadReport = (samples: ReadLoadSample[]): string => {
  return [
    'label=comparative local benchmark',
    'doNotExtrapolate=true',
    ...samples.map((sample) =>
      [
        `target=${sample.target}`,
        `scenario=${sample.scenario}`,
        `totalRequests=${sample.totalRequests}`,
        `successfulResponses=${sample.successfulResponses}`,
        `errorResponses=${sample.errorResponses}`,
        `requestsPerSecond=${sample.requestsPerSecond.toFixed(1)}`,
        `averageMs=${sample.averageMs.toFixed(1)}`,
        `p50Ms=${sample.p50Ms.toFixed(1)}`,
        `p95Ms=${sample.p95Ms.toFixed(1)}`,
        `p99Ms=${sample.p99Ms.toFixed(1)}`,
      ].join(' '),
    ),
  ].join('\n');
};
