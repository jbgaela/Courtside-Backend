import type {
  AccountClaimToken,
  AccountRecoveryToken,
  AdministrativeAuditEvent,
  ClubMembership,
  PlayerProfile,
  RegistrationReview,
  User,
  Club,
} from '@prisma/client';
import { accountStatusOf, platformRoleOf, registrationStatusOf } from '../accounts/state.js';

type ReviewWithUser = RegistrationReview & {
  user: User & { profile: PlayerProfile | null };
  reviewedBy: Pick<User, 'id' | 'name'> | null;
};

type UserWithContext = User & {
  profile: PlayerProfile | null;
  registrationReview: RegistrationReview | null;
};

export function adminRegistrationSummary(review: ReviewWithUser) {
  return {
    id: review.id,
    userId: review.userId,
    name: review.user.name,
    email: review.user.email,
    displayName: review.user.profile?.displayName ?? review.user.name,
    skillRating: review.user.profile?.skillRating ?? 3,
    status: review.status,
    submittedAt: review.submittedAt.toISOString(),
    reviewedAt: review.reviewedAt?.toISOString() ?? null,
    reviewedBy: review.reviewedBy
      ? { id: review.reviewedBy.id, name: review.reviewedBy.name }
      : null,
    publicReason: review.publicReason,
    version: review.version,
  };
}

export function adminRegistrationDetail(review: ReviewWithUser) {
  return {
    ...adminRegistrationSummary(review),
    internalReason: review.internalReason,
    accountStatus: accountStatusOf(review.user),
    platformRole: platformRoleOf(review.user),
    emailVerified: Boolean(review.user.emailVerifiedAt),
    createdAt: review.user.createdAt.toISOString(),
  };
}

export function adminUserSummary(user: UserWithContext) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    displayName: user.profile?.displayName ?? user.name,
    skillRating: user.profile?.skillRating ?? 3,
    platformRole: platformRoleOf(user),
    accountStatus: accountStatusOf(user),
    registrationStatus: registrationStatusOf(user.registrationReview),
    emailVerified: Boolean(user.emailVerifiedAt),
    activatedAt: user.activatedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}

type MembershipWithClub = ClubMembership & { club: Pick<Club, 'name' | 'slug'> };
type AuditWithNames = AdministrativeAuditEvent & {
  actor: Pick<User, 'id' | 'name'> | null;
  target: Pick<User, 'id' | 'name'> | null;
};

export function adminUserDetail(
  user: UserWithContext & {
    memberships: MembershipWithClub[];
    ownedClubs: Pick<Club, 'id' | 'name' | 'slug' | 'archivedAt'>[];
    accountClaimTokens: AccountClaimToken[];
    accountRecoveryTokens: AccountRecoveryToken[];
    adminAuditTargets: AuditWithNames[];
  },
) {
  const now = Date.now();
  return {
    ...adminUserSummary(user),
    termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
    profile: user.profile
      ? {
          displayName: user.profile.displayName,
          skillRating: user.profile.skillRating,
          bio: user.profile.bio,
          avatarColor: user.profile.avatarColor,
        }
      : null,
    registration: user.registrationReview
      ? {
          id: user.registrationReview.id,
          status: user.registrationReview.status,
          submittedAt: user.registrationReview.submittedAt.toISOString(),
          reviewedAt: user.registrationReview.reviewedAt?.toISOString() ?? null,
          publicReason: user.registrationReview.publicReason,
          internalReason: user.registrationReview.internalReason,
          version: user.registrationReview.version,
        }
      : null,
    memberships: user.memberships.map((membership) => ({
      id: membership.id,
      clubId: membership.clubId,
      clubName: membership.club.name,
      clubSlug: membership.club.slug,
      role: membership.role,
      status: membership.status,
    })),
    ownedClubs: user.ownedClubs.map((club) => ({
      id: club.id,
      name: club.name,
      slug: club.slug,
      archived: Boolean(club.archivedAt),
    })),
    claimPending: user.accountClaimTokens.some(
      (token) => !token.consumedAt && token.expiresAt.getTime() > now,
    ),
    recoveryPending: user.accountRecoveryTokens.some(
      (token) => !token.consumedAt && !token.revokedAt && token.expiresAt.getTime() > now,
    ),
    recentAudit: user.adminAuditTargets.map(adminAuditSummary),
  };
}

export function adminAuditSummary(event: AuditWithNames) {
  return {
    id: event.id,
    action: event.action,
    outcome: event.outcome,
    summary: event.summary,
    entityType: event.entityType,
    entityId: event.entityId,
    actor: event.actor ? { id: event.actor.id, name: event.actor.name } : null,
    target: event.target ? { id: event.target.id, name: event.target.name } : null,
    metadata: event.metadata,
    requestId: event.requestId,
    createdAt: event.createdAt.toISOString(),
  };
}
