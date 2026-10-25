import 'dotenv/config';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/infrastructure/prisma.js';
import { assertPasswordPolicy } from '../src/security/password.js';

const schema = z.object({
  BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().trim().toLowerCase().email(),
  BOOTSTRAP_SUPER_ADMIN_PASSWORD: z.string().min(8).max(128),
  BOOTSTRAP_SUPER_ADMIN_NAME: z.string().trim().min(2).max(80).default('Super Admin'),
});

async function main() {
  if (!process.env.NODE_ENV) throw new Error('NODE_ENV is required');
  const input = schema.parse(process.env);
  assertPasswordPolicy(input.BOOTSTRAP_SUPER_ADMIN_PASSWORD);
  const existingSuperAdmins = await prisma.user.count({
    where: { platformRole: 'SUPER_ADMIN', accountStatus: 'ACTIVE', deletedAt: null },
  });
  if (existingSuperAdmins > 0) {
    throw new Error('Bootstrap refused: an active Super Admin already exists');
  }
  const existing = await prisma.user.findUnique({
    where: { email: input.BOOTSTRAP_SUPER_ADMIN_EMAIL },
  });
  if (existing) {
    throw new Error(
      'Bootstrap refused: the email already belongs to an account; use the reviewed provisioning procedure',
    );
  }
  const passwordHash = await bcrypt.hash(input.BOOTSTRAP_SUPER_ADMIN_PASSWORD, 12);
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: input.BOOTSTRAP_SUPER_ADMIN_EMAIL,
        name: input.BOOTSTRAP_SUPER_ADMIN_NAME,
        passwordHash,
        platformRole: 'SUPER_ADMIN',
        accountStatus: 'ACTIVE',
        activatedAt: new Date(),
        emailVerifiedAt: null,
        profile: {
          create: { displayName: input.BOOTSTRAP_SUPER_ADMIN_NAME, skillRating: 3 },
        },
      },
    });
    await tx.administrativeAuditEvent.create({
      data: {
        actorId: created.id,
        targetUserId: created.id,
        action: 'super_admin.bootstrapped',
        outcome: 'SUCCESS',
        entityType: 'User',
        entityId: created.id,
        summary: 'Initial Super Admin provisioned through bootstrap CLI',
        requestId: 'bootstrap-cli',
      },
    });
    return created;
  });
  console.log(JSON.stringify({ id: user.id, email: user.email, platformRole: user.platformRole }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
