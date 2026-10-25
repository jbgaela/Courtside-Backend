import type { Request } from 'express';
import type { PlayerProfile, RegistrationReview, User } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { randomToken, sha256 } from '../security/tokens.js';
import { accountStatusOf, loginStateFor, registrationStatusOf } from '../accounts/state.js';
import { readRegistrationCookie } from './cookies.js';

export interface RegistrationContext {
  user: User;
  profile: PlayerProfile | null;
  review: RegistrationReview | null;
  session: {
    id: string;
    csrfToken: string;
    expiresAt: Date;
  };
}

export interface CreatedRegistrationSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createRegistrationSession(
  userId: string,
): Promise<CreatedRegistrationSession> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + env.REGISTRATION_TTL_MINUTES * 60 * 1000);
  await prisma.registrationSession.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfToken,
      expiresAt,
    },
  });
  return { token, csrfToken, expiresAt };
}

export async function attachRegistration(req: Request): Promise<void> {
  const token = readRegistrationCookie(req.cookies as Record<string, string | undefined>);
  if (!token) return;
  const session = await prisma.registrationSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      user: { include: { profile: true, registrationReview: true } },
    },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    return;
  }
  req.registration = {
    user: session.user,
    profile: session.user.profile,
    review: session.user.registrationReview,
    session: {
      id: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    },
  };
}

export function requireRegistration(req: Request): RegistrationContext {
  if (!req.registration) {
    throw AppError.unauthorized('Sign in again to check or activate this registration');
  }
  return req.registration;
}

export function requireRegistrationCsrf(req: Request, header: string | undefined): void {
  const registration = requireRegistration(req);
  if (!header || header !== registration.session.csrfToken) {
    throw AppError.forbidden('Invalid or missing registration CSRF token');
  }
}

export function registrationView(registration: RegistrationContext) {
  const reviewStatus = registrationStatusOf(registration.review);
  const state = loginStateFor(registration.user, registration.review);
  return {
    name: registration.user.name,
    email: registration.user.email,
    accountStatus: accountStatusOf(registration.user),
    registrationStatus: reviewStatus,
    submittedAt: registration.review?.submittedAt.toISOString() ?? null,
    reviewedAt: registration.review?.reviewedAt?.toISOString() ?? null,
    publicReason: registration.review?.publicReason ?? null,
    canActivate: state.kind === 'RESTRICTED' && state.status === 'APPROVED_PENDING_ACTIVATION',
    restricted: state.kind === 'RESTRICTED',
  };
}

export async function revokeRegistrationSessions(userId: string): Promise<void> {
  await prisma.registrationSession.deleteMany({ where: { userId } });
}
