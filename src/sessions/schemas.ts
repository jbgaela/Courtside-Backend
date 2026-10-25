import { z } from 'zod';
import {
  CHECK_IN_POLICIES,
  GUEST_GENDERS,
  MATCH_FORMATS,
  REGISTRATION_POLICIES,
  SESSION_STATUSES,
  SKILL_MAX,
  SKILL_MIN,
  SKILL_STEP,
} from '@picklequeue/contracts';

const dateTimeString = z
  .string()
  .min(10)
  .max(40)
  .refine(
    (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value)),
    {
      message: 'Expected an ISO-8601 date-time',
    },
  );

const timezoneSchema = z
  .string()
  .min(1)
  .max(80)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown IANA timezone' },
  );

const courtIdsSchema = z
  .array(z.string().min(1).max(40))
  .min(1, 'Select at least one court')
  .max(30)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Court IDs must be unique' });

const participantNameSchema = z
  .string()
  .trim()
  .min(1, 'Player name is required')
  .max(80, 'Player name must be 80 characters or fewer')
  .regex(/^[^\u0000-\u001f\u007f]*$/u, 'Player name contains invalid characters');

const guestSkillSchema = z
  .number()
  .min(SKILL_MIN, `Skill must be between ${SKILL_MIN} and ${SKILL_MAX}`)
  .max(SKILL_MAX, `Skill must be between ${SKILL_MIN} and ${SKILL_MAX}`)
  .refine(
    (value) => Math.abs(value / SKILL_STEP - Math.round(value / SKILL_STEP)) < 1e-9,
    `Skill must be in ${SKILL_STEP} increments`,
  );

export const createSessionSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(1000).optional(),
    venue: z.string().trim().max(150).optional(),
    startsAt: dateTimeString,
    endsAt: dateTimeString,
    timezone: timezoneSchema,
    capacity: z.number().int().min(2).max(200),
    format: z.enum(MATCH_FORMATS).default('DOUBLES'),
    registrationPolicy: z.enum(REGISTRATION_POLICIES).default('OPEN'),
    checkInPolicy: z.enum(CHECK_IN_POLICIES).default('SELF'),
    published: z.boolean().default(false),
    allowLateArrivals: z.boolean().default(true),
    courtIds: courtIdsSchema,
    matchmaking: z.unknown().optional(),
    scoring: z.unknown().optional(),
  })
  .refine((input) => new Date(input.endsAt).getTime() > new Date(input.startsAt).getTime(), {
    message: 'End time must be after start time',
    path: ['endsAt'],
  })
  .refine(
    (input) =>
      new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime() <= 24 * 60 * 60 * 1000,
    { message: 'Session cannot exceed 24 hours', path: ['endsAt'] },
  );

export const updateSessionSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    venue: z.string().trim().max(150).nullable().optional(),
    startsAt: dateTimeString.optional(),
    endsAt: dateTimeString.optional(),
    timezone: timezoneSchema.optional(),
    capacity: z.number().int().min(2).max(200).optional(),
    format: z.enum(MATCH_FORMATS).optional(),
    registrationPolicy: z.enum(REGISTRATION_POLICIES).optional(),
    checkInPolicy: z.enum(CHECK_IN_POLICIES).optional(),
    allowLateArrivals: z.boolean().optional(),
    courtIds: courtIdsSchema.optional(),
    matchmaking: z.unknown().optional(),
    scoring: z.unknown().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .refine(
    (input) =>
      !input.startsAt ||
      !input.endsAt ||
      new Date(input.endsAt).getTime() > new Date(input.startsAt).getTime(),
    { message: 'End time must be after start time', path: ['endsAt'] },
  );

export const transitionSchema = z.object({
  status: z.enum(SESSION_STATUSES),
  reason: z.string().trim().max(300).optional(),
  force: z.boolean().default(false),
  expectedVersion: z.number().int().min(1).optional(),
});

export const publishSchema = z.object({
  published: z.boolean(),
  expectedVersion: z.number().int().min(1).optional(),
});

export const sessionCourtsSchema = z.object({
  courtIds: courtIdsSchema,
  expectedVersion: z.number().int().min(1).optional(),
});

export const registerSchema = z.object({
  note: z.string().trim().max(300).optional(),
});

export const sessionListQuerySchema = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const checkInSchema = z.object({
  userId: z.string().min(1).max(40).optional(),
  method: z.enum(['SELF', 'MANAGER', 'QR']).optional(),
  reason: z.string().trim().max(300).optional(),
});

export const qrCheckInSchema = z.object({
  token: z.string().min(10).max(100),
});

export const queueActionSchema = z.object({
  userId: z.string().min(1).max(40).optional(),
  participantId: z.string().min(1).max(40).optional(),
  reason: z.string().trim().max(300).optional(),
});

export const createGuestSchema = z.object({
  displayName: participantNameSchema,
  gender: z.enum(GUEST_GENDERS),
  skillRating: guestSkillSchema,
  addToQueue: z.boolean().default(false),
});

export const updateGuestSchema = z
  .object({
    displayName: participantNameSchema.optional(),
    gender: z.enum(GUEST_GENDERS).optional(),
    skillRating: guestSkillSchema.optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine(
    (input) =>
      input.displayName !== undefined ||
      input.gender !== undefined ||
      input.skillRating !== undefined,
    { message: 'Provide at least one guest field to update' },
  );

export const registrationActionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'NO_SHOW']),
  reason: z.string().trim().max(300).optional(),
});

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().min(1).max(40),
});

export const sessionRegistrationParamsSchema = z.object({
  sessionId: z.string().min(1).max(40),
  registrationId: z.string().min(1).max(40),
});

export const sessionGuestParamsSchema = z.object({
  sessionId: z.string().min(1).max(40),
  guestId: z.string().min(1).max(40),
});

export const sessionClubParamsSchema = z.object({
  clubId: z.string().min(1).max(40),
});
