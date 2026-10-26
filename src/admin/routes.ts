import { Router, type Router as ExpressRouter } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { sendData } from '../http/respond.js';
import { param } from '../http/params.js';
import { requireSuperAdmin, requireDestructiveAdminReauth, superAdminOnly } from './access.js';
import {
  adminAuditQuerySchema,
  approvalSchema,
  assignRoleSchema,
  createAdminUserSchema,
  createRoleSchema,
  membershipParamsSchema,
  recoveryRequestSchema,
  registrationListQuerySchema,
  rejectionSchema,
  reopenSchema,
  reviewParamsSchema,
  roleListQuerySchema,
  roleParamsSchema,
  suspendUserSchema,
  updateAdminUserSchema,
  updateRoleSchema,
  userListQuerySchema,
  userParamsSchema,
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
import {
  archiveRole,
  assignRole,
  createRole,
  duplicateRole,
  getPermissionCatalog,
  getPermissionMatrix,
  getRoleDetail,
  getRolesForUser,
  listRoles,
  removeRoleAssignment,
  updateRole,
} from './roles.js';

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
  '/roles/catalog',
  asyncHandler(async (_req, res) => {
    sendData(res, await getPermissionCatalog());
  }),
);

adminRouter.get(
  '/roles/matrix',
  asyncHandler(async (_req, res) => {
    sendData(res, await getPermissionMatrix());
  }),
);

adminRouter.get(
  '/roles',
  validateQuery(roleListQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as { q?: string; scope?: string };
    sendData(res, await listRoles(query));
  }),
);

adminRouter.post(
  '/roles',
  validateBody(createRoleSchema),
  asyncHandler(async (req, res) => {
    const auth = requireSuperAdmin(req);
    sendData(res, await createRole(req.body, auth.user.id, req), 201);
  }),
);

adminRouter.get(
  '/roles/:roleId',
  validateParams(roleParamsSchema),
  asyncHandler(async (req, res) => {
    sendData(res, await getRoleDetail(param(req, 'roleId')));
  }),
);

adminRouter.patch(
  '/roles/:roleId',
  validateParams(roleParamsSchema),
  validateBody(updateRoleSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await updateRole(param(req, 'roleId'), req.body, auth.user.id, req));
  }),
);

adminRouter.post(
  '/roles/:roleId/duplicate',
  validateParams(roleParamsSchema),
  asyncHandler(async (req, res) => {
    const auth = requireSuperAdmin(req);
    sendData(res, await duplicateRole(param(req, 'roleId'), auth.user.id, req), 201);
  }),
);

adminRouter.delete(
  '/roles/:roleId',
  validateParams(roleParamsSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await archiveRole(param(req, 'roleId'), auth.user.id, req));
  }),
);

adminRouter.get(
  '/users/:userId/club-roles',
  validateParams(userParamsSchema),
  asyncHandler(async (req, res) => {
    sendData(res, await getRolesForUser(param(req, 'userId')));
  }),
);

adminRouter.post(
  '/roles/assign',
  validateBody(assignRoleSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await assignRole(req.body, auth.user.id, req), 201);
  }),
);

adminRouter.delete(
  '/roles/assignments/:membershipId',
  validateParams(membershipParamsSchema),
  asyncHandler(async (req, res) => {
    requireDestructiveAdminReauth(req);
    const auth = requireSuperAdmin(req);
    sendData(res, await removeRoleAssignment(param(req, 'membershipId'), auth.user.id, req));
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
