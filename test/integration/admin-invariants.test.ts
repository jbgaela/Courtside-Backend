import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/prisma.js';
import { createSuperAdminUser } from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

async function activeSuperAdminCount(): Promise<number> {
  return prisma.user.count({
    where: {
      platformRole: 'SUPER_ADMIN',
      accountStatus: 'ACTIVE',
      OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
    },
  });
}

describe('platform administration invariants', () => {
  it('cannot lose every active Super Admin through concurrent conflicting suspensions', async () => {
    const first = await createSuperAdminUser('race-a');
    const second = await createSuperAdminUser('race-b');

    // Make the race deterministic: only these two administrators are active.
    await prisma.user.updateMany({
      where: { platformRole: 'SUPER_ADMIN', id: { notIn: [first.id, second.id] } },
      data: { platformRole: 'USER', accountStatus: 'DELETED', deletedAt: new Date() },
    });

    try {
      expect(await activeSuperAdminCount()).toBe(2);
      const [firstSuspend, secondSuspend] = await Promise.all([
        first.agent
          .post(`/api/v1/admin/users/${second.id}/suspend`)
          .set('x-csrf-token', first.csrf)
          .send({ reason: 'Concurrent suspension A' }),
        second.agent
          .post(`/api/v1/admin/users/${first.id}/suspend`)
          .set('x-csrf-token', second.csrf)
          .send({ reason: 'Concurrent suspension B' }),
      ]);

      // Both may succeed when the guard is read outside the write transaction.
      // Whatever happens, at least one administrator must remain active.
      expect([firstSuspend.status, secondSuspend.status]).toEqual(
        expect.arrayContaining([expect.any(Number)]),
      );
      const remaining = await activeSuperAdminCount();
      expect(remaining).toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: [first.id, second.id] } },
        data: {
          platformRole: 'SUPER_ADMIN',
          accountStatus: 'ACTIVE',
          deletedAt: null,
        },
      });
    }
  });
});
