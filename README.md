# inventai-modaco-assignment

Minimal Node.js REST API scaffold using Express and TypeScript.

## Requirements

- Node.js 20.11 or later

## Setup

```bash
npm install
cp .env.example .env
```

Start the local Redis cache:

```bash
docker compose up -d redis
```

## Scripts

| Script                          | Purpose                            |
| ------------------------------- | ---------------------------------- |
| `npm run dev`                   | Start the API with hot reload      |
| `npm run build`                 | Compile TypeScript to `dist/`      |
| `npm start`                     | Run the compiled API               |
| `npm run lint`                  | Lint the project                   |
| `npm run format`                | Format files with Prettier         |
| `npm test`                      | Run the test suite                 |
| `npm run prisma:generate`       | Generate Prisma Client             |
| `npm run prisma:migrate`        | Create and apply a local migration |
| `npm run prisma:migrate:deploy` | Apply migrations without prompting |
| `npm run perf:generate-vendor`  | Generate a deterministic vendor CSV |
| `npm run perf:ingestion`        | Run the real local ingestion flow |
| `npm run perf:seed-flash-sale`  | Seed or clean reserved flash-sale data |
| `npm run perf:read`             | Comparative local Product read smoke test |

Database constraint tests need a migrated local PostgreSQL database:

```bash
cp .env.example .env
npm run prisma:generate
npm run prisma:migrate:deploy
npm test
```

## Database constraints

Prisma defines the core tables, relations, types, and indexes. PostgreSQL-specific `CHECK`
and exclusion constraints that Prisma cannot represent are maintained in committed migration SQL.
Promotion assignment pre-checks provide user-friendly conflicts but are race-prone; PostgreSQL
atomically rejects overlapping non-cancelled schedules at the same Product or Category. Half-open
`[startAt, endAt)` ranges permit adjacency, while Product and Category schedules may overlap because
Product precedence is resolved during reads. This uses the PostgreSQL-specific `btree_gist`
extension as a portability trade-off.

## Product detail cache

`GET /products/:id` uses Redis as a cache-aside optimization; PostgreSQL remains the source of
truth. Local configuration defaults to:

- `REDIS_URL=redis://localhost:6379`
- `PRODUCT_DETAIL_CACHE_TTL_SECONDS=30`

Each cached public Product DTO is stored under `cache:product-detail:<productId>` in a validated,
versioned JSON envelope. `cache:product-version:<productId>` tracks Product changes and
`cache:category-promotion-version:<categoryId>` tracks Category Promotion changes. Product
Promotion changes increment one Product version. Category Promotion changes increment one Category
version, logically invalidating every related Product without scanning or deleting Product keys.

Cache misses use the existing PostgreSQL effective-price resolver. Version values are checked before
and after the database load, and the final Redis write compares them atomically to prevent stale
cache writes. Concurrent misses for one Product share one database-loading Promise within one Node
process; cross-instance stampede prevention is intentionally deferred.

Redis reads, writes, and invalidations fail open. If Redis is unavailable, Product reads continue
from PostgreSQL and committed Promotion or ingestion writes still succeed. Failed invalidation may
leave a cached response stale only until its short TTL expires. This selects A-10 as bounded eventual
consistency with a normal maximum stale window equal to `PRODUCT_DETAIL_CACHE_TTL_SECONDS`.
Assignment and cancellation invalidate immediately when Redis is available; scheduled Promotion
`startAt` and `endAt` boundaries rely on the same TTL and do not require timers.

## Product listing cache

`GET /products` uses the same fail-open Redis client and caches only validated pages from 1 through
`PRODUCT_LIST_CACHE_MAX_PAGE`, defaulting to 5. Deeper pages bypass Redis. Listing entries expire
after `PRODUCT_LIST_CACHE_TTL_SECONDS`, defaulting to 15 seconds.

Keys use the schema-versioned form
`cache:product-list:v1:<scope>:<version>:page=<page>:pageSize=<pageSize>:sort=<sort>:order=<order>`.
Only normalized page, page size, Category, sort, and order values are included. Unfiltered requests
use `cache:product-list-version:global`; filtered requests use
`cache:product-list-version:category:<categoryId>`.

