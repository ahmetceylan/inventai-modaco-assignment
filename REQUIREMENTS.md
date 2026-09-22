# ModaCo Promotion Management API — Requirements Analysis

## 1. Purpose

This document translates the case-study brief into an implementation-ready set of requirements while keeping the following categories separate:

- **Explicit requirements:** stated directly in the assignment.
- **Derived engineering requirements:** necessary to satisfy the assignment reliably in production-like conditions.
- **Assumptions:** proposed decisions for unspecified business behavior. These must be confirmed or documented in `ADR.md`.
- **Open decisions:** deliberately unresolved until architecture and domain-design work is completed.

This file is a source of context for developers and AI coding assistants. It is **not** a substitute for `ADR.md`: requirements belong here; selected technologies, alternatives, and trade-offs belong in the ADR.

## 2. Scope

ModaCo needs an internal REST API for managing its product catalog and promotions. In addition to the core API, the solution must address:

1. Weekly ingestion of vendor files containing more than 500,000 product/pricing records, processed under serverless consumption-plan constraints.
2. Flash sales affecting more than 50,000 products while the storefront receives heavy read traffic.

### 2.1 Required submission artifacts

- Source-code repository.
- Database schema/DDL.
- `ADR.md` explaining and defending architectural choices and trade-offs, especially for Scenarios A and B.
- `AI_APPENDIX.md` describing AI tools, critical prompts, human refinement, verification, and at least one important AI mistake that was detected and corrected.

## 3. Required technology constraints

- Runtime/platform: Node.js.
- HTTP framework: Express.
- Language: TypeScript.
- Database and ORM choices are intentionally left open.
- The ingestion processor must be designed for a serverless consumption plan, such as AWS Lambda or Azure Functions.

NestJS or another higher-level application framework is not assumed because the brief explicitly requests Express.

## 4. Domain model

### 4.1 Product

A product has:

- Name.
- Category.
- Unique SKU (derived invariant; uniqueness is required to identify records safely during ingestion).
- Base price.
- Stock quantity.

### 4.2 Promotion

A promotion has:

- Name.
- Discount type: `percentage` or `fixed`.
- Discount value.
- Start date/time.
- End date/time.
- A target that is either a specific product or an entire category.
- Cancellation state/time (derived recommendation; cancellation should not destroy audit history).

### 4.3 Effective price

The API must return the price after applying the currently applicable promotion, not only the product's base price.

Conceptually:

```text
percentage: basePrice × (1 - discountPercentage / 100)
fixed:      max(0, basePrice - discountAmount)
```

`effectivePrice` is time-dependent and promotion-dependent. It must not be treated as an ordinary mutable product attribute without an explicitly justified consistency strategy.

## 5. Business invariants

### 5.1 Explicit invariant

- A product may have at most one active/effective promotion at any instant.
- Promotion conflicts must be resolved logically and deterministically.

### 5.2 Proposed validation invariants

Unless a later business clarification contradicts them:

- `sku` must be non-empty and unique.
- `basePrice >= 0`.
- `stockQuantity >= 0` and is an integer.
- `promotion.startAt < promotion.endAt`.
- Percentage discount must be greater than `0` and less than or equal to `100`.
- Fixed discount must be greater than `0`.
- Effective price must never be negative.
- Monetary values must use a decimal-safe representation; binary floating-point arithmetic must not determine persisted or returned prices.
- Timestamps must be stored and compared in UTC; API timestamps should be ISO 8601 values with an explicit offset or `Z`.

### 5.3 Proposed active-period semantics

Recommended interval semantics:

```text
active = cancelledAt is null
         AND startAt <= now
         AND now < endAt
```

The half-open interval `[startAt, endAt)` permits one promotion to end exactly when another begins without an overlap. This is an assumption to document in `ADR.md` unless ModaCo specifies different semantics.

## 6. Promotion conflict-resolution policy

Unless ModaCo supplies a different business rule, the system will use the following deterministic policy:

1. A product-specific promotion takes precedence over an applicable category promotion.
2. Overlapping promotions at the same scope are rejected:
   - Two product promotions may not overlap for the same product.
   - Two category promotions may not overlap for the same category.
