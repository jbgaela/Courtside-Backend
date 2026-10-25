import 'dotenv/config';
import { prisma } from '../src/infrastructure/prisma.js';
import { revokeAllSessions } from '../src/auth/session.js';

async function main() {
  if (!process.env.NODE_ENV) throw new Error('NODE_ENV is required');
  if (process.env.CONFIRM_MFA_RESET !== 'RESET-MFA') {
    throw new Error('Set CONFIRM_MFA_RESET=RESET-MFA to confirm this controlled operation');
  }
  const email = process.env.TARGET_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('TARGET_SUPER_ADMIN_EMAIL is required');
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.platformRole !== 'SUPER_ADMIN') {
    throw new Error('Target is not a Super Admin');
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null },
  });
  await revokeAllSessions(user.id);
  await prisma.administrativeAuditEvent.create({
    data: {
      actorId: user.id,
      targetUserId: user.id,
      action: 'mfa.reset_by_operator',
      outcome: 'SUCCESS',
      entityType: 'User',
      entityId: user.id,
      summary: 'Super Admin MFA reset through controlled operator CLI',
      requestId: 'mfa-reset-cli',
    },
  });
  console.log(JSON.stringify({ email, mfaEnabled: false }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
