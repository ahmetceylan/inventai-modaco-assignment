import { type NextFunction, type Request, type Response } from 'express';
import { HttpError, isMalformedJsonError } from './errors.js';

const sanitizedInternalError = {
  error: {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
    details: [] as const,
  },
};

const logInternalError = (error: unknown): void => {
  const errorName =
    error instanceof Error
      ? error.constructor.name
      : typeof error === 'object' && error !== null
        ? 'object'
        : typeof error;

  console.error(JSON.stringify({ event: 'unhandled_http_error', errorName }));
};

export const httpErrorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
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

  logInternalError(err);
  res.status(500).json(sanitizedInternalError);
};
