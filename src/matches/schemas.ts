import { z } from 'zod';

export const startMatchSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
});

export const scoreEventSchema = z.object({
  team: z.enum(['A', 'B']),
  expectedVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export const completeMatchSchema = z.object({
  expectedVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export const undoPointSchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export const correctionSchema = z.object({
  games: z
    .array(
      z.object({
        a: z.number().int().min(0).max(99),
        b: z.number().int().min(0).max(99),
      }),
    )
    .min(1)
    .max(3),
  reason: z.string().trim().min(3).max(300),
  expectedVersion: z.number().int().min(1).optional(),
});

export const matchListQuerySchema = z.object({
  status: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const matchIdParamsSchema = z.object({
  matchId: z.string().min(1).max(40),
});
