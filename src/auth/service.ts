import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { logger } from '../infrastructure/logger.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../security/password.js';
import { randomToken, sha256 } from '../security/tokens.js';
import { writeAudit } from '../audit/audit.js';
import { createAuthSession, revokeAllSessions } from './session.js';
import { toMe } from '../users/serializers.js';
import type { Request } from 'express';
import { requestMetadata } from '../http/middleware/request-id.js';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

async function issueEmailToken(
  userId: string,
  type: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
  ttlMs: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlMs);
  await prisma.emailToken.create({
    data: { userId, type, tokenHash: sha256(token), expiresAt },
  });
  return { token, expiresAt };
}

async function loadMeData(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      profile: true,
      memberships: { include: { club: true } },
    },
  });
}

export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
  req: Request;
}) {
  assertPasswordPolicy(input.password);
  const passwordHash = await hashPassword(input.password);
  const metadata = requestMetadata(input.req);

  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        profile: {
          create: {
            displayName: input.name,
            skillRating: 3.0,
          },
        },
        skillRatings: {
          create: {
            value: 3.0,
            source: 'SELF_REPORTED',
          },
        },
      },
      include: { profile: true },
    });

    const verification = await issueEmailToken(user.id, 'VERIFY_EMAIL', VERIFY_TTL_MS);
    const session = await createAuthSession(user.id, metadata);
    const full = await loadMeData(user.id);

    await writeAudit(prisma, {
      actorId: user.id,
      action: 'user.registered',
      entityType: 'User',
      entityId: user.id,
      summary: 'Account created',
      ip: metadata.ip,
      userAgent: metadata.userAgent,
    });

    return {
      token: session.token,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      user: toMe(full, full.profile, full.memberships, session.csrfToken),
      devVerificationToken: env.EXPOSE_DEV_TOKENS ? verification.token : null,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw AppError.conflict('An account with this email already exists');
    }
    throw error;
  }
}

export async function loginUser(input: { email: string; password: string; req: Request }) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { profile: true },
  });

  // Always perform a bcrypt comparison to reduce timing-based account enumeration.
  const hash =
    user?.passwordHash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const valid = await verifyPassword(input.password, hash);
  if (!user || !valid) {
    throw AppError.unauthorized('Email or password is incorrect');
  }
  if (user.emailVerifiedAt === null) {
    logger.info({ userId: user.id }, 'Login with unverified email');
  }

  const session = await createAuthSession(user.id, requestMetadata(input.req));
  const full = await loadMeData(user.id);

  await writeAudit(prisma, {
    actorId: user.id,
    action: 'user.signed_in',
    entityType: 'User',
    entityId: user.id,
    summary: 'Signed in',
    ip: requestMetadata(input.req).ip,
    userAgent: requestMetadata(input.req).userAgent,
  });

  return {
    token: session.token,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    user: toMe(full, full.profile, full.memberships, session.csrfToken),
  };
}

export async function getMe(userId: string, csrfToken: string) {
  const user = await loadMeData(userId);
  return toMe(user, user.profile, user.memberships, csrfToken);
}

export async function verifyEmail(token: string) {
  const record = await prisma.emailToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!record || record.type !== 'VERIFY_EMAIL' || record.usedAt || record.expiresAt < new Date()) {
    throw AppError.badRequest('This verification link is invalid or has expired');
  }
  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: record.user.emailVerifiedAt ?? new Date() },
    }),
  ]);
  await writeAudit(prisma, {
    actorId: record.userId,
    action: 'user.email_verified',
    entityType: 'User',
    entityId: record.userId,
    summary: 'Email verified',
  });
  return { verified: true };
}

export async function resendVerification(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) throw AppError.conflict('Email is already verified');
  const token = await issueEmailToken(userId, 'VERIFY_EMAIL', VERIFY_TTL_MS);
  return { devVerificationToken: env.EXPOSE_DEV_TOKENS ? token.token : null };
}

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return { devResetToken: null };
  const token = await issueEmailToken(user.id, 'RESET_PASSWORD', RESET_TTL_MS);
  return { devResetToken: env.EXPOSE_DEV_TOKENS ? token.token : null };
}

export async function resetPassword(token: string, password: string) {
  assertPasswordPolicy(password);
  const record = await prisma.emailToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (
    !record ||
    record.type !== 'RESET_PASSWORD' ||
    record.usedAt ||
    record.expiresAt < new Date()
  ) {
    throw AppError.badRequest('This reset link is invalid or has expired');
  }
  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
  ]);
  await revokeAllSessions(record.userId);
  await writeAudit(prisma, {
    actorId: record.userId,
    action: 'user.password_reset',
    entityType: 'User',
    entityId: record.userId,
    summary: 'Password reset; all sessions revoked',
  });
  return { reset: true };
}
