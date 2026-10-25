import 'dotenv/config';
import { prisma } from '../src/infrastructure/prisma.js';

async function main() {
  if (!process.env.NODE_ENV) throw new Error('NODE_ENV is required');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const now = new Date();
  const command = {
    update: 'User',
    updates: [
      {
        q: { accountStatus: { $exists: false } },
        u: { $set: { accountStatus: 'ACTIVE', activatedAt: now } },
      },
      {
        q: { platformRole: { $exists: false } },
        u: { $set: { platformRole: 'USER' } },
      },
      {
        q: { sessionVersion: { $exists: false } },
        u: { $set: { sessionVersion: 0 } },
      },
      {
        q: { mfaEnabled: { $exists: false } },
        u: { $set: { mfaEnabled: false } },
      },
    ],
    ordered: false,
  } as const;

  const result = await prisma.$runCommandRaw(command);
  console.log(JSON.stringify({ migration: 'legacy-account-lifecycle', result, completedAt: now }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
