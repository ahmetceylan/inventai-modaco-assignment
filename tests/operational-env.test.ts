import { afterEach, describe, expect, it, vi } from 'vitest';

const SETTING_NAMES = ['HTTP_BODY_LIMIT', 'SHUTDOWN_TIMEOUT_SECONDS'] as const;
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

describe('Operational environment configuration', () => {
  it.each(['0', '-1', '1.5', 'text'])(
    'rejects invalid SHUTDOWN_TIMEOUT_SECONDS %s',
    async (value) => {
      process.env.SHUTDOWN_TIMEOUT_SECONDS = value;
      vi.resetModules();

      await expect(import('../src/config/env.js')).rejects.toThrow(
        'Invalid SHUTDOWN_TIMEOUT_SECONDS',
      );
    },
  );

  it.each(['0mb', '1gb', '1', '1.5mb', ''])('rejects invalid HTTP_BODY_LIMIT %s', async (value) => {
    process.env.HTTP_BODY_LIMIT = value;
    vi.resetModules();

    await expect(import('../src/config/env.js')).rejects.toThrow('Invalid HTTP_BODY_LIMIT');
  });

  it('accepts validated shutdown and body-limit settings', async () => {
    process.env.SHUTDOWN_TIMEOUT_SECONDS = '15';
    process.env.HTTP_BODY_LIMIT = '100KB';
    vi.resetModules();

    const { env } = await import('../src/config/env.js');

    expect(env.SHUTDOWN_TIMEOUT_SECONDS).toBe(15);
    expect(env.HTTP_BODY_LIMIT).toBe('100kb');
  });
});
