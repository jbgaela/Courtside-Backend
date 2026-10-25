import { Router, type Router as ExpressRouter } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { authenticated, emailVerified, requireAuth } from '../http/middleware/auth.js';
import { sendData } from '../http/respond.js';
import { param } from '../http/params.js';
import { validateBody, validateQuery } from '../http/validate.js';
import { requestMetadata } from '../http/middleware/request-id.js';
import { rotationPreviewRateLimit } from '../http/middleware/rate-limit.js';
import {
  checkInSchema,
  createSessionSchema,
  publishSchema,
  qrCheckInSchema,
  queueActionSchema,
  registerSchema,
  registrationActionSchema,
  sessionCourtsSchema,
  sessionIdParamsSchema,
  sessionListQuerySchema,
  transitionSchema,
  updateSessionSchema,
} from './schemas.js';
import {
  createSession,
  getSessionDetail,
  getSessionPublicLink,
  listSessions,
  publishSession,
  transitionSession,
  updateSession,
  updateSessionCourts,
} from './service.js';
import {
  cancelRegistration,
  checkInPlayer,
  leaveSession,
  listRegistrations,
  qrCheckIn,
  queueSnapshot,
  registerForSession,
  registrationAction,
  setQueuePaused,
} from './participants.js';
import {
  cancelPreview,
  commitRotation,
  createPreview,
  getLatestRotation,
  overridePreviewPlayer,
} from '../matchmaking/service.js';
import {
  rotationCommitSchema,
  rotationPreviewSchema,
  rotationIdParamsSchema,
  rotationSwapSchema,
} from '../matchmaking/schemas.js';
import { getLiveSnapshot } from './live.js';
import { listSessionMatches } from '../matches/service.js';
import { matchListQuerySchema } from '../matches/schemas.js';

export const clubSessionsRouter: ExpressRouter = Router();

clubSessionsRouter.get(
  '/:clubId/sessions',
  authenticated,
  validateQuery(sessionListQuerySchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const query = req.validatedQuery as { status?: string; limit: number };
    sendData(res, await listSessions(param(req, 'clubId'), auth.user.id, query));
  }),
);

clubSessionsRouter.post(
  '/:clubId/sessions',
  authenticated,
  emailVerified,
  validateBody(createSessionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const session = await createSession(
      param(req, 'clubId'),
      auth.user.id,
      req.body,
      requestMetadata(req),
    );
    sendData(res, session, 201);
  }),
);

export const sessionsRouter: ExpressRouter = Router();

sessionsRouter.get(
  '/:sessionId',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getSessionDetail(param(req, 'sessionId'), auth.user.id));
  }),
);

sessionsRouter.patch(
  '/:sessionId',
  authenticated,
  emailVerified,
  validateBody(updateSessionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await updateSession(param(req, 'sessionId'), auth.user.id, req.body, requestMetadata(req)),
    );
  }),
);

sessionsRouter.post(
  '/:sessionId/status',
  authenticated,
  emailVerified,
  validateBody(transitionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await transitionSession(
        param(req, 'sessionId'),
        auth.user.id,
        req.body,
        requestMetadata(req),
      ),
    );
  }),
);

sessionsRouter.post(
  '/:sessionId/publish',
  authenticated,
  emailVerified,
  validateBody(publishSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await publishSession(
        param(req, 'sessionId'),
        auth.user.id,
        req.body.published,
        requestMetadata(req),
      ),
    );
  }),
);

sessionsRouter.get(
  '/:sessionId/public-link',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getSessionPublicLink(param(req, 'sessionId'), auth.user.id));
  }),
);

sessionsRouter.get(
  '/:sessionId/courts',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const detail = await getSessionDetail(param(req, 'sessionId'), auth.user.id);
    sendData(res, detail.courts);
  }),
);

sessionsRouter.put(
  '/:sessionId/courts',
  authenticated,
  emailVerified,
  validateBody(sessionCourtsSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await updateSessionCourts(
        param(req, 'sessionId'),
        auth.user.id,
        req.body,
        requestMetadata(req),
      ),
    );
  }),
);

sessionsRouter.post(
  '/:sessionId/register',
  authenticated,
  emailVerified,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await registerForSession(
        param(req, 'sessionId'),
        auth.user.id,
        req.body.note,
        requestMetadata(req),
      ),
      201,
    );
  }),
);

sessionsRouter.delete(
  '/:sessionId/register',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await cancelRegistration(
        param(req, 'sessionId'),
        auth.user.id,
        undefined,
        requestMetadata(req),
      ),
    );
  }),
);

