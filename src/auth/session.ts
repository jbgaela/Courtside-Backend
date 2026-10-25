import type { Request } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { logger } from '../infrastructure/logger.js';
import { randomToken, sha256 } from '../security/tokens.js';
import { readSessionCookie } from './cookies.js';
import { revokeSocketSession } from '../realtime/gateway.js';
import { accountStatusOf } from '../accounts/state.js';

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createAuthSession(
  userId: string,
  metadata: { ip?: string | null; userAgent?: string | null },
): Promise<CreatedSession> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.authSession.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfToken,
      expiresAt,
      reauthenticatedAt: new Date(),
      ip: metadata.ip ?? null,
      userAgent: metadata.userAgent?.slice(0, 300) ?? null,
    },
  });

  return { token, csrfToken, expiresAt };
}

export async function attachAuth(req: Request): Promise<void> {
  const token = readSessionCookie(req.cookies as Record<string, string | undefined>);
  if (!token) return;

  const record = await prisma.authSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { profile: true } } },
  });

  if (!record) return;
  const idleMs = env.SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
  if (
    record.revokedAt ||
    record.expiresAt.getTime() <= Date.now() ||
    accountStatusOf(record.user) !== 'ACTIVE'
  ) {
    return;
  }
  if (Date.now() - record.lastUsedAt.getTime() > idleMs) {
    void prisma.authSession
      .update({ where: { id: record.id }, data: { revokedAt: new Date() } })
      .catch((error: unknown) => logger.warn({ err: error }, 'Failed to revoke idle session'));
    return;
  }

  req.auth = {
    user: record.user,
    profile: record.user.profile,
    session: {
      id: record.id,
      csrfToken: record.csrfToken,
      expiresAt: record.expiresAt,
      reauthenticatedAt: record.reauthenticatedAt,
    },
  };

  if (Date.now() - record.lastUsedAt.getTime() > 5 * 60 * 1000) {
    void prisma.authSession
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch((error: unknown) =>
        logger.warn({ err: error }, 'Failed to update session lastUsedAt'),
      );
  }
}

export function requireAuth(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}

/**
 * Legacy route guard name retained for compatibility. Email ownership is
 * informational in the approval-first model; the active account and club
 * authorization checks are the authoritative access gates.
 */
export function requireVerifiedEmail(req: Request): NonNullable<Request['auth']> {
  return requireAuth(req);
}

export async function revokeCurrentSession(req: Request): Promise<void> {
  if (!req.auth) return;
  await prisma.authSession.update({
    where: { id: req.auth.session.id },
    data: { revokedAt: new Date() },
  });
  revokeSocketSession(req.auth.session.id);
}

export async function revokeAllSessions(userId: string, exceptId?: string): Promise<void> {
  const sessions = await prisma.authSession.findMany({
    where: {
      userId,
      OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  await prisma.authSession.updateMany({
    where: {
      userId,
      OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  for (const session of sessions) revokeSocketSession(session.id);
}
