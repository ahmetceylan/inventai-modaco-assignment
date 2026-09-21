import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(healthRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}
