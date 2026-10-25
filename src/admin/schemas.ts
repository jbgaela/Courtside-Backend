import { z } from 'zod';
import {
  ACCOUNT_STATUSES,
  PLATFORM_ROLES,
  REGISTRATION_REVIEW_STATUSES,
  SKILL_MAX,
  SKILL_MIN,
} from '@picklequeue/contracts';

const idSchema = z.string().min(1).max(64);
const emailSchema = z.string().trim().toLowerCase().min(3).max(254).email();

export const adminPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const registrationListQuerySchema = adminPaginationSchema.extend({
  status: z.enum(REGISTRATION_REVIEW_STATUSES).optional(),
});

export const userListQuerySchema = adminPaginationSchema.extend({
  status: z.enum(ACCOUNT_STATUSES).optional(),
  registrationStatus: z.enum(REGISTRATION_REVIEW_STATUSES).optional(),
  platformRole: z.enum(PLATFORM_ROLES).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'name', 'email']).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export const reviewParamsSchema = z.object({
  registrationId: idSchema,
});

export const userParamsSchema = z.object({
  userId: idSchema,
});

export const approvalSchema = z.object({
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().max(1000).optional(),
});

export const rejectionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  internalReason: z.string().trim().max(1000).optional(),
  publicReason: z.string().trim().max(500).optional(),
});

export const reopenSchema = z.object({
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().max(1000).optional(),
});

export const createAdminUserSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: emailSchema,
    displayName: z.string().trim().min(1).max(50).optional(),
    skillRating: z.number().min(SKILL_MIN).max(SKILL_MAX).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const updateAdminUserSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    displayName: z.string().trim().min(1).max(50).optional(),
    skillRating: z.number().min(SKILL_MIN).max(SKILL_MAX).optional(),
    bio: z.string().trim().max(300).nullable().optional(),
    avatarColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).some((key) => key !== 'note'), {
    message: 'No permitted account fields were supplied',
  });

export const suspendUserSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const recoveryRequestSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const adminAuditQuerySchema = adminPaginationSchema.extend({
  action: z.string().trim().max(100).optional(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILED']).optional(),
  targetUserId: idSchema.optional(),
  actorId: idSchema.optional(),
});

export const reauthSchema = z.object({
  password: z.string().min(1).max(128),
});
