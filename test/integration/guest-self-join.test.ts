import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/infrastructure/prisma.js';
import { sha256 } from '../../src/security/tokens.js';
import {
  app,
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

function guestPayload(name: string, clientKey: string) {
  return {
    displayName: name,
    gender: 'PREFER_NOT_TO_SAY',
    skillRating: 3.25,
    clientKey,
  };
}

async function checkInToken(sessionId: string) {
  const session = await prisma.playSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { checkInToken: true },
  });
  return session.checkInToken;
}

async function preview(token: string) {
  const response = await request(app).get(`/api/v1/public/checkins/${token}`).expect(200);
  return readJson<{
    join: { canGuestJoin: boolean; guestJoinEnabled: boolean; availability: string };
  }>(response);
}

function guestAgent() {
  return request.agent(app);
}

async function joinGuest(token: string, name: string, clientKey: string, agent = guestAgent()) {
  const response = await agent
    .post(`/api/v1/public/checkins/${token}/guests`)
    .send(guestPayload(name, clientKey));
  return { response, agent };
}

async function enableGuestJoin(owner: TestUser, sessionId: string) {
  const session = await owner.agent.get(`/api/v1/sessions/${sessionId}`).expect(200);
  const version = readJson<{ version: number }>(session).version;
  await owner.agent
    .patch(`/api/v1/sessions/${sessionId}/guest-policy`)
    .set('x-csrf-token', owner.csrf)
    .send({ guestJoinPolicy: 'OPEN', expectedVersion: version })
    .expect(200);
}

async function guestId(sessionId: string, clientKey: string) {
  const guest = await prisma.sessionGuest.findFirstOrThrow({
    where: { sessionId, clientKeyHash: sha256(clientKey) },
    select: { id: true },
  });
  return guest.id;
}

