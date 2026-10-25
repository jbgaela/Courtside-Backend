import { Router, type Router as ExpressRouter } from 'express';
import { authenticated } from '../http/middleware/auth.js';
import { requireAuth } from '../auth/session.js';
import { clearSessionCookie, setSessionCookie } from '../auth/cookies.js';
import { sendData } from '../http/respond.js';
import { asyncHandler } from '../http/async-handler.js';
import { authRateLimit } from '../http/middleware/rate-limit.js';
import { validateBody } from '../http/validate.js';
import { AppError } from '../http/errors.js';
import { revokeCurrentSession } from '../auth/session.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './schemas.js';
import {
  getMe,
  loginUser,
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
    setSessionCookie(res, result.token);
    sendData(
      res,
      {
        user: result.user,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt.toISOString(),
        devVerificationToken: result.devVerificationToken,
      },
      201,
    );
  }),
);

authRouter.post(
  '/login',
  authRateLimit,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await loginUser({ ...req.body, req });
    setSessionCookie(res, result.token);
    sendData(res, {
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
    await revokeCurrentSession(req);
    clearSessionCookie(res);
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
    sendData(res, { sent: true, devResetToken: result.devResetToken });
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
