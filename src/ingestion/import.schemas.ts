import { basename } from 'node:path';
import { HttpError, validationError } from '../http/errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
]);

const removeControlCharacters = (value: string): string => {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    })
    .join('');
};

export const sanitizeOriginalFileName = (originalName: string): string => {
  const normalizedSeparators = originalName.replaceAll('\\', '/');
  return removeControlCharacters(basename(normalizedSeparators)).trim();
};

export const assertSupportedImportFile = (originalName: string, mimeType: string): void => {
  const sanitizedName = sanitizeOriginalFileName(originalName);
  const normalizedMimeType = mimeType.toLowerCase().split(';', 1)[0] ?? '';

  if (
    sanitizedName === '' ||
    !sanitizedName.toLowerCase().endsWith('.csv') ||
    !CSV_MIME_TYPES.has(normalizedMimeType)
  ) {
    throw new HttpError(400, 'UNSUPPORTED_IMPORT_FILE', 'Import file must be a supported CSV file');
  }
};

export const parseImportJobId = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw validationError([{ field: 'id', message: 'Must be a valid UUID' }]);
  }

  return value;
};
