import { Router, type Router as ExpressRouter } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { authenticated, emailVerified, requireAuth } from '../http/middleware/auth.js';
import { requestMetadata } from '../http/middleware/request-id.js';
import { validateBody, validateParams, validateQuery } from '../http/validate.js';
import { sendData } from '../http/respond.js';
import { param } from '../http/params.js';
import {
  acceptInvitationSchema,
  courtParamsSchema,
  createClubSchema,
  createCourtSchema,
  inviteSchema,
  joinClubSchema,
  listClubsQuerySchema,
  memberParamsSchema,
  transferOwnershipSchema,
  updateClubSchema,
  updateCourtSchema,
  updateMemberSchema,
} from './schemas.js';
import {
  acceptInvitation,
  archiveClub,
  createClub,
  createCourt,
  createInvitation,
  deactivateCourt,
  getClub,
  leaveClub,
  listAudit,
  listClubs,
  listCourts,
  listInvitations,
  listMembers,
  listClubRoles,
  removeMember,
  requestMembership,
  revokeInvitation,
  transferOwnership,
  updateClub,
  updateCourt,
  updateMember,
} from './service.js';

export const clubsRouter: ExpressRouter = Router();

clubsRouter.get(
  '/',
  validateQuery(listClubsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as { q?: string; limit: number };
    const clubs = await listClubs(query, req.auth?.user.id);
    sendData(res, clubs);
  }),
);

clubsRouter.post(
  '/',
  authenticated,
  emailVerified,
  validateBody(createClubSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const club = await createClub(auth.user.id, req.body, requestMetadata(req));
    sendData(res, club, 201);
  }),
);

clubsRouter.post(
  '/invitations/accept',
  authenticated,
  emailVerified,
  validateBody(acceptInvitationSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await acceptInvitation(
      auth.user.id,
      auth.user.email,
      req.body.token,
      requestMetadata(req),
    );
    sendData(res, result);
  }),
);

clubsRouter.get(
  '/:clubId',
  asyncHandler(async (req, res) => {
    const club = await getClub(param(req, 'clubId'), req.auth?.user.id);
    sendData(res, club);
  }),
);

clubsRouter.patch(
  '/:clubId',
  authenticated,
  emailVerified,
  validateBody(updateClubSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const club = await updateClub(
      param(req, 'clubId'),
      auth.user.id,
      req.body,
      requestMetadata(req),
    );
    sendData(res, club);
  }),
);

clubsRouter.get(
  '/:clubId/members',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const members = await listMembers(param(req, 'clubId'), auth.user.id);
    sendData(res, members);
  }),
);

clubsRouter.get(
  '/:clubId/roles',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    sendData(res, await listClubRoles(param(req, 'clubId'), auth.user.id));
  }),
);

clubsRouter.patch(
  '/:clubId/members/:membershipId',
  authenticated,
  emailVerified,
  validateParams(memberParamsSchema),
  validateBody(updateMemberSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const member = await updateMember(
      param(req, 'clubId'),
      auth.user.id,
      param(req, 'membershipId'),
      req.body,
      requestMetadata(req),
    );
    sendData(res, member);
  }),
);

clubsRouter.delete(
  '/:clubId/members/:membershipId',
  authenticated,
  emailVerified,
  validateParams(memberParamsSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await removeMember(
      param(req, 'clubId'),
      auth.user.id,
      param(req, 'membershipId'),
      requestMetadata(req),
    );
    sendData(res, result);
  }),
);

clubsRouter.post(
  '/:clubId/join',
  authenticated,
  emailVerified,
  validateBody(joinClubSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await requestMembership(
      param(req, 'clubId'),
      auth.user.id,
      requestMetadata(req),
    );
    sendData(res, result, 201);
  }),
);

clubsRouter.post(
  '/:clubId/leave',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await leaveClub(param(req, 'clubId'), auth.user.id, requestMetadata(req));
    sendData(res, result);
  }),
);

clubsRouter.post(
  '/:clubId/transfer',
  authenticated,
  emailVerified,
  validateBody(transferOwnershipSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const club = await transferOwnership(
      param(req, 'clubId'),
      auth.user.id,
      req.body.userId,
      requestMetadata(req),
    );
    sendData(res, club);
  }),
);

clubsRouter.post(
  '/:clubId/archive',
  authenticated,
  emailVerified,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await archiveClub(param(req, 'clubId'), auth.user.id, requestMetadata(req));
    sendData(res, result);
  }),
);

clubsRouter.get(
  '/:clubId/invitations',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const invitations = await listInvitations(param(req, 'clubId'), auth.user.id);
    sendData(res, invitations);
  }),
);

clubsRouter.post(
  '/:clubId/invitations',
  authenticated,
  emailVerified,
  validateBody(inviteSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await createInvitation(
      param(req, 'clubId'),
      auth.user.id,
      req.body,
      requestMetadata(req),
    );
    sendData(res, result, 201);
  }),
);

clubsRouter.delete(
  '/:clubId/invitations/:invitationId',
  authenticated,
  emailVerified,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await revokeInvitation(
      param(req, 'clubId'),
      auth.user.id,
      param(req, 'invitationId'),
    );
    sendData(res, result);
  }),
);

clubsRouter.get(
  '/:clubId/audit',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const events = await listAudit(param(req, 'clubId'), auth.user.id);
    sendData(res, events);
  }),
);

clubsRouter.get(
  '/:clubId/courts',
  authenticated,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const courts = await listCourts(param(req, 'clubId'), auth.user.id);
    sendData(res, courts);
  }),
);

clubsRouter.post(
  '/:clubId/courts',
  authenticated,
  emailVerified,
  validateBody(createCourtSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const court = await createCourt(
      param(req, 'clubId'),
      auth.user.id,
      req.body,
      requestMetadata(req),
    );
    sendData(res, court, 201);
  }),
);

clubsRouter.patch(
  '/:clubId/courts/:courtId',
  authenticated,
  emailVerified,
  validateParams(courtParamsSchema),
  validateBody(updateCourtSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const court = await updateCourt(
      param(req, 'clubId'),
      param(req, 'courtId'),
      auth.user.id,
      req.body,
      requestMetadata(req),
    );
    sendData(res, court);
  }),
);

clubsRouter.delete(
  '/:clubId/courts/:courtId',
  authenticated,
  emailVerified,
  validateParams(courtParamsSchema),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const result = await deactivateCourt(
      param(req, 'clubId'),
      param(req, 'courtId'),
      auth.user.id,
      requestMetadata(req),
    );
    sendData(res, result);
  }),
);
