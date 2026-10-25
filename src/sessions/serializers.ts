import type { Club, ClubMembership, PlaySession, SessionRegistration } from '@prisma/client';
import type { MatchmakingConfig, ScoringConfig } from '@picklequeue/contracts';
import { MATCHMAKING_DEFAULTS, SCORING_DEFAULTS } from '@picklequeue/contracts';

export function sessionDto(
  session: PlaySession & { club?: Club },
  viewer: {
    role: string | null;
    registration?: SessionRegistration | null;
    queueState?: string | null;
  },
  extras: {
    counts?: {
      registered: number;
      checkedIn: number;
      waiting: number;
      playing: number;
      pending: number;
      courts: number;
    };
    courts?: Array<{ id: string; name: string; status: string; sortOrder: number }>;
  } = {},
) {
  return {
    id: session.id,
    clubId: session.clubId,
    club: session.club
      ? { id: session.club.id, name: session.club.name, slug: session.club.slug }
      : undefined,
    publicId: session.publicId,
    name: session.name,
    description: session.description,
    venue: session.venue,
    startsAt: session.startsAt.toISOString(),
    endsAt: session.endsAt.toISOString(),
    timezone: session.timezone,
    status: session.status,
    capacity: session.capacity,
    format: session.format,
    registrationPolicy: session.registrationPolicy,
    checkInPolicy: session.checkInPolicy,
    published: session.published,
    allowLateArrivals: session.allowLateArrivals,
    matchmaking:
      (session.matchmakingConfig as unknown as MatchmakingConfig) ?? MATCHMAKING_DEFAULTS,
    scoring: (session.scoringConfig as unknown as ScoringConfig) ?? SCORING_DEFAULTS,
    version: session.version,
    startsAtTimestamp: session.startsAt.getTime(),
    checkInOpensAt: session.checkInOpensAt?.toISOString() ?? null,
    startedAt: session.startedAt?.toISOString() ?? null,
    completedAt: session.completedAt?.toISOString() ?? null,
    cancelledAt: session.cancelledAt?.toISOString() ?? null,
    cancelReason: session.cancelReason,
    createdAt: session.createdAt.toISOString(),
    viewerRole: viewer.role,
    viewerRegistration: viewer.registration
      ? {
          id: viewer.registration.id,
          status: viewer.registration.status,
          registeredAt: viewer.registration.registeredAt.toISOString(),
          checkedInAt: viewer.registration.checkedInAt?.toISOString() ?? null,
        }
      : null,
    viewerQueueState: viewer.queueState ?? null,
    ...extras.counts,
    courts: extras.courts ?? [],
  };
}

export function registrationDto(
  registration: SessionRegistration & {
    user: {
      id: string;
      name: string;
      email: string;
      profile: { displayName: string; skillRating: number } | null;
    };
  },
  queueState: string | null = null,
) {
  return {
    id: registration.id,
    userId: registration.userId,
    name: registration.user.name,
    email: registration.user.email,
    displayName: registration.user.profile?.displayName ?? registration.user.name,
    skillRating: registration.user.profile?.skillRating ?? 3,
    status: registration.status,
    registeredAt: registration.registeredAt.toISOString(),
    checkedInAt: registration.checkedInAt?.toISOString() ?? null,
    checkInMethod: registration.checkInMethod,
    queueState,
  };
}

export function membershipRole(membership: ClubMembership): string {
  return membership.role;
}
