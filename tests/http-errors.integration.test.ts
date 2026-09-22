import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { httpErrorHandler } from '../src/http/error-handler.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP error responses', () => {
  it('returns sanitized 400 for malformed JSON', async () => {
    const response = await request(createApp())
      .post('/promotions')
      .set('Content-Type', 'application/json')
      .send('{"name":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request parameters',
        details: [{ field: 'body', message: 'Must contain valid JSON' }],
      },
    });
    expect(response.text).not.toContain('SyntaxError');
    expect(response.text).not.toContain('Unexpected');
  });

  it('returns sanitized 500 for unexpected errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.get('/boom', () => {
      throw Object.assign(
        new Error(
          'connect ECONNREFUSED postgresql://user:secret@localhost:5432/db redis://:hunter2@localhost:6379',
        ),
        {
          stack: 'Error: connect ECONNREFUSED\n    at /var/app/src/products/product.service.ts:1:1',
        },
      );
    });
    app.use(httpErrorHandler);

    const response = await request(app).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
      },
    });
    expect(response.text).not.toContain('postgresql://');
    expect(response.text).not.toContain('secret');
    expect(response.text).not.toContain('hunter2');
    expect(response.text).not.toContain('/var/app');
    expect(response.text).not.toContain('stack');
  });
});
