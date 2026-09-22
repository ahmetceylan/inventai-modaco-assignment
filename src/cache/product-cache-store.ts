import { runRedisOperation, type RedisOperationResult } from './redis-client.js';

const SET_IF_VERSIONS_MATCH = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
  end
  if redis.call('GET', KEYS[2]) ~= ARGV[2] then
    return 0
  end
  redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
  return 1
`;

const SET_IF_VERSION_MATCHES = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
  end
  redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
  return 1
`;

export interface VersionedCacheWrite {
  productVersionKey: string;
  productVersion: number;
  categoryVersionKey: string;
  categoryVersion: number;
  cacheKey: string;
  payload: string;
  ttlSeconds: number;
}

export interface ProductCacheStore {
  get(key: string): Promise<string | null>;
  mGet(keys: string[]): Promise<Array<string | null>>;
  delete(key: string): Promise<void>;
  initializeVersion(key: string): Promise<void>;
  setIfVersionsMatch(write: VersionedCacheWrite): Promise<boolean>;
  setIfVersionMatches(write: {
    versionKey: string;
    version: number;
    cacheKey: string;
    payload: string;
    ttlSeconds: number;
  }): Promise<boolean>;
}

class RedisUnavailableError extends Error {}

const valueOrThrow = <T>(result: RedisOperationResult<T>): T => {
  if (!result.ok) {
    throw new RedisUnavailableError();
  }

  return result.value;
};

export const redisProductCacheStore: ProductCacheStore = {
  async get(key) {
    return valueOrThrow(await runRedisOperation((client) => client.get(key)));
  },

  async mGet(keys) {
    return valueOrThrow(await runRedisOperation((client) => client.mGet(keys)));
  },

  async delete(key) {
    valueOrThrow(await runRedisOperation((client) => client.del(key)));
  },

  async initializeVersion(key) {
    valueOrThrow(await runRedisOperation((client) => client.set(key, '1', { NX: true })));
  },

  async setIfVersionsMatch(write) {
    const result = valueOrThrow(
      await runRedisOperation((client) =>
        client.eval(SET_IF_VERSIONS_MATCH, {
          keys: [write.productVersionKey, write.categoryVersionKey, write.cacheKey],
          arguments: [
            String(write.productVersion),
            String(write.categoryVersion),
            write.payload,
            String(write.ttlSeconds),
          ],
        }),
      ),
    );

    return result === 1;
  },

  async setIfVersionMatches(write) {
    const result = valueOrThrow(
      await runRedisOperation((client) =>
        client.eval(SET_IF_VERSION_MATCHES, {
          keys: [write.versionKey, write.cacheKey],
          arguments: [String(write.version), write.payload, String(write.ttlSeconds)],
        }),
      ),
    );

    return result === 1;
  },
};
