import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import { logger } from '../infrastructure/logger.js';
import { isProduction } from '../config/env.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
      requestId: req.requestId,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  let appError: AppError;

  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof ZodError) {
    appError = AppError.validation(
      'Request validation failed',
      error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    );
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      appError = AppError.conflict('A record with these details already exists');
    } else if (error.code === 'P2025') {
      appError = AppError.notFound('Resource not found');
    } else if (error.code === 'P2023' || error.code === 'P2024') {
      appError = AppError.badRequest('Invalid identifier or database operation');
    } else if (error.code === 'P2034') {
      appError = AppError.conflict('A concurrent operation won. Refresh and try again.');
    } else {
      appError = new AppError(500, 'INTERNAL_ERROR', 'A database error occurred');
    }
  } else if (error instanceof Prisma.PrismaClientValidationError) {
    appError = AppError.badRequest('Invalid database query');
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  ) {
    appError = AppError.badRequest('Malformed JSON body');
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.too.large'
  ) {
    appError = new AppError(413, 'BAD_REQUEST', 'Request body is too large');
  } else {
    appError = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }

  const status = appError.status;
  const log = req.log ?? logger;
  if (status >= 500) {
    log.error({ err: error, requestId: req.requestId }, 'Request failed');
  } else {
    log.warn({ requestId: req.requestId, code: appError.code, status }, appError.message);
  }

  const body = {
    error: {
      code: appError.code,
      message:
        status >= 500 && isProduction && !(error instanceof AppError)
          ? 'An unexpected error occurred'
          : appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      requestId: req.requestId,
    },
  };
  res.status(status).json(body);
};
