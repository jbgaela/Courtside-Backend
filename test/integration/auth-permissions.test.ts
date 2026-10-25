import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/infrastructure/prisma.js';
import {
  PASSWORD,
  app,
  checkIn,
  createClub,
  createCourt,
  createSession,
  joinClub,
  registerUser,
  setupLiveSession,
  transition,
} from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('authentication and authorization', () => {
  it('registers, verifies, logs in and returns CSRF-protected sessions', async () => {
    const user = await registerUser('auth');
    const me = await user.agent.get('/api/v1/auth/me').expect(200);
    const meData = me.body.data as { email: string; emailVerified: boolean; csrfToken: string };
    expect(meData.email).toBe(user.email);
    expect(meData.emailVerified).toBe(true);
    expect(meData.csrfToken).toBe(user.csrf);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);
    expect(login.headers['set-cookie']).toBeDefined();

    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'WrongPassword123!' })
      .expect(401);
    expect(wrong.body.error.code).toBe('UNAUTHORIZED');
  });

  it('blocks unauthenticated access and missing CSRF tokens', async () => {
    await request(app).get('/api/v1/users/me/profile').expect(401);
    const user = await registerUser('csrf');
    const blocked = await user.agent
      .post('/api/v1/clubs')
      .send({ name: 'No CSRF Club' })
      .expect(403);
    expect(blocked.body.error.code).toBe('FORBIDDEN');
  });

  it('requires a verified email for privileged creation', async () => {
    const agent = request.agent(app);
    const email = `unverified.${Date.now()}@example.test`;
    const register = await agent
      .post('/api/v1/auth/register')
      .send({ name: 'Unverified Player', email, password: PASSWORD })
      .expect(201);
    const csrf = register.body.data.csrfToken as string;
    const blocked = await agent
      .post('/api/v1/clubs')
      .set('x-csrf-token', csrf)
      .send({ name: 'Should Not Exist' })
      .expect(403);
    expect(blocked.body.error.message).toMatch(/verify/i);

    const token = register.body.data.devVerificationToken as string;
    await agent
      .post('/api/v1/auth/verify-email')
      .set('x-csrf-token', csrf)
      .send({ token })
      .expect(200);
    await agent
      .post('/api/v1/clubs')
      .set('x-csrf-token', csrf)
      .send({ name: `Verified Club ${Date.now()}` })
      .expect(201);
  });

  it('scopes club administration and prevents cross-club access', async () => {
    const owner = await registerUser('owner');
    const outsider = await registerUser('outsider');
    const player = await registerUser('member');
    const club = await createClub(owner, 'Scoped');
    const court = await createCourt(owner, club.id, 'Court A');
    await joinClub(player, club.id);

    const session = await createSession(owner, club.id, { courtIds: [court.id] });

    await player.agent
      .post(`/api/v1/clubs/${club.id}/courts`)
      .set('x-csrf-token', player.csrf)
      .send({ name: 'Player Court' })
      .expect(403);
    await player.agent
      .post(`/api/v1/sessions/${session.id}/status`)
      .set('x-csrf-token', player.csrf)
      .send({ status: 'CHECK_IN_OPEN' })
      .expect(403);
    await outsider.agent.get(`/api/v1/sessions/${session.id}`).expect(403);
    await outsider.agent.get(`/api/v1/clubs/${club.id}/members`).expect(403);
    await owner.agent.get(`/api/v1/clubs/${club.id}/members`).expect(200);
  });

  it('does not leak private data through public session pages', async () => {
    const setup = await setupLiveSession(8, 2);
    const publicResponse = await request(app)
      .get(`/api/v1/public/sessions/${setup.session.publicId}`)
      .expect(200);
    const raw = JSON.stringify(publicResponse.body);
    expect(publicResponse.body.data).toBeTruthy();
    expect(raw).not.toContain('@example.test');
    expect(raw).not.toContain('"email"');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('checkInToken');
    expect(publicResponse.body.data.courts.length).toBe(2);
    expect(publicResponse.body.data.status).toBe('LIVE');
    expect(publicResponse.body.data.counts.checkedIn).toBe(8);

    const unpublishedOwner = await registerUser('private');
    const privateClub = await createClub(unpublishedOwner, 'Private');
    const privateCourt = await createCourt(unpublishedOwner, privateClub.id, 'Court P');
    const privateSession = await createSession(unpublishedOwner, privateClub.id, {
      courtIds: [privateCourt.id],
      published: false,
    });
    await request(app).get(`/api/v1/public/sessions/${privateSession.publicId}`).expect(404);
  });

  it('rejects malformed identifiers and invalid state transitions', async () => {
    const owner = await registerUser('ids');
    const club = await createClub(owner, 'Ids');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, { courtIds: [court.id] });
    await request(app).get('/api/v1/sessions/not-an-id').expect(401);
    await owner.agent.get('/api/v1/sessions/not-an-id').expect(404);
    const invalid = await owner.agent
      .post(`/api/v1/sessions/${session.id}/status`)
      .set('x-csrf-token', owner.csrf)
      .send({ status: 'LIVE' })
      .expect(409);
    expect(invalid.body.error.code).toBe('CONFLICT');

    await transition(owner, session.id, 'CHECK_IN_OPEN');
    const backward = await owner.agent
      .post(`/api/v1/sessions/${session.id}/status`)
      .set('x-csrf-token', owner.csrf)
      .send({ status: 'SCHEDULED' })
      .expect(409);
    expect(backward.body.error.code).toBe('CONFLICT');
  });

  it('prevents duplicate check-ins and registrations', async () => {
    const setup = await setupLiveSession(8, 2);
    const player = setup.players[0]!;
    const duplicateRegistration = await player.agent
      .post(`/api/v1/sessions/${setup.session.id}/register`)
      .set('x-csrf-token', player.csrf)
      .send({})
      .expect(409);
    expect(duplicateRegistration.body.error.code).toBe('CONFLICT');

    const duplicateCheckIn = await checkIn(player, setup.session.id);
    expect(duplicateCheckIn.alreadyCheckedIn).toBe(true);
    const entries = await prisma.queueEntry.count({
      where: { sessionId: setup.session.id, userId: player.id },
    });
    expect(entries).toBe(1);
  });

  it('isolates read access to the club a user belongs to', async () => {
    const owner = await registerUser('isoowner');
    const club = await createClub(owner, 'Iso');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, { courtIds: [court.id] });
    await owner.agent.get(`/api/v1/sessions/${session.id}`).expect(200);

    const outsider = await registerUser('isoother');
    await outsider.agent.get(`/api/v1/sessions/${session.id}`).expect(403);
    await outsider.agent.get(`/api/v1/clubs/${club.id}/courts`).expect(403);
  });
});
