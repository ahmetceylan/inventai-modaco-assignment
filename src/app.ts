import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { HttpError } from './http/errors.js';
import { productRouter } from './products/product.routes.js';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(healthRouter);
  app.use(productRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        details: [],
      },
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      });
      return;
    }

    console.error(err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
      },
    });
  });

  return app;
}
