import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Enumerations shared by API, web and domain packages                 */
/* ------------------------------------------------------------------ */

export const PLATFORM_ROLES = ['USER', 'SUPER_ADMIN'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ACCOUNT_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED_PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
  'DELETED',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const REGISTRATION_REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type RegistrationReviewStatus = (typeof REGISTRATION_REVIEW_STATUSES)[number];

export const PARTICIPANT_TYPES = ['REGISTERED', 'GUEST'] as const;
export type ParticipantType = (typeof PARTICIPANT_TYPES)[number];

export const GUEST_GENDERS = ['MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY'] as const;
export type GuestGender = (typeof GUEST_GENDERS)[number];

export const GUEST_GENDER_LABELS: Record<GuestGender, string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  NON_BINARY: 'Non-binary',
  PREFER_NOT_TO_SAY: 'Prefer not to say',
};
export const CLUB_ROLES = ['OWNER', 'QUEUE_MASTER', 'PLAYER'] as const;
export type ClubRole = (typeof CLUB_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'LEFT'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const SESSION_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'CHECK_IN_OPEN',
  'LIVE',
  'COMPLETED',
  'CANCELLED',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  DRAFT: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['CHECK_IN_OPEN', 'CANCELLED'],
  CHECK_IN_OPEN: ['LIVE', 'CANCELLED'],
  LIVE: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const REGISTRATION_STATUSES = [
  'PENDING',
  'REGISTERED',
  'CHECKED_IN',
  'WITHDRAWN',
  'REJECTED',
  'NO_SHOW',
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const CLUB_JOIN_POLICIES = ['OPEN', 'APPROVAL', 'INVITE_ONLY'] as const;
export type ClubJoinPolicy = (typeof CLUB_JOIN_POLICIES)[number];

export const QUEUE_STATES = [
  'WAITING',
  'RESERVED',
  'PLAYING',
  'RESTING',
  'PAUSED',
  'LEFT',
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export const MATCH_STATUSES = [
  'PROPOSED',
  'RESERVED',
  'READY',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'CORRECTED',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const ROTATION_STATUSES = [
  'PREVIEW',
  'COMMITTED',
  'SUPERSEDED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type RotationStatus = (typeof ROTATION_STATUSES)[number];

export const ASSIGNMENT_STATUSES = ['PROPOSED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const MATCH_FORMATS = ['SINGLES', 'DOUBLES'] as const;
export type MatchFormat = (typeof MATCH_FORMATS)[number];

export const MATCHMAKING_STRATEGIES = ['HYBRID', 'SKILL_FIRST', 'FAIRNESS_FIRST'] as const;
export type MatchmakingStrategy = (typeof MATCHMAKING_STRATEGIES)[number];

export const REGISTRATION_POLICIES = ['OPEN', 'APPROVAL', 'INVITE_ONLY'] as const;
export type RegistrationPolicy = (typeof REGISTRATION_POLICIES)[number];

export const CHECK_IN_POLICIES = ['SELF', 'MANAGER', 'SELF_AND_MANAGER'] as const;
export type CheckInPolicy = (typeof CHECK_IN_POLICIES)[number];

export const COURT_STATUSES = ['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'INACTIVE'] as const;
export type CourtStatus = (typeof COURT_STATUSES)[number];

export const SCORE_TEAMS = ['A', 'B'] as const;
export type ScoreTeam = (typeof SCORE_TEAMS)[number];

/* ------------------------------------------------------------------ */
/* Human-readable labels (shared so UI and API never diverge)          */
/* ------------------------------------------------------------------ */

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  CHECK_IN_OPEN: 'Check-in open',
  LIVE: 'Live',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const QUEUE_STATE_LABELS: Record<QueueState, string> = {
  WAITING: 'Waiting',
  RESERVED: 'Reserved',
  PLAYING: 'Playing',
  RESTING: 'Resting',
  PAUSED: 'Paused',
  LEFT: 'Left',
};

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  PROPOSED: 'Proposed',
  RESERVED: 'Reserved',
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  CORRECTED: 'Corrected',
};

export const CLUB_ROLE_LABELS: Record<ClubRole, string> = {
  OWNER: 'Owner',
  QUEUE_MASTER: 'Queue Master',
  PLAYER: 'Player',
};

export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  USER: 'User',
  SUPER_ADMIN: 'Super Admin',
};

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  PENDING_APPROVAL: 'Pending approval',
  APPROVED_PENDING_ACTIVATION: 'Approved - activation required',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
  DELETED: 'Deleted',
};

export const REGISTRATION_REVIEW_STATUS_LABELS: Record<RegistrationReviewStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const ACCOUNT_STATUS_TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  PENDING_APPROVAL: ['APPROVED_PENDING_ACTIVATION', 'SUSPENDED', 'DELETED'],
  APPROVED_PENDING_ACTIVATION: ['ACTIVE', 'SUSPENDED', 'DELETED'],
  ACTIVE: ['SUSPENDED', 'DEACTIVATED', 'DELETED'],
  SUSPENDED: ['ACTIVE', 'DELETED'],
  DEACTIVATED: ['ACTIVE', 'DELETED'],
  DELETED: ['ACTIVE'],
};

export const REGISTRATION_REVIEW_TRANSITIONS: Record<
  RegistrationReviewStatus,
  readonly RegistrationReviewStatus[]
> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: ['PENDING'],
};

/* ------------------------------------------------------------------ */
/* Skill bounds                                                       */
/* ------------------------------------------------------------------ */

export const SKILL_MIN = 1;
export const SKILL_MAX = 7;
export const SKILL_STEP = 0.25;

export function isValidSkill(value: number): boolean {
  return Number.isFinite(value) && value >= SKILL_MIN && value <= SKILL_MAX;
}

export function formatSkill(value: number): string {
  return value.toFixed(2).replace(/0$/, '');
}

/* ------------------------------------------------------------------ */
/* Matchmaking configuration                                          */
/* ------------------------------------------------------------------ */

export const matchmakingConfigSchema = z
  .object({
    strategy: z.enum(MATCHMAKING_STRATEGIES).default('HYBRID'),
    format: z.enum(MATCH_FORMATS).default('DOUBLES'),
    preferredSkillSpread: z.number().min(0).max(3).default(0.5),
    maxSkillSpread: z.number().min(0.25).max(4).default(1.5),
    widenAfterMinutes: z.number().int().min(0).max(120).default(10),
    minRestMinutes: z.number().int().min(0).max(180).default(5),
    partnerPenalty: z.number().min(0).max(100).default(12),
    opponentPenalty: z.number().min(0).max(100).default(4),
    starvationMaxGap: z.number().int().min(0).max(5).default(1),
    maxGamesPerPlayer: z.number().int().min(1).max(50).nullable().default(null),
    autoAssign: z.boolean().default(false),
    allowMixedSkillFallback: z.boolean().default(true),
  })
  .refine((config) => config.preferredSkillSpread <= config.maxSkillSpread, {
    message: 'Preferred skill spread cannot exceed the maximum skill spread',
    path: ['preferredSkillSpread'],
  });

export type MatchmakingConfig = z.infer<typeof matchmakingConfigSchema>;

/** Defaults are derived from the schema so validation and defaults cannot drift. */
export const MATCHMAKING_DEFAULTS: MatchmakingConfig = matchmakingConfigSchema.parse({});

/* ------------------------------------------------------------------ */
/* Scoring configuration                                              */
/* ------------------------------------------------------------------ */

export const TARGET_SCORES = [11, 15, 21] as const;
export type TargetScore = (typeof TARGET_SCORES)[number];

export const scoringConfigSchema = z
  .object({
    mode: z.literal('RALLY').default('RALLY'),
    targetScore: z.union([z.literal(11), z.literal(15), z.literal(21)]).default(11),
    winByTwo: z.boolean().default(true),
    pointCap: z.number().int().min(11).max(40).nullable().default(null),
    bestOf: z.union([z.literal(1), z.literal(3)]).default(1),
  })
  .refine(
    (config) =>
      config.pointCap === null ||
      !config.winByTwo ||
      (config.pointCap >= config.targetScore && config.pointCap - config.targetScore <= 10),
    {
      message:
        'Point cap must be between the target score and target score + 10 when win-by-two is on',
      path: ['pointCap'],
    },
  );

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

export const SCORING_DEFAULTS: ScoringConfig = scoringConfigSchema.parse({});

/* ------------------------------------------------------------------ */
/* Session configuration                                              */
/* ------------------------------------------------------------------ */

export const sessionConfigSchema = z.object({
  capacity: z.number().int().min(2).max(200),
  registrationPolicy: z.enum(REGISTRATION_POLICIES).default('OPEN'),
  checkInPolicy: z.enum(CHECK_IN_POLICIES).default('SELF'),
  matchmaking: matchmakingConfigSchema,
  scoring: scoringConfigSchema,
  published: z.boolean().default(false),
  allowLateArrivals: z.boolean().default(true),
});
export type SessionConfig = z.infer<typeof sessionConfigSchema>;

/* ------------------------------------------------------------------ */
/* API envelopes                                                      */
/* ------------------------------------------------------------------ */

export interface ApiErrorDetail {
  path?: string;
  message: string;
  code?: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    requestId?: string;
  };
}

export interface ApiSuccessEnvelope<T> {
  data: T;
  meta?: {
    nextCursor?: string | null;
    total?: number;
    [key: string]: unknown;
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* Privacy helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Public pages show a first name plus a last initial. Single names are left intact.
 * This is deliberately conservative: no email, no full surname, no user id.
 */
export function toPublicDisplayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Player';
  const first = parts[0] ?? 'Player';
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1] ?? '';
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').charAt(0)}${(parts[parts.length - 1] ?? '').charAt(0)}`.toUpperCase();
}