3. Date ranges use half-open intervals, `[startAt, endAt)`. A promotion may begin exactly when another ends without conflicting.
4. Conflict checks include both currently active and future-scheduled promotions.
5. The rule selects exactly one **effective promotion** for a product at a given instant. A lower-priority category promotion may remain active for its category while being overridden for a product that has a product-specific promotion.
6. Resolution does not choose the numerically greatest discount. Business intent and target specificity take precedence over discount size.

This policy allows a category-wide flash sale to remain a category rule while supporting intentional product-level exceptions. It is deterministic, queryable, independently testable, and does not require comparing percentage and fixed discounts for every conflict decision.

The following behaviors follow from the policy:

- A product entering an actively promoted category inherits the category promotion unless it has an active product-specific promotion.
- A product leaving the category immediately ceases to qualify for that category promotion, subject to the documented consistency contract.
- Concurrent conflicting assignments must be serialized or rejected atomically; application-level pre-checks alone are insufficient.
- Cancelling the winning product-specific promotion makes the still-active category promotion effective without creating a new assignment.
- If ModaCo later specifies a different precedence rule, conflict resolution must be changed in one centralized domain policy rather than across controllers, queries, and cache code independently.

## 7. Core API capabilities

Exact endpoint paths and DTOs are an API-design decision, but the REST API must support the following capabilities.

### 7.1 List products

The product list must:

- Return base price and correctly calculated effective price.
- Support filtering by category.
- Support pagination.
- Support sorting by effective price.
- Produce deterministic pagination; sorting must include a stable tie-breaker.
- Validate and cap page size to protect the service.

Derived correctness requirement: filtering and effective-price sorting must occur over the complete matching result set before pagination. Fetching one page and sorting it in application memory is incorrect.

### 7.2 Get product details

- Return a single product and its current effective price.
- Return a clear not-found response for an unknown product.
- This is explicitly the most highly trafficked endpoint and must be designed as a read-optimized path.
- Any cache must have a defined freshness, invalidation/versioning, and fallback strategy.

### 7.3 Manage promotions

The API must support:

- Creating a promotion.
- Assigning a promotion to a product or a category.
- Cancelling a promotion.

Derived requirements:

- Assignment and conflict checking must be atomic under concurrent requests.
- Cancellation should be idempotent or return a documented stable outcome when repeated.
- Validation errors, conflicts, not-found errors, and malformed requests must have consistent error responses.
- Historical promotion data should remain available for audit/debugging; hard deletion is not recommended.

## 8. Scenario A — massive vendor-file ingestion

### 8.1 Explicit requirements and constraints

- ModaCo receives weekly vendor files with more than 500,000 product/pricing rows.
- Every record must pass through application-layer dynamic-pricing rules before persistence.
- Vendor data cannot be loaded directly into the database as the final ingestion path.
- The processor runs under serverless consumption-plan constraints:
  - Strict execution timeout.
  - Restricted memory.
  - Stateless executions.
  - Processing cannot rely on continuing after the initiating HTTP request completes.
- The ingestion must finish successfully without crashing or being abandoned midway.

### 8.2 Derived engineering requirements

- The upload/acceptance request must not synchronously process the entire file.
- The file must be streamed or partitioned; it must not be loaded fully into memory.
- Processing must be divided into bounded work units that complete within the serverless timeout.
- Durable state must track the import job and its progress outside the function process.
- Each work unit and each record write must be safe to retry without creating duplicates or applying changes twice.
- Delivery should be assumed to be **at least once**; exactly-once execution must not be assumed.
- Retries need bounded exponential backoff and a terminal failure/dead-letter strategy.
- Partial failures must not force the whole 500,000-row import to restart.
- Invalid rows must be isolated and reported with enough context to diagnose them, without losing valid rows unless an explicitly selected all-or-nothing business policy requires it.
- Concurrent processing must be bounded to protect the database and avoid exhausting connection limits.
- The system must expose job status and processing metrics such as total, processed, succeeded, failed, retried, and remaining records.
- A completed job must be distinguishable from completed-with-errors and failed jobs.
- Dynamic-pricing rule versioning must be considered so retries do not unpredictably apply a different ruleset midway through the same import.
- Input-file size/type limits and safe parsing behavior must be defined.

