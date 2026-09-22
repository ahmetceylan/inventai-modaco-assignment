import { isAbsolute, relative, resolve } from 'node:path';
import { PerfArgumentError } from './args.js';

export const resolveInsideCwd = (candidate: string): string => {
  const cwd = process.cwd();
  const resolved = resolve(cwd, candidate);
  const relativePath = relative(cwd, resolved);

  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new PerfArgumentError('Output path must stay inside the current working directory');
  }

  return resolved;
};
