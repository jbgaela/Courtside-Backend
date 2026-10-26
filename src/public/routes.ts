import { Router, type Router as ExpressRouter } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { sendData } from '../http/respond.js';
import { param } from '../http/params.js';
import { validateBody } from '../http/validate.js';
import { guestJoinRateLimit, publicReadRateLimit } from '../http/middleware/rate-limit.js';
import {
  getPublicCheckIn,
  getPublicClub,
  getPublicLiveMatches,
  getPublicResults,
  getPublicSession,
} from './service.js';
import { getGuestStatusFromQr, joinGuestFromQr, leaveGuestFromQr } from './guests.js';
import { guestJoinSchema } from './schemas.js';

export const publicRouter: ExpressRouter = Router();

publicRouter.use(publicReadRateLimit);

publicRouter.get(
  '/checkins/:token',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await getPublicCheckIn(param(req, 'token')));
  }),
);

publicRouter.post(
  '/checkins/:token/guests',
  guestJoinRateLimit,
  validateBody(guestJoinSchema),
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const result = await joinGuestFromQr(param(req, 'token'), req.body, req, res);
    sendData(res, { created: result.created, ...result.status }, result.created ? 201 : 200);
  }),
);

publicRouter.get(
  '/checkins/:token/guest',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await getGuestStatusFromQr(param(req, 'token'), req, res));
  }),
);

publicRouter.post(
  '/checkins/:token/guest/leave',
  guestJoinRateLimit,
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await leaveGuestFromQr(param(req, 'token'), req));
  }),
);

publicRouter.get(
  '/sessions/:publicId',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await getPublicSession(param(req, 'publicId')));
  }),
);

publicRouter.get(
  '/sessions/:publicId/matches',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await getPublicLiveMatches(param(req, 'publicId')));
  }),
);

publicRouter.get(
  '/sessions/:publicId/results',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await getPublicResults(param(req, 'publicId')));
  }),
);

publicRouter.get(
  '/clubs/:slug',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await getPublicClub(param(req, 'slug')));
  }),
);
