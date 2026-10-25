import { Router, type Router as ExpressRouter } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { authenticated, emailVerified, requireAuth } from '../http/middleware/auth.js';
import { sendData } from '../http/respond.js';
import { param } from '../http/params.js';
import { validateBody } from '../http/validate.js';
import { requestMetadata } from '../http/middleware/request-id.js';
import { withIdempotency } from '../http/idempotency.js';
import { withWriteConflictRetry } from '../http/transaction-retry.js';
import {
  completeMatchSchema,
  correctionSchema,
  scoreEventSchema,
  startMatchSchema,
  undoPointSchema,
} from './schemas.js';
import {
  completeMatch,
  correctMatch,
  getMatchDetail,
  getMatchEvents,
  recordPoint,
  startMatch,
  undoLastPoint,
} from './service.js';
import type { ScoreTeam } from '@picklequeue/contracts';

export const matchesRouter: ExpressRouter = Router();

matchesRouter.get(
  '/:matchId',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getMatchDetail(param(req, 'matchId'), auth.user.id));
  }),
);

matchesRouter.get(
  '/:matchId/events',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getMatchEvents(param(req, 'matchId'), auth.user.id));
  }),
);

matchesRouter.post(
  '/:matchId/start',
  authenticated,
  emailVerified,
  validateBody(startMatchSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await startMatch(param(req, 'matchId'), auth.user.id, req.body));
  }),
);

matchesRouter.post(
  '/:matchId/score-events',
  authenticated,
  emailVerified,
  validateBody(scoreEventSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const matchId = param(req, 'matchId');
    const key = req.get('idempotency-key') ?? req.body.idempotencyKey ?? null;
    const result = await withIdempotency({
      userId: auth.user.id,
      key,
      endpoint: `POST /matches/${matchId}/score-events`,
      request: req.body,
      action: async () => ({
        data: await recordPoint(matchId, auth.user.id, {
          team: req.body.team as ScoreTeam,
          expectedVersion: req.body.expectedVersion,
        }),
        statusCode: 201,
      }),
    });
    sendData(res, result.data, result.statusCode);
  }),
);

matchesRouter.post(
  '/:matchId/complete',
  authenticated,
  emailVerified,
  validateBody(completeMatchSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const matchId = param(req, 'matchId');
    const key = req.get('idempotency-key') ?? req.body.idempotencyKey ?? null;
    const result = await withIdempotency({
      userId: auth.user.id,
      key,
      endpoint: `POST /matches/${matchId}/complete`,
      request: req.body,
      action: async () => {
        const data = await withWriteConflictRetry(() =>
          completeMatch(
            matchId,
            auth.user.id,
            { expectedVersion: req.body.expectedVersion },
            requestMetadata(req),
          ),
        );
        return { data, statusCode: data.alreadyCompleted ? 200 : 201 };
      },
    });
    sendData(res, result.data, result.statusCode);
  }),
);

matchesRouter.post(
  '/:matchId/undo',
  authenticated,
  emailVerified,
  validateBody(undoPointSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(
      res,
      await undoLastPoint(param(req, 'matchId'), auth.user.id, {
        expectedVersion: req.body.expectedVersion,
      }),
    );
  }),
);

matchesRouter.post(
  '/:matchId/correction',
  authenticated,
  emailVerified,
  validateBody(correctionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const matchId = param(req, 'matchId');
    const result = await withIdempotency({
      userId: auth.user.id,
      key: req.get('idempotency-key') ?? null,
      endpoint: `POST /matches/${matchId}/correction`,
      request: req.body,
      action: async () => ({
        data: await withWriteConflictRetry(() =>
          correctMatch(matchId, auth.user.id, req.body, requestMetadata(req)),
        ),
      }),
    });
    sendData(res, result.data, result.statusCode);
  }),
);
