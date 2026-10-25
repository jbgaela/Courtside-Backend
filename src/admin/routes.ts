import { Router, type Router as ExpressRouter } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { sendData } from '../http/respond.js';
import { param } from '../http/params.js';
import { requireSuperAdmin, requireDestructiveAdminReauth, superAdminOnly } from './access.js';
import {
  approvalSchema,
  createAdminUserSchema,
  recoveryRequestSchema,
  registrationListQuerySchema,
  rejectionSchema,
  reopenSchema,
  reviewParamsSchema,
  suspendUserSchema,
  updateAdminUserSchema,
  userListQuerySchema,
  userParamsSchema,
  adminAuditQuerySchema,
} from './schemas.js';
import { validateBody, validateParams, validateQuery } from '../http/validate.js';
import {
  approveRegistration,
  getRegistration,
  listRegistrations,
  registrationCounts,
  rejectRegistration,
  reopenRegistration,
} from './registrations.js';
import {
  createUser,
  deleteUser,
  getUser,
  issueClaim,
  issueRecovery,
  listAudit,
  listUsers,
  overview,
  reactivateUser,
  restoreUser,
  revokeUserSessions,
  suspendUser,
  updateUser,
} from './users.js';

export const adminRouter: ExpressRouter = Router();

adminRouter.use(superAdminOnly);

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    sendData(res, await overview());
  }),
);

adminRouter.get(
  '/registrations',
  validateQuery(registrationListQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as {
      page: number;
      limit: number;
      status?: string;
      q?: string;
      from?: string;
      to?: string;
    };
    sendData(res, await listRegistrations(query));
  }),
);

adminRouter.get(
  '/registrations/counts',
  asyncHandler(async (_req, res) => {
    sendData(res, await registrationCounts());
  }),
);

adminRouter.get(
  '/registrations/:registrationId',
  validateParams(reviewParamsSchema),
  asyncHandler(async (req, res) => {
    sendData(res, await getRegistration(param(req, 'registrationId')));
  }),
);

adminRouter.post(
  '/registrations/:registrationId/approve',
  validateParams(reviewParamsSchema),
  validateBody(approvalSchema),
  asyncHandler(async (req, res) => {
    const auth = requireSuperAdmin(req);
    const actorId = auth.user.id;
    sendData(
      res,
      await approveRegistration(
        actorId,
        param(req, 'registrationId'),
        req.body.expectedVersion,
        req.body.note,
        req,
      ),
    );
  }),
);

adminRouter.post(
  '/registrations/:registrationId/reject',
  validateParams(reviewParamsSchema),
  validateBody(rejectionSchema),
  asyncHandler(async (req, res) => {
    const auth = requireSuperAdmin(req);
    sendData(
      res,
      await rejectRegistration(
        auth.user.id,
        param(req, 'registrationId'),
        req.body.expectedVersion,
        {
          internalReason: req.body.internalReason,
          publicReason: req.body.publicReason,
        },
        req,
      ),
    );
  }),
);

adminRouter.post(
  '/registrations/:registrationId/reopen',
  validateParams(reviewParamsSchema),
  validateBody(reopenSchema),
  asyncHandler(async (req, res) => {
    const auth = requireSuperAdmin(req);
    sendData(
      res,
      await reopenRegistration(
        auth.user.id,
        param(req, 'registrationId'),
        req.body.expectedVersion,
        req.body.note,
        req,
      ),
    );
  }),
);

adminRouter.get(
  '/users',
  validateQuery(userListQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as {
      page: number;
      limit: number;
      q?: string;
      status?: string;
      registrationStatus?: string;
      platformRole?: string;
      sort: 'createdAt' | 'updatedAt' | 'name' | 'email';
      direction: 'asc' | 'desc';
      from?: string;
      to?: string;
    };
    sendData(res, await listUsers(query));
  }),
);

adminRouter.post(
  '/users',
  validateBody(createAdminUserSchema),
  asyncHandler(async (req, res) => {
    const auth = requireSuperAdmin(req);
    sendData(res, await createUser(auth.user.id, req.body, req), 201);
  }),
);

adminRouter.get(
  '/users/:userId',
  validateParams(userParamsSchema),
  asyncHandler(async (req, res) => {
    sendData(res, await getUser(param(req, 'userId')));
  }),
);

adminRouter.patch(
  '/users/:userId',
  validateParams(userParamsSchema),
  validateBody(updateAdminUserSchema),
  asyncHandler(async (req, res) => {
    const auth = requireSuperAdmin(req);
    sendData(res, await updateUser(auth.user.id, param(req, 'userId'), req.body, req));
  }),
);

adminRouter.post(
  '/users/:userId/suspend',
  validateParams(userParamsSchema),
  validateBody(suspendUserSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await suspendUser(auth.user.id, param(req, 'userId'), req.body.reason, req));
  }),
);

adminRouter.post(
  '/users/:userId/reactivate',
  validateParams(userParamsSchema),
  asyncHandler(async (req, res) => {
    const auth = requireSuperAdmin(req);
    sendData(res, await reactivateUser(auth.user.id, param(req, 'userId'), req));
  }),
);

adminRouter.delete(
  '/users/:userId',
  validateParams(userParamsSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 500)
        : 'Administrative deletion';
    sendData(res, await deleteUser(auth.user.id, param(req, 'userId'), reason, req));
  }),
);

adminRouter.post(
  '/users/:userId/restore',
  validateParams(userParamsSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await restoreUser(auth.user.id, param(req, 'userId'), req));
  }),
);

adminRouter.post(
  '/users/:userId/claim',
  validateParams(userParamsSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await issueClaim(auth.user.id, param(req, 'userId'), req));
  }),
);

adminRouter.post(
  '/users/:userId/recovery',
  validateParams(userParamsSchema),
  validateBody(recoveryRequestSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await issueRecovery(auth.user.id, param(req, 'userId'), req));
  }),
);

adminRouter.post(
  '/users/:userId/revoke-sessions',
  validateParams(userParamsSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await revokeUserSessions(auth.user.id, param(req, 'userId'), req));
  }),
);

adminRouter.get(
  '/audit-logs',
  validateQuery(adminAuditQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as {
      page: number;
      limit: number;
      q?: string;
      action?: string;
      outcome?: string;
      targetUserId?: string;
      actorId?: string;
      from?: string;
      to?: string;
    };
    sendData(res, await listAudit(query));
  }),
);
