import 'dotenv/config';
import { prisma } from '../src/infrastructure/prisma.js';
import { revokeAllSessions } from '../src/auth/session.js';

async function main() {
  if (!process.env.NODE_ENV) throw new Error('NODE_ENV is required');
  if (process.env.CONFIRM_SUPER_ADMIN_PROMOTION !== 'PROMOTE-EXISTING-USER') {
    throw new Error(
      'Set CONFIRM_SUPER_ADMIN_PROMOTION=PROMOTE-EXISTING-USER to confirm this controlled operation',
    );
  }
  const email = process.env.TARGET_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('TARGET_SUPER_ADMIN_EMAIL is required');
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('Target account does not exist');
  if (user.accountStatus !== 'ACTIVE') {
    throw new Error('Target account must be active before promotion');
  }
  if (user.platformRole === 'SUPER_ADMIN') {
    throw new Error('Target is already a Super Admin');
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { platformRole: 'SUPER_ADMIN' },
  });
  await revokeAllSessions(user.id);
  await prisma.administrativeAuditEvent.create({
    data: {
      actorId: user.id,
      targetUserId: user.id,
      action: 'super_admin.promoted_by_operator',
      outcome: 'SUCCESS',
      entityType: 'User',
      entityId: user.id,
      summary: 'Existing user promoted through controlled operator CLI',
      requestId: 'super-admin-promotion-cli',
    },
  });
  console.log(JSON.stringify({ email, platformRole: 'SUPER_ADMIN', sessionsRevoked: true }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
