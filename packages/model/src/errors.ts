// @openrai/model — Custom error classes for RaiFlow

export type ErrorCode =
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'unauthorized'
  | 'internal_error';

export class RaiFlowError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode = 'internal_error',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RaiFlowError';
  }

  static notFound(resource: string, id: string): RaiFlowError {
    return new RaiFlowError(`${resource} not found: ${id}`, 'not_found');
  }

  static conflict(message: string): RaiFlowError {
    return new RaiFlowError(message, 'conflict');
  }

  static badRequest(message: string): RaiFlowError {
    return new RaiFlowError(message, 'bad_request');
  }

  static unauthorized(message: string): RaiFlowError {
    return new RaiFlowError(message, 'unauthorized');
  }

  static internal(message: string, cause?: unknown): RaiFlowError {
    return new RaiFlowError(message, 'internal_error', cause);
  }
}

export class StorageError extends RaiFlowError {
  constructor(message: string, cause?: unknown) {
    super(message, 'internal_error', cause);
    this.name = 'StorageError';
  }
}

export class CustodyError extends RaiFlowError {
  constructor(message: string, cause?: unknown) {
    super(message, 'internal_error', cause);
    this.name = 'CustodyError';
  }
}

export function isErrorWithCode(error: unknown): error is RaiFlowError {
  return error instanceof RaiFlowError;
}

export function getErrorCode(error: unknown): ErrorCode {
  if (isErrorWithCode(error)) return error.code;
  return 'internal_error';
}