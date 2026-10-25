import { Router, type Router as ExpressRouter } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { sendData } from '../http/respond.js';
import { param } from '../http/params.js';
import {
  getPublicClub,
  getPublicLiveMatches,
  getPublicResults,
  getPublicSession,
} from './service.js';

export const publicRouter: ExpressRouter = Router();

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
