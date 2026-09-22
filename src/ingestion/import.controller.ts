import { type Request, type Response } from 'express';
import { HttpError } from '../http/errors.js';
import { mapAcceptedImportJob, mapImportJobStatus } from './import.mapper.js';
import { parseImportJobId } from './import.schemas.js';
import { createImportJob, getImportJob, removeStoredImportFile } from './import.service.js';

export const createImportController = async (req: Request, res: Response): Promise<void> => {
  const file = req.file;

  if (file === undefined) {
    throw new HttpError(400, 'IMPORT_FILE_REQUIRED', 'Import file is required');
  }

  if (file.size === 0) {
    await removeStoredImportFile(file.path);
    throw new HttpError(400, 'EMPTY_IMPORT_FILE', 'Import file must not be empty');
  }

  const job = await createImportJob({
    originalName: file.originalname,
    storedName: file.filename,
    absolutePath: file.path,
  });

  res.status(202).json({ data: mapAcceptedImportJob(job) });
};

export const getImportController = async (req: Request, res: Response): Promise<void> => {
  const id = parseImportJobId(req.params.id);
  const job = await getImportJob(id);

  if (job === null) {
    throw new HttpError(404, 'IMPORT_JOB_NOT_FOUND', 'Import job not found');
  }

  res.status(200).json({ data: mapImportJobStatus(job) });
};
