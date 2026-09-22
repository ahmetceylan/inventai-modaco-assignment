export interface ErrorDetail {
  field: string;
  message: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message);
  }
}

export const validationError = (details: ErrorDetail[]): HttpError => {
  return new HttpError(400, 'VALIDATION_ERROR', 'Invalid request parameters', details);
};

export const isMalformedJsonError = (error: unknown): boolean => {
  return (
    error instanceof SyntaxError && 'status' in error && error.status === 400 && 'body' in error
  );
};