sessionsRouter.get(
  '/:sessionId/registrations',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await listRegistrations(param(req, 'sessionId'), auth.user.id));
  }),
);

sessionsRouter.patch(
  '/:sessionId/registrations/:registrationId',
  authenticated,
  emailVerified,
  validateBody(registrationActionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await registrationAction(
        param(req, 'sessionId'),
        auth.user.id,
        param(req, 'registrationId'),
        req.body.action,
        req.body.reason,
        requestMetadata(req),
      ),
    );
  }),
);

sessionsRouter.post(
  '/:sessionId/checkins',
  authenticated,
  emailVerified,
  validateBody(checkInSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await checkInPlayer(param(req, 'sessionId'), auth.user.id, req.body, requestMetadata(req)),
    );
  }),
);

sessionsRouter.get(
  '/:sessionId/queue',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await queueSnapshot(param(req, 'sessionId'), auth.user.id));
  }),
);

sessionsRouter.post(
  '/:sessionId/queue/pause',
  authenticated,
  validateBody(queueActionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await setQueuePaused(
        param(req, 'sessionId'),
        auth.user.id,
        req.body,
        true,
        requestMetadata(req),
      ),
    );
  }),
);

sessionsRouter.post(
  '/:sessionId/queue/resume',
  authenticated,
  validateBody(queueActionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await setQueuePaused(
        param(req, 'sessionId'),
        auth.user.id,
        req.body,
        false,
        requestMetadata(req),
      ),
    );
  }),
);

sessionsRouter.post(
  '/:sessionId/leave',
  authenticated,
  validateBody(queueActionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await leaveSession(param(req, 'sessionId'), auth.user.id, req.body, requestMetadata(req)),
    );
  }),
);

sessionsRouter.get(
  '/:sessionId/live',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getLiveSnapshot(param(req, 'sessionId'), auth.user.id));
  }),
);

sessionsRouter.get(
  '/:sessionId/matches',
  authenticated,
  validateQuery(matchListQuerySchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const query = req.validatedQuery as { status?: string; limit: number };
    sendData(res, await listSessionMatches(param(req, 'sessionId'), auth.user.id, query));
  }),
);

sessionsRouter.get(
  '/:sessionId/results',
  authenticated,
  validateQuery(matchListQuerySchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const query = req.validatedQuery as { status?: string; limit: number };
    sendData(res, await listSessionMatches(param(req, 'sessionId'), auth.user.id, query, true));
  }),
);

sessionsRouter.get(
  '/:sessionId/rotations/latest',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getLatestRotation(param(req, 'sessionId'), auth.user.id));
  }),
);

sessionsRouter.post(
  '/:sessionId/rotations/preview',
  authenticated,
  emailVerified,
  rotationPreviewRateLimit,
  validateBody(rotationPreviewSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const preview = await createPreview(param(req, 'sessionId'), auth.user.id, req.body);
    sendData(res, preview, 201);
  }),
);

sessionsRouter.post(
  '/:sessionId/rotations/commit',
  authenticated,
  emailVerified,
  validateBody(rotationCommitSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const idempotencyKey = req.get('idempotency-key') ?? req.body.idempotencyKey ?? undefined;
    const result = await commitRotation(
      param(req, 'sessionId'),
      auth.user.id,
      {
        rotationId: req.body.rotationId,
        expectedSessionVersion: req.body.expectedSessionVersion,
        idempotencyKey,
      },
      requestMetadata(req),
    );
    sendData(res, result, result.alreadyCommitted ? 200 : 201);
  }),
);

sessionsRouter.patch(
  '/:sessionId/rotations/:rotationId/players',
  authenticated,
  emailVerified,
  validateBody(rotationSwapSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await overridePreviewPlayer(
        param(req, 'sessionId'),
        auth.user.id,
        param(req, 'rotationId'),
        req.body,
        requestMetadata(req),
      ),
    );
  }),
);

sessionsRouter.post(
  '/:sessionId/rotations/:rotationId/cancel',
  authenticated,
  emailVerified,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await cancelPreview(
        param(req, 'sessionId'),
        auth.user.id,
        param(req, 'rotationId'),
        requestMetadata(req),
      ),
    );
  }),
);

void rotationIdParamsSchema;

export const checkinsRouter: ExpressRouter = Router();

checkinsRouter.post(
  '/qr',
  authenticated,
  emailVerified,
  validateBody(qrCheckInSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await qrCheckIn(req.body.token, auth.user.id, requestMetadata(req)));
  }),
);

void sessionIdParamsSchema;
