import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { healthRouter } from './health/health.routes.js';
import { httpErrorHandler } from './http/error-handler.js';
import { importRouter } from './ingestion/import.routes.js';
import { productRouter } from './products/product.routes.js';
import { promotionRouter } from './promotions/promotion.routes.js';

export const createApp = (): Express => {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: env.HTTP_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.HTTP_BODY_LIMIT }));
  app.use(healthRouter);
  app.use(importRouter);
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

  app.use(httpErrorHandler);

  return app;
};
