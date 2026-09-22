export class PerfArgumentError extends Error {}

export type FlagMap = Map<string, string | true>;

export const parseFlags = (argv: string[]): FlagMap => {
  const flags: FlagMap = new Map();

  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      throw new PerfArgumentError(`Unexpected argument "${argument}"`);
    }

    const body = argument.slice(2);
    const separator = body.indexOf('=');
    if (separator === -1) {
      if (body === '') {
        throw new PerfArgumentError('Expected a flag name');
      }
      flags.set(body, true);
      continue;
    }

    const name = body.slice(0, separator);
    const value = body.slice(separator + 1);
    if (name === '' || value === '') {
      throw new PerfArgumentError(`Invalid flag "${argument}"`);
    }
    flags.set(name, value);
  }

  return flags;
};

export const readOptionalString = (flags: FlagMap, name: string): string | undefined => {
  const value = flags.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    throw new PerfArgumentError(`--${name} requires a value`);
  }
  return value;
};

export const readRequiredString = (flags: FlagMap, name: string): string => {
  const value = readOptionalString(flags, name);
  if (value === undefined) {
    throw new PerfArgumentError(`--${name} is required`);
  }
  return value;
};

export const readBooleanFlag = (flags: FlagMap, name: string): boolean => {
  const value = flags.get(name);
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    throw new PerfArgumentError(`--${name} does not take a value`);
  }
  return true;
};

export const readPositiveInteger = (
  flags: FlagMap,
  name: string,
  defaultValue: number,
  maximum: number,
): number => {
  const raw = readOptionalString(flags, name);
  if (raw === undefined) {
    return defaultValue;
  }

  if (!/^[1-9]\d*$/.test(raw)) {
    throw new PerfArgumentError(`--${name} must be a positive integer`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new PerfArgumentError(`--${name} must be between 1 and ${maximum}`);
  }

  return value;
};

export const assertAllowedFlags = (flags: FlagMap, allowed: readonly string[]): void => {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) {
      throw new PerfArgumentError(`Unknown flag --${name}`);
    }
  }
};
