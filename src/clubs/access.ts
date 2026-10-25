import { ClubRole } from '@picklequeue/contracts';
import type { Club, ClubMembership } from '@prisma/client';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';

export interface ClubAccess {
  club: Club;
  membership: ClubMembership;
}

export const ADMIN_ROLES: ClubRole[] = ['OWNER', 'QUEUE_MASTER'];

export async function getClubAccess(
  clubId: string,
  userId: string,
  options: { roles?: ClubRole[]; allowArchived?: boolean } = {},
): Promise<ClubAccess> {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw AppError.notFound('Club not found');
  if (club.archivedAt && !options.allowArchived) {
    throw AppError.gone('This club has been archived');
  }
  const membership = await prisma.clubMembership.findUnique({
    where: { clubId_userId: { clubId, userId } },
  });
  if (!membership || membership.status !== 'ACTIVE') {
    throw AppError.forbidden('You do not have access to this club');
  }
  if (options.roles && !options.roles.includes(membership.role as ClubRole)) {
    throw AppError.forbidden('This action requires a club administrator role');
  }
  return { club, membership };
}

export async function getClubForAdmin(clubId: string, userId: string): Promise<ClubAccess> {
  return getClubAccess(clubId, userId, { roles: ADMIN_ROLES });
}

export async function getClubForOwner(clubId: string, userId: string): Promise<ClubAccess> {
  return getClubAccess(clubId, userId, { roles: ['OWNER'] });
}

export function isAdminRole(role: string): boolean {
  return role === 'OWNER' || role === 'QUEUE_MASTER';
}