### 8.3 Important ingestion edge cases

- Duplicate SKU within the same file.
- A SKU that already exists in the database.
- Duplicate delivery of the same vendor file.
- Duplicate delivery of the same chunk/message.
- Malformed rows, missing columns, invalid encodings, or unexpected delimiters.
- Pricing-rule failure for a subset of rows.
- Function timeout/crash after a database commit but before message acknowledgement.
- Out-of-order chunk processing.
- Two imports for the same vendor or SKU range running concurrently.
- Database throttling or temporary unavailability.
- Poison records that fail on every retry.
- Import cancellation and safe resumption.

The precise duplicate/update policy is a business assumption that must be stated before implementation.

## 9. Scenario B — flash-sale load distribution

### 9.1 Explicit requirements

- A category-wide promotion may instantly affect more than 50,000 products.
- The product-listing endpoint receives massive read traffic during a flash sale.
- A product added to the promoted category after the sale starts must automatically receive the discount.
- The design must avoid bottlenecks during simultaneous heavy reads and writes.

### 9.2 Derived engineering requirements

- A category promotion must be modeled as a rule/relationship to the category, not only as a one-time snapshot of current product IDs.
- Creating a category promotion must not require synchronously updating 50,000 product rows.
- A newly created or recategorized product must be evaluated against the current category promotion automatically.
- Effective-price reads must avoid N+1 queries.
- The read path must support high throughput while preserving the selected promotion-conflict policy.
- Cache keys/data must not require a 50,000-key synchronous invalidation operation when a category promotion begins, ends, or is cancelled.
- Cache failure must degrade to a correct database/application path rather than make product reads unavailable.
- A consistency model must be explicitly selected: strong consistency or a bounded, documented period of eventual consistency.
- Promotion start/end boundaries must work even if no administrator request occurs at the boundary time; correctness cannot depend solely on a timer successfully firing once.

### 9.3 Important flash-sale edge cases

- Promotion starts or ends while a response is being generated.
- Promotion is cancelled under heavy traffic.
- Stale cached product details or product-list pages.
- Cache stampede at campaign start or cache expiry.
- Two administrators concurrently assign overlapping promotions.
- A product enters or leaves a promoted category.
- A new product is created while a category promotion is active.
- Read replicas lag behind promotion writes.
- Redis/cache is unavailable.
- Clock skew across distributed components.
- Effective-price ties during pagination.

## 10. Cross-cutting quality requirements

### 10.1 Correctness and concurrency

- Domain invariants must be protected at the strongest practical layer, including database constraints/transactions where possible; controller-level checks alone are insufficient.
- Race conditions must be tested, especially simultaneous promotion assignments and retry-after-commit ingestion behavior.
- Transaction boundaries must be explicit and kept appropriately small.

### 10.2 Performance

- Avoid N+1 queries.
- Add indexes based on actual filter, join, conflict-detection, and ordering paths.
- Do not perform unbounded queries or unbounded in-memory sorting.
- Verify important queries with query plans and representative data volumes.
- Keep serverless database connection behavior and pool limits in mind.

### 10.3 Reliability and observability

- Use structured logs with correlation/request IDs and import job/chunk identifiers.
- Expose health/readiness signals appropriate to the implemented dependencies.
- Record metrics for request latency/error rate/cache behavior and ingestion throughput/failure/retry counts.
- Do not log secrets or full sensitive input records.
- Define retryable versus non-retryable failures.

### 10.4 Security

- Validate all request parameters and uploaded content.
- Apply reasonable request and upload limits.
- Protect management and ingestion endpoints with an authentication/authorization boundary in a real deployment; if auth is excluded from the case-study implementation, state this explicitly.
- Keep secrets in environment/secret-management configuration, not source control.
- Use parameterized queries or ORM mechanisms that prevent injection.

## 11. Testing and acceptance criteria

The implementation should include:

