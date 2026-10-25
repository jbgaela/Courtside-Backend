import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';

export const app = createApp();
export type Agent = ReturnType<typeof request.agent>;

export const PASSWORD = 'TestPassword123!';
let counter = 0;

export interface TestUser {
  agent: Agent;
  id: string;
  email: string;
  name: string;
  csrf: string;
  verifyToken: string | null;
}

function body<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

export async function registerUser(label: string): Promise<TestUser> {
  counter += 1;
  const suffix = `${randomUUID().slice(0, 8)}-${counter}`;
  const email = `pq.${label}.${suffix}@example.test`;
  const name = `${label} ${counter}`;
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/register')
    .send({ name, email, password: PASSWORD })
    .expect(201);
  const data = body<{
    user: { id: string; csrfToken: string };
    csrfToken: string;
    devVerificationToken: string | null;
  }>(response);

  await agent
    .post('/api/v1/auth/verify-email')
    .set('x-csrf-token', data.csrfToken)
    .send({ token: data.devVerificationToken })
    .expect(200);

  return {
    agent,
    id: data.user.id,
    email,
    name,
    csrf: data.csrfToken,
    verifyToken: data.devVerificationToken,
  };
}

export async function loginUser(email: string, password = PASSWORD): Promise<TestUser> {
  const agent = request.agent(app);
  const response = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
  const data = body<{
    user: { id: string; csrfToken: string };
    csrfToken: string;
  }>(response);
  return {
    agent,
    id: data.user.id,
    email,
    name: '',
    csrf: data.csrfToken,
    verifyToken: null,
  };
}

export async function createClub(owner: TestUser, label = 'Club') {
  const response = await owner.agent
    .post('/api/v1/clubs')
    .set('x-csrf-token', owner.csrf)
    .send({
      name: `${label} ${randomUUID().slice(0, 6)}`,
      description: 'Integration test club',
      location: 'Test courts',
      joinPolicy: 'OPEN',
    })
    .expect(201);
  return body<{ id: string; slug: string; name: string; viewerRole: string }>(response);
}

export async function createCourt(owner: TestUser, clubId: string, name: string) {
  const response = await owner.agent
    .post(`/api/v1/clubs/${clubId}/courts`)
    .set('x-csrf-token', owner.csrf)
    .send({ name, sortOrder: 0 })
    .expect(201);
  return body<{ id: string; name: string; status: string }>(response);
}

export async function joinClub(player: TestUser, clubId: string) {
  await player.agent
    .post(`/api/v1/clubs/${clubId}/join`)
    .set('x-csrf-token', player.csrf)
    .send({})
    .expect(201);
}

export interface SessionOptions {
  published?: boolean;
  registrationPolicy?: 'OPEN' | 'APPROVAL' | 'INVITE_ONLY';
  checkInPolicy?: 'SELF' | 'MANAGER' | 'SELF_AND_MANAGER';
  capacity?: number;
  format?: 'SINGLES' | 'DOUBLES';
  autoAssign?: boolean;
  courtIds: string[];
  name?: string;
}

export async function createSession(owner: TestUser, clubId: string, options: SessionOptions) {
  const now = Date.now();
  const response = await owner.agent
    .post(`/api/v1/clubs/${clubId}/sessions`)
    .set('x-csrf-token', owner.csrf)
    .send({
      name: options.name ?? `Test Session ${randomUUID().slice(0, 6)}`,
      description: 'Integration session',
      venue: 'Test venue',
      startsAt: new Date(now + 60 * 60 * 1000).toISOString(),
      endsAt: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
      capacity: options.capacity ?? 24,
      format: options.format ?? 'DOUBLES',
      registrationPolicy: options.registrationPolicy ?? 'OPEN',
      checkInPolicy: options.checkInPolicy ?? 'SELF',
      published: options.published ?? true,
      allowLateArrivals: true,
      courtIds: options.courtIds,
      matchmaking: {
        autoAssign: options.autoAssign ?? false,
        minRestMinutes: 0,
        preferredSkillSpread: 1.5,
        maxSkillSpread: 2.5,
      },
      scoring: { targetScore: 11, winByTwo: true, bestOf: 1 },
    })
    .expect(201);
  return body<{
    id: string;
    status: string;
    version: number;
    publicId: string;
    published: boolean;
    viewerRole: string;
  }>(response);
}

export async function transition(
  owner: TestUser,
  sessionId: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  const response = await owner.agent
    .post(`/api/v1/sessions/${sessionId}/status`)
    .set('x-csrf-token', owner.csrf)
    .send({ status, ...extra })
    .expect(200);
  return body<{ id: string; status: string; version: number }>(response);
}

export async function registerSession(player: TestUser, sessionId: string) {
  const response = await player.agent
    .post(`/api/v1/sessions/${sessionId}/register`)
    .set('x-csrf-token', player.csrf)
    .send({})
    .expect(201);
  return body<{ id: string; status: string; version: number }>(response);
}

export async function checkIn(player: TestUser, sessionId: string, targetUserId?: string) {
  const response = await player.agent
    .post(`/api/v1/sessions/${sessionId}/checkins`)
    .set('x-csrf-token', player.csrf)
    .send(targetUserId ? { userId: targetUserId } : {})
    .expect(200);
  return body<{ version: number; alreadyCheckedIn: boolean }>(response);
}

export interface LiveSetup {
  owner: TestUser;
  club: { id: string; slug: string; name: string; viewerRole: string };
  players: TestUser[];
  session: { id: string; publicId: string; version: number };
  courts: Array<{ id: string; name: string; status: string }>;
}

export async function setupLiveSession(
  playerCount = 8,
  courtCount = 2,
  options: { autoAssign?: boolean } = {},
): Promise<LiveSetup> {
  const owner = await registerUser('owner');
  const club = await createClub(owner, 'Ace');
  const courts: Array<{ id: string; name: string; status: string }> = [];
  for (let index = 0; index < courtCount; index += 1) {
    courts.push(await createCourt(owner, club.id, `Court ${index + 1}`));
  }
  const players: TestUser[] = [];
  for (let index = 0; index < playerCount; index += 1) {
    const player = await registerUser(`player${index + 1}`);
    await joinClub(player, club.id);
    players.push(player);
  }
  const session = await createSession(owner, club.id, {
    courtIds: courts.map((court) => court.id),
    autoAssign: options.autoAssign ?? false,
  });
  await transition(owner, session.id, 'CHECK_IN_OPEN');
  for (const [index, player] of players.entries()) {
    await registerSession(player, session.id);
    await checkIn(player, session.id);
    void index;
  }
  await transition(owner, session.id, 'LIVE');
  const refreshed = await owner.agent.get(`/api/v1/sessions/${session.id}`).expect(200);
  const detail = body<{ version: number }>(refreshed);
  return {
    owner,
    club,
    players,
    session: { id: session.id, publicId: session.publicId, version: detail.version },
    courts,
  };
}

export async function previewRotation(owner: TestUser, sessionId: string) {
  const response = await owner.agent
    .post(`/api/v1/sessions/${sessionId}/rotations/preview`)
    .set('x-csrf-token', owner.csrf)
    .send({})
    .expect(201);
  return body<{
    rotationId: string;
    sessionVersion: number;
    assignments: Array<{
      id: string;
      courtId: string;
      teamA: Array<{ userId: string; displayName: string }>;
      teamB: Array<{ userId: string; displayName: string }>;
    }>;
    bench: Array<{ userId: string; displayName: string }>;
    warnings: string[];
  }>(response);
}

export function readJson<T>(response: request.Response): T {
  return body<T>(response);
}
