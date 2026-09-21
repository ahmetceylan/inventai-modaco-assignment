# Engineering Journal

Purpose

This journal preserves engineering context throughout the assignment.

It exists to:

- prevent context loss across AI conversations
- document engineering decisions
- explain why changes were made
- avoid duplicate investigations
- provide an audit trail for reviewers

This file is append-only.

Each issue must be recorded immediately before or immediately after its commit.

---

## 2026-09-21 — Bootstrap Express + TypeScript API

### Problem

The repository had no application runtime, toolchain, or test harness.

### Root Cause

Greenfield assignment repo; only operator docs existed.

### Impact

The project could not be installed, started, linted, or tested.

### Solution

Added a minimal Express 5 ESM API with TypeScript strict mode, env validation, Helmet, `/health`, ESLint, Prettier, and Vitest. No ORM, database, Redis, queues, Docker, or cloud SDKs.

### Trade-offs

Helmet is included as a security baseline. CORS, logging libraries, and schema validators were deferred. Env validation is local code rather than Zod/envalid to keep the dependency surface small.

### Validation

`npm run build`, `npm run lint`, and `npm test` succeed.

---

## 2026-09-21 — Prisma PostgreSQL catalog schema

### Problem

The API had no persistence layer or catalog schema.

### Root Cause

The initial scaffold intentionally omitted ORM and database dependencies.

### Impact

Category, product, and promotion data could not be stored or migrated.

### Solution

Added Prisma 7.10 with local PostgreSQL, `Category` / `Product` / `Promotion` models, UUID keys, `TIMESTAMPTZ` timestamps, `Decimal(12, 2)` money fields, Restrict deletes on promotion FKs, and an initial migration. No REST, workers, constraints beyond Prisma relations, or Prisma hosted services.

### Trade-offs

Check/exclusion constraints and XOR assignment rules are deferred. `DATABASE_URL` is not validated in `src/config/env.ts` so `/health` still starts without a database. Prisma Client is generated to `generated/prisma`, which is gitignored. No local Postgres was running, so the migration was created but not applied.

### Validation

`prisma format`, `prisma validate`, `prisma generate`, `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build` succeed.
