import { Router, type Router as ExpressRouter } from 'express';
import { authenticated } from '../http/middleware/auth.js';
import { requireAuth } from '../auth/session.js';
import {
  clearMfaCookie,
  clearRegistrationCookie,
  clearSessionCookie,
  setMfaCookie,
  setRegistrationCookie,
  setSessionCookie,
} from '../auth/cookies.js';
import { createAuthSession } from '../auth/session.js';
import { enableMfa, getMfaStatus, setupMfa, verifyMfaLogin } from '../auth/mfa.js';
import { isSuperAdmin } from '../accounts/state.js';
import { sendData } from '../http/respond.js';
import { asyncHandler } from '../http/async-handler.js';
import { authRateLimit } from '../http/middleware/rate-limit.js';
import { validateBody } from '../http/validate.js';
import { AppError } from '../http/errors.js';
import { revokeCurrentSession } from '../auth/session.js';
import {
  requireRegistration,
  requireRegistrationCsrf,
  revokeRegistrationSessions,
} from '../auth/registration-session.js';
import { writeAudit } from '../audit/audit.js';
import { prisma } from '../infrastructure/prisma.js';
import { requestMetadata } from '../http/middleware/request-id.js';
import {
  activateRegistrationSchema,
  claimAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaCodeSchema,
  reauthSchema,
  recoverAccountSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './schemas.js';
import {
  activateRegistration,
  claimAccount,
  getMe,
  getRegistrationStatus,
  loginUser,
  reauthenticate,
  recoverAccount,
  registerUser,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  verifyEmail,
} from './service.js';

export const authRouter: ExpressRouter = Router();

authRouter.post(
  '/register',
  authRateLimit,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await registerUser({ ...req.body, req });
    sendData(res, result, 201);
  }),
);

authRouter.post(
  '/login',
  authRateLimit,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const previousAuth = req.auth;
    const result = await loginUser({ ...req.body, req });
    // Session fixation defence: if a browser already has a valid session,
    // revoke it after the replacement session is created.
    if (previousAuth) await revokeCurrentSession(req);
    clearRegistrationCookie(res);
    if ('mfaRequired' in result) {
      clearSessionCookie(res);
      setMfaCookie(res, result.token);
      sendData(res, {
        mfaRequired: true,
        setupRequired: result.setupRequired,
        expiresAt: result.expiresAt.toISOString(),
      });
      return;
    }
    if (result.restricted) {
      clearSessionCookie(res);
      clearMfaCookie(res);
      setRegistrationCookie(res, result.token);
      sendData(res, {
        restricted: true,
        status: result.status,
        registration: result.registration,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt.toISOString(),
      });
      return;
    }
    clearMfaCookie(res);
    setSessionCookie(res, result.token);
    sendData(res, {
      restricted: false,
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt.toISOString(),
    });
  }),
);

authRouter.post(
  '/logout',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const metadata = requestMetadata(req);
    await revokeCurrentSession(req);
    clearSessionCookie(res);
    clearRegistrationCookie(res);
    clearMfaCookie(res);
    await writeAudit(prisma, {
      actorId: auth.user.id,
      action: 'user.signed_out',
      entityType: 'User',
      entityId: auth.user.id,
      summary: 'Signed out',
      ip: metadata.ip,
      userAgent: metadata.userAgent,
    });
    sendData(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const me = await getMe(auth.user.id, auth.session.csrfToken);
    sendData(res, me);
  }),
);

authRouter.post(
  '/reauth',
  authenticated,
  authRateLimit,
  validateBody(reauthSchema),
  asyncHandler(async (req, res) => {
    sendData(res, await reauthenticate(req, req.body.password));
  }),
);

authRouter.post(
  '/mfa/setup',
  authRateLimit,
  asyncHandler(async (req, res) => {
    sendData(res, await setupMfa(req));
  }),
);

