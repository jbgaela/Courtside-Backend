import type { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../infrastructure/prisma.js';
import { randomToken, sha256 } from '../security/tokens.js';

export interface IssuedAccountToken {
  token: string;
  expiresAt: Date;
}

type TokenDb = typeof prisma | Prisma.TransactionClient;

export async function issueClaimToken(
  userId: string,
  createdById: string,
  db: TokenDb = prisma,
): Promise<IssuedAccountToken> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.CLAIM_TTL_HOURS * 60 * 60 * 1000);
  const now = new Date();
  await db.accountClaimToken.updateMany({
    where: {
      userId,
      OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
    },
    data: { consumedAt: now },
  });
  await db.accountClaimToken.create({
    data: { userId, tokenHash: sha256(token), expiresAt, createdById },
  });
  return { token, expiresAt };
}

export async function issueRecoveryToken(
  userId: string,
  createdById: string,
): Promise<IssuedAccountToken> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.RECOVERY_TTL_MINUTES * 60 * 1000);
  const now = new Date();
  await prisma.accountRecoveryToken.updateMany({
    where: {
      userId,
      OR: [{ consumedAt: null }, { consumedAt: { isSet: false } }],
    },
    data: { revokedAt: now },
  });
  await prisma.accountRecoveryToken.create({
    data: { userId, tokenHash: sha256(token), expiresAt, createdById },
  });
  return { token, expiresAt };
}
