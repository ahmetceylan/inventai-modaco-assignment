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
