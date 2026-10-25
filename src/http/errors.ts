import type { ApiErrorDetail } from '@picklequeue/contracts';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GONE'
  | 'RATE_LIMITED'
  | 'UNPROCESSABLE'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: ApiErrorDetail[]): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static validation(message = 'Request validation failed', details?: ApiErrorDetail[]): AppError {
    return new AppError(422, 'VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string): AppError {
    return new AppError(409, 'CONFLICT', message);
  }

  static gone(message: string): AppError {
    return new AppError(410, 'GONE', message);
  }

  static rateLimited(message = 'Too many requests'): AppError {
    return new AppError(429, 'RATE_LIMITED', message);
  }

  static unprocessable(message: string, details?: ApiErrorDetail[]): AppError {
    return new AppError(422, 'UNPROCESSABLE', message, details);
  }

  static unavailable(message = 'Service temporarily unavailable'): AppError {
    return new AppError(503, 'SERVICE_UNAVAILABLE', message);
  }
}
