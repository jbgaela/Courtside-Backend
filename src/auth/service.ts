import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { logger } from '../infrastructure/logger.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../security/password.js';
import { randomToken, sha256 } from '../security/tokens.js';
import { writeAudit } from '../audit/audit.js';
import { createAuthSession, revokeAllSessions } from './session.js';
import { createRegistrationSession, registrationView, revokeRegistrationSessions } from './registration-session.js';
import { toMe } from '../users/serializers.js';
import type { Request } from 'express';
import { requestMetadata } from '../http/middleware/request-id.js';
import {
  accountStatusOf,
  isActiveAccount,
  isSuperAdmin,
  loginStateFor,
  registrationStatusOf,
} from '../accounts/state.js';
import { createMfaChallenge } from './mfa.js';
import type { RegistrationContext } from './registration-session.js';
import { assertSkillValue } from '../accounts/validation.js';

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

async function writeRegistrationAudit(input: {
  actorId?: string | null;
  targetUserId?: string | null;
  action: string;
  outcome?: string;
  summary: string;
  metadata?: Prisma.InputJsonValue;
  req: Request;
}) {
  const metadata = requestMetadata(input.req);
  await prisma.administrativeAuditEvent.create({
    data: {
      actorId: input.actorId ?? null,
      targetUserId: input.targetUserId ?? null,
      action: input.action,
      outcome: input.outcome ?? 'SUCCESS',
      entityType: 'User',
      entityId: input.targetUserId ?? null,
      summary: input.summary,
      metadata: input.metadata,
      requestId: input.req.requestId,
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent ?? null,
    },
  });
}

export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
  skillRating?: number;
  acceptTerms: boolean;
  req: Request;
}) {
  if (!input.acceptTerms) {
    throw AppError.unprocessable('You must accept the terms and privacy notice');
  }
  if (input.skillRating !== undefined) assertSkillValue(input.skillRating);
  assertPasswordPolicy(input.password);
  const passwordHash = await hashPassword(input.password);
  const metadata = requestMetadata(input.req);

  try {
    const now = new Date();
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          platformRole: 'USER',
          accountStatus: 'PENDING_APPROVAL',
          termsAcceptedAt: now,
          profile: {
            create: {
              displayName: input.name,
              skillRating: input.skillRating ?? 3.0,
            },
          },
          skillRatings: {
            create: {
              value: input.skillRating ?? 3.0,
              source: 'SELF_REPORTED',
            },
          },
          registrationReview: {
            create: {
              status: 'PENDING',
              submittedAt: now,
            },
          },
        },
        include: { profile: true },
      });
      await tx.administrativeAuditEvent.create({
        data: {
          actorId: created.id,
          targetUserId: created.id,
          action: 'registration.submitted',
          outcome: 'SUCCESS',
          entityType: 'RegistrationReview',
          entityId: created.id,
          summary: 'Registration submitted for approval',
          requestId: input.req.requestId,
          ip: metadata.ip ?? null,
          userAgent: metadata.userAgent ?? null,
        },
      });
      return created;
    });

    return {
      submitted: true,
      approvalRequired: true,
      status: 'PENDING_APPROVAL' as const,
      user: { name: user.name, email: user.email },
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Keep the public response identical so registration does not confirm
      // whether an email already has an account.
      await writeRegistrationAudit({
        action: 'registration.duplicate_attempt',
        outcome: 'DENIED',
        summary: 'Duplicate registration attempt',
        metadata: { emailHash: sha256(input.email) },
        req: input.req,
      }).catch((auditError: unknown) => {
        logger.warn({ err: auditError }, 'Failed to audit duplicate registration');
      });
      return {
        submitted: true,
        approvalRequired: true,
        status: 'PENDING_APPROVAL' as const,
        user: { name: input.name, email: input.email },
      };
    }
    throw error;
  }
}

export type LoginResult =
  | {
      restricted: false;
      token: string;
      csrfToken: string;
      expiresAt: Date;
      user: ReturnType<typeof toMe>;
    }
  | {
      restricted: true;
      status: 'PENDING_APPROVAL' | 'APPROVED_PENDING_ACTIVATION' | 'REJECTED';
      token: string;
      csrfToken: string;
      expiresAt: Date;
      registration: ReturnType<typeof registrationView>;
    }
  | {
      mfaRequired: true;
      setupRequired: boolean;
      token: string;
      expiresAt: Date;
    };

