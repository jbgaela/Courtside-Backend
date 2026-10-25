import { Prisma } from '@prisma/client';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { hashPassword } from '../security/password.js';
import { randomToken } from '../security/tokens.js';
import { revokeAllSessions } from '../auth/session.js';
import { revokeRegistrationSessions } from '../auth/registration-session.js';
import { accountStatusOf, platformRoleOf } from '../accounts/state.js';
import { issueClaimToken, issueRecoveryToken } from '../accounts/tokens.js';
import { writeAdminAudit } from './audit.js';
import { adminRegistrationSummary, adminUserDetail, adminUserSummary } from './serializers.js';
import type { Request } from 'express';

const userListInclude = {
  profile: true,
  registrationReview: true,
} satisfies Prisma.UserInclude;

const userDetailInclude = {
  profile: true,
  registrationReview: true,
  memberships: { include: { club: { select: { name: true, slug: true } } } },
  ownedClubs: { select: { id: true, name: true, slug: true, archivedAt: true } },
  accountClaimTokens: { orderBy: { createdAt: 'desc' }, take: 5 },
  accountRecoveryTokens: { orderBy: { createdAt: 'desc' }, take: 5 },
  adminAuditTargets: {
    include: {
      actor: { select: { id: true, name: true } },
      target: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  },
} satisfies Prisma.UserInclude;

async function getDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: userDetailInclude,
  });
  if (!user) throw AppError.notFound('User not found');
  return adminUserDetail(user);
}

async function assertNotLastSuperAdmin(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || platformRoleOf(user) !== 'SUPER_ADMIN') return;
  const count = await prisma.user.count({
    where: {
      platformRole: 'SUPER_ADMIN',
      accountStatus: 'ACTIVE',
      OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
    },
  });
  if (count <= 1) {
    throw AppError.conflict('The last active Super Admin cannot be removed or suspended');
  }
}

async function cleanupUserOperationalState(
  tx: Prisma.TransactionClient,
  userId: string,
  mode: 'PAUSE' | 'REMOVE',
) {
  const sessions = await tx.playSession.findMany({
    where: { status: { in: ['DRAFT', 'SCHEDULED', 'CHECK_IN_OPEN', 'LIVE'] } },
    select: { id: true },
  });
  if (sessions.length === 0) return [];
  const sessionIds = sessions.map((session) => session.id);
  await tx.queueEntry.updateMany({
    where: { sessionId: { in: sessionIds }, userId, state: { not: 'LEFT' } },
    data: {
      state: mode === 'REMOVE' ? 'LEFT' : 'PAUSED',
      ...(mode === 'REMOVE' ? { currentMatchId: null } : {}),
      version: { increment: 1 },
    },
  });
  await tx.sessionRegistration.updateMany({
    where: {
      sessionId: { in: sessionIds },
      userId,
      status: { in: ['PENDING', 'REGISTERED', 'CHECKED_IN'] },
    },
    data: { status: 'WITHDRAWN', respondedAt: new Date() },
  });
  await tx.playSession.updateMany({
    where: { id: { in: sessionIds } },
    data: { version: { increment: 1 } },
  });
  return tx.playSession.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, publicId: true, version: true },
  });
}

export async function listUsers(query: {
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
}) {
  const where: Prisma.UserWhereInput = {
    ...(query.status ? { accountStatus: query.status } : {}),
    ...(query.platformRole ? { platformRole: query.platformRole } : {}),
    ...(query.registrationStatus
      ? { registrationReview: { is: { status: query.registrationStatus } } }
      : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q } },
            { email: { contains: query.q } },
            { profile: { is: { displayName: { contains: query.q } } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: userListInclude,
      orderBy: [{ [query.sort]: query.direction }, { id: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.user.count({ where }),
  ]);
  return {
    items: items.map(adminUserSummary),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}

export async function getUser(userId: string) {
  return getDetail(userId);
}

export async function createUser(
  actorId: string,
  input: {
    name: string;
    email: string;
    displayName?: string;
    skillRating?: number;
    note?: string;
  },
  req: Request,
) {
  const now = new Date();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const randomPassword = randomToken(32);
      const passwordHash = await hashPassword(randomPassword);
      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          platformRole: 'USER',
          accountStatus: 'APPROVED_PENDING_ACTIVATION',
          emailVerifiedAt: null,
          profile: {
            create: {
              displayName: input.displayName ?? input.name,
              skillRating: input.skillRating ?? 3,
            },
          },
          skillRatings: {
            create: {
              value: input.skillRating ?? 3,
              source: 'SELF_REPORTED',
            },
          },
          registrationReview: {
            create: {
              status: 'APPROVED',
              submittedAt: now,
              reviewedAt: now,
              reviewedById: actorId,
              publicReason: 'Account created by a Super Admin',
              internalReason: input.note ?? null,
            },
          },
        },
      });
      const claim = await issueClaimToken(user.id, actorId, tx);
      await writeAdminAudit(
        {
          actorId,
          targetUserId: user.id,
          action: 'account.created',
          summary: 'Super Admin created an account',
          entityType: 'User',
          entityId: user.id,
          metadata: { note: input.note ?? null },
          req,
        },
        tx,
      );
      return { user, claim };
    });
    return {
      user: await getDetail(result.user.id),
      claimToken: result.claim.token,
      claimExpiresAt: result.claim.expiresAt.toISOString(),
      claimPath: `/claim-account?token=${encodeURIComponent(result.claim.token)}`,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw AppError.conflict('An account with this email already exists');
    }
    throw error;
  }
}

