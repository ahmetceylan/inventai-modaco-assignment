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

| Script           | Purpose                       |
| ---------------- | ----------------------------- |
| `npm run dev`    | Start the API with hot reload |
| `npm run build`  | Compile TypeScript to `dist/` |
| `npm start`      | Run the compiled API          |
| `npm run lint`   | Lint the project              |
| `npm run format` | Format files with Prettier    |
| `npm test`       | Run the test suite            |

## Health check

```bash
curl http://localhost:3000/health
```
