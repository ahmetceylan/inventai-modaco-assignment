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

## Health check

```bash
curl http://localhost:3000/health
```
