# ModaCo Promotion Management API

Internal REST API for ModaCo product catalog and promotions. It returns decimal-safe
effective prices, accepts streamed vendor CSV uploads, and processes those files through
bounded one-shot workers. Redis is an optional cache in front of PostgreSQL. The
implementation is local-first: Compose starts Redis, PostgreSQL is the existing local
database, and files are stored on disk.

## Key Features

- Product listing and detail with base price and current effective price
- Category filtering, offset pagination, and optional effective-price sorting
- Product-specific and Category Promotions with deterministic precedence
- Streamed CSV upload with server-generated stored names
- Chunked preparation and one-shot Product processing workers
- Retry, bounded backoff, and stale-lock recovery for temporary chunk failures
- Redis cache-aside for Product detail and the first listing pages, with fail-open reads
- Optional local performance-verification commands

## Technology Stack

| Component | Implementation |
| --- | --- |
| Runtime | Node.js `>=20.11.0` |
| HTTP | Express `^5.2.1` |
| Language | TypeScript `^6.0.3` |
| Database | PostgreSQL via `pg` `^8.23.0` |
| ORM | Prisma `^7.10.0` (`@prisma/client`, `@prisma/adapter-pg`) |
| Cache | Redis `^6.2.1` client; Compose image `redis:8-alpine` |
| Tests | Vitest `^4.1.11`, Supertest `^7.2.2` |
| Local services | Docker Compose (`compose.yaml`) |

Cloud services, queues, and object storage are not implemented.

## Architecture Overview

```mermaid
flowchart LR
    Client --> API["Express API"]
    API --> PostgreSQL
    API --> Redis
    API --> Storage["Local file storage"]
    Prepare["ingestion:prepare"] --> Storage
    Prepare --> PostgreSQL
    Process["ingestion:process"] --> Storage
    Process --> PostgreSQL
    Process --> Redis
```

PostgreSQL is the source of truth for Products, Promotions, and import progress. Redis is
optional for correctness: reads and writes continue when it is unavailable. Raw CSVs and
prepared NDJSON chunks live under `IMPORT_STORAGE_PATH`. Preparation and processing are
one-shot CLI workers. Production object-storage and queue mapping is not implemented here;
`REQUIREMENTS.md` leaves those choices to a later ADR.

## Domain Rules

- A Product-specific Promotion overrides an applicable Category Promotion.
- Two non-cancelled Promotions may not overlap at the same Product or the same Category.
- A Product Promotion and a Category Promotion may overlap; Product scope wins at read time.
- Active interval is `[startAt, endAt)` in UTC.
- Cancellation is soft: `cancelledAt` is set and the row is kept.
- `PERCENTAGE`: `basePrice × (1 - value / 100)`.
- `FIXED`: `max(0, basePrice - value)`.
- Effective price is never negative and is rounded half-up to two decimal places.
- Money uses Prisma `Decimal`, not floating-point arithmetic.

## Prerequisites

- Node.js 20.11 or later
- npm (this repository uses `package-lock.json`)
- Docker and Docker Compose, for local Redis
- A local PostgreSQL database reachable at `DATABASE_URL`

Compose does not start PostgreSQL. Default ports used by this project:

- API: `3000`
- Redis: `6379`

Prisma is a local `devDependency`. Do not assume a global `prisma` install.

## Local Setup

```bash
git clone git@github.com:ahmetceylan/inventai-modaco-assignment.git
cd inventai-modaco-assignment
npm install
cp .env.example .env
```

Create the PostgreSQL database named in `DATABASE_URL` (example: `modaco`), then:

```bash
docker compose up -d redis
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
```

In another terminal:

```bash
curl http://localhost:3000/health
```

Expected body: `{"status":"ok"}`.

`DATABASE_URL` is required by the Prisma client. The process cannot start API routes that
import Prisma without it.

## Environment Variables

Values below match `.env.example` and the defaults in `src/config/env.ts` unless noted.

