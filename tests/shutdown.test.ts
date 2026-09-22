import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown, type GracefulShutdownHooks } from '../src/shutdown.js';

const createHooks = (
  overrides: Partial<GracefulShutdownHooks> = {},
): GracefulShutdownHooks & {
  stopAcceptingConnections: ReturnType<typeof vi.fn>;
  closeIdleConnections: ReturnType<typeof vi.fn>;
  closeRedis: ReturnType<typeof vi.fn>;
  disconnectPrisma: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} => {
  return {
    stopAcceptingConnections: vi.fn(() => Promise.resolve()),
    closeIdleConnections: vi.fn(),
    closeRedis: vi.fn(() => Promise.resolve()),
    disconnectPrisma: vi.fn(() => Promise.resolve()),
    timeoutMs: 10_000,
    exit: vi.fn(),
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Graceful shutdown', () => {
  it('runs cleanup for SIGTERM and SIGINT', async () => {
    const termHooks = createHooks();
    await createGracefulShutdown(termHooks)('SIGTERM');

    expect(termHooks.log).toHaveBeenCalledWith('Received SIGTERM, shutting down');
    expect(termHooks.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(termHooks.stopAcceptingConnections).toHaveBeenCalledTimes(1);
    expect(termHooks.closeRedis).toHaveBeenCalledTimes(1);
    expect(termHooks.disconnectPrisma).toHaveBeenCalledTimes(1);
    expect(termHooks.exit).toHaveBeenCalledWith(0);

    const intHooks = createHooks();
    await createGracefulShutdown(intHooks)('SIGINT');

    expect(intHooks.log).toHaveBeenCalledWith('Received SIGINT, shutting down');
    expect(intHooks.exit).toHaveBeenCalledWith(0);
  });

  it('does not run cleanup twice when signals repeat', async () => {
    const hooks = createHooks();
    const shutdown = createGracefulShutdown(hooks);

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(hooks.stopAcceptingConnections).toHaveBeenCalledTimes(1);
    expect(hooks.closeRedis).toHaveBeenCalledTimes(1);
    expect(hooks.disconnectPrisma).toHaveBeenCalledTimes(1);
    expect(hooks.exit).toHaveBeenCalledTimes(1);
  });

  it('stops accepting connections before closing Redis or Prisma', async () => {
    let release!: () => void;
    const hooks = createHooks({
      stopAcceptingConnections: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const shutdownPromise = createGracefulShutdown(hooks)('SIGTERM');

    await vi.waitFor(() => {
      expect(hooks.stopAcceptingConnections).toHaveBeenCalledTimes(1);
    });
    expect(hooks.closeRedis).not.toHaveBeenCalled();
    expect(hooks.disconnectPrisma).not.toHaveBeenCalled();

    release();
    await shutdownPromise;

    expect(hooks.closeRedis).toHaveBeenCalledTimes(1);
    expect(hooks.disconnectPrisma).toHaveBeenCalledTimes(1);
  });

  it('still disconnects Prisma when Redis close fails', async () => {
    const hooks = createHooks({
      closeRedis: vi.fn(() => Promise.reject(new Error('Redis unavailable'))),
    });

    await createGracefulShutdown(hooks)('SIGTERM');

    expect(hooks.disconnectPrisma).toHaveBeenCalledTimes(1);
    expect(hooks.logError).toHaveBeenCalledWith('redis_close_failed');
    expect(hooks.exit).toHaveBeenCalledWith(1);
  });

  it('still closes Redis when Prisma disconnect fails', async () => {
    const hooks = createHooks({
      disconnectPrisma: vi.fn(() => Promise.reject(new Error('Prisma unavailable'))),
    });

    await createGracefulShutdown(hooks)('SIGTERM');

    expect(hooks.closeRedis).toHaveBeenCalledTimes(1);
    expect(hooks.logError).toHaveBeenCalledWith('prisma_disconnect_failed');
    expect(hooks.exit).toHaveBeenCalledWith(1);
  });

  it('forces shutdown when cleanup exceeds the timeout', async () => {
    vi.useFakeTimers();
    const hooks = createHooks({
      disconnectPrisma: vi.fn(() => new Promise(() => undefined)),
    });

    void createGracefulShutdown(hooks)('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(hooks.logError).toHaveBeenCalledWith('shutdown_timeout');
    expect(hooks.exit).toHaveBeenCalledWith(1);
  });

  it('cancels the force timer after successful cleanup', async () => {
    vi.useFakeTimers();
    const hooks = createHooks();

    await createGracefulShutdown(hooks)('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(hooks.exit).toHaveBeenCalledTimes(1);
    expect(hooks.exit).toHaveBeenCalledWith(0);
    expect(hooks.logError).not.toHaveBeenCalledWith('shutdown_timeout');
  });

  it('does not register process signals when constructing the Express app', async () => {
    const processOn = vi.spyOn(process, 'on');
    const { createApp } = await import('../src/app.js');

    createApp();

    expect(processOn).not.toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOn).not.toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });
});
