export interface GracefulShutdownHooks {
  stopAcceptingConnections: () => Promise<void>;
  closeIdleConnections?: () => void;
  closeRedis: () => Promise<void>;
  disconnectPrisma: () => Promise<void>;
  timeoutMs: number;
  exit: (code: number) => void;
  log: (message: string) => void;
  logError: (event: string) => void;
}

const runStep = async (
  step: () => Promise<void> | void,
  event: string,
  logError: (event: string) => void,
): Promise<boolean> => {
  try {
    await step();
    return true;
  } catch {
    logError(event);
    return false;
  }
};

export const createGracefulShutdown = (
  hooks: GracefulShutdownHooks,
): ((signal: string) => Promise<void>) => {
  let started = false;

  return async (signal) => {
    if (started) {
      return;
    }

    started = true;
    hooks.log(`Received ${signal}, shutting down`);

    const forceTimer = setTimeout(() => {
      hooks.logError('shutdown_timeout');
      hooks.exit(1);
    }, hooks.timeoutMs);

    let succeeded = true;

    if (hooks.closeIdleConnections !== undefined) {
      succeeded =
        (await runStep(hooks.closeIdleConnections, 'http_idle_close_failed', hooks.logError)) &&
        succeeded;
    }

    succeeded =
      (await runStep(
        hooks.stopAcceptingConnections,
        'http_server_close_failed',
        hooks.logError,
      )) && succeeded;
    succeeded =
      (await runStep(hooks.closeRedis, 'redis_close_failed', hooks.logError)) && succeeded;
    succeeded =
      (await runStep(hooks.disconnectPrisma, 'prisma_disconnect_failed', hooks.logError)) &&
      succeeded;

    clearTimeout(forceTimer);
    hooks.exit(succeeded ? 0 : 1);
  };
};
