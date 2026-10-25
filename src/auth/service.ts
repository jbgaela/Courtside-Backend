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

// A real bcrypt hash with the same cost as production passwords. Comparing
// against this on unknown-email attempts keeps failed-login work comparable.
const DUMMY_PASSWORD_HASH = '$2b$12$x9THV5hh8WbVMo7pSA9UJuMqwuOrDtSyfbh5QHrEH9hlKpRbHn6Ky';

async function issueEmailToken(
  userId: string,
  type: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
  ttlMs: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlMs);
  await prisma.$transaction([
    // Only the newest verification/reset link remains usable.
    prisma.emailToken.updateMany({
      where: {
        userId,
        type,
        OR: [{ usedAt: null }, { usedAt: { isSet: false } }],
      },
      data: { usedAt: new Date() },
    }),
    prisma.emailToken.create({
      data: { userId, type, tokenHash: sha256(token), expiresAt },
    }),
  ]);
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
  const hash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const valid = await verifyPassword(input.password, hash);
  if (!user || !valid) {
    await writeAudit(prisma, {
      actorId: user?.id ?? null,
      action: 'user.sign_in_failed',
      entityType: 'User',
      entityId: user?.id ?? null,
      summary: 'Failed sign-in attempt',
      metadata: { emailHash: sha256(input.email), reason: 'invalid_credentials' },
      ip: requestMetadata(input.req).ip,
      userAgent: requestMetadata(input.req).userAgent,
    }).catch((error: unknown) => {
      logger.warn({ err: error }, 'Failed to write failed-login audit event');
    });
    throw AppError.unauthorized('Email or password is incorrect');
  }
  if (user.emailVerifiedAt === null) {
    logger.info({ userId: user.id }, 'Login with unverified email');
  }

  const metadata = requestMetadata(input.req);
  const session = await createAuthSession(user.id, metadata);
  const full = await loadMeData(user.id);

  await writeAudit(prisma, {
    actorId: user.id,
    action: 'user.signed_in',
    entityType: 'User',
    entityId: user.id,
    summary: 'Signed in',
    ip: metadata.ip,
    userAgent: metadata.userAgent,
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
  const now = new Date();
  if (!record || record.type !== 'VERIFY_EMAIL' || record.usedAt || record.expiresAt <= now) {
    throw AppError.badRequest('This verification link is invalid or has expired');
  }
  const claimed = await prisma.$transaction(async (tx) => {
    const updated = await tx.emailToken.updateMany({
      where: {
        id: record.id,
        expiresAt: { gt: now },
        OR: [{ usedAt: null }, { usedAt: { isSet: false } }],
      },
      data: { usedAt: now },
    });
    if (updated.count === 0) return false;
    await tx.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: record.user.emailVerifiedAt ?? now },
    });
    return true;
  });
  if (!claimed) {
    throw AppError.badRequest('This verification link is invalid or has expired');
  }
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
  const now = new Date();
  if (!record || record.type !== 'RESET_PASSWORD' || record.usedAt || record.expiresAt <= now) {
    throw AppError.badRequest('This reset link is invalid or has expired');
  }
  const passwordHash = await hashPassword(password);
  const claimed = await prisma.$transaction(async (tx) => {
    const updated = await tx.emailToken.updateMany({
      where: {
        id: record.id,
        expiresAt: { gt: now },
        OR: [{ usedAt: null }, { usedAt: { isSet: false } }],
      },
      data: { usedAt: now },
    });
    if (updated.count === 0) return false;
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    return true;
  });
  if (!claimed) {
    throw AppError.badRequest('This reset link is invalid or has expired');
  }
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