| Variable | Required | Default / example | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development`, `test`, or `production` |
| `PORT` | no | `3000` | HTTP listen port |
| `DATABASE_URL` | yes | `postgresql://postgres:postgres@localhost:5432/modaco?schema=public` | PostgreSQL connection string (validated by Prisma, not `env.ts`) |
| `REDIS_URL` | no | `redis://localhost:6379` | Redis URL (`redis://` or `rediss://`) |
| `IMPORT_STORAGE_PATH` | no | `./data/imports` | Root for raw uploads and chunks |
| `MAX_IMPORT_FILE_SIZE_BYTES` | no | `536870912` | Maximum streamed CSV size (512 MiB) |
| `IMPORT_CHUNK_SIZE` | no | `500` (max `10000`) | Prepared NDJSON rows per chunk |
| `IMPORT_MAX_ATTEMPTS` | no | `3` | Chunk claim attempts before terminal failure |
| `IMPORT_RETRY_BASE_DELAY_SECONDS` | no | `5` | Retry backoff base |
| `IMPORT_RETRY_MAX_DELAY_SECONDS` | no | `300` | Retry backoff cap; must be `>=` base |
| `IMPORT_LOCK_TIMEOUT_SECONDS` | no | `300` | Stale `PROCESSING` lock timeout |
| `PRODUCT_DETAIL_CACHE_TTL_SECONDS` | no | `30` | Product detail entry TTL |
| `PRODUCT_LIST_CACHE_TTL_SECONDS` | no | `15` | Product listing entry TTL |
| `PRODUCT_LIST_CACHE_MAX_PAGE` | no | `5` | Highest listing page stored in Redis |
| `HTTP_BODY_LIMIT` | no | `1mb` | JSON and URL-encoded body limit (`b` / `kb` / `mb`) |
| `SHUTDOWN_TIMEOUT_SECONDS` | no | `10` | Graceful-shutdown force-exit timeout |
| `PRICING_RULE_VERSION` | no | `v1` | Pricing rule stamped on new ImportJobs |

Do not commit `.env`. The example credentials are local placeholders only.

## Available Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API with `tsx watch` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run `node dist/index.js` |
| `npm run lint` | ESLint with `--max-warnings 0` |
| `npm run format` | Prettier write |
| `npm test` | Vitest full suite |
| `npm run prisma:generate` | Generate Prisma Client |
| `npm run prisma:migrate` | Create and apply a local migration |
| `npm run prisma:migrate:deploy` | Apply committed migrations |
| `npm run ingestion:prepare` | Prepare at most one pending ImportJob |
| `npm run ingestion:process` | Process at most one available chunk |
| `npm run perf:generate-vendor` | Stream a deterministic vendor CSV |
| `npm run perf:ingestion` | Run the real local ingestion path |
| `npm run perf:seed-flash-sale` | Seed or clean reserved flash-sale data |
| `npm run perf:read` | Comparative local Product read smoke test |

There is no separate `typecheck` script. `npm run build` is the TypeScript compile step.

## API Overview

