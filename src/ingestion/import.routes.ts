import { Router } from 'express';
import { createImportController, getImportController } from './import.controller.js';
import { uploadImportFile } from './upload.middleware.js';

export const importRouter = Router();

importRouter.post('/imports', uploadImportFile, createImportController);
importRouter.get('/imports/:id', getImportController);
