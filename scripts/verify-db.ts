import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();
const suffix = randomUUID();
const syntheticUserId = randomUUID().replaceAll('-', '').slice(0, 24);

async function main(): Promise<void> {
  const committedKey = `verify-commit-${suffix}`;
  const rolledBackKey = `verify-rollback-${suffix}`;

  await prisma.$transaction(async (tx) => {
    await tx.idempotencyRecord.create({
      data: {
        key: committedKey,
        userId: syntheticUserId,
        endpoint: 'verification',
        requestHash: 'commit',
        status: 'COMPLETED',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  });

  let rolledBack = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.idempotencyRecord.create({
        data: {
          key: rolledBackKey,
          userId: syntheticUserId,
          endpoint: 'verification',
          requestHash: 'rollback',
          status: 'PROCESSING',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      throw new Error('intentional rollback');
    });
  } catch (error) {
    rolledBack = error instanceof Error && error.message === 'intentional rollback';
  }

  const committed = await prisma.idempotencyRecord.findFirst({ where: { key: committedKey } });
  const absent = await prisma.idempotencyRecord.findFirst({ where: { key: rolledBackKey } });

  console.log(`MongoDB transaction commit: ${committed ? 'PASS' : 'FAIL'}`);
  console.log(`MongoDB transaction rollback: ${rolledBack && absent === null ? 'PASS' : 'FAIL'}`);

  await prisma.idempotencyRecord.deleteMany({ where: { key: committedKey } });

  if (!committed || !rolledBack || absent !== null) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
