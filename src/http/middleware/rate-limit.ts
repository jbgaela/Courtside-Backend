import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../errors.js';

function handler(message: string): RequestHandler {
  return (req, res) => {
    const requestId = req.requestId;
    const error = AppError.rateLimited(message);
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        requestId,
      },
    });
  };
}

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.RATE_LIMIT_DISABLED,
  handler: handler('Too many authentication attempts. Try again later.'),
});

export const generalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.RATE_LIMIT_DISABLED,
  handler: handler('Too many requests. Slow down.'),
});

export const writeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.RATE_LIMIT_DISABLED,
  handler: handler('Too many write requests. Slow down.'),
});
