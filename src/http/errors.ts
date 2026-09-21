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

export function validationError(details: ErrorDetail[]): HttpError {
  return new HttpError(400, 'VALIDATION_ERROR', 'Invalid request parameters', details);
}
