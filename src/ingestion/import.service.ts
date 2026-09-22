import { unlink } from 'node:fs/promises';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { type Prisma } from '../generated/prisma/client.js';
import { resolveContainedPath } from './import-storage-path.js';
import { sanitizeOriginalFileName } from './import.schemas.js';

const importJobSelect = {
  id: true,
  status: true,
  originalFileName: true,
  totalRows: true,
  processedRows: true,
  succeededRows: true,
  failedRows: true,
  pricingRuleVersion: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
} satisfies Prisma.ImportJobSelect;

export type ImportJobRecord = Prisma.ImportJobGetPayload<{ select: typeof importJobSelect }>;

export interface StoredImportFile {
  originalName: string;
  storedName: string;
  absolutePath: string;
}

export const removeStoredImportFile = async (filePath: string): Promise<void> => {
  const safePath = resolveContainedPath(env.IMPORT_STORAGE_PATH, filePath);

  try {
    await unlink(safePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
};

export const createImportJob = async (file: StoredImportFile): Promise<ImportJobRecord> => {
  try {
    return await prisma.importJob.create({
      data: {
        originalFileName: sanitizeOriginalFileName(file.originalName),
        storagePath: file.storedName,
        fileChecksum: null,
        pricingRuleVersion: env.PRICING_RULE_VERSION,
      },
      select: importJobSelect,
    });
  } catch (error) {
    await removeStoredImportFile(file.absolutePath);
    throw error;
  }
};

export const getImportJob = (id: string): Promise<ImportJobRecord | null> => {
  return prisma.importJob.findUnique({
    where: { id },
    select: importJobSelect,
  });
};
