import { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpErrorHandler } from '../src/http/error-handler.js';
import { validationError } from '../src/http/errors.js';

const createResponse = () => {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const handle = (error: unknown, res = createResponse()) => {
  httpErrorHandler(
    error,
    {} as Request,
    res as unknown as Response,
    (() => undefined) as NextFunction,
  );
  return res;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP error sanitization', () => {
  it('maps malformed JSON to a sanitized 400', () => {
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      body: true,
    });
    const res = handle(error);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request parameters',
        details: [{ field: 'body', message: 'Must contain valid JSON' }],
      },
    });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('Unexpected token');
  });

  it('preserves known domain errors', () => {
    const res = handle(validationError([{ field: 'name', message: 'Required' }]));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request parameters',
        details: [{ field: 'name', message: 'Required' }],
      },
    });
  });

  it('returns a generic 500 for unexpected errors', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = handle(new Error('boom'));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
      },
    });
  });

  it('does not expose Prisma-like details, Redis credentials, paths, or stacks', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    const error = Object.assign(
      new Error(
        'Invalid `prisma.product.findMany()` invocation SELECT * FROM "Product" postgresql://user:secret@localhost:5432/db redis://:hunter2@localhost:6379 /var/app/data/imports/file.csv',
      ),
      {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
        meta: { database_url: 'postgresql://user:secret@localhost:5432/db' },
        stack: 'Error: secret stack\n    at /var/app/src/index.ts:1:1',
      },
    );
    const res = handle(error);
    const body = JSON.stringify(res.json.mock.calls);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(body).not.toContain('SELECT');
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('/var/app');
    expect(body).not.toContain('P2002');
    expect(body).not.toContain('secret stack');
    expect(logs.join('\n')).not.toContain('secret');
    expect(logs.join('\n')).not.toContain('hunter2');
    expect(logs.join('\n')).not.toContain('postgresql://');
  });
});