describe('guest QR self-joining', () => {
  it('is disabled by default, joins without an account when enabled, and handles duplicates and forged cookies', async () => {
    const owner = await registerUser('guest-join-owner');
    const club = await createClub(owner, 'Guest join club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 8,
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');
    const token = await checkInToken(session.id);

    expect((await preview(token)).join.canGuestJoin).toBe(false);
    const disabled = await joinGuest(token, 'Disabled Guest', 'client-disabled-0001');
    expect(disabled.response.status).toBe(409);
    expect(disabled.response.body.error.message).toMatch(/not enabled/i);
    expect(
      await prisma.sessionGuest.count({ where: { sessionId: session.id } }),
    ).toBe(0);

    await enableGuestJoin(owner, session.id);
    expect((await preview(token)).join.canGuestJoin).toBe(true);

    const first = await joinGuest(token, 'Alex Guest', 'client-alex-0000001');
    expect(first.response.status).toBe(201);
    const cookie = String(first.response.headers['set-cookie'] ?? '');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(first.response.body.data.queue.state).toBe('WAITING');
    expect(first.response.body.data.guest.displayName).toBe('Alex Guest');
    expect(JSON.stringify(first.response.body)).not.toContain('@example.test');

    const status = await first.agent.get(`/api/v1/public/checkins/${token}/guest`).expect(200);
    const statusData = readJson<{
      guest: { displayName: string; origin: string };
      queue: { state: string; position: number | null };
      session: { name: string };
    }>(status);
    expect(statusData.guest.displayName).toBe('Alex Guest');
    expect(statusData.guest.origin).toBe('SELF');
    expect(statusData.queue.state).toBe('WAITING');
    expect(statusData.queue.position).toBe(1);
    expect(statusData.session.name).toBe(session.name);

    // A repeat request from the same browser returns the existing guest.
    const repeat = await joinGuest(token, 'Alex Guest', 'client-alex-0000001', first.agent);
    expect(repeat.response.status).toBe(200);
    expect(repeat.response.body.data.created).toBe(false);
    expect(
      await prisma.sessionGuest.count({
        where: { sessionId: session.id, displayName: 'Alex Guest' },
      }),
    ).toBe(1);

    // A second tab with the same client key but no cookie cannot read the guest.
    const secondTab = await joinGuest(token, 'Alex Guest', 'client-alex-0000001');
    expect(secondTab.response.status).toBe(409);
    expect(
      await prisma.sessionGuest.count({
        where: { sessionId: session.id, displayName: 'Alex Guest' },
      }),
    ).toBe(1);

    // Identical names are allowed for genuinely different browsers; names are not identity.
    const namesake = await joinGuest(token, 'Alex Guest', 'client-alex-0000002');
    expect(namesake.response.status).toBe(201);
    expect(
      await prisma.sessionGuest.count({
        where: { sessionId: session.id, displayName: 'Alex Guest' },
      }),
    ).toBe(2);

    // Forged or unknown guest cookies are rejected.
    const forged = await request(app)
      .get(`/api/v1/public/checkins/${token}/guest`)
      .set('Cookie', `pq_guest_${session.id}=forged-token`)
      .expect(401);
    expect(forged.body.error.code).toBe('UNAUTHORIZED');

    // The QM can remove the guest; the terminal state remains readable but live data is gone.
    const removedId = await guestId(session.id, 'client-alex-0000001');
    await owner.agent
      .delete(`/api/v1/sessions/${session.id}/guests/${removedId}`)
      .set('x-csrf-token', owner.csrf)
      .expect(200);
    const removedStatus = await first.agent
      .get(`/api/v1/public/checkins/${token}/guest`)
      .expect(200);
    const removed = readJson<{ guest: { status: string }; queue: null; match: null }>(removedStatus);
    expect(removed.guest.status).toBe('REMOVED');
    expect(removed.queue).toBeNull();
    expect(removed.match).toBeNull();

    await first.agent
      .post(`/api/v1/public/checkins/${token}/guests`)
      .send(guestPayload('Alex Guest', 'client-alex-0000001'))
      .expect(409);
  });

  it('never exceeds capacity when two guests race for the final slot', async () => {    const owner = await registerUser('guest-capacity-owner');
    const club = await createClub(owner, 'Guest capacity club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 2,
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');
    const player = await registerUser('guest-capacity-player');
    await joinClub(player, club.id);
    await registerSession(player, session.id);
    await checkIn(player, session.id);
    await enableGuestJoin(owner, session.id);
    const token = await checkInToken(session.id);

    const [left, right] = await Promise.all([
      joinGuest(token, 'Racer One', 'client-racer-0000001'),
      joinGuest(token, 'Racer Two', 'client-racer-0000002'),
    ]);
    const statuses = [left.response.status, right.response.status].sort();
    expect(statuses).toEqual([201, 409]);
    const active = await prisma.sessionGuest.count({
      where: { sessionId: session.id, status: 'ACTIVE' },
    });
    expect(active).toBe(1);
  });

  it('requires self check-in before guest self-join can be enabled', async () => {
    const owner = await registerUser('guest-manager-owner');
    const club = await createClub(owner, 'Guest manager club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 8,
      checkInPolicy: 'MANAGER',
    });
    const detail = await owner.agent.get(`/api/v1/sessions/${session.id}`).expect(200);
    const version = readJson<{ version: number }>(detail).version;
    const response = await owner.agent
      .patch(`/api/v1/sessions/${session.id}/guest-policy`)
      .set('x-csrf-token', owner.csrf)
      .send({ guestJoinPolicy: 'OPEN', expectedVersion: version })
      .expect(409);
    expect(response.body.error.message).toMatch(/self-service|self check-in/i);
  });

  it('shares the final capacity slot with concurrent registered registration', async () => {
    const owner = await registerUser('guest-mixed-owner');
    const club = await createClub(owner, 'Guest mixed club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 2,
      guestJoinPolicy: 'OPEN',
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');
    const seeded = await registerUser('guest-mixed-seeded');
    await joinClub(seeded, club.id);
    await registerSession(seeded, session.id);
    await checkIn(seeded, session.id);
    const challenger = await registerUser('guest-mixed-challenger');
    await joinClub(challenger, club.id);
    const token = await checkInToken(session.id);

    const [registered, guest] = await Promise.all([
      challenger.agent
        .post(`/api/v1/sessions/${session.id}/register`)
        .set('x-csrf-token', challenger.csrf)
        .send({}),
      joinGuest(token, 'Mixed Racer', 'client-mixed-racer-01'),
    ]);
    const statuses = [registered.status, guest.response.status].sort();
    expect(statuses).toEqual([201, 409]);
    const registrations = await prisma.sessionRegistration.count({
      where: { sessionId: session.id, status: { in: ['PENDING', 'REGISTERED', 'CHECKED_IN'] } },
    });
    const guests = await prisma.sessionGuest.count({
      where: { sessionId: session.id, status: 'ACTIVE' },
    });
    expect(registrations + guests).toBeLessThanOrEqual(2);
  });

  it('rejects a closed session, keeps a joined guest’s ended status, and rejects an expired credential', async () => {
    const owner = await registerUser('guest-closed-owner');
    const club = await createClub(owner, 'Guest closed club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 8,
      guestJoinPolicy: 'OPEN',
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');
    const token = await checkInToken(session.id);
    const joined = await joinGuest(token, 'Closed Guest', 'client-closed-000001');
    expect(joined.response.status).toBe(201);

    await transition(owner, session.id, 'CANCELLED');
    const closed = await joinGuest(token, 'Late Guest', 'client-closed-late-1');
    expect(closed.response.status).toBe(409);
    expect(closed.response.body.error.message).toMatch(/cancelled/i);

    const ended = await joined.agent
      .get(`/api/v1/public/checkins/${token}/guest`)
      .expect(200);
    const endedData = readJson<{ session: { status: string }; canLeave: boolean }>(ended);
    expect(endedData.session.status).toBe('CANCELLED');
    expect(endedData.canLeave).toBe(false);

    const guest = await prisma.sessionGuest.findFirstOrThrow({
      where: { sessionId: session.id, displayName: 'Closed Guest' },
    });
    await prisma.sessionGuest.update({
      where: { id: guest.id },
      data: { guestAccessExpiresAt: new Date(Date.now() - 60_000) },
    });
    const expired = await joined.agent
      .get(`/api/v1/public/checkins/${token}/guest`)
      .expect(401);
    expect(expired.body.error.code).toBe('UNAUTHORIZED');
  });

  it('shows the guest’s own court, team and completed result without exposing account data', async () => {
    const owner = await registerUser('guest-match-owner');
    const club = await createClub(owner, 'Guest match club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      capacity: 8,
      guestJoinPolicy: 'OPEN',
    });
    await transition(owner, session.id, 'CHECK_IN_OPEN');
    const token = await checkInToken(session.id);

    const guests = await Promise.all(
      ['Match One', 'Match Two', 'Match Three', 'Match Four'].map((name, index) =>
        joinGuest(token, name, `client-match-000000${index}`),
      ),
    );
    for (const guest of guests) expect(guest.response.status).toBe(201);
    await transition(owner, session.id, 'LIVE');

    const preview = await previewRotation(owner, session.id);
    const commit = await owner.agent
      .post(`/api/v1/sessions/${session.id}/rotations/commit`)
      .set('x-csrf-token', owner.csrf)
      .set('idempotency-key', `guest-commit-${preview.rotationId}`)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const committed = readJson<{ matches: Array<{ id: string; status: string }> }>(commit);
    expect(committed.matches).toHaveLength(1);

    const before = await guests[0]!.agent
      .get(`/api/v1/public/checkins/${token}/guest`)
      .expect(200);
    const beforeData = readJson<{
      match: { state: string; courtName: string; yourTeam: string[] } | null;
      session: { name: string };
    }>(before);
    expect(beforeData.match?.courtName).toBe('Court 1');
    expect(beforeData.match?.yourTeam.length).toBeGreaterThan(0);
    expect(JSON.stringify(before.body)).not.toContain('@example.test');

    const matchId = committed.matches[0]!.id;
    await owner.agent
      .post(`/api/v1/matches/${matchId}/start`)
      .set('x-csrf-token', owner.csrf)
      .send({})
      .expect(200);
    let version = (
      await owner.agent.get(`/api/v1/matches/${matchId}`).expect(200)
    ).body.data.version as number;
    for (let point = 1; point <= 11; point += 1) {
      const response = await owner.agent
        .post(`/api/v1/matches/${matchId}/score-events`)
        .set('x-csrf-token', owner.csrf)
        .set('idempotency-key', `guest-point-${matchId}-${point}`)
        .send({ team: 'A', expectedVersion: version })
        .expect(201);
      version = readJson<{ match: { version: number } }>(response).match.version;
    }
    await owner.agent
      .post(`/api/v1/matches/${matchId}/complete`)
      .set('x-csrf-token', owner.csrf)
      .set('idempotency-key', `guest-complete-${matchId}`)
      .send({ expectedVersion: version })
      .expect(201);

    const after = await guests[0]!.agent
      .get(`/api/v1/public/checkins/${token}/guest`)
      .expect(200);
    const afterData = readJson<{
      match: { state: string; courtName: string } | null;
      lastResult: { courtName: string; yourTeam: string[]; winnerTeam: string } | null;
    }>(after);
    const result = afterData.match ?? afterData.lastResult;
    expect(result).toBeTruthy();
    if (!result) throw new Error('Expected a guest match or result');
    if ('courtName' in result) expect(result.courtName).toBe('Court 1');
    expect(JSON.stringify(after.body)).not.toContain('@example.test');
  });
});
