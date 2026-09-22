import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveContainedPath,
  StoragePathEscapeError,
} from '../src/ingestion/import-storage-path.js';

const root = join(tmpdir(), 'modaco-storage-root');

describe('Import storage path containment', () => {
  it('resolves a relative path inside the configured root', () => {
    expect(resolveContainedPath(root, 'abc.csv')).toBe(join(root, 'abc.csv'));
  });

  it('rejects traversal, absolute, and root-equivalent paths', () => {
    expect(() => resolveContainedPath(root, '../outside.csv')).toThrow(StoragePathEscapeError);
    expect(() => resolveContainedPath(root, '/tmp/outside.csv')).toThrow(StoragePathEscapeError);
    expect(() => resolveContainedPath(root, join(root, '..', 'outside.csv'))).toThrow(
      StoragePathEscapeError,
    );
    expect(() => resolveContainedPath(root, '.')).toThrow(StoragePathEscapeError);
  });

  it('rejects an absolute candidate that resolves outside the root', () => {
    expect(() => resolveContainedPath(root, join(tmpdir(), 'other', 'file.csv'))).toThrow(
      StoragePathEscapeError,
    );
  });
});
