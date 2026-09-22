import type { Server } from 'node:http';
import { createApp } from './app.js';
import { closeRedisClient } from './cache/redis-client.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { createGracefulShutdown } from './shutdown.js';

const logShutdownError = (event: string): void => {
  console.error(JSON.stringify({ event }));
};

const stopAcceptingConnections = (server: Server): Promise<void> => {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

export const startHttpServer = (): Server => {
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`Server listening on port ${env.PORT}`);
  });

  const shutdown = createGracefulShutdown({
    stopAcceptingConnections: () => stopAcceptingConnections(server),
    closeIdleConnections:
      typeof server.closeIdleConnections === 'function'
        ? () => {
            server.closeIdleConnections();
          }
        : undefined,
    closeRedis: closeRedisClient,
    disconnectPrisma: () => prisma.$disconnect(),
    timeoutMs: env.SHUTDOWN_TIMEOUT_SECONDS * 1000,
    exit: (code) => {
      process.exit(code);
    },
    log: (message) => {
      console.log(message);
    },
    logError: logShutdownError,
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  return server;
};
