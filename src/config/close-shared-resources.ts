import { closeRedisClient } from '../cache/redis-client.js';
import { prisma } from './prisma.js';

const logCloseFailure = (event: string): void => {
  console.error(JSON.stringify({ event }));
};

export const closeSharedResources = async (): Promise<void> => {
  try {
    await closeRedisClient();
  } catch {
    logCloseFailure('redis_close_failed');
  }

  try {
    await prisma.$disconnect();
  } catch {
    logCloseFailure('prisma_disconnect_failed');
  }
};