export async function updateUser(
  actorId: string,
  userId: string,
  input: {
    name?: string;
    displayName?: string;
    skillRating?: number;
    bio?: string | null;
    avatarColor?: string | null;
    note?: string;
  },
  req: Request,
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  if (accountStatusOf(user) === 'DELETED') {
    throw AppError.conflict('Restore the account before editing it');
  }
  await prisma.$transaction(async (tx) => {
    if (input.name !== undefined) {
      await tx.user.update({ where: { id: userId }, data: { name: input.name } });
    }
    await tx.playerProfile.update({
      where: { userId },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.name !== undefined && input.displayName === undefined
          ? { displayName: input.name }
          : {}),
        ...(input.skillRating !== undefined ? { skillRating: input.skillRating } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
      },
    });
    if (input.skillRating !== undefined) {
      await tx.skillRating.create({
        data: { userId, value: input.skillRating, source: 'ADMIN_VERIFIED', verifiedById: actorId },
      });
    }
    await writeAdminAudit(
      {
        actorId,
        targetUserId: userId,
        action: 'account.updated',
        summary: 'Super Admin updated an account',
        entityType: 'User',
        entityId: userId,
        metadata: { ...input, note: input.note ?? null },
        req,
      },
      tx,
    );
  });
  return getDetail(userId);
}

export async function suspendUser(
  actorId: string,
  userId: string,
  reason: string,
  req: Request,
) {
  await assertNotLastSuperAdmin(userId);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  if (accountStatusOf(user) === 'DELETED' || accountStatusOf(user) === 'SUSPENDED') {
    throw AppError.conflict('This account cannot be suspended from its current state');
  }
  const { sessions } = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { accountStatus: 'SUSPENDED' },
    });
    const changedSessions = await cleanupUserOperationalState(tx, userId, 'PAUSE');
    await writeAdminAudit(
      {
        actorId,
        targetUserId: userId,
        action: 'account.suspended',
        summary: 'Account suspended',
        entityType: 'User',
        entityId: userId,
        metadata: { reason },
        req,
      },
      tx,
    );
    return { sessions: changedSessions };
  });
  await revokeAllSessions(userId);
  await revokeRegistrationSessions(userId);
  return { user: await getDetail(userId), sessions };
}

export async function reactivateUser(actorId: string, userId: string, req: Request) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { registrationReview: true },
  });
  if (!user) throw AppError.notFound('User not found');
  if (accountStatusOf(user) !== 'SUSPENDED') {
    throw AppError.conflict('Only suspended accounts can be reactivated');
  }
  if (user.registrationReview?.status === 'REJECTED') {
    throw AppError.conflict('Reopen the registration review instead of reactivating');
  }
  if (user.registrationReview?.status === 'PENDING') {
    throw AppError.conflict('Complete the registration review before reactivating');
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { accountStatus: 'ACTIVE' } });
    await writeAdminAudit(
      {
        actorId,
        targetUserId: userId,
        action: 'account.reactivated',
        summary: 'Account reactivated',
        entityType: 'User',
        entityId: userId,
        req,
      },
      tx,
    );
  });
  return getDetail(userId);
}

export async function deleteUser(actorId: string, userId: string, reason: string, req: Request) {
  await assertNotLastSuperAdmin(userId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { ownedClubs: { where: { archivedAt: null }, select: { id: true, name: true } } },
  });
  if (!user) throw AppError.notFound('User not found');
  if (accountStatusOf(user) === 'DELETED') throw AppError.conflict('Account is already deleted');
  if (user.ownedClubs.length > 0) {
    throw AppError.conflict('Transfer ownership of active clubs before deleting this account');
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        accountStatus: 'DELETED',
        deletedAt: new Date(),
        platformRole: 'USER',
      },
    });
    await tx.clubMembership.updateMany({
      where: { userId, status: { not: 'LEFT' } },
      data: { status: 'LEFT', role: 'PLAYER' },
    });
    await cleanupUserOperationalState(tx, userId, 'REMOVE');
    await writeAdminAudit(
      {
        actorId,
        targetUserId: userId,
        action: 'account.deleted',
        summary: 'Account soft-deleted',
        entityType: 'User',
        entityId: userId,
        metadata: { reason },
        req,
      },
      tx,
    );
  });
  await revokeAllSessions(userId);
  await revokeRegistrationSessions(userId);
  return { deleted: true };
}

