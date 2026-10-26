import { z } from 'zod';
import { GUEST_GENDERS } from '@picklequeue/contracts';
import { guestNameSchema, guestSkillValueSchema } from '../sessions/schemas.js';

export const guestJoinSchema = z
  .object({
    displayName: guestNameSchema,
    gender: z.enum(GUEST_GENDERS),
    skillRating: guestSkillValueSchema,
    clientKey: z.string().trim().min(16).max(128),
  })
  .strict();
