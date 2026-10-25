import type { Request, RequestHandler } from 'express';
import { requireAuth } from '../auth/session.js';
import { requireRecentReauth } from '../http/middleware/auth.js';
import { isSuperAdmin } from '../accounts/state.js';
import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { writeAdminAudit } from './audit.js';

export function requireSuperAdmin(req: Request) {
  const auth = requireAuth(req);
  if (!isSuperAdmin(auth.user)) {
    throw AppError.forbidden('Super Admin access is required');
  }
  if (env.REQUIRE_SUPER_ADMIN_MFA && !auth.user.mfaEnabled) {
    throw AppError.forbidden('Set up Super Admin MFA before accessing platform administration');
  }
  return auth;
}

export const superAdminOnly: RequestHandler = (req, _res, next) => {
  try {
    requireSuperAdmin(req);
    next();
  } catch (error) {
    if (req.auth) {
      const action =
        error instanceof AppError && error.message.toLowerCase().includes('mfa')
          ? 'admin.mfa_required'
          : 'admin.access_denied';
      void writeAdminAudit({
        actorId: req.auth.user.id,
        targetUserId: req.auth.user.id,
        action,
        outcome: 'DENIED',
        summary:
          error instanceof AppError ? error.message : 'Platform administration access denied',
        req,
      }).catch(() => undefined);
    }
    next(error);
  }
};

export function requireDestructiveAdminReauth(req: Request): void {
  requireSuperAdmin(req);
  requireRecentReauth(req);
}
