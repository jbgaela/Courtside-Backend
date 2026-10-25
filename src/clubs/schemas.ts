import { z } from 'zod';
import { CLUB_ROLES } from '@picklequeue/contracts';
import { emailSchema } from '../auth/schemas.js';

export const clubJoinPolicySchema = z.enum(['OPEN', 'APPROVAL', 'INVITE_ONLY']);

export const createClubSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(600).optional(),
  location: z.string().trim().max(120).optional(),
  joinPolicy: clubJoinPolicySchema.default('APPROVAL'),
});

export const updateClubSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(600).nullable().optional(),
  location: z.string().trim().max(120).nullable().optional(),
  joinPolicy: clubJoinPolicySchema.optional(),
  expectedVersion: z.number().int().min(1),
});

export const listClubsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const joinClubSchema = z.object({
  message: z.string().trim().max(300).optional(),
});

export const updateMemberSchema = z.object({
  role: z.enum(CLUB_ROLES).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'LEFT']).optional(),
});

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(['QUEUE_MASTER', 'PLAYER']).default('PLAYER'),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(300),
});

export const transferOwnershipSchema = z.object({
  userId: z.string().min(1),
});

export const createCourtSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(100).default(0),
});

export const updateCourtSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  status: z.enum(['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'INACTIVE']).optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
});

export const idParamSchema = z.object({
  clubId: z.string().min(1).max(40),
});

export const courtParamsSchema = z.object({
  clubId: z.string().min(1).max(40),
  courtId: z.string().min(1).max(40),
});

export const memberParamsSchema = z.object({
  clubId: z.string().min(1).max(40),
  membershipId: z.string().min(1).max(40),
});