Committed ingestion chunks increment the global version once and each affected old or new Category
version once. Product Promotion changes increment global and the Product's Category versions;
Category Promotion changes increment global and the targeted Category versions. Version increments
replace key scans and listing-key deletion. Cache fills compare the scope version before and after
the PostgreSQL query and use an atomic final version check, preventing stale writes after
invalidation.

Redis failure falls back to the existing PostgreSQL listing query and does not fail Product,
Promotion, or ingestion operations. Failed invalidation can leave a listing stale for at most the
15-second default TTL. Scheduled Promotion boundaries use the same bounded eventual-consistency
window. Concurrent misses for one complete listing key share a Promise only within one Node
process; no distributed lock is used.

## Ingestion persistence

PostgreSQL stores durable import-job, bounded-chunk, and row-failure state so progress can survive
disposable worker processes. File and chunk content remains in external file storage and is
referenced by `storagePath`; it is not stored in the database. `fileChecksum` is retained for future
duplicate detection, but duplicate-file policy remains unresolved. Future worker logic will update
job counters explicitly and transactionally. Production queue and object-storage mappings remain
an ADR concern.

### Local uploads

Local upload configuration:

- `IMPORT_STORAGE_PATH=./data/imports`
- `MAX_IMPORT_FILE_SIZE_BYTES=536870912`
- `IMPORT_CHUNK_SIZE=500`
- `IMPORT_MAX_ATTEMPTS=3`
- `IMPORT_RETRY_BASE_DELAY_SECONDS=5`
- `IMPORT_RETRY_MAX_DELAY_SECONDS=300`
- `IMPORT_LOCK_TIMEOUT_SECONDS=300`
- `HTTP_BODY_LIMIT=1mb`
- `SHUTDOWN_TIMEOUT_SECONDS=10`
- `PRICING_RULE_VERSION=v1`

The storage directory is created when needed and is ignored by Git. Upload a CSV with:

```bash
curl -X POST \
  -F "file=@vendor-products.csv" \
  http://localhost:3000/imports
```

`202 Accepted` means the raw file is safely stored and an ImportJob exists; it does not mean the
file has been parsed or processed. The Job remains `PENDING` until preparation runs.

### Local preparation

Prepare at most one pending import and exit:

```bash
npm run ingestion:prepare
npm run ingestion:prepare -- --job-id=<import-job-uuid>
```

Preparation requires the case-sensitive headers `sku`, `name`, `category`, `basePrice`, and
`stockQuantity`. It streams the raw CSV once, computes SHA-256 from the original bytes, and writes
bounded NDJSON chunks under `data/imports/chunks/<job-id>/`. Each line contains the source
`rowNumber` and an unvalidated string-valued `data` object.

The preparation lifecycle is `PENDING → PREPARING → READY`; malformed files become `FAILED`.
Preparation does not write Product records or apply pricing rules. A failed attempt preserves the
raw CSV but removes partial chunks. A future explicit retry will restart this lightweight split
step from the beginning rather than from a byte checkpoint; Product processing remains separately
chunked and retryable. Production object storage and serverless execution may replace this local
mechanism.

### Local Product-chunk processing

Process at most one available prepared chunk and exit:

```bash
npm run ingestion:process
npm run ingestion:process -- --job-id=<import-job-uuid>
```

The explicit `v1` pricing rule accepts a non-negative vendor decimal and normalizes it to two
decimal places using decimal round-half-up. Within one chunk, the first valid normalized SKU is
accepted and later occurrences become `DUPLICATE_SKU_IN_CHUNK` failures. Existing Products are
upserted by SKU, including their name, Category, base price, and stock.

Category creation, Product upserts, row failures, chunk completion, and job counters commit in one
database transaction after the bounded chunk has been streamed and validated. Duplicate ordering
across chunks or imports remains unresolved under A-08.

Chunk delivery is assumed to be at least once. `attemptCount` is incremented on every claim and,
together with `lockedBy`, acts as the fencing token. Before Product writes, the transaction verifies
that the worker still owns that exact attempt. Category writes, Product upserts, row-level failures,
chunk completion, counters, and the job completion decision remain the transactional idempotency
boundary. A crash before commit rolls all of them back; a crash after commit leaves a `COMPLETED`
chunk that cannot be claimed again.

