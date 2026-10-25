import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { prisma } from '../../src/infrastructure/prisma.js';
import { app } from './helpers.js';
import {
  checkIn,
  createClub,
  createCourt,
  createSession,
  joinClub,
  previewRotation,
  readJson,
  registerSession,
  registerUser,
  transition,
  type TestUser,
} from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

interface GuestResponse {
  guest: {
    id: string;
    sessionId: string;
    displayName: string;
    gender: string;
    skillRating: number;
    participantType: 'GUEST';
    status: string;
    version: number;
    queueState: string | null;
  };
  version: number;
}

interface ParticipantRow {
  participantId: string;
  participantType: 'REGISTERED' | 'GUEST';
  userId: string | null;
  guestId: string | null;
  displayName: string;
  gender: string | null;
  queueState: string | null;
  status: string;
}

function guestBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    displayName: 'Juan Dela Cruz',
    gender: 'MALE',
    skillRating: 3.25,
    addToQueue: true,
    ...overrides,
  };
}

function addGuest(
  owner: TestUser,
  sessionId: string,
  body: Record<string, unknown> = guestBody(),
  key = `guest-${randomUUID()}`,
) {
  return owner.agent
    .post(`/api/v1/sessions/${sessionId}/guests`)
    .set('x-csrf-token', owner.csrf)
    .set('idempotency-key', key)
    .send(body);
}

async function setupOpenSession(capacity = 12) {
  const owner = await registerUser('guestowner');
  const club = await createClub(owner, 'Guest Club');
  const court = await createCourt(owner, club.id, 'Court 1');
  const session = await createSession(owner, club.id, {
    courtIds: [court.id],
    capacity,
    name: `Guest Session ${randomUUID().slice(0, 6)}`,
  });
  await transition(owner, session.id, 'CHECK_IN_OPEN');
  return { owner, club, court, session };
}

async function setupMixedLiveSession() {
  const owner = await registerUser('mixedowner');
  const club = await createClub(owner, 'Mixed Club');
  const court = await createCourt(owner, club.id, 'Court 1');
  const session = await createSession(owner, club.id, { courtIds: [court.id] });
  await transition(owner, session.id, 'CHECK_IN_OPEN');

  const players: TestUser[] = [];
  for (let index = 0; index < 2; index += 1) {
    const player = await registerUser(`mixedplayer${index + 1}`);
    await joinClub(player, club.id);
    await registerSession(player, session.id);
    await checkIn(player, session.id);
    players.push(player);
  }
  return { owner, club, court, session, players };
}

async function scoreToWin(owner: TestUser, matchId: string, points = 11) {
  const start = await owner.agent
    .post(`/api/v1/matches/${matchId}/start`)
    .set('x-csrf-token', owner.csrf)
    .send({})
    .expect(200);
  let version = readJson<{ match: { version: number } }>(start).match.version;

  for (let point = 1; point <= points; point += 1) {
    const response = await owner.agent
      .post(`/api/v1/matches/${matchId}/score-events`)
      .set('x-csrf-token', owner.csrf)
      .set('idempotency-key', `guest-point-${matchId}-${point}`)
      .send({ team: 'A', expectedVersion: version })
      .expect(201);
    version = readJson<{ match: { version: number } }>(response).match.version;
  }

  const complete = await owner.agent
    .post(`/api/v1/matches/${matchId}/complete`)
    .set('x-csrf-token', owner.csrf)
    .set('idempotency-key', `guest-complete-${matchId}`)
    .send({ expectedVersion: version })
    .expect(201);
  return readJson<{ match: { id: string; status: string } }>(complete).match;
}

