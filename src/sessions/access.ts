import type { Club, ClubMembership, PlaySession, Role } from '@prisma/client';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { hasClubPermission } from '../clubs/access.js';
import type { ClubRole } from '@picklequeue/contracts';

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export interface SessionAccess {
  session: PlaySession & { club: Club };
  membership: ClubMembership & { roleRef: Role | null };
  permissions: string[];
}

export async function getSessionAccess(
  sessionId: string,
  userId: string,
  options: { roles?: ClubRole[] } = {},
): Promise<SessionAccess> {
  if (!OBJECT_ID.test(sessionId)) throw AppError.notFound('Session not found');
  const session = await prisma.playSession.findUnique({
    where: { id: sessionId },
    include: { club: true },
  });
  if (!session) throw AppError.notFound('Session not found');
  if (session.club.archivedAt) throw AppError.gone('This club has been archived');
  const membership = await prisma.clubMembership.findUnique({
    where: { clubId_userId: { clubId: session.clubId, userId } },
    include: { roleRef: true },
  });
  if (!membership || membership.status !== 'ACTIVE') {
    throw AppError.forbidden('You do not have access to this session');
  }
  if (options.roles && !options.roles.includes(membership.role as ClubRole)) {
    throw AppError.forbidden('This action requires a club administrator role');
  }
  return {
    session,
    membership,
    permissions: membership.roleRef?.permissions ?? [],
  };
}

export function hasSessionPermission(access: SessionAccess, permission: string): boolean {
  return hasClubPermission(access, permission);
}

export function requireSessionPermission(access: SessionAccess, permission: string): void {
  if (!hasClubPermission(access, permission)) {
    throw AppError.forbidden('You do not have permission to perform this action');
  }
}

export async function getSessionForPermission(
  sessionId: string,
  userId: string,
  permission: string,
): Promise<SessionAccess> {
  const access = await getSessionAccess(sessionId, userId);
  requireSessionPermission(access, permission);
  return access;
}

export async function getSessionForAdmin(
  sessionId: string,
  userId: string,
  permission = 'sessions.manage',
): Promise<SessionAccess> {
  return getSessionForPermission(sessionId, userId, permission);
}

export async function getSessionByCheckInToken(token: string) {
  const session = await prisma.playSession.findUnique({
    where: { checkInToken: token },
    include: { club: true },
  });
  if (!session || session.club.archivedAt) throw AppError.notFound('Check-in link is invalid');
  return session;
}
