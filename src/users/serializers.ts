import type { Club, ClubMembership, PlayerProfile, User } from '@prisma/client';
import { toPublicDisplayName } from '@picklequeue/contracts';

export interface MembershipSummary {
  clubId: string;
  clubName: string;
  clubSlug: string;
  role: string;
  status: string;
  location: string | null;
}

export function toSelf(user: User, profile: PlayerProfile | null) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: Boolean(user.emailVerifiedAt),
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    platformRole: user.platformRole === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'USER',
    accountStatus: user.accountStatus ?? 'ACTIVE',
    activatedAt: user.activatedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    profile: profile
      ? {
          displayName: profile.displayName,
          skillRating: profile.skillRating,
          bio: profile.bio,
          avatarColor: profile.avatarColor,
        }
      : null,
  };
}

export function toMe(
  user: User,
  profile: PlayerProfile | null,
  memberships: Array<ClubMembership & { club: Club }>,
  csrfToken: string,
) {
  return {
    ...toSelf(user, profile),
    memberships: memberships
      .filter((membership) => membership.status === 'ACTIVE' && !membership.club.archivedAt)
      .map<MembershipSummary>((membership) => ({
        clubId: membership.clubId,
        clubName: membership.club.name,
        clubSlug: membership.club.slug,
        role: membership.role,
        status: membership.status,
        location: membership.club.location,
      })),
    csrfToken,
  };
}

export function toClubSummary(club: Club, viewerRole: string | null = null) {
  return {
    id: club.id,
    slug: club.slug,
    name: club.name,
    description: club.description,
    location: club.location,
    joinPolicy: club.joinPolicy,
    archived: Boolean(club.archivedAt),
    viewerRole,
  };
}

export function toPublicPlayer(displayName: string, skillRating: number) {
  return {
    name: toPublicDisplayName(displayName),
    skillRating,
  };
}
