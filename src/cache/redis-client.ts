import { createClient, type RedisClientType } from 'redis';
import { env } from '../config/env.js';

const CONNECT_TIMEOUT_MS = 500;
const RECONNECT_COOLDOWN_MS = 5_000;

export type RedisOperationResult<T> = { ok: true; value: T } | { ok: false };

const client: RedisClientType = createClient({
  url: env.REDIS_URL,
  disableOfflineQueue: true,
  socket: {
    connectTimeout: CONNECT_TIMEOUT_MS,
    reconnectStrategy: false,
  },
});

let connectPromise: Promise<boolean> | null = null;
let nextConnectAttemptAt = 0;

const errorCode = (error: unknown): string | undefined => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
};

const logRedisError = (event: string, error: unknown): void => {
  console.error(
    JSON.stringify({
      event,
      ...(errorCode(error) === undefined ? {} : { errorCode: errorCode(error) }),
    }),
  );
};

client.on('error', (error: unknown) => {
  logRedisError('redis_client_error', error);
});

const ensureConnected = async (): Promise<boolean> => {
  if (client.isReady) {
    return true;
  }

  if (connectPromise !== null) {
    return connectPromise;
  }

  if (Date.now() < nextConnectAttemptAt) {
    return false;
  }

  connectPromise = client
    .connect()
    .then(() => true)
    .catch((error: unknown) => {
      nextConnectAttemptAt = Date.now() + RECONNECT_COOLDOWN_MS;
      logRedisError('redis_connect_failed', error);
      if (client.isOpen) {
        client.destroy();
      }
      return false;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
};

export const runRedisOperation = async <T>(
  operation: (connectedClient: RedisClientType) => Promise<T>,
): Promise<RedisOperationResult<T>> => {
  if (!(await ensureConnected())) {
    return { ok: false };
  }

  try {
    return { ok: true, value: await operation(client) };
  } catch (error) {
    logRedisError('redis_operation_failed', error);
    return { ok: false };
  }
};

export const closeRedisClient = async (): Promise<void> => {
  if (!client.isOpen) {
    return;
  }

  try {
    await client.close();
  } catch (error) {
    logRedisError('redis_close_failed', error);
    client.destroy();
  }
};
