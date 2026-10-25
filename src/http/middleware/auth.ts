import type { RequestHandler } from 'express';
import { attachAuth, requireAuth, requireVerifiedEmail } from '../../auth/session.js';
import { AppError } from '../errors.js';
import { safeEqual } from '../../security/tokens.js';

export { requireAuth, requireVerifiedEmail } from '../../auth/session.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const withAuth: RequestHandler = (req, _res, next) => {
  void attachAuth(req)
    .then(() => next())
    .catch(next);
};

export const authenticated: RequestHandler = (req, _res, next) => {
  try {
    requireAuth(req);
    next();
  } catch (error) {
    next(error);
  }
};

export const emailVerified: RequestHandler = (req, _res, next) => {
  try {
    requireVerifiedEmail(req);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Synchronizer-token CSRF check for cookie-authenticated mutations.
 * Public auth endpoints are mounted before this guard.
 */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (!UNSAFE_METHODS.has(req.method) || !req.auth) {
    next();
    return;
  }
  const header = req.get('x-csrf-token');
  if (!header || !safeEqual(header, req.auth.session.csrfToken)) {
    next(new AppError(403, 'FORBIDDEN', 'Invalid or missing CSRF token'));
    return;
  }
  next();
};
