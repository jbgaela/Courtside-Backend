import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from './errors.js';

type RequestPart = 'body' | 'query' | 'params';

function formatIssues(error: ZodErrorLike) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

interface ZodErrorLike {
  issues: Array<{ path: PropertyKey[]; message: string; code: string }>;
}

export function validate(part: RequestPart, schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      next(AppError.validation('Request validation failed', formatIssues(result.error)));
      return;
    }
    if (part === 'body') req.body = result.data;
    if (part === 'query') {
      Object.defineProperty(req, 'validatedQuery', { value: result.data, writable: true });
    }
    if (part === 'params') {
      Object.defineProperty(req, 'validatedParams', { value: result.data, writable: true });
    }
    next();
  };
}

export const validateBody = (schema: ZodType): RequestHandler => validate('body', schema);
export const validateQuery = (schema: ZodType): RequestHandler => validate('query', schema);
export const validateParams = (schema: ZodType): RequestHandler => validate('params', schema);
