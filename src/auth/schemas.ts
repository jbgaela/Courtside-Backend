import { z } from 'zod';
import { SKILL_MAX, SKILL_MIN } from '@picklequeue/contracts';

export const emailSchema = z.string().trim().toLowerCase().min(3).max(254).email();

export const acceptedTermsSchema = z.literal(true, {
  message: 'You must accept the terms and privacy notice',
});

export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: emailSchema,
    password: z.string().min(8).max(128),
    skillRating: z.number().min(SKILL_MIN).max(SKILL_MAX).optional(),
    acceptTerms: acceptedTermsSchema,
  })
  .strict();

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(20).max(200),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(128),
});

export const activateRegistrationSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  skillRating: z.number().min(SKILL_MIN).max(SKILL_MAX).optional(),
  acceptTerms: acceptedTermsSchema,
});

export const claimAccountSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(50).optional(),
  acceptTerms: acceptedTermsSchema,
});

export const recoverAccountSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(128),
});

export const reauthSchema = z.object({
  password: z.string().min(1).max(128),
});

export const mfaCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the six-digit authenticator code'),
});
