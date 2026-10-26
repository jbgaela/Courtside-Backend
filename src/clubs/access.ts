import { ClubRole } from '@picklequeue/contracts';
import type { Club, ClubMembership, Role } from '@prisma/client';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';

export interface ClubAccess {
  club: Club;
  membership: ClubMembership & { roleRef: Role | null };
  permissions: string[];
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
    include: { roleRef: true },
  });
  if (!membership || membership.status !== 'ACTIVE') {
    throw AppError.forbidden('You do not have access to this club');
  }
  if (options.roles && !options.roles.includes(membership.role as ClubRole)) {
    throw AppError.forbidden('This action requires a club administrator role');
  }
  return {
    club,
    membership,
    permissions: membership.roleRef?.permissions ?? [],
  };
}

export function hasClubPermission(
  access: Pick<ClubAccess, 'permissions' | 'membership'>,
  permission: string,
): boolean {
  // Owners must always retain the full club capability even if a role record
  // is temporarily unavailable during an additive deployment.
  if (access.membership.role === 'OWNER') return true;
  return access.permissions.includes(permission);
}

export function requireClubPermission(access: ClubAccess, permission: string): void {
  if (!hasClubPermission(access, permission)) {
    throw AppError.forbidden('You do not have permission to perform this action');
  }
}

export async function getClubForPermission(
  clubId: string,
  userId: string,
  permission: string,
): Promise<ClubAccess> {
  const access = await getClubAccess(clubId, userId);
  requireClubPermission(access, permission);
  return access;
}

export async function getClubForAdmin(clubId: string, userId: string): Promise<ClubAccess> {
  return getClubForPermission(clubId, userId, 'club.manage');
}

export async function getClubForOwner(clubId: string, userId: string): Promise<ClubAccess> {
  return getClubAccess(clubId, userId, { roles: ['OWNER'] });
}

export function isAdminRole(role: string): boolean {
  return role === 'OWNER' || role === 'QUEUE_MASTER';
}