describe('guest players', () => {
  it('creates a guest, queues atomically, deduplicates retries and lists the participant', async () => {
    const setup = await setupOpenSession();
    const key = `guest-create-${randomUUID()}`;
    const created = await addGuest(setup.owner, setup.session.id, guestBody(), key).expect(201);
    const result = readJson<GuestResponse>(created);
    expect(result.guest.displayName).toBe('Juan Dela Cruz');
    expect(result.guest.participantType).toBe('GUEST');
    expect(result.guest.gender).toBe('MALE');
    expect(result.guest.skillRating).toBe(3.25);
    expect(result.guest.queueState).toBe('WAITING');

    const retried = await addGuest(setup.owner, setup.session.id, guestBody(), key).expect(201);
    expect(readJson<GuestResponse>(retried).guest.id).toBe(result.guest.id);
    expect(await prisma.sessionGuest.count({ where: { sessionId: setup.session.id } })).toBe(1);

    const board = await setup.owner.agent
      .get(`/api/v1/sessions/${setup.session.id}/registrations`)
      .expect(200);
    const data = readJson<{
      registrations: ParticipantRow[];
      guests: ParticipantRow[];
      participants: ParticipantRow[];
      counts: Record<string, number>;
      capacity: number;
    }>(board);
    expect(data.registrations).toHaveLength(0);
    expect(data.guests).toHaveLength(1);
    expect(data.participants).toHaveLength(1);
    expect(data.participants[0]?.participantType).toBe('GUEST');
    expect(data.counts.guests).toBe(1);
    expect(data.counts.CHECKED_IN).toBe(1);
    expect(data.capacity).toBe(12);

    const queue = await setup.owner.agent
      .get(`/api/v1/sessions/${setup.session.id}/queue`)
      .expect(200);
    const snapshot = readJson<{
      counts: { checkedIn: number; guests: number };
      queue: Array<{
        participantType: string;
        userId: string | null;
        guestId: string | null;
        gender: string | null;
      }>;
    }>(queue);
    expect(snapshot.counts.guests).toBe(1);
    expect(snapshot.counts.checkedIn).toBe(1);
    expect(snapshot.queue[0]?.participantType).toBe('GUEST');
    expect(snapshot.queue[0]?.userId).toBeNull();
    expect(snapshot.queue[0]?.guestId).toBe(result.guest.id);
    expect(snapshot.queue[0]?.gender).toBe('MALE');

    const live = await setup.owner.agent
      .get(`/api/v1/sessions/${setup.session.id}/live`)
      .expect(200);
    expect(readJson<{ session: { checkedIn: number; guests: number } }>(live).session.guests).toBe(
      1,
    );

    const audit = await prisma.auditEvent.findFirst({
      where: { sessionId: setup.session.id, action: 'guest.created' },
    });
    expect(audit?.actorId).toBe(setup.owner.id);
    expect((audit?.metadata as { guestId?: string } | null)?.guestId).toBe(result.guest.id);
  });

  it('enforces permissions, session windows and input validation', async () => {
    const setup = await setupOpenSession();
    const outsider = await registerUser('guestoutsider');
    await outsider.agent
      .post(`/api/v1/sessions/${setup.session.id}/guests`)
      .set('x-csrf-token', outsider.csrf)
      .send(guestBody())
      .expect(403);

    await addGuest(setup.owner, setup.session.id, guestBody({ gender: undefined })).expect(422);
    await addGuest(setup.owner, setup.session.id, guestBody({ skillRating: 3.1 })).expect(422);
    await addGuest(setup.owner, setup.session.id, guestBody({ displayName: '   ' })).expect(422);

    const scheduledOwner = await registerUser('scheduledowner');
    const scheduledClub = await createClub(scheduledOwner, 'Scheduled Club');
    const scheduledCourt = await createCourt(scheduledOwner, scheduledClub.id, 'Court 1');
    const scheduled = await createSession(scheduledOwner, scheduledClub.id, {
      courtIds: [scheduledCourt.id],
    });
    await addGuest(scheduledOwner, scheduled.id).expect(409);

    const otherOwner = await registerUser('otherguestowner');
    await createClub(otherOwner, 'Other Club');
    await otherOwner.agent
      .post(`/api/v1/sessions/${setup.session.id}/guests`)
      .set('x-csrf-token', otherOwner.csrf)
      .send(guestBody())
      .expect(403);
  });

  it('runs a mixed registered and guest match through court, score and history', async () => {
    const setup = await setupMixedLiveSession();
    const firstGuest = readJson<GuestResponse>(
      await addGuest(setup.owner, setup.session.id, guestBody()).expect(201),
    );
    const secondGuest = readJson<GuestResponse>(
      await addGuest(
        setup.owner,
        setup.session.id,
        guestBody({ displayName: 'Maria Santos', gender: 'FEMALE', skillRating: 3.5 }),
      ).expect(201),
    );

    await transition(setup.owner, setup.session.id, 'LIVE');
    const preview = await previewRotation(setup.owner, setup.session.id);
    expect(preview.assignments).toHaveLength(1);
    const selected = [
      ...preview.assignments[0]!.teamA.map((player) => player.userId),
      ...preview.assignments[0]!.teamB.map((player) => player.userId),
    ];
    expect(selected).toHaveLength(4);
    for (const player of setup.players) expect(selected).toContain(player.id);
    expect(selected).toContain(firstGuest.guest.id);
    expect(selected).toContain(secondGuest.guest.id);

    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', `guest-commit-${preview.rotationId}`)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const match = readJson<{ matches: Array<{ id: string }> }>(commit).matches[0]!;
    const participants = await prisma.matchParticipant.findMany({ where: { matchId: match.id } });
    expect(participants).toHaveLength(4);
    expect(participants.filter((row) => row.participantType === 'GUEST')).toHaveLength(2);
    expect(participants.filter((row) => row.participantType === 'REGISTERED')).toHaveLength(2);
    expect(participants.filter((row) => row.guestId).map((row) => row.displayName)).toEqual(
      expect.arrayContaining(['Juan Dela Cruz', 'Maria Santos']),
    );

    await setup.owner.agent
      .patch(`/api/v1/sessions/${setup.session.id}/guests/${firstGuest.guest.id}`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ skillRating: 4 })
      .expect(409);
    await setup.owner.agent
      .delete(`/api/v1/sessions/${setup.session.id}/guests/${firstGuest.guest.id}`)
      .set('x-csrf-token', setup.owner.csrf)
      .expect(409);
    await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/guests/${firstGuest.guest.id}/enqueue`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({})
      .expect(409);
    const renamed = await setup.owner.agent
      .patch(`/api/v1/sessions/${setup.session.id}/guests/${firstGuest.guest.id}`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ displayName: 'Juan D. Cruz' })
      .expect(200);
    expect(readJson<GuestResponse>(renamed).guest.displayName).toBe('Juan D. Cruz');

    await scoreToWin(setup.owner, match.id);

    const completedGuest = await prisma.sessionGuest.findUniqueOrThrow({
      where: { id: firstGuest.guest.id },
    });
    const skillUpdate = await setup.owner.agent
      .patch(`/api/v1/sessions/${setup.session.id}/guests/${firstGuest.guest.id}`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ skillRating: 4, expectedVersion: completedGuest.version })
      .expect(200);
    expect(readJson<GuestResponse>(skillUpdate).guest.skillRating).toBe(4);

    const queueAfter = await prisma.queueEntry.findMany({
      where: {
        sessionId: setup.session.id,
        participantType: 'GUEST',
      },
    });
    expect(queueAfter.every((row) => row.gamesPlayed === 1)).toBe(true);

    await setup.owner.agent
      .delete(`/api/v1/sessions/${setup.session.id}/guests/${firstGuest.guest.id}`)
      .set('x-csrf-token', setup.owner.csrf)
      .expect(200);
    const duplicateRemoval = await setup.owner.agent
      .delete(`/api/v1/sessions/${setup.session.id}/guests/${firstGuest.guest.id}`)
      .set('x-csrf-token', setup.owner.csrf)
      .expect(200);
    expect(duplicateRemoval.body.data.alreadyRemoved).toBe(true);

    const removed = await prisma.sessionGuest.findUniqueOrThrow({
      where: { id: firstGuest.guest.id },
    });
    expect(removed.status).toBe('REMOVED');
    expect(
      await prisma.matchParticipant.count({ where: { matchId: match.id, guestId: removed.id } }),
    ).toBe(1);

    const results = await setup.owner.agent
      .get(`/api/v1/sessions/${setup.session.id}/results`)
      .expect(200);
    const resultRows = results.body.data as Array<{
      teams: { A: Array<{ displayName: string }>; B: Array<{ displayName: string }> };
    }>;
    const names = resultRows.flatMap((row) => [
      ...row.teams.A.map((player) => player.displayName),
      ...row.teams.B.map((player) => player.displayName),
    ]);
    // The match keeps the snapshot from when it was created, even after the
    // guest was renamed and later removed from the session.
    expect(names).toEqual(expect.arrayContaining(['Juan Dela Cruz', 'Maria Santos']));

    const publicPage = await request(app)
      .get(`/api/v1/public/sessions/${setup.session.publicId}`)
      .expect(200);
    const publicNames = (
      publicPage.body.data.results as Array<{
        teams: { A: Array<{ name: string }>; B: Array<{ name: string }> };
      }>
    ).flatMap((row) => [
      ...row.teams.A.map((player) => player.name),
      ...row.teams.B.map((player) => player.name),
    ]);
    // Public projections reduce full names to first name + surname initial.
    expect(publicNames).toEqual(expect.arrayContaining(['Juan C.', 'Maria S.']));

    const participantBoard = await setup.owner.agent
      .get(`/api/v1/sessions/${setup.session.id}/registrations`)
      .expect(200);
    const board = readJson<{ guests: ParticipantRow[] }>(participantBoard);
    expect(board.guests.some((row) => row.guestId === removed.id)).toBe(false);
  });

  it('supports an all-guest match and simultaneous enqueue retries', async () => {
    const setup = await setupOpenSession();
    const guests: GuestResponse[] = [];
    for (let index = 0; index < 4; index += 1) {
      guests.push(
        readJson<GuestResponse>(
          await addGuest(
            setup.owner,
            setup.session.id,
            guestBody({
              displayName: `Guest ${index + 1}`,
              gender: index % 2 === 0 ? 'FEMALE' : 'MALE',
              skillRating: 3 + index * 0.25,
            }),
          ).expect(201),
        ),
      );
    }

    await transition(setup.owner, setup.session.id, 'LIVE');
    const preview = await previewRotation(setup.owner, setup.session.id);
    expect(preview.assignments).toHaveLength(1);
    const selected = [
      ...preview.assignments[0]!.teamA.map((player) => player.userId),
      ...preview.assignments[0]!.teamB.map((player) => player.userId),
    ];
    for (const guest of guests) expect(selected).toContain(guest.guest.id);

    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', `guest-only-commit-${preview.rotationId}`)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const matchId = readJson<{ matches: Array<{ id: string }> }>(commit).matches[0]!.id;
    const matchParticipants = await prisma.matchParticipant.findMany({ where: { matchId } });
    expect(matchParticipants).toHaveLength(4);
    expect(matchParticipants.every((row) => row.participantType === 'GUEST')).toBe(true);
    expect(matchParticipants.every((row) => row.userId === null)).toBe(true);

    // A fresh guest is queued exactly once even when two requests race.
    const extra = readJson<GuestResponse>(
      await addGuest(
        setup.owner,
        setup.session.id,
        guestBody({ displayName: 'Race Guest', addToQueue: false }),
      ).expect(201),
    );
    const [first, second] = await Promise.all([
      setup.owner.agent
        .post(`/api/v1/sessions/${setup.session.id}/guests/${extra.guest.id}/enqueue`)
        .set('x-csrf-token', setup.owner.csrf)
        .send({}),
      setup.owner.agent
        .post(`/api/v1/sessions/${setup.session.id}/guests/${extra.guest.id}/enqueue`)
        .set('x-csrf-token', setup.owner.csrf)
        .send({}),
    ]);
    expect([200, 201]).toContain(first.status);
    expect([200, 201]).toContain(second.status);
    expect(
      await prisma.queueEntry.count({
        where: { sessionId: setup.session.id, participantId: extra.guest.id },
      }),
    ).toBe(1);
  });
});