authRouter.post(
  '/mfa/enable',
  authRateLimit,
  validateBody(mfaCodeSchema),
  asyncHandler(async (req, res) => {
    const result = await enableMfa(req, req.body.code);
    if (result.fromChallenge) {
      const metadata = requestMetadata(req);
      const session = await createAuthSession(result.user.id, metadata);
      setSessionCookie(res, session.token);
      clearMfaCookie(res);
      clearRegistrationCookie(res);
      const me = await getMe(result.user.id, session.csrfToken);
      sendData(res, {
        user: me,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt.toISOString(),
        mfaEnabled: true,
      });
      return;
    }
    sendData(res, { enabled: true });
  }),
);

authRouter.post(
  '/mfa/verify',
  authRateLimit,
  validateBody(mfaCodeSchema),
  asyncHandler(async (req, res) => {
    const result = await verifyMfaLogin(req, req.body.code);
    const metadata = requestMetadata(req);
    const session = await createAuthSession(result.user.id, metadata);
    setSessionCookie(res, session.token);
    clearMfaCookie(res);
    clearRegistrationCookie(res);
    const me = await getMe(result.user.id, session.csrfToken);
    sendData(res, {
      user: me,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    });
  }),
);

authRouter.get(
  '/mfa/status',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    if (!isSuperAdmin(auth.user)) throw AppError.forbidden('Super Admin access is required');
    sendData(res, await getMfaStatus(auth.user.id));
  }),
);

authRouter.get(
  '/registration-status',
  authRateLimit,
  asyncHandler(async (req, res) => {
    const registration = requireRegistration(req);
    sendData(res, getRegistrationStatus(registration));
  }),
);

authRouter.post(
  '/activate',
  authRateLimit,
  validateBody(activateRegistrationSchema),
  asyncHandler(async (req, res) => {
    const registration = requireRegistration(req);
    requireRegistrationCsrf(req, req.get('x-csrf-token'));
    const result = await activateRegistration(registration, req.body, req);
    setSessionCookie(res, result.token);
    clearRegistrationCookie(res);
    sendData(res, {
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt.toISOString(),
    });
  }),
);

authRouter.post(
  '/registration-logout',
  asyncHandler(async (req, res) => {
    if (req.registration) {
      requireRegistrationCsrf(req, req.get('x-csrf-token'));
      await revokeRegistrationSessions(req.registration.user.id);
    }
    clearRegistrationCookie(res);
    clearMfaCookie(res);
    sendData(res, { loggedOut: true });
  }),
);

authRouter.post(
  '/claim',
  authRateLimit,
  validateBody(claimAccountSchema),
  asyncHandler(async (req, res) => {
    const result = await claimAccount(req.body, req);
    setSessionCookie(res, result.token);
    clearRegistrationCookie(res);
    clearMfaCookie(res);
    sendData(res, {
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt.toISOString(),
    });
  }),
);

authRouter.post(
  '/recover',
  authRateLimit,
  validateBody(recoverAccountSchema),
  asyncHandler(async (req, res) => {
    const result = await recoverAccount(req.body, req);
    clearSessionCookie(res);
    clearRegistrationCookie(res);
    clearMfaCookie(res);
    sendData(res, result);
  }),
);

authRouter.post(
  '/verify-email',
  authRateLimit,
  validateBody(verifyEmailSchema),
  asyncHandler(async (req, res) => {
    const result = await verifyEmail(req.body.token);
    sendData(res, result);
  }),
);

authRouter.post(
  '/resend-verification',
  authRateLimit,
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await resendVerification(auth.user.id);
    sendData(res, {
      sent: true,
      devVerificationToken: result.devVerificationToken,
    });
  }),
);

authRouter.post(
  '/forgot-password',
  authRateLimit,
  validateBody(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const result = await requestPasswordReset(req.body.email);
    sendData(res, {
      sent: true,
      supportRequired: Boolean(result.supportRequired),
      devResetToken: result.devResetToken,
    });
  }),
);

authRouter.post(
  '/reset-password',
  authRateLimit,
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const result = await resetPassword(req.body.token, req.body.password);
    sendData(res, result);
  }),
);

authRouter.get('/csrf', authenticated, (req, res) => {
  const auth = requireAuth(req);
  sendData(res, { csrfToken: auth.session.csrfToken });
});

authRouter.use((_req, _res, next) => next(AppError.notFound('Auth endpoint not found')));
