import { z } from 'zod';

export const rotationPreviewSchema = z.object({
  format: z.enum(['SINGLES', 'DOUBLES']).optional(),
  maxAssignments: z.number().int().min(1).max(20).optional(),
});

export const rotationCommitSchema = z.object({
  rotationId: z.string().min(1).max(40),
  expectedSessionVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export const rotationIdParamsSchema = z.object({
  sessionId: z.string().min(1).max(40),
  rotationId: z.string().min(1).max(40),
});

export const rotationSwapSchema = z.object({
  playerUserId: z.string().min(1).max(40),
  replacementUserId: z.string().min(1).max(40),
});

export const selectedPlayerSchema = z.object({
  queueEntryId: z.string(),
  userId: z.string(),
  displayName: z.string(),
  skill: z.number(),
  gamesPlayed: z.number().int(),
  waitMinutes: z.number(),
});
