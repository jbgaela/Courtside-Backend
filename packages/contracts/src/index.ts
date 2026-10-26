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

export const GUEST_JOIN_POLICIES = ['DISABLED', 'OPEN'] as const;
export type GuestJoinPolicy = (typeof GUEST_JOIN_POLICIES)[number];

export const GUEST_JOIN_POLICY_LABELS: Record<GuestJoinPolicy, string> = {
  DISABLED: 'Guests must be added by a Queue Master',
  OPEN: 'Players can join as guests from the QR code',
};

export const GUEST_ORIGINS = ['MANAGER', 'SELF'] as const;
export type GuestOrigin = (typeof GUEST_ORIGINS)[number];
export const CLUB_ROLES = ['OWNER', 'QUEUE_MASTER', 'PLAYER'] as const;
export type ClubRole = (typeof CLUB_ROLES)[number];

/* ------------------------------------------------------------------ */
/* Club-scoped RBAC catalogue                                          */
/* ------------------------------------------------------------------ */

export const ROLE_SCOPES = ['PLATFORM', 'CLUB'] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

export const CLUB_PERMISSION_GROUPS = [
  'Clubs',
  'Members',
  'Sessions',
  'Queue & matches',
  'Scores',
  'System',
] as const;

export type ClubPermissionGroup = (typeof CLUB_PERMISSION_GROUPS)[number];

export interface ClubPermissionDefinition {
  key: string;
  label: string;
  description: string;
  group: ClubPermissionGroup;
  /** Owner-only controls that cannot be delegated to a custom role. */
  ownerOnly?: boolean;
}

/**
 * Human-readable permission catalogue. The keys are stable; labels and
 * descriptions are the only things a Super Admin sees in the role editor.
 */
export const CLUB_PERMISSION_DEFINITIONS: readonly ClubPermissionDefinition[] = [
  {
    key: 'club.view',
    label: 'View club',
    description: 'See the club, its public profile and its sessions.',
    group: 'Clubs',
  },
  {
    key: 'club.manage',
    label: 'Edit club',
    description: 'Update the club name, description and venue.',
    group: 'Clubs',
  },
  {
    key: 'club.courts.manage',
    label: 'Manage courts',
    description: 'Add, rename, retire and restore the club courts.',
    group: 'Clubs',
  },
  {
    key: 'club.members.manage',
    label: 'Manage members',
    description: 'Approve requests, remove members and change member roles.',
    group: 'Members',
  },
  {
    key: 'club.invitations.manage',
    label: 'Manage invitations',
    description: 'Invite players and revoke pending invitations.',
    group: 'Members',
  },
  {
    key: 'sessions.create',
    label: 'Create sessions',
    description: 'Create scheduled or immediate open-play sessions.',
    group: 'Sessions',
  },
  {
    key: 'sessions.manage',
    label: 'Manage sessions',
    description: 'Edit session setup, courts, publication and lifecycle.',
    group: 'Sessions',
  },
  {
    key: 'sessions.checkin.manage',
    label: 'Manage check-in',
    description: 'Approve registrations, check players in and record no-shows.',
    group: 'Sessions',
  },
  {
    key: 'sessions.participants.manage',
    label: 'Manage participants',
    description: 'Withdraw or remove participants from a session.',
    group: 'Sessions',
  },
  {
    key: 'sessions.guests.manage',
    label: 'Manage guests',
    description: 'Add, edit, queue and remove guest players.',
    group: 'Sessions',
  },
  {
    key: 'queue.manage',
    label: 'Manage queue and rotations',
    description: 'Generate and commit rotations, swap players and pause the queue.',
    group: 'Queue & matches',
  },
  {
    key: 'scores.record',
    label: 'Record scores',
    description: 'Start matches, record points and complete matches.',
    group: 'Scores',
  },
  {
    key: 'scores.correct',
    label: 'Correct results',
    description: 'Correct a completed match with an audit reason.',
    group: 'Scores',
  },
  {
    key: 'club.audit.view',
    label: 'View club audit',
    description: 'Read the club audit history of privileged actions.',
    group: 'System',
  },
] as const;

export type ClubPermissionKey = (typeof CLUB_PERMISSION_DEFINITIONS)[number]['key'];

