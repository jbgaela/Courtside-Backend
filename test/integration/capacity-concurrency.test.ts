import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/prisma.js';
import {
  checkIn,
  createClub,
  createCourt,
  createSession,
  joinClub,
  registerSession,
  registerUser,
  transition,
} from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

const ACTIVE_REGISTRATION_STATUSES = ['PENDING', 'REGISTERED', 'CHECKED_IN'];

async function activeRegistrationCount(sessionId: string): Promise<number> {
  return prisma.sessionRegistration.count({
    where: { sessionId, status: { in: ACTIVE_REGISTRATION_STATUSES } },
  });
}

describe('session capacity under concurrent load', () => {
  it('allows exactly one registration when many players race for the final slot', async () => {
    const owner = await registerUser('capacity-owner');
    const club = await createClub(owner, 'Capacity club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 2,
      registrationPolicy: 'OPEN',
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');

    const seeded = await registerUser('capacity-seeded');
    await joinClub(seeded, club.id);
    await registerSession(seeded, session.id);
    expect(await activeRegistrationCount(session.id)).toBe(1);

    const contenders = [];
    for (let index = 0; index < 12; index += 1) {
      const player = await registerUser(`capacity-racer-${index}`);
      await joinClub(player, club.id);
      contenders.push(player);
    }

    const responses = await Promise.all(
      contenders.map((player) =>
        player.agent
          .post(`/api/v1/sessions/${session.id}/register`)
          .set('x-csrf-token', player.csrf)
          .send({}),
      ),
    );
    const created = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status === 409);

    expect({
      created: created.length,
      other: responses.length - created.length - rejected.length,
    }).toEqual({ created: 1, other: 0 });

    const persisted = await activeRegistrationCount(session.id);
    expect(persisted).toBeLessThanOrEqual(2);
    expect(persisted).toBe(2);
  });

  it('does not overbook through concurrent guest creation', async () => {
    const owner = await registerUser('guest-capacity-owner');
    const club = await createClub(owner, 'Guest capacity club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 2,
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');

    const seeded = await registerUser('guest-capacity-seeded');
    await joinClub(seeded, club.id);
    await registerSession(seeded, session.id);
    await checkIn(seeded, session.id);

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        owner.agent
          .post(`/api/v1/sessions/${session.id}/guests`)
          .set('x-csrf-token', owner.csrf)
          .send({
            displayName: `Guest racer ${index}`,
            gender: 'PREFER_NOT_TO_SAY',
            skillRating: 3,
            addToQueue: true,
          }),
      ),
    );
    const created = responses.filter((response) => response.status === 201);
    expect(created).toHaveLength(1);
    expect(responses.filter((response) => response.status >= 500)).toHaveLength(0);

    const registrations = await activeRegistrationCount(session.id);
    const guests = await prisma.sessionGuest.count({
      where: { sessionId: session.id, status: 'ACTIVE' },
    });
    expect(registrations + guests).toBeLessThanOrEqual(2);
  });

  it('does not let an admin re-check-in a withdrawn player beyond capacity', async () => {
    const owner = await registerUser('withdrawn-owner');
    const club = await createClub(owner, 'Withdrawn club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 2,
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');

    const first = await registerUser('withdrawn-first');
    const second = await registerUser('withdrawn-second');
    const replacement = await registerUser('withdrawn-replacement');
    for (const player of [first, second]) {
      await joinClub(player, club.id);
      await registerSession(player, session.id);
    }
    await joinClub(replacement, club.id);
    await checkIn(first, session.id);
    await checkIn(second, session.id);

    // The second player leaves, freeing a slot. A replacement takes it.
    await second.agent
      .post(`/api/v1/sessions/${session.id}/leave`)
      .set('x-csrf-token', second.csrf)
      .send({})
      .expect(200);
    await registerSession(replacement, session.id);
    await checkIn(replacement, session.id);

    const rejected = await owner.agent
      .post(`/api/v1/sessions/${session.id}/checkins`)
      .set('x-csrf-token', owner.csrf)
      .send({ userId: second.id, reason: 'Re-add withdrawn player' })
      .expect(409);
    expect(rejected.body.error.message).toMatch(/full/i);

    const registrations = await activeRegistrationCount(session.id);
    const guests = await prisma.sessionGuest.count({
      where: { sessionId: session.id, status: 'ACTIVE' },
    });
    expect(registrations + guests).toBeLessThanOrEqual(2);
  });

  it('does not overbook through concurrent manager walk-in check-ins', async () => {
    const owner = await registerUser('walkin-owner');
    const club = await createClub(owner, 'Walk-in club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 2,
      checkInPolicy: 'SELF_AND_MANAGER',
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');

    const seeded = await registerUser('walkin-seeded');
    await joinClub(seeded, club.id);
    await registerSession(seeded, session.id);
    await checkIn(seeded, session.id);

    const walkIns = [];
    for (let index = 0; index < 8; index += 1) {
      const player = await registerUser(`walkin-racer-${index}`);
      await joinClub(player, club.id);
      walkIns.push(player);
    }

    const responses = await Promise.all(
      walkIns.map((player) =>
        owner.agent
          .post(`/api/v1/sessions/${session.id}/checkins`)
          .set('x-csrf-token', owner.csrf)
          .send({ userId: player.id, reason: 'Concurrent walk-in test' }),
      ),
    );
    const accepted = responses.filter((response) => response.status === 200);

    expect(accepted).toHaveLength(1);
    expect(await activeRegistrationCount(session.id)).toBeLessThanOrEqual(2);
  });
});
