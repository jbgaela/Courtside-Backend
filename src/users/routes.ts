import { Router, type Router as ExpressRouter } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { authenticated, requireAuth } from '../http/middleware/auth.js';
import { sendData } from '../http/respond.js';
import { param } from '../http/params.js';
import { validateBody, validateParams, validateQuery } from '../http/validate.js';
import { notificationParamsSchema, paginationQuerySchema, updateProfileSchema } from './schemas.js';
import {
  getMatchHistory,
  getProfile,
  getStats,
  getUpcoming,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  updateProfile,
} from './service.js';

export const usersRouter: ExpressRouter = Router();

usersRouter.get(
  '/me/profile',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getProfile(auth.user.id));
  }),
);

usersRouter.patch(
  '/me/profile',
  authenticated,
  validateBody(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await updateProfile(auth.user.id, req.body));
  }),
);

usersRouter.get(
  '/me/stats',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getStats(auth.user.id));
  }),
);

usersRouter.get(
  '/me/matches',
  authenticated,
  validateQuery(paginationQuerySchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const query = req.validatedQuery as { limit: number; cursor?: string };
    sendData(res, await getMatchHistory(auth.user.id, query));
  }),
);

usersRouter.get(
  '/me/upcoming',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await getUpcoming(auth.user.id));
  }),
);

usersRouter.get(
  '/me/notifications',
  authenticated,
  validateQuery(paginationQuerySchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const query = req.validatedQuery as { limit: number };
    sendData(res, await listNotifications(auth.user.id, query.limit));
  }),
);

usersRouter.patch(
  '/me/notifications/:notificationId',
  authenticated,
  validateParams(notificationParamsSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await markNotificationRead(auth.user.id, param(req, 'notificationId')));
  }),
);

usersRouter.post(
  '/me/notifications/read-all',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await markAllNotificationsRead(auth.user.id));
  }),
);
