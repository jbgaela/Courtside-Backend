import type { Request } from 'express';
import type { PlayerProfile, User } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { randomToken, sha256 } from '../security/tokens.js';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from '../security/mfa.js';
import { isActiveAccount, isSuperAdmin } from '../accounts/state.js';
import { readMfaCookie } from './cookies.js';
import { revokeAllSessions } from './session.js';

export interface MfaContext {
  user: User & { profile: PlayerProfile | null };
  challengeId: string;
  purpose: 'LOGIN' | 'SETUP';
  expiresAt: Date;
}

export interface CreatedMfaChallenge {
  token: string;
  expiresAt: Date;
}

export async function createMfaChallenge(
  userId: string,
  purpose: 'LOGIN' | 'SETUP',
): Promise<CreatedMfaChallenge> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.MFA_CHALLENGE_TTL_MINUTES * 60 * 1000);
  await prisma.mfaChallenge.updateMany({
    where: {
      userId,
      purpose,
      OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
    },
    data: { consumedAt: new Date() },
  });
  await prisma.mfaChallenge.create({
    data: { userId, purpose, tokenHash: sha256(token), expiresAt },
  });
  return { token, expiresAt };
}

export async function attachMfa(req: Request): Promise<void> {
  const token = readMfaCookie(req.cookies as Record<string, string | undefined>);
  if (!token) return;
  const challenge = await prisma.mfaChallenge.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { profile: true } } },
  });
  if (!challenge || challenge.expiresAt.getTime() <= Date.now() || challenge.consumedAt) {
    return;
  }
  if (!isActiveAccount(challenge.user) || !isSuperAdmin(challenge.user)) return;
  req.mfa = {
    user: challenge.user,
    challengeId: challenge.id,
    purpose: challenge.purpose === 'SETUP' ? 'SETUP' : 'LOGIN',
    expiresAt: challenge.expiresAt,
  };
}

export function requireMfaChallenge(req: Request): MfaContext {
  if (!req.mfa) {
    throw AppError.unauthorized('Complete sign-in again to continue');
  }
  return req.mfa;
}

export function requireMfaActor(req: Request): { user: User & { profile: PlayerProfile | null } } {
  if (req.auth) {
    if (!isSuperAdmin(req.auth.user)) throw AppError.forbidden('Super Admin access is required');
    return { user: { ...req.auth.user, profile: req.auth.profile } };
  }
  const challenge = requireMfaChallenge(req);
  return { user: challenge.user };
}

export async function setupMfa(req: Request) {
  const { user } = requireMfaActor(req);
  if (user.mfaEnabled) throw AppError.conflict('MFA is already enabled for this account');
  if (!env.MFA_ENCRYPTION_KEY) {
    throw AppError.unavailable('Super Admin MFA is not configured on this deployment');
  }
  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaSecret: encryptMfaSecret(secret),
      mfaEnabled: false,
      mfaEnrolledAt: null,
    },
  });
  await prisma.administrativeAuditEvent.create({
    data: {
      actorId: user.id,
      targetUserId: user.id,
      action: 'mfa.setup_started',
      outcome: 'SUCCESS',
      entityType: 'User',
      entityId: user.id,
      summary: 'MFA enrollment started',
      requestId: req.requestId,
    },
  });
  return { secret, otpauthUri: otpauthUri(secret, user.email) };
}

export async function enableMfa(req: Request, code: string) {
  const actor = requireMfaActor(req);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.user.id } });
  if (user.mfaEnabled) throw AppError.conflict('MFA is already enabled for this account');
  if (!user.mfaSecret) throw AppError.conflict('Start MFA setup before verifying a code');
  const secret = decryptMfaSecret(user.mfaSecret);
  if (!verifyTotp(secret, code)) {
    throw AppError.unauthorized('The authenticator code is incorrect');
  }
  const challenge = req.mfa;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
    });
    if (challenge) {
      await tx.mfaChallenge.updateMany({
        where: {
          id: challenge.challengeId,
          OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
        },
        data: { consumedAt: new Date() },
      });
    }
    await tx.administrativeAuditEvent.create({
      data: {
        actorId: user.id,
        targetUserId: user.id,
        action: 'mfa.enabled',
        outcome: 'SUCCESS',
        entityType: 'User',
        entityId: user.id,
        summary: 'Super Admin MFA enabled',
        requestId: req.requestId,
      },
    });
  });
  await revokeAllSessions(user.id, req.auth?.session.id);
  const full = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    include: { profile: true, memberships: { include: { club: true } } },
  });
  return { user: full, fromChallenge: Boolean(challenge) };
}

export async function verifyMfaLogin(req: Request, code: string) {
  const challenge = requireMfaChallenge(req);
  if (challenge.purpose !== 'LOGIN') {
    throw AppError.forbidden('This challenge is not a login challenge');
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: challenge.user.id },
    include: { profile: true, memberships: { include: { club: true } } },
  });
  if (!user.mfaEnabled || !user.mfaSecret) {
    throw AppError.conflict('MFA is not enabled for this account');
  }
  if (!verifyTotp(decryptMfaSecret(user.mfaSecret), code)) {
    await prisma.administrativeAuditEvent.create({
      data: {
        actorId: user.id,
        targetUserId: user.id,
        action: 'mfa.login_failed',
        outcome: 'DENIED',
        entityType: 'User',
        entityId: user.id,
        summary: 'Incorrect Super Admin MFA code',
        requestId: req.requestId,
      },
    });
    throw AppError.unauthorized('The authenticator code is incorrect');
  }
  const claimed = await prisma.mfaChallenge.updateMany({
    where: {
      id: challenge.challengeId,
      expiresAt: { gt: new Date() },
      OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
    },
    data: { consumedAt: new Date() },
  });
  if (claimed.count === 0) throw AppError.unauthorized('This MFA challenge has expired');
  await prisma.administrativeAuditEvent.create({
    data: {
      actorId: user.id,
      targetUserId: user.id,
      action: 'mfa.login_verified',
      outcome: 'SUCCESS',
      entityType: 'User',
      entityId: user.id,
      summary: 'Super Admin MFA login verified',
      requestId: req.requestId,
    },
  });
  return { user };
}

export async function getMfaStatus(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { mfaEnabled: true, mfaEnrolledAt: true },
  });
  return {
    enabled: user.mfaEnabled,
    enrolledAt: user.mfaEnrolledAt?.toISOString() ?? null,
    requiredInProduction: env.REQUIRE_SUPER_ADMIN_MFA,
  };
}