- Unit tests for discount calculation, date-boundary semantics, validation, and conflict-resolution policy.
- Integration tests for endpoints, persistence constraints, transactions, effective-price sorting, filtering, and pagination.
- Concurrency tests proving two conflicting promotions cannot both become effective because of a race.
- Ingestion tests for chunk retries, duplicate messages, partial failures, timeout/restart behavior, and poison records.
- Cache tests for hit, miss, stale/version change, stampede mitigation, and cache-unavailable fallback.
- Representative-volume performance tests or a documented reproducible test plan for 500,000+ ingestion rows, 50,000+ promoted products, and read-heavy traffic.

Minimum behavioral acceptance examples:

- A product with no active promotion returns `effectivePrice == basePrice`.
- Percentage and fixed discounts return correct decimal-safe values.
- A fixed discount cannot produce a negative effective price.
- A promotion is active at `startAt` and inactive at `endAt` under the proposed interval rule.
- Category filtering plus effective-price sorting is correct before pagination and deterministic across pages.
- A product added to an actively promoted category immediately follows the selected consistency contract without explicit per-product assignment.
- Retrying the same ingestion work unit does not create an additional product or double-apply an update.
- A worker failure after a commit and before acknowledgement remains retry-safe.

## 12. Assumptions and decisions register

| ID | Item | Current status | Documentation target |
|---|---|---|---|
| A-01 | Product-specific promotion overrides category promotion; same-scope overlaps are rejected | Selected assumption; superseded by any later ModaCo clarification | `ADR.md` and tests |
| A-02 | Active interval is `[startAt, endAt)` | Proposed | `ADR.md` |
| A-03 | All timestamps use UTC | Proposed | API contract / `ADR.md` |
| A-04 | Percentage range is `(0, 100]` | Proposed | Validation/API contract |
| A-05 | Effective price is floored at zero | Proposed | Domain tests / API contract |
| A-06 | Cancellation is soft and auditable | Proposed | Schema / `ADR.md` |
| A-07 | Money uses decimal-safe storage/arithmetic | Proposed | Schema / `ADR.md` |
| A-08 | Vendor duplicate/upsert semantics | Open business decision | Ingestion contract / `ADR.md` |
| A-09 | Invalid-row policy: partial success vs whole-file rejection | Open business decision | Ingestion contract / `ADR.md` |
| A-10 | Product detail and bounded listing caches use bounded eventual consistency with TTL-defined stale windows | Selected assumption | `README.md` / incremental ADR notes |
| A-11 | Pagination style: offset or cursor/keyset | Open architecture decision | `ADR.md` / API contract |
| A-12 | Authentication/authorization implementation scope | Selected: excluded from the case-study implementation; production must add authn/authz around management and ingestion endpoints | `README.md` / incremental ADR notes |

## 13. Deliberately deferred architecture decisions

The following must not be inferred from this requirements document:

- Database engine and ORM/query builder.
- Queue/event-bus and object-storage provider.
- Cache technology and cache topology.
- Exact conflict-enforcement mechanism.
- Exact API routes and response envelopes.
- Offset versus cursor/keyset pagination.
- Effective-price query/read-model strategy.
- Cloud vendor.

These choices should be made after comparing alternatives against the requirements above and recorded in `ADR.md` with trade-offs.

## 14. Guidance for AI coding assistants

When using this file as context:

1. Do not convert proposed assumptions into hidden facts. Reference their IDs and flag open items.
2. Do not select infrastructure or persistence technologies unless explicitly asked.
3. Do not implement the whole assignment in one step. Work in small, reviewable changes.
4. Before generating code, identify the requirements and edge cases covered by that change.
5. Preserve business invariants under concurrency; do not rely only on `SELECT`-then-`INSERT` application checks.
6. Treat queue delivery as at least once and serverless workers as disposable.
7. Never load the full vendor file into memory or process all 500,000 rows within the upload HTTP request.
8. Never satisfy a category flash sale by synchronously updating every affected product row unless an ADR explicitly justifies that trade-off.
9. Add or update tests with every domain behavior change.
10. Surface ambiguities instead of inventing business rules.

## 15. Source of truth and change process

- The original assignment remains authoritative for explicit requirements.
- Confirmed answers from ModaCo supersede proposed assumptions in this document.
- When an assumption is confirmed or changed, update its status in the decision register and align the API contract, schema, tests, and `ADR.md`.
- Record material architectural choices in `ADR.md`, not only in code or AI-chat history.
