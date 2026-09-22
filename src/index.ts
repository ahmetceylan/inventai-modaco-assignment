import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Server listening on port ${env.PORT}`);
});

const shutdown = (signal: string): void => {
  console.log(`Received ${signal}, shutting down`);
  server.close((closeError) => {
    if (closeError) {
      console.error(closeError);
      process.exit(1);
      return;
    }

    process.exit(0);
  });
};

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
