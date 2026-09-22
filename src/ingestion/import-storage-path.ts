import { isAbsolute, relative, resolve } from 'node:path';

export class StoragePathEscapeError extends Error {
  constructor() {
    super('Stored import path is outside the configured directory');
  }
}

export const resolveContainedPath = (root: string, candidate: string): string => {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedRoot, candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);

  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new StoragePathEscapeError();
  }

  return resolvedCandidate;
};