Known temporary Prisma and filesystem errors return the owned chunk to `PENDING` while attempts
remain. Retry delay is `min(baseDelay × 2^(attemptCount - 1), maxDelay)`. Malformed or missing chunk
files, unsupported pricing rules, invariants, and unknown errors fail immediately. Before a normal
claim, each invocation recovers at most 100 expired `PROCESSING` locks. An expired chunk at the
maximum attempt count becomes `FAILED`.

For this local implementation, a terminal `FAILED` chunk plus its chunk-level `ImportFailure` is the
durable dead-letter representation. A production deployment may map that state to a managed DLQ,
but no external queue or DLQ is implemented here. Continuous polling, manual retry, duplicate-file
rejection, cross-import ordering, caching, representative-volume performance testing, and cloud
queue/object-storage deployment remain deferred.

## Process lifecycle

The Express application is constructed in `src/app.ts`. HTTP listening and process signals live in
`src/server.ts`, so tests can import the app without opening a port or registering handlers.

`SIGTERM` and `SIGINT` start an idempotent graceful shutdown:

1. Stop accepting new HTTP connections.
2. Close idle keep-alive connections when the Node.js version supports it.
3. Allow in-flight requests to finish, bounded by `SHUTDOWN_TIMEOUT_SECONDS` (default 10).
4. Close the shared Redis client if it was initialized.
5. Disconnect the shared Prisma Client.
6. Exit `0` when cleanup completes, or force-exit `1` if the timeout elapses.

A resource-close failure is logged without credentials or connection URLs and does not skip the
remaining steps. Successful cleanup clears the force-exit timer.

One-shot `ingestion:prepare` and `ingestion:process` workers do not claim extra work after they
start. If the process is terminated before a chunk transaction commits, rollback and stale-lock
recovery reclaim the work. If termination happens after commit, the completed chunk is not
reclaimed. Workers close Prisma and Redis on normal completion; they do not reuse the HTTP
shutdown sequence.

## Upload and request limits

- `MAX_IMPORT_FILE_SIZE_BYTES` limits streamed CSV uploads (default 512 MiB). Oversized files
  return `413`.
- Multipart requests accept exactly one `file` field, with finite field, file, and part counts.
  Invalid or unsupported uploads return `400`.
- Empty files, missing files, extra files, and unsupported types are rejected. Partial files and
  files left behind after ImportJob persistence failure are removed.
- Stored names are server-generated UUIDs. Client filenames are metadata only and cannot choose
  the path, escape `IMPORT_STORAGE_PATH`, or overwrite an existing file.
- Raw upload and generated chunk paths are resolved and checked against the configured storage
  root before any filesystem operation. Public responses do not include absolute paths.
- `HTTP_BODY_LIMIT` (default `1mb`) applies only to JSON and URL-encoded bodies. It does not cap
  streamed CSV bytes.

## Authentication

Authentication and authorization are intentionally outside this case-study implementation (A-12).
A production deployment must place management and ingestion endpoints behind authentication and
authorization.

## Health check

`GET /health` is a liveness probe. It does not depend on Redis. Redis is optional for correctness:
Product reads fall back to PostgreSQL, and Promotion or ingestion writes still succeed when Redis
is unavailable.

```bash
curl http://localhost:3000/health
```

## Local performance verification

These commands are manual. `npm test` does not run them. They need the existing local PostgreSQL
database (`DATABASE_URL`) and Redis from Compose. Generated files stay under `tmp/`, which Git
ignores.

Large runs can take several minutes and tens of megabytes of disk for a 500,000-row CSV plus
prepared chunks. Do not treat laptop or local Docker numbers as production capacity. See
`PERFORMANCE.md`.

Required services:

```bash
docker compose up -d redis
# PostgreSQL is the existing local database configured by DATABASE_URL
```

Safe order:

```bash
npm run perf:generate-vendor -- --rows=500000 --output=./tmp/perf/vendor-500k.csv
npm run perf:ingestion -- --file=./tmp/perf/vendor-500k.csv
npm run perf:seed-flash-sale -- --products=50000 --explain
npm run dev
npm run perf:read -- --url=http://localhost:3000 --duration=30 --concurrency=20
```

Redis-unavailable reads require the API to be started after Redis is stopped. The read command
does not stop Redis itself.

Cleanup is limited to reserved identifiers `PERF_ACCESSORIES`, `PERFR-`, and `PERF_FLASH_SALE`:

```bash
npm run perf:seed-flash-sale -- --cleanup
```
