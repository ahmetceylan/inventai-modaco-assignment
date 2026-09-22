import { resolve } from 'node:path';

const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;

type NodeEnv = (typeof NODE_ENV_VALUES)[number];

const hasControlCharacter = (value: string): boolean => {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
};

const isNodeEnv = (value: string): value is NodeEnv => {
  return (NODE_ENV_VALUES as readonly string[]).includes(value);
};

const readNodeEnv = (): NodeEnv => {
  const value = process.env.NODE_ENV ?? 'development';

  if (!isNodeEnv(value)) {
    throw new Error(`Invalid NODE_ENV "${value}". Expected one of: ${NODE_ENV_VALUES.join(', ')}.`);
  }

  return value;
};

const readPort = (): number => {
  const raw = process.env.PORT ?? '3000';
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}". Expected an integer between 1 and 65535.`);
  }

  return port;
};

const readPositiveInteger = (name: string, defaultValue: string): number => {
  const raw = process.env[name] ?? defaultValue;
  const value = Number(raw);

  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${name} "${raw}". Expected a positive integer.`);
  }

  return value;
};

const readBoundedPositiveInteger = (
  name: string,
  defaultValue: string,
  maximum: number,
): number => {
  const value = readPositiveInteger(name, defaultValue);

  if (value > maximum) {
    throw new Error(`Invalid ${name} "${value}". Expected a value no greater than ${maximum}.`);
  }

  return value;
};

const readRequiredString = (name: string, defaultValue: string): string => {
  const value = (process.env[name] ?? defaultValue).trim();

  if (value === '' || hasControlCharacter(value)) {
    throw new Error(`Invalid ${name}. Expected a non-empty value without control characters.`);
  }

  return value;
};

export const env = {
  NODE_ENV: readNodeEnv(),
  PORT: readPort(),
  IMPORT_STORAGE_PATH: resolve(readRequiredString('IMPORT_STORAGE_PATH', './data/imports')),
  MAX_IMPORT_FILE_SIZE_BYTES: readPositiveInteger('MAX_IMPORT_FILE_SIZE_BYTES', '536870912'),
  IMPORT_CHUNK_SIZE: readBoundedPositiveInteger('IMPORT_CHUNK_SIZE', '500', 10_000),
  PRICING_RULE_VERSION: readRequiredString('PRICING_RULE_VERSION', 'v1'),
} as const;