export const CLUB_PERMISSION_KEYS = CLUB_PERMISSION_DEFINITIONS.map(
  (permission) => permission.key,
) as readonly string[];

export const PLATFORM_PERMISSION_DEFINITIONS = [
  {
    key: 'platform.registrations.review',
    label: 'Review registrations',
    description: 'Approve, reject and reopen account applications.',
    group: 'Users',
  },
  {
    key: 'platform.users.view',
    label: 'View users',
    description: 'Search the account directory and read account details.',
    group: 'Users',
  },
  {
    key: 'platform.users.manage',
    label: 'Manage users',
    description: 'Suspend, restore, delete, recover and revoke sessions.',
    group: 'Users',
  },
  {
    key: 'platform.roles.manage',
    label: 'Manage roles',
    description: 'Create, edit, duplicate and retire club roles.',
    group: 'System',
  },
  {
    key: 'platform.audit.view',
    label: 'View platform audit',
    description: 'Read the administrative audit trail.',
    group: 'System',
  },
] as const;

export interface BuiltinRoleDefinition {
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  permissions: readonly string[];
  isSystem: boolean;
  isProtected: boolean;
}

/**
 * Built-in roles are seeded idempotently. Owner and Queue Master remain
 * protected so a configuration mistake cannot remove the capability to run a
 * club. Admins can duplicate a built-in role to customize its permissions.
 */
export const BUILTIN_ROLE_DEFINITIONS: readonly BuiltinRoleDefinition[] = [
  {
    key: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Full access to platform users, roles, registrations and audit history.',
    scope: 'PLATFORM',
    permissions: PLATFORM_PERMISSION_DEFINITIONS.map((permission) => permission.key),
    isSystem: true,
    isProtected: true,
  },
  {
    key: 'OWNER',
    name: 'Owner',
    description: 'Full control of the club, including ownership transfer and archive.',
    scope: 'CLUB',
    permissions: CLUB_PERMISSION_KEYS,
    isSystem: true,
    isProtected: true,
  },
  {
    key: 'QUEUE_MASTER',
    name: 'Queue Master',
    description: 'Run sessions, check in players, build rotations and record scores.',
    scope: 'CLUB',
    permissions: [
      'club.view',
      'club.manage',
      'club.invitations.manage',
      'club.courts.manage',
      'club.audit.view',
      'sessions.create',
      'sessions.manage',
      'sessions.checkin.manage',
      'sessions.participants.manage',
      'sessions.guests.manage',
      'queue.manage',
      'scores.record',
      'scores.correct',
    ],
    isSystem: true,
    isProtected: true,
  },
  {
    key: 'PLAYER',
    name: 'Player',
    description: 'Join eligible sessions, check in and follow the live queue.',
    scope: 'CLUB',
    permissions: ['club.view'],
    isSystem: true,
    isProtected: true,
  },
] as const;

export const PREVIEW_ROLE_DEFINITIONS: readonly BuiltinRoleDefinition[] = [
  {
    key: 'CLUB_MANAGER',
    name: 'Club Manager',
    description: 'Manage club information, members, courts and sessions.',
    scope: 'CLUB',
    permissions: [
      'club.view',
      'club.manage',
      'club.members.manage',
      'club.invitations.manage',
      'club.courts.manage',
      'club.audit.view',
      'sessions.create',
      'sessions.manage',
      'sessions.checkin.manage',
      'sessions.participants.manage',
      'sessions.guests.manage',
      'queue.manage',
      'scores.record',
    ],
    isSystem: false,
    isProtected: false,
  },
  {
    key: 'VIEWER',
    name: 'Viewer',
    description: 'View-only access to the club and its sessions.',
    scope: 'CLUB',
    permissions: ['club.view', 'club.audit.view'],
    isSystem: false,
    isProtected: false,
  },
] as const;

export const CLUB_PERMISSION_LABELS: Record<string, string> = Object.fromEntries(
  CLUB_PERMISSION_DEFINITIONS.map((permission) => [permission.key, permission.label]),
);

export const CLUB_PERMISSION_GROUPS_MAP = CLUB_PERMISSION_DEFINITIONS.reduce<
  Record<string, ClubPermissionDefinition[]>
>((groups, permission) => {
  (groups[permission.group] ??= []).push(permission);
  return groups;
}, {});


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

