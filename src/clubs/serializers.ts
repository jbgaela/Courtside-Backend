import type {
  Club,
  ClubInvitation,
  ClubMembership,
  Court,
  PlayerProfile,
  User,
} from '@prisma/client';
import { toPublicDisplayName } from '@picklequeue/contracts';

export function clubDto(club: Club, extras: Record<string, unknown> = {}) {
  return {
    id: club.id,
    slug: club.slug,
    name: club.name,
    description: club.description,
    location: club.location,
    joinPolicy: club.joinPolicy,
    version: club.version,
    archived: Boolean(club.archivedAt),
    createdAt: club.createdAt.toISOString(),
    ...extras,
  };
}

export function membershipDto(
  membership: ClubMembership & {
    user: User & { profile: PlayerProfile | null };
    roleRef?: { name: string } | null;
  },
  options: { includeEmail: boolean },
) {
  return {
    id: membership.id,
    userId: membership.userId,
    name: membership.user.name,
    ...(options.includeEmail ? { email: membership.user.email } : {}),
    displayName: membership.user.profile?.displayName ?? membership.user.name,
    skillRating: membership.user.profile?.skillRating ?? 3,
    role: membership.role,
    roleName: membership.roleRef?.name ?? membership.role,
    status: membership.status,
    joinedAt: membership.joinedAt?.toISOString() ?? null,
    createdAt: membership.createdAt.toISOString(),
  };
}

export function invitationDto(invitation: ClubInvitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
  };
}

export function courtDto(court: Court) {
  return {
    id: court.id,
    clubId: court.clubId,
    name: court.name,
    status: court.status,
    sortOrder: court.sortOrder,
    createdAt: court.createdAt.toISOString(),
    updatedAt: court.updatedAt.toISOString(),
  };
}

export function publicCourtDto(court: Pick<Court, 'id' | 'name' | 'status' | 'sortOrder'>) {
  return {
    id: court.id,
    name: court.name,
    status: court.status,
    sortOrder: court.sortOrder,
  };
}

export function publicMemberName(name: string): string {
  return toPublicDisplayName(name);
}
