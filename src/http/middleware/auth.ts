import type { Request, RequestHandler } from 'express';
import { attachAuth, requireAuth, requireVerifiedEmail } from '../../auth/session.js';
import { attachRegistration } from '../../auth/registration-session.js';
import { attachMfa } from '../../auth/mfa.js';
import { env } from '../../config/env.js';
import { AppError } from '../errors.js';
import { safeEqual } from '../../security/tokens.js';

export { requireAuth, requireVerifiedEmail } from '../../auth/session.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const withAuth: RequestHandler = (req, _res, next) => {
  void attachAuth(req)
    .then(() => next())
    .catch(next);
};

export const withRegistrationAuth: RequestHandler = (req, _res, next) => {
  void attachRegistration(req)
    .then(() => next())
    .catch(next);
};

export const withMfaAuth: RequestHandler = (req, _res, next) => {
  void attachMfa(req)
    .then(() => next())
    .catch(next);
};

export function requireRecentReauth(req: Request): void {
  const auth = requireAuth(req);
  const reauthenticatedAt = auth.session.reauthenticatedAt;
  if (
    !reauthenticatedAt ||
    Date.now() - reauthenticatedAt.getTime() > env.ADMIN_REAUTH_MINUTES * 60 * 1000
  ) {
    throw AppError.forbidden('Confirm your password again before performing this action');
  }
}

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
