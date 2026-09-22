# inventai-modaco-assignment

Minimal Node.js REST API scaffold using Express and TypeScript.

## Requirements

- Node.js 20.11 or later

## Setup

```bash
npm install
cp .env.example .env
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

## Health check

```bash
curl http://localhost:3000/health
```
