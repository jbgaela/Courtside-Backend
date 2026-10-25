/**
 * Backfills the polymorphic participant identity added for guest players.
 *
 * Run this before `prisma db push` on a database that already contains queue
 * entries or match participants. The new unique indexes use participantId, so
 * every existing document needs a value before the index is created.
 *
 *   1. Backup the database.
 *   2. pnpm --filter @picklequeue/api db:migrate:guests
 *   3. pnpm --filter @picklequeue/api db:push
 *
 * The script uses raw MongoDB updates so it does not depend on the new fields
 * being readable by the currently generated Prisma client.
 */
import { prisma } from '../src/infrastructure/prisma.js';

interface UpdateResult {
  n?: number;
  nModified?: number;
}

async function backfill(collection: string): Promise<void> {
  const identity = (await prisma.$runCommandRaw({
    update: collection,
    updates: [
      {
        q: { participantId: { $exists: false } },
        u: [
          {
            $set: {
              participantId: '$userId',
              participantType: { $ifNull: ['$participantType', 'REGISTERED'] },
            },
          },
        ],
        multi: true,
      },
    ],
  })) as UpdateResult;

  const typeOnly = (await prisma.$runCommandRaw({
    update: collection,
    updates: [
      {
        q: { participantType: { $exists: false } },
        u: [{ $set: { participantType: 'REGISTERED' } }],
        multi: true,
      },
    ],
  })) as UpdateResult;

  console.log(
    `${collection}: identity=${identity.nModified ?? 0}, type=${typeOnly.nModified ?? 0}`,
  );
}

async function main(): Promise<void> {
  await backfill('QueueEntry');
  await backfill('MatchParticipant');
  console.log('Participant identity backfill complete. Run prisma db push next.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
