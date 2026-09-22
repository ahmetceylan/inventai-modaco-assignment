import { afterEach, describe, expect, it, vi } from 'vitest';

const SETTING_NAMES = [
  'IMPORT_MAX_ATTEMPTS',
  'IMPORT_RETRY_BASE_DELAY_SECONDS',
  'IMPORT_RETRY_MAX_DELAY_SECONDS',
  'IMPORT_LOCK_TIMEOUT_SECONDS',
] as const;
const originalValues = Object.fromEntries(
  SETTING_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof SETTING_NAMES)[number], string | undefined>;

afterEach(() => {
  for (const name of SETTING_NAMES) {
    const value = originalValues[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  vi.resetModules();
});

describe('Import retry environment configuration', () => {
  it.each(SETTING_NAMES)('requires %s to be a positive integer', async (name) => {
    process.env[name] = '0';
    vi.resetModules();

    await expect(import('../src/config/env.js')).rejects.toThrow(`Invalid ${name}`);
  });

  it('requires the maximum retry delay to cover the base delay', async () => {
    process.env.IMPORT_RETRY_BASE_DELAY_SECONDS = '10';
    process.env.IMPORT_RETRY_MAX_DELAY_SECONDS = '9';
    vi.resetModules();

    await expect(import('../src/config/env.js')).rejects.toThrow(
      'Invalid IMPORT_RETRY_MAX_DELAY_SECONDS',
    );
  });

  it('accepts valid retry settings', async () => {
    process.env.IMPORT_MAX_ATTEMPTS = '4';
    process.env.IMPORT_RETRY_BASE_DELAY_SECONDS = '2';
    process.env.IMPORT_RETRY_MAX_DELAY_SECONDS = '30';
    process.env.IMPORT_LOCK_TIMEOUT_SECONDS = '45';
    vi.resetModules();

    const { env } = await import('../src/config/env.js');

    expect(env).toMatchObject({
      IMPORT_MAX_ATTEMPTS: 4,
      IMPORT_RETRY_BASE_DELAY_SECONDS: 2,
      IMPORT_RETRY_MAX_DELAY_SECONDS: 30,
      IMPORT_LOCK_TIMEOUT_SECONDS: 45,
    });
  });
});
