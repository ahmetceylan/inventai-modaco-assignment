type ImportChunkEvent =
  | 'chunk_claimed'
  | 'chunk_retry_scheduled'
  | 'stale_chunk_recovered'
  | 'stale_chunk_exhausted'
  | 'chunk_completed'
  | 'chunk_failed'
  | 'chunk_ownership_lost'
  | 'job_completed'
  | 'job_failed';

interface ImportChunkLogFields {
  jobId?: string;
  chunkId?: string;
  chunkNumber?: number;
  attemptCount?: number;
  workerId?: string;
  nextAvailableAt?: string;
  errorCode?: string;
}

export const logImportChunkEvent = (
  event: ImportChunkEvent,
  fields: ImportChunkLogFields,
): void => {
  console.log(JSON.stringify({ event, ...fields }));
};
