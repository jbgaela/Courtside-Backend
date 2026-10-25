import { z } from 'zod';
import { SKILL_MAX, SKILL_MIN } from '@picklequeue/contracts';

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  displayName: z.string().trim().min(1).max(50).optional(),
  skillRating: z.number().min(SKILL_MIN).max(SKILL_MAX).optional(),
  bio: z.string().trim().max(300).nullable().optional(),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const notificationParamsSchema = z.object({
  notificationId: z.string().min(1).max(40),
});
