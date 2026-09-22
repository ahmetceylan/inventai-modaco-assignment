import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { type NextFunction, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '../config/env.js';
import { HttpError, validationError } from '../http/errors.js';
import { assertSupportedImportFile } from './import.schemas.js';

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    void mkdir(env.IMPORT_STORAGE_PATH, { recursive: true })
      .then(() => {
        callback(null, env.IMPORT_STORAGE_PATH);
      })
      .catch((error: unknown) => {
        callback(
          error instanceof Error ? error : new Error('Failed to create import directory'),
          '',
        );
      });
  },
  filename: (_req, _file, callback) => {
    callback(null, `${randomUUID()}.csv`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: env.MAX_IMPORT_FILE_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    try {
      assertSupportedImportFile(file.originalname, file.mimetype);
      callback(null, true);
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Import file validation failed'));
    }
  },
}).single('file');

const mapUploadError = (error: unknown): unknown => {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new HttpError(413, 'IMPORT_FILE_TOO_LARGE', 'Import file exceeds the size limit');
    }

    return validationError([
      {
        field: 'file',
        message:
          error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT'
            ? 'Exactly one file field is allowed'
            : 'Invalid multipart upload',
      },
    ]);
  }

  if (
    error instanceof Error &&
    (error.message.startsWith('Multipart:') || error.message === 'Unexpected end of form')
  ) {
    return validationError([{ field: 'file', message: 'Invalid multipart upload' }]);
  }

  return error;
};

export const uploadImportFile = (req: Request, res: Response, next: NextFunction): void => {
  upload(req, res, (error: unknown) => {
    if (error === undefined) {
      next();
      return;
    }

    next(mapUploadError(error));
  });
};