export async function loginUser(input: {
  email: string;
  password: string;
  req: Request;
}): Promise<LoginResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { profile: true, registrationReview: true },
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

  const metadata = requestMetadata(input.req);
  const state = loginStateFor(user, user.registrationReview);

  if (state.kind === 'DENIED') {
    throw AppError.forbidden('This account is not available. Contact support for assistance.');
  }

  if (state.kind === 'RESTRICTED') {
    const registration = await createRegistrationSession(user.id);
    await writeRegistrationAudit({
      actorId: user.id,
      targetUserId: user.id,
      action: 'registration.status_accessed',
      summary: 'Restricted registration status session issued',
      req: input.req,
    }).catch((error: unknown) => {
      logger.warn({ err: error }, 'Failed to audit restricted sign-in');
    });
    const context: RegistrationContext = {
      user,
      profile: user.profile,
      review: user.registrationReview,
      session: {
        id: '',
        csrfToken: registration.csrfToken,
        expiresAt: registration.expiresAt,
      },
    };
    return {
      restricted: true,
      status: state.status,
      token: registration.token,
      csrfToken: registration.csrfToken,
      expiresAt: registration.expiresAt,
      registration: registrationView(context),
    };
  }

  if (isSuperAdmin(user)) {
    if (user.mfaEnabled) {
      const challenge = await createMfaChallenge(user.id, 'LOGIN');
      return {
        mfaRequired: true,
        setupRequired: false,
        token: challenge.token,
        expiresAt: challenge.expiresAt,
      };
    }
    if (env.REQUIRE_SUPER_ADMIN_MFA) {
      const challenge = await createMfaChallenge(user.id, 'SETUP');
      return {
        mfaRequired: true,
        setupRequired: true,
        token: challenge.token,
        expiresAt: challenge.expiresAt,
      };
    }
  }

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
    restricted: false,
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

export function getRegistrationStatus(registration: RegistrationContext) {
  return {
    ...registrationView(registration),
    csrfToken: registration.session.csrfToken,
    expiresAt: registration.session.expiresAt.toISOString(),
  };
}

export async function activateRegistration(
  registration: RegistrationContext,
  input: { displayName?: string; skillRating?: number; acceptTerms: boolean },
  req: Request,
) {
  if (!input.acceptTerms) {
    throw AppError.unprocessable('You must accept the terms and privacy notice');
  }
  if (input.skillRating !== undefined) assertSkillValue(input.skillRating);
  if (registrationStatusOf(registration.review) !== 'APPROVED') {
    throw AppError.conflict('This registration has not been approved for activation');
  }
  if (accountStatusOf(registration.user) !== 'APPROVED_PENDING_ACTIVATION') {
    throw AppError.conflict('This account is not awaiting activation');
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.user.updateMany({
      where: {
        id: registration.user.id,
        accountStatus: 'APPROVED_PENDING_ACTIVATION',
      },
      data: {
        accountStatus: 'ACTIVE',
        activatedAt: now,
        termsAcceptedAt: registration.user.termsAcceptedAt ?? now,
      },
    });
    if (claimed.count === 0) {
      throw AppError.conflict('This account was already activated or is no longer eligible');
    }
    if (input.displayName !== undefined || input.skillRating !== undefined) {
      await tx.playerProfile.update({
        where: { userId: registration.user.id },
        data: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.skillRating !== undefined ? { skillRating: input.skillRating } : {}),
        },
      });
    }
    await tx.registrationSession.deleteMany({ where: { userId: registration.user.id } });
    await tx.administrativeAuditEvent.create({
      data: {
        actorId: registration.user.id,
        targetUserId: registration.user.id,
        action: 'account.activated',
        outcome: 'SUCCESS',
        entityType: 'User',
        entityId: registration.user.id,
        summary: 'Applicant completed activation',
        requestId: req.requestId,
      },
    });
  });

  await revokeAllSessions(registration.user.id);
  const metadata = requestMetadata(req);
  const session = await createAuthSession(registration.user.id, metadata);
  const full = await loadMeData(registration.user.id);
  return {
    user: toMe(full, full.profile, full.memberships, session.csrfToken),
    token: session.token,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

export async function claimAccount(
  input: { token: string; password: string; displayName?: string; acceptTerms: boolean },
  req: Request,
) {
  if (!input.acceptTerms) {
    throw AppError.unprocessable('You must accept the terms and privacy notice');
  }
  assertPasswordPolicy(input.password);
  const now = new Date();
  const record = await prisma.accountClaimToken.findUnique({
    where: { tokenHash: sha256(input.token) },
    include: { user: { include: { profile: true } } },
  });
  if (!record || record.consumedAt || record.expiresAt <= now) {
    throw AppError.badRequest('This account claim link is invalid or has expired');
  }
  if (accountStatusOf(record.user) !== 'APPROVED_PENDING_ACTIVATION') {
    throw AppError.conflict('This account is not awaiting activation');
  }
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.accountClaimToken.updateMany({
      where: {
        id: record.id,
        expiresAt: { gt: now },
        OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
      },
      data: { consumedAt: now },
    });
    if (claimed.count === 0) {
      throw AppError.badRequest('This account claim link is invalid or has expired');
    }
    const activated = await tx.user.updateMany({
      where: {
        id: record.userId,
        accountStatus: 'APPROVED_PENDING_ACTIVATION',
      },
      data: {
        passwordHash,
        accountStatus: 'ACTIVE',
        activatedAt: now,
        termsAcceptedAt: now,
      },
    });
    if (activated.count === 0) {
      throw AppError.conflict('This account is not awaiting activation');
    }
    if (input.displayName !== undefined) {
      await tx.playerProfile.update({
        where: { userId: record.userId },
        data: { displayName: input.displayName },
      });
    }
    await tx.accountClaimToken.updateMany({
      where: {
        userId: record.userId,
        OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
      },
      data: { consumedAt: now },
    });
    await tx.administrativeAuditEvent.create({
      data: {
        actorId: record.userId,
        targetUserId: record.userId,
        action: 'account.claim_redeemed',
        outcome: 'SUCCESS',
        entityType: 'User',
        entityId: record.userId,
        summary: 'Administratively created account claimed',
        requestId: req.requestId,
      },
    });
  });

  await revokeAllSessions(record.userId);
  const metadata = requestMetadata(req);
  const session = await createAuthSession(record.userId, metadata);
  const full = await loadMeData(record.userId);
  return {
    user: toMe(full, full.profile, full.memberships, session.csrfToken),
    token: session.token,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

export async function recoverAccount(
  input: { token: string; password: string },
  req: Request,
) {
  assertPasswordPolicy(input.password);
  const now = new Date();
  const record = await prisma.accountRecoveryToken.findUnique({
    where: { tokenHash: sha256(input.token) },
    include: { user: true },
  });
  if (!record || record.consumedAt || record.revokedAt || record.expiresAt <= now) {
    throw AppError.badRequest('This recovery link is invalid or has expired');
  }
  if (accountStatusOf(record.user) === 'DELETED') {
    throw AppError.badRequest('This account cannot be recovered');
  }
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.accountRecoveryToken.updateMany({
      where: {
        id: record.id,
        expiresAt: { gt: now },
        OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
      },
      data: { consumedAt: now },
    });
    if (claimed.count === 0) {
      throw AppError.badRequest('This recovery link is invalid or has expired');
    }
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await tx.administrativeAuditEvent.create({
      data: {
        actorId: record.userId,
        targetUserId: record.userId,
        action: 'account.recovery_redeemed',
        outcome: 'SUCCESS',
        entityType: 'User',
        entityId: record.userId,
        summary: 'Account recovery credential redeemed',
        requestId: req.requestId,
      },
    });
  });
  await revokeAllSessions(record.userId);
  await revokeRegistrationSessions(record.userId);
  return { reset: true };
}

