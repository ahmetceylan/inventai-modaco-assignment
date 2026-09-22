# Performance verification

Comparative local evidence for Scenario A (vendor ingestion) and Scenario B (flash-sale reads).
These are not production SLAs. Laptop and local Docker results must not be treated as capacity
claims.

## Environment

| Item | Value |
| --- | --- |
| Date/time of run | 2026-09-22T21:16:15Z |
| Machine/OS | Darwin 23.5.0 arm64 |
| Node.js | v20.19.5 |
| PostgreSQL | Existing local `DATABASE_URL` instance; version not captured |
| Redis | `redis:8-alpine` via `compose.yaml`, server v=8.10.2 |
| Docker resource limits | None set in `compose.yaml` |
| `IMPORT_CHUNK_SIZE` | 500 (application default) |
| Ingestion worker concurrency | 1 (command default; max 4) |
| Product detail TTL | `PRODUCT_DETAIL_CACHE_TTL_SECONDS=30` |
| Product listing TTL | `PRODUCT_LIST_CACHE_TTL_SECONDS=15` |
| Listing cache max page | `PRODUCT_LIST_CACHE_MAX_PAGE=5` |
| Listing page size used | 20 |

Compose currently starts Redis only. PostgreSQL is the existing local `DATABASE_URL` instance.

## Scenario A

### Measured: 500,000-row CSV generation

| Item | Value |
| --- | --- |
| Rows | 500,000 |
| Output | `./tmp/perf/vendor-500k.csv` (Git-ignored) |
| File size | 28.0 MB (29,352,028 bytes) |
| Duration | 429 ms |
| Peak observed RSS | 106.6 MB |

### Measured: 50-row real ingestion path

Used the already-generated `./tmp/perf/vendor-50.csv` through `createImportJob`,
`prepareNextImport`, and one one-shot `processNextImportChunk` invocation.

| Item | Value |
| --- | --- |
| Input rows | 50 |
| File size | 2.9 KB |
| Chunk size | 500 |
| Chunks | 1 |
| Preparation | 62 ms |
| Processing | 109 ms |
| Throughput | 458.7 rows/s on this 50-row file |
| Succeeded / failed | 50 / 0 |
| Retries | 0 |
| Final status | `COMPLETED` |
| `PERFV-` Product count | 50 |
| Peak observed RSS | 254.5 MB |
| Max concurrent workers | 1 |
| Counters reconciled | `processedRows` matched input; Product count matched succeeded rows |

### Not measured in this environment

- 500,000-row preparation
- 500,000-row chunk processing
- Multi-worker ingestion (`--concurrency>1`)
- Memory/retry behavior under a full 500k run

Do not project the 50-row rows/s figure to 500,000 rows.

## Scenario B

### Measured: 20-product reserved seed

| Item | Value |
| --- | --- |
| Product count | 20 (`PERFR-` prefix) |
| Promotion scope | Category `PERF_ACCESSORIES` (`d4acc603-fab0-4d28-9772-6ab739af32be`) |
| Promotion | 50% `PERF_FLASH_SALE` (`af2e1933-10cd-4107-bc4d-4c1b8d300856`) |
| Promotion creation | One Promotion row assigned to the Category |
| 50K-row Product update | None. Seed inserted Products, then created/assigned one Promotion |

### Query-plan findings (20-row Category, not 50,000)

`EXPLAIN (ANALYZE, BUFFERS)` wrapped the production effective-price SQL:

- `Filter: (product."categoryId" = ...)` ran on the Product scan before the sort/limit.
- `Sort Key` was calculated `effectivePrice`, then `product.id`.
- `Limit` sat above that sort, so pagination happened after sort.
- Promotion lookup was two SQL `LEFT JOIN` / `Limit 1` laterals, not application N+1 queries.
- Planner used sequential scans. That is expected at 20 rows and is **not** evidence for a new
  index. `Product.categoryId`, `Promotion.categoryId`, and `Promotion.productId` indexes already
  exist.
- Execution time was 0.280 ms with shared-buffer hits only.

### Not measured in this environment

- 50,000-product seed
- Cold/warm/fallback read-load smoke test against a running API
- Query plan at 50,000 Products
- Confirmation that the planner uses `Product_categoryId_idx` at that size

## Cache verification

| Item | Expected from implementation | Measured |
| --- | --- | --- |
| Detail miss vs hit | Miss loads PostgreSQL; hit returns Redis JSON | Existing unit/Redis tests; large-load not measured |
| Listing miss vs hit | Same, for pages 1–5 | Existing unit/Redis tests; large-load not measured |
| Category Promotion invalidation | Increments one Category version and listing versions; no 50k key delete | Existing invalidation tests; 50k-key delete was not attempted |
| Redis unavailable | Product and listing reads continue from PostgreSQL; `/health` stays `ok` | Existing fail-open tests; `perf:read --scenarios=fallback` not run |
| Scheduled Promotion boundaries | Become visible within the configured TTL | Existing TTL documentation; not re-measured here |

## Interpretation

### Directly measured

- Streaming 500k CSV generation stayed around 107 MB RSS and finished in under a second.
- The real 50-row ingestion path completed with reconciled counters and no retries.
- A Category Promotion was created without updating Product rows.
- The production listing SQL sorts by effective price and Product ID before `LIMIT`.

### Inferred for production

- Chunked ingestion scales by repeating one-shot workers, not by enlarging one process.
- Category Promotions are rules, so a flash sale should not rewrite 50,000 Product rows.
- Logical cache versions avoid a 50,000-key delete.
- At 50,000 Products the planner may start using the existing `categoryId` index. That is a
  hypothesis, not a measurement.

### Known limitations of local testing

- Single laptop, single PostgreSQL, single Redis, no replicas.
- Compose defines no CPU/memory limits.
- The only executed ingestion was 50 rows / 1 chunk.
- The only executed seed was 20 Products.
- Read smoke tests and 50K/500K processing were not run.

### Recommended production mapping

- Run preparation and chunk workers as separate serverless invocations.
- Put Redis and PostgreSQL on sized managed services.
- Re-run `perf:ingestion` on the 500k file and `perf:seed-flash-sale -- --products=50000 --explain`
  before judging indexes or throughput.
- Measure p95/p99 with `perf:read` under production-like concurrency before setting any SLO.
- Place management and ingestion endpoints behind authentication.

No index migration is recommended from the 20-row plan.

## How to run

See the README section "Local performance verification". Record new results by replacing the
`Not measured in this environment` cells with command output. Do not invent numbers.
