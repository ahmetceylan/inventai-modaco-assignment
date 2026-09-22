import { type ImportJobRecord } from './import.service.js';

export interface ImportJobStatusResponse {
  id: string;
  status: string;
  originalFileName: string;
  totalRows: number | null;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  pricingRuleVersion: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface AcceptedImportJobResponse {
  id: string;
  status: string;
  originalFileName: string;
  totalRows: number | null;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  pricingRuleVersion: string;
  createdAt: string;
  statusUrl: string;
}

export const mapImportJobStatus = (job: ImportJobRecord): ImportJobStatusResponse => {
  return {
    id: job.id,
    status: job.status,
    originalFileName: job.originalFileName,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    succeededRows: job.succeededRows,
    failedRows: job.failedRows,
    pricingRuleVersion: job.pricingRuleVersion,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  };
};

export const mapAcceptedImportJob = (job: ImportJobRecord): AcceptedImportJobResponse => {
  return {
    id: job.id,
    status: job.status,
    originalFileName: job.originalFileName,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    succeededRows: job.succeededRows,
    failedRows: job.failedRows,
    pricingRuleVersion: job.pricingRuleVersion,
    createdAt: job.createdAt.toISOString(),
    statusUrl: `/imports/${job.id}`,
  };
};
