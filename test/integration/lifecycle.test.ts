import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import { prisma } from '../../src/infrastructure/prisma.js';
import {
  checkIn,
  createClub,
  createCourt,
  createSession,
  joinClub,
  previewRotation,
  registerSession,
  registerUser,
  transition,
} from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

interface RegistrationRow {
  id: string;
  userId: string;
  email: string;
  status: string;
}

describe('session lifecycle and queue controls', () => {
  it('enforces approval, capacity, pause/resume and cancellation', async () => {
    const owner = await registerUser('lifecycle');
    const club = await createClub(owner, 'Lifecycle');
    const court = await createCourt(owner, club.id, 'Court 1');
    const players = [];
    for (let index = 0; index < 5; index += 1) {
      const player = await registerUser(`life${index + 1}`);
      await joinClub(player, club.id);
      players.push(player);
    }
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 4,
      registrationPolicy: 'APPROVAL',
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');

    for (const player of players.slice(0, 4)) {
      const registration = await registerSession(player, session.id);
      expect(registration.status).toBe('PENDING');
    }
    const fifth = await players[4]!.agent
      .post(`/api/v1/sessions/${session.id}/register`)
      .set('x-csrf-token', players[4]!.csrf)
      .send({})
      .expect(409);
    expect(fifth.body.error.message).toMatch(/full/i);

    const blockedCheckIn = await players[0]!.agent
      .post(`/api/v1/sessions/${session.id}/checkins`)
      .set('x-csrf-token', players[0]!.csrf)
      .send({})
      .expect(409);
    expect(blockedCheckIn.body.error.message).toMatch(/approval/i);

    const registrationsResponse = await owner.agent
      .get(`/api/v1/sessions/${session.id}/registrations`)
      .expect(200);
    const registrations = registrationsResponse.body.data.registrations as RegistrationRow[];
    expect(registrations).toHaveLength(4);
    for (const registration of registrations) {
      await owner.agent
        .patch(`/api/v1/sessions/${session.id}/registrations/${registration.id}`)
        .set('x-csrf-token', owner.csrf)
        .send({ action: 'APPROVE' })
        .expect(200);
    }
    for (const player of players.slice(0, 4)) {
      await checkIn(player, session.id);
    }

    await transition(owner, session.id, 'LIVE');
    const afterLive = await owner.agent.get(`/api/v1/sessions/${session.id}`).expect(200);
    const liveVersion = afterLive.body.data.version as number;
    const updateAfterLive = await owner.agent
      .patch(`/api/v1/sessions/${session.id}`)
      .set('x-csrf-token', owner.csrf)
      .send({ name: 'Renamed After Start', expectedVersion: liveVersion })
      .expect(409);
    expect(updateAfterLive.body.error.code).toBe('CONFLICT');

    const paused = await players[0]!.agent
      .post(`/api/v1/sessions/${session.id}/queue/pause`)
      .set('x-csrf-token', players[0]!.csrf)
      .send({})
      .expect(200);
    expect(paused.body.data.state).toBe('PAUSED');
    const queueWhilePaused = await players[0]!.agent
      .get(`/api/v1/sessions/${session.id}/queue`)
      .expect(200);
    expect(queueWhilePaused.body.data.self.state).toBe('PAUSED');

    const resumed = await players[0]!.agent
      .post(`/api/v1/sessions/${session.id}/queue/resume`)
      .set('x-csrf-token', players[0]!.csrf)
      .send({})
      .expect(200);
    expect(resumed.body.data.state).toBe('WAITING');

    const refreshed = await owner.agent.get(`/api/v1/sessions/${session.id}`).expect(200);
    const preview = await previewRotation(owner, session.id);
    expect(preview.assignments).toHaveLength(1);
    await owner.agent
      .post(`/api/v1/sessions/${session.id}/rotations/commit`)
      .set('x-csrf-token', owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    void refreshed;

    const completeBlocked = await owner.agent
      .post(`/api/v1/sessions/${session.id}/status`)
      .set('x-csrf-token', owner.csrf)
      .send({ status: 'COMPLETED' })
      .expect(409);
    expect(completeBlocked.body.error.message).toMatch(/active matches/i);

    const cancelled = await owner.agent
      .post(`/api/v1/sessions/${session.id}/status`)
      .set('x-csrf-token', owner.csrf)
      .send({ status: 'CANCELLED', force: true, reason: 'Weather' })
      .expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(
      await prisma.match.count({
        where: { sessionId: session.id, status: { in: ['READY', 'IN_PROGRESS'] } },
      }),
    ).toBe(0);
    expect(
      await prisma.queueEntry.count({
        where: { sessionId: session.id, state: { not: 'LEFT' } },
      }),
    ).toBe(0);
    const releasedCourt = await prisma.court.findUniqueOrThrow({ where: { id: court.id } });
    expect(releasedCourt.status).toBe('AVAILABLE');
  });

  it('requires a Queue Master when the check-in policy is MANAGER', async () => {
    const owner = await registerUser('managerpolicy');
    const club = await createClub(owner, 'ManagerPolicy');
    const court = await createCourt(owner, club.id, 'Court 1');
    const player = await registerUser('managedplayer');
    await joinClub(player, club.id);
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      checkInPolicy: 'MANAGER',
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');
    await registerSession(player, session.id);

    const self = await player.agent
      .post(`/api/v1/sessions/${session.id}/checkins`)
      .set('x-csrf-token', player.csrf)
      .send({})
      .expect(403);
    expect(self.body.error.message).toMatch(/Queue Master/i);

    await checkIn(owner, session.id, player.id);
    const queue = await prisma.queueEntry.findUnique({
      where: {
        sessionId_participantId: { sessionId: session.id, participantId: player.id },
      },
    });
    expect(queue?.state).toBe('WAITING');
  });

  it('supports authenticated QR check-in without treating the token as identity', async () => {
    const owner = await registerUser('qrowner');
    const club = await createClub(owner, 'QR');
    const court = await createCourt(owner, club.id, 'Court 1');
    const player = await registerUser('qrplayer');
    const outsider = await registerUser('qroutsider');
    await joinClub(player, club.id);
    await joinClub(outsider, club.id);
    const session = await createSession(owner, club.id, { courtIds: [court.id] });
    await transition(owner, session.id, 'CHECK_IN_OPEN');
    await registerSession(player, session.id);

    const link = await owner.agent.get(`/api/v1/sessions/${session.id}/public-link`).expect(200);
    const token = link.body.data.checkInToken as string;

    await request(app).post('/api/v1/checkins/qr').send({ token }).expect(401);

    await player.agent
      .post('/api/v1/checkins/qr')
      .set('x-csrf-token', player.csrf)
      .send({ token })
      .expect(200);
    await player.agent
      .post(`/api/v1/sessions/${session.id}/checkins`)
      .set('x-csrf-token', player.csrf)
      .send({})
      .expect(200);

    const playerEntry = await prisma.queueEntry.findUnique({
      where: {
        sessionId_participantId: { sessionId: session.id, participantId: player.id },
      },
    });
    expect(playerEntry?.state).toBe('WAITING');
    const outsiderEntry = await prisma.queueEntry.findUnique({
      where: {
        sessionId_participantId: { sessionId: session.id, participantId: outsider.id },
      },
    });
    expect(outsiderEntry).toBeNull();
  });
});