export async function reauthenticate(req: Request, password: string) {
  const auth = req.auth;
  if (!auth) throw AppError.unauthorized();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw AppError.unauthorized('Password is incorrect');
  }
  const reauthenticatedAt = new Date();
  await prisma.authSession.update({
    where: { id: auth.session.id },
    data: { reauthenticatedAt },
  });
  await prisma.administrativeAuditEvent.create({
    data: {
      actorId: auth.user.id,
      targetUserId: auth.user.id,
      action: 'account.reauthenticated',
      outcome: 'SUCCESS',
      entityType: 'User',
      entityId: auth.user.id,
      summary: 'Administrator reauthenticated',
      requestId: req.requestId,
    },
  });
  return { reauthenticatedAt: reauthenticatedAt.toISOString() };
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
  if (!env.EXPOSE_DEV_TOKENS) {
    // No SMTP provider is configured. Do not start a silent self-service reset
    // that the user cannot complete; administrators use the recovery workflow.
    return { devResetToken: null, supportRequired: true };
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return { devResetToken: null };
  const token = await issueEmailToken(user.id, 'RESET_PASSWORD', RESET_TTL_MS);
  return { devResetToken: env.EXPOSE_DEV_TOKENS ? token.token : null };
}

export async function resetPassword(token: string, password: string) {
  assertPasswordPolicy(password);
  const record = await prisma.emailToken.findUnique({ where: { tokenHash: sha256(token) } });
  const now = new Date();
  if (
    !record ||
    record.type !== 'RESET_PASSWORD' ||
    record.usedAt ||
    record.expiresAt <= now
  ) {
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

export async function getLoginRestriction(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { registrationReview: true },
  });
  if (!user) return null;
  return {
    accountStatus: accountStatusOf(user),
    registrationStatus: registrationStatusOf(user.registrationReview),
    active: isActiveAccount(user),
  };
}
