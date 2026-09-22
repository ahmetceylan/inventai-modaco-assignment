-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportChunkStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" UUID NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "fileChecksum" TEXT,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "succeededRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "pricingRuleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportChunk" (
    "id" UUID NOT NULL,
    "importJobId" UUID NOT NULL,
    "chunkNumber" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "startRowNumber" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "status" "ImportChunkStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMPTZ(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ImportChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportFailure" (
    "id" UUID NOT NULL,
    "importJobId" UUID NOT NULL,
    "importChunkId" UUID,
    "rowNumber" INTEGER,
    "sku" TEXT,
    "rawData" JSONB,
    "errorCode" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_status_idx" ON "ImportJob"("status");

-- CreateIndex
CREATE INDEX "ImportChunk_status_availableAt_idx" ON "ImportChunk"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportChunk_importJobId_chunkNumber_key" ON "ImportChunk"("importJobId", "chunkNumber");

-- CreateIndex
CREATE INDEX "ImportFailure_importJobId_idx" ON "ImportFailure"("importJobId");

-- CreateIndex
CREATE INDEX "ImportFailure_importChunkId_idx" ON "ImportFailure"("importChunkId");

-- AddForeignKey
ALTER TABLE "ImportChunk" ADD CONSTRAINT "ImportChunk_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportFailure" ADD CONSTRAINT "ImportFailure_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportFailure" ADD CONSTRAINT "ImportFailure_importChunkId_fkey" FOREIGN KEY ("importChunkId") REFERENCES "ImportChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Import job progress invariants
ALTER TABLE "ImportJob"
ADD CONSTRAINT "import_job_total_rows_non_negative"
CHECK ("totalRows" IS NULL OR "totalRows" >= 0);

ALTER TABLE "ImportJob"
ADD CONSTRAINT "import_job_processed_rows_non_negative"
CHECK ("processedRows" >= 0);

ALTER TABLE "ImportJob"
ADD CONSTRAINT "import_job_succeeded_rows_non_negative"
CHECK ("succeededRows" >= 0);

ALTER TABLE "ImportJob"
ADD CONSTRAINT "import_job_failed_rows_non_negative"
CHECK ("failedRows" >= 0);

-- Import chunk retry and source-position invariants
ALTER TABLE "ImportChunk"
ADD CONSTRAINT "import_chunk_number_non_negative"
CHECK ("chunkNumber" >= 0);

ALTER TABLE "ImportChunk"
ADD CONSTRAINT "import_chunk_start_row_number_positive"
CHECK ("startRowNumber" >= 1);

ALTER TABLE "ImportChunk"
ADD CONSTRAINT "import_chunk_row_count_non_negative"
CHECK ("rowCount" >= 0);

ALTER TABLE "ImportChunk"
ADD CONSTRAINT "import_chunk_attempt_count_non_negative"
CHECK ("attemptCount" >= 0);

ALTER TABLE "ImportFailure"
ADD CONSTRAINT "import_failure_row_number_positive"
CHECK ("rowNumber" IS NULL OR "rowNumber" >= 1);