There is no URL prefix. Errors use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request parameters",
    "details": [{ "field": "page", "message": "Must be a positive integer" }]
  }
}
```

Unknown routes return `404` with `NOT_FOUND`. Unexpected errors return `500` with
`INTERNAL_ERROR` and no stack, SQL, paths, or connection details.

### `GET /health`

Liveness probe. Does not check Redis or PostgreSQL.

Success: `200`

```json
{ "status": "ok" }
```

### `GET /products`

Lists Products with current effective prices.

| Query | Default | Notes |
| --- | --- | --- |
| `page` | `1` | Positive integer |
| `pageSize` | `20` | `1`–`100` |
| `categoryId` | omitted | UUID |
| `sort` | omitted | Only `effectivePrice` is accepted |
| `order` | `asc` when `sort` is set | `asc` or `desc`; requires `sort` |

Without `sort`, order is Product `id` ascending. With `sort=effectivePrice`, the SQL path
calculates effective price over the full filtered set, sorts by that price then Product `id`,
and only then applies offset pagination.

Success: `200`

```http
GET /products?categoryId=40000000-0000-4000-8000-000000000001&sort=effectivePrice&page=1&pageSize=20
```

```json
{
  "data": [
    {
      "id": "50000000-0000-4000-8000-000000000001",
      "name": "Sunglasses",
      "sku": "SUN-001",
      "basePrice": "100.00",
      "effectivePrice": "80.00",
      "stockQuantity": 10,
      "category": { "id": "40000000-0000-4000-8000-000000000001", "name": "Accessories" },
      "createdAt": "2030-01-01T00:00:00.000Z",
      "updatedAt": "2030-01-02T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

Important errors: `400 VALIDATION_ERROR`.

### `GET /products/:id`

Returns one Product and its current effective price.

Success: `200` `{ "data": { ...product } }`

Important errors: `400 VALIDATION_ERROR`, `404 PRODUCT_NOT_FOUND`.

### `POST /promotions`

Creates an unassigned Promotion. Body fields: `name`, `discountType` (`PERCENTAGE` or
`FIXED`), `value` (decimal string), `startAt`, `endAt` (ISO 8601 with timezone).
`productId` and `categoryId` are not accepted here.

Success: `201`

```http
POST /promotions
Content-Type: application/json

{
  "name": "Summer Sale",
  "discountType": "PERCENTAGE",
  "value": "20.00",
  "startAt": "2030-06-01T00:00:00.000Z",
  "endAt": "2030-07-01T00:00:00.000Z"
}
```

```json
{
  "data": {
    "id": "60000000-0000-4000-8000-000000000001",
    "name": "Summer Sale",
    "discountType": "PERCENTAGE",
    "value": "20.00",
    "startAt": "2030-06-01T00:00:00.000Z",
    "endAt": "2030-07-01T00:00:00.000Z",
    "cancelledAt": null,
    "target": null,
    "createdAt": "2030-01-01T00:00:00.000Z",
    "updatedAt": "2030-01-01T00:00:00.000Z"
  }
}
```

Important errors: `400 VALIDATION_ERROR`.

### `POST /promotions/:id/assign`

Assigns an unassigned Promotion to exactly one target:

```json
{ "productId": "50000000-0000-4000-8000-000000000001" }
```

or

```json
{ "categoryId": "40000000-0000-4000-8000-000000000001" }
```

Repeating the same target returns `200` without changing state. A different target returns
`409 PROMOTION_ALREADY_ASSIGNED`. Same-scope overlap returns `409 PROMOTION_CONFLICT`.
Cancelled Promotions return `409 PROMOTION_CANCELLED`.

Success: `200` `{ "data": { ..., "target": { "type": "PRODUCT", "id": "..." } } }`

Important errors: `400`, `404 PROMOTION_NOT_FOUND`, `404 PRODUCT_NOT_FOUND`,
`404 CATEGORY_NOT_FOUND`, `409`.

### `POST /promotions/:id/cancel`

Soft-cancels a Promotion. Repeating the call returns `200` with the existing `cancelledAt`.

Success: `200`

Important errors: `400`, `404 PROMOTION_NOT_FOUND`.

### `POST /imports`

Accepts one multipart field named `file`. Stores the CSV on disk and creates a `PENDING`
ImportJob. `202` means the file is stored, not that Products were written.

```bash
curl -X POST \
  -F "file=@vendor-products.csv" \
  http://localhost:3000/imports
```

Success: `202`

```json
{
  "data": {
    "id": "70000000-0000-4000-8000-000000000001",
    "status": "PENDING",
    "originalFileName": "vendor-products.csv",
    "totalRows": null,
    "processedRows": 0,
    "succeededRows": 0,
    "failedRows": 0,
    "pricingRuleVersion": "v1",
    "createdAt": "2030-01-01T00:00:00.000Z",
    "statusUrl": "/imports/70000000-0000-4000-8000-000000000001"
  }
}
```

Important errors: `400 IMPORT_FILE_REQUIRED`, `400 EMPTY_IMPORT_FILE`,
`400 UNSUPPORTED_IMPORT_FILE`, `400 VALIDATION_ERROR`, `413 IMPORT_FILE_TOO_LARGE`.

### `GET /imports/:id`

Returns public job progress. `storagePath` is never included.

Success: `200`

Important errors: `400 VALIDATION_ERROR`, `404 IMPORT_JOB_NOT_FOUND`.

## Vendor CSV Format

Required headers, case-sensitive:

```csv
sku,name,category,basePrice,stockQuantity
SUN-001,Sunglasses,Accessories,100.00,10
BAG-002,Tote Bag,Bags,49.50,3
```

- Maximum file size: `MAX_IMPORT_FILE_SIZE_BYTES` (default 512 MiB).
- Preparation validates headers, streams the file, and writes NDJSON chunks. It does not
  apply Product business validation.
- Processing validates each row: non-empty SKU/name/category, non-negative decimal
  `basePrice` (v1 rule, two decimal places, max `9999999999.99`), non-negative integer
  `stockQuantity` up to `2147483647`.
- Within one chunk, the first valid SKU is accepted; later copies become
  `DUPLICATE_SKU_IN_CHUNK` failures.
- An existing Product with the same SKU is upserted (name, category, base price, stock).
- Ordering across chunks or imports is not a guaranteed business policy (open item A-08).

## Ingestion Workflow

Implemented job statuses:

```text
PENDING → PREPARING → READY → PROCESSING → COMPLETED | COMPLETED_WITH_ERRORS | FAILED
```

The Prisma enum also includes `CANCELLED`. No HTTP or worker path sets that status.

1. `POST /imports` streams the CSV to `IMPORT_STORAGE_PATH` under a UUID filename.
2. `npm run ingestion:prepare` claims one `PENDING` job, validates CSV structure, writes
   chunks under `chunks/<job-id>/`, and moves the job to `READY` or `FAILED`.
3. `npm run ingestion:process` claims one available chunk, applies the `v1` pricing rule,
   upserts Products, records row failures, and updates counters in one transaction.
4. Temporary Prisma/filesystem errors requeue the chunk with
   `min(baseDelay × 2^(attemptCount - 1), maxDelay)` until `IMPORT_MAX_ATTEMPTS`.
5. Before a normal claim, the worker recovers at most 100 stale `PROCESSING` locks older
   than `IMPORT_LOCK_TIMEOUT_SECONDS`.
6. `GET /imports/:id` reports progress.

Optional job targeting:

```bash
npm run ingestion:prepare -- --job-id=<import-job-uuid>
npm run ingestion:process -- --job-id=<import-job-uuid>
```

Workers exit after one unit of work so they can model disposable serverless executions.
There is no in-process poller and no external queue.

## Caching and Consistency

`GET /products/:id` and eligible `GET /products` pages use Redis cache-aside.
PostgreSQL remains authoritative.

- Detail key: `cache:product-detail:<productId>`
- Detail versions: `cache:product-version:<productId>`,
  `cache:category-promotion-version:<categoryId>`
- Listing keys include schema version, global or Category scope, listing version, page,
  pageSize, sort, and order
- Listing versions: `cache:product-list-version:global` and
  `cache:product-list-version:category:<categoryId>`
- Only listing pages `1` through `PRODUCT_LIST_CACHE_MAX_PAGE` are cached
- Writes increment versions after commit; keys are not scanned or bulk-deleted
- If Redis is down, Product reads use PostgreSQL and Promotion/ingestion writes still
  succeed
- Scheduled `startAt` / `endAt` boundaries rely on TTL rather than a timer
- Single-flight deduplication is per Node process only

Assumption A-10: bounded eventual consistency. The normal stale window is the configured
TTL when invalidation fails.

## Testing

```bash
npm test
npm run lint
npm run build
```

The suite includes unit and integration tests in `tests/`. Constraint and endpoint tests
need a migrated local PostgreSQL database. Redis integration files are skipped unless
`RUN_REDIS_INTEGRATION_TESTS=true`. Product tests still pass when Redis is unavailable
because cache operations fail open.

There are no separate `test:unit` or `test:integration` scripts. Large 50k/500k
performance runs are manual and are not part of `npm test`.

## Performance Verification

Optional commands. Details and measured-vs-unmeasured results are in
[PERFORMANCE.md](PERFORMANCE.md). Local Docker numbers are not production capacity.

```bash
npm run perf:generate-vendor -- --rows=500000 --output=./tmp/perf/vendor-500k.csv
npm run perf:ingestion -- --file=./tmp/perf/vendor-500k.csv
npm run perf:seed-flash-sale -- --products=50000 --explain
npm run dev
npm run perf:read -- --url=http://localhost:3000 --duration=30 --concurrency=20
npm run perf:seed-flash-sale -- --cleanup
```

Cleanup is limited to `PERF_ACCESSORIES`, `PERFR-`, and `PERF_FLASH_SALE`. Generated files
under `tmp/` are Git-ignored.

## Design Decisions

| Document | Purpose |
| --- | --- |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Assignment requirements, assumptions, and open decisions |
| [PERFORMANCE.md](PERFORMANCE.md) | Manual benchmark commands and recorded local measurements |

`ADR.md` and `AI_APPENDIX.md` are required submission artifacts in `REQUIREMENTS.md` but
are not in this repository yet.

## Assumptions and Known Limitations

- Authentication and authorization are outside this case-study implementation (A-12). A
  production deployment must protect management and ingestion endpoints.
- Local disk stands in for object storage. `data/imports/` is Git-ignored.
- ImportJob/ImportChunk rows stand in for a managed queue. No SQS, Service Bus, or worker
  pool is implemented.
- Duplicate-file and cross-import SKU ordering remain an open business decision (A-08).
- Redis is not a source of truth.
- Local performance measurements do not represent production capacity.
- Serverless execution is modeled by one-shot workers; no cloud function is provisioned.
- Docker Compose starts Redis only. PostgreSQL must already exist locally.
- ImportJob status `CANCELLED` exists in Prisma but has no cancel API.
- There is no dedicated TypeScript `typecheck` script beyond `npm run build`.

These are scoped case-study choices, not silent defects in the implemented API.

## Graceful Shutdown and Operational Notes

`src/server.ts` registers `SIGTERM` and `SIGINT`. Shutdown is idempotent: stop accepting
connections, close idle sockets when the Node.js version supports it, wait for in-flight
requests, close Redis if opened, disconnect Prisma, then exit. If cleanup exceeds
`SHUTDOWN_TIMEOUT_SECONDS`, the process force-exits. Workers close the same shared
resources after one job or chunk.

JSON/form bodies use `HTTP_BODY_LIMIT`. Multipart CSVs use `MAX_IMPORT_FILE_SIZE_BYTES`.
Upload and chunk paths are resolved inside `IMPORT_STORAGE_PATH`. Git ignores `.env`,
`data/imports/`, `tmp/`, `dist/`, and `generated/`.

## Repository Structure

```text
src/app.ts                 Express app; no listen, no signal handlers
src/server.ts              HTTP listen and process lifecycle
src/index.ts               Process entry
src/config/                Environment, Prisma, shared resource close
src/http/                  Errors and sanitized error handler
src/products/              Product routes, query, mapping
src/promotions/            Promotion routes and conflict checks
src/pricing/               Effective-price calculation
src/cache/                 Redis client, keys, detail/list cache
src/ingestion/             Upload, prepare, process, retry
src/perf/                  Optional local performance tools
src/health/                Liveness route
prisma/                    Schema and SQL migrations
tests/                     Vitest unit and integration tests
```
