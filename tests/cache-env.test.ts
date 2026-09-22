import { afterEach, describe, expect, it, vi } from 'vitest';

const originalRedisUrl = process.env.REDIS_URL;
const originalCacheTtl = process.env.PRODUCT_DETAIL_CACHE_TTL_SECONDS;
const originalListCacheTtl = process.env.PRODUCT_LIST_CACHE_TTL_SECONDS;
const originalListCacheMaxPage = process.env.PRODUCT_LIST_CACHE_MAX_PAGE;

afterEach(() => {
  restoreEnvironment('REDIS_URL', originalRedisUrl);
  restoreEnvironment('PRODUCT_DETAIL_CACHE_TTL_SECONDS', originalCacheTtl);
  restoreEnvironment('PRODUCT_LIST_CACHE_TTL_SECONDS', originalListCacheTtl);
  restoreEnvironment('PRODUCT_LIST_CACHE_MAX_PAGE', originalListCacheMaxPage);
  vi.resetModules();
});

describe('Product cache environment configuration', () => {
  it('requires a Redis URL', async () => {
    process.env.REDIS_URL = 'https://localhost:6379';
    vi.resetModules();

    await expect(import('../src/config/env.js')).rejects.toThrow('Invalid REDIS_URL');
  });

  it.each(['0', '-1', '1.5', 'text'])('rejects invalid cache TTL %s', async (value) => {
    process.env.PRODUCT_DETAIL_CACHE_TTL_SECONDS = value;
    vi.resetModules();

    await expect(import('../src/config/env.js')).rejects.toThrow(
      'Invalid PRODUCT_DETAIL_CACHE_TTL_SECONDS',
    );
  });

  it.each([
    ['PRODUCT_LIST_CACHE_TTL_SECONDS', '0'],
    ['PRODUCT_LIST_CACHE_TTL_SECONDS', '1.5'],
    ['PRODUCT_LIST_CACHE_MAX_PAGE', '-1'],
    ['PRODUCT_LIST_CACHE_MAX_PAGE', 'text'],
  ])('rejects invalid %s value %s', async (name, value) => {
    process.env[name] = value;
    vi.resetModules();

    await expect(import('../src/config/env.js')).rejects.toThrow(`Invalid ${name}`);
  });

  it('accepts Redis and cache TTL settings', async () => {
    process.env.REDIS_URL = 'rediss://cache.example.test:6380';
    process.env.PRODUCT_DETAIL_CACHE_TTL_SECONDS = '45';
    process.env.PRODUCT_LIST_CACHE_TTL_SECONDS = '15';
    process.env.PRODUCT_LIST_CACHE_MAX_PAGE = '5';
    vi.resetModules();

    const { env } = await import('../src/config/env.js');

    expect(env.REDIS_URL).toBe('rediss://cache.example.test:6380');
    expect(env.PRODUCT_DETAIL_CACHE_TTL_SECONDS).toBe(45);
    expect(env.PRODUCT_LIST_CACHE_TTL_SECONDS).toBe(15);
    expect(env.PRODUCT_LIST_CACHE_MAX_PAGE).toBe(5);
  });
});

const restoreEnvironment = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};