export async function restoreUser(actorId: string, userId: string, req: Request) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { registrationReview: true },
  });
  if (!user) throw AppError.notFound('User not found');
  if (accountStatusOf(user) !== 'DELETED') {
    throw AppError.conflict('Only deleted accounts can be restored');
  }
  if (user.registrationReview?.status === 'REJECTED') {
    throw AppError.conflict('A rejected registration must be reopened through the review workflow');
  }
  if (user.registrationReview?.status === 'PENDING') {
    throw AppError.conflict('A pending registration must be reviewed before the account is restored');
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        accountStatus: 'ACTIVE',
        deletedAt: null,
        platformRole: 'USER',
      },
    });
    await writeAdminAudit(
      {
        actorId,
        targetUserId: userId,
        action: 'account.restored',
        summary: 'Account restored',
        entityType: 'User',
        entityId: userId,
        req,
      },
      tx,
    );
  });
  return getDetail(userId);
}

export async function issueRecovery(actorId: string, userId: string, req: Request) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  if (accountStatusOf(user) === 'DELETED') throw AppError.conflict('Deleted accounts cannot be recovered');
  const token = await issueRecoveryToken(userId, actorId);
  await writeAdminAudit({
    actorId,
    targetUserId: userId,
    action: 'account.recovery_issued',
    summary: 'One-time recovery credential issued',
    entityType: 'User',
    entityId: userId,
    req,
  });
  return {
    token: token.token,
    expiresAt: token.expiresAt.toISOString(),
    path: `/recover-account?token=${encodeURIComponent(token.token)}`,
  };
}

export async function issueClaim(actorId: string, userId: string, req: Request) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  if (accountStatusOf(user) !== 'APPROVED_PENDING_ACTIVATION') {
    throw AppError.conflict('Only approved accounts awaiting activation can receive a claim link');
  }
  const token = await issueClaimToken(userId, actorId);
  await writeAdminAudit({
    actorId,
    targetUserId: userId,
    action: 'account.claim_issued',
    summary: 'New one-time account claim credential issued',
    entityType: 'User',
    entityId: userId,
    req,
  });
  return {
    token: token.token,
    expiresAt: token.expiresAt.toISOString(),
    path: `/claim-account?token=${encodeURIComponent(token.token)}`,
  };
}

export async function revokeUserSessions(actorId: string, userId: string, req: Request) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  await revokeAllSessions(userId);
  await revokeRegistrationSessions(userId);
  await writeAdminAudit({
    actorId,
    targetUserId: userId,
    action: 'account.sessions_revoked',
    summary: 'All account sessions revoked',
    entityType: 'User',
    entityId: userId,
    req,
  });
  return { revoked: true };
}

export async function overview() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [
    pendingRegistrations,
    activeUsers,
    suspendedUsers,
    newThisWeek,
    recentPending,
    recentAudit,
  ] = await Promise.all([
    prisma.registrationReview.count({ where: { status: 'PENDING' } }),
    prisma.user.count({
      where: { accountStatus: 'ACTIVE', OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
    }),
    prisma.user.count({ where: { accountStatus: 'SUSPENDED' } }),
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.registrationReview.findMany({
      where: { status: 'PENDING' },
      include: {
        user: { include: { profile: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
      orderBy: { submittedAt: 'desc' },
      take: 5,
    }),
    prisma.administrativeAuditEvent.findMany({
      include: {
        actor: { select: { id: true, name: true } },
        target: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);
  return {
    counts: {
      pendingRegistrations,
      activeUsers,
      suspendedUsers,
      newThisWeek,
    },
    recentPending: recentPending.map(adminRegistrationSummary),
    recentAudit: recentAudit.map((event) => ({
      id: event.id,
      action: event.action,
      outcome: event.outcome,
      summary: event.summary,
      actor: event.actor ? { id: event.actor.id, name: event.actor.name } : null,
      target: event.target ? { id: event.target.id, name: event.target.name } : null,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

export async function listAudit(query: {
  page: number;
  limit: number;
  q?: string;
  action?: string;
  outcome?: string;
  targetUserId?: string;
  actorId?: string;
  from?: string;
  to?: string;
}) {
  const where: Prisma.AdministrativeAuditEventWhereInput = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.outcome ? { outcome: query.outcome } : {}),
    ...(query.targetUserId ? { targetUserId: query.targetUserId } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { action: { contains: query.q } },
            { summary: { contains: query.q } },
            { actor: { is: { name: { contains: query.q } } } },
            { target: { is: { name: { contains: query.q } } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.administrativeAuditEvent.findMany({
      where,
      include: {
        actor: { select: { id: true, name: true } },
        target: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.administrativeAuditEvent.count({ where }),
  ]);
  return {
    items: items.map((event) => ({
      id: event.id,
      action: event.action,
      outcome: event.outcome,
      summary: event.summary,
      actor: event.actor ? { id: event.actor.id, name: event.actor.name } : null,
      target: event.target ? { id: event.target.id, name: event.target.name } : null,
      metadata: event.metadata,
      requestId: event.requestId,
      createdAt: event.createdAt.toISOString(),
    })),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}
