const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;

type NodeEnv = (typeof NODE_ENV_VALUES)[number];

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENV_VALUES as readonly string[]).includes(value);
}

function readNodeEnv(): NodeEnv {
  const value = process.env.NODE_ENV ?? 'development';

  if (!isNodeEnv(value)) {
    throw new Error(`Invalid NODE_ENV "${value}". Expected one of: ${NODE_ENV_VALUES.join(', ')}.`);
  }

  return value;
}

function readPort(): number {
  const raw = process.env.PORT ?? '3000';
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}". Expected an integer between 1 and 65535.`);
  }

  return port;
}

export const env = {
  NODE_ENV: readNodeEnv(),
  PORT: readPort(),
} as const;
