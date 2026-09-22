import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { healthRouter } from './health/health.routes.js';
import { HttpError, isMalformedJsonError } from './http/errors.js';
import { productRouter } from './products/product.routes.js';
import { promotionRouter } from './promotions/promotion.routes.js';

export const createApp = (): Express => {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(healthRouter);
  app.use(productRouter);
  app.use(promotionRouter);

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
    if (isMalformedJsonError(err)) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request parameters',
          details: [{ field: 'body', message: 'Must contain valid JSON' }],
        },
      });
      return;
    }

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
};
