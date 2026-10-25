import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { io as createSocket, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { PASSWORD, app, previewRotation, setupLiveSession } from './helpers.js';
import { prisma } from '../../src/infrastructure/prisma.js';
import { closeRealtime, initRealtime } from '../../src/realtime/gateway.js';
import { frontendOrigins } from '../../src/config/env.js';
import { maybeAutoRotate } from '../../src/matchmaking/service.js';

const allowedOrigin = frontendOrigins[0] ?? 'http://localhost:3000';

let server: Server;
let socketUrl: string;

function cookieFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  if (!first) throw new Error('Expected a session cookie');
  return first.split(';')[0] ?? first;
}

async function directLogin(email: string) {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return {
    cookie: cookieFrom(response),
    csrf: response.body.data.csrfToken as string,
    userId: response.body.data.user.id as string,
  };
}

function waitForSocketEvent(socket: Socket, event: string, timeoutMs = 4_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args[0]);
    });
  });
}

async function connectClient(cookie?: string, origin = allowedOrigin) {
  const socket = createSocket(socketUrl, {
    transports: ['polling'],
    reconnection: false,
    timeout: 4_000,
    extraHeaders: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  await waitForSocketEvent(socket, 'connect');
  return socket;
}

beforeAll(async () => {
  server = createServer(app);
  initRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  socketUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  closeRealtime();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('authentication and account recovery hardening', () => {
  it('revokes the previous session when a cookie-authenticated browser signs in again', async () => {
    const user = await setupLiveSession(4, 1);
    const first = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.players[0]!.email, password: PASSWORD })
      .expect(200);
    const firstCookie = cookieFrom(first);

    const second = await request(app)
      .post('/api/v1/auth/login')
      .set('Cookie', firstCookie)
      .set('x-csrf-token', first.body.data.csrfToken as string)
      .send({ email: user.players[0]!.email, password: PASSWORD })
      .expect(200);
    const secondCookie = cookieFrom(second);

    await request(app).get('/api/v1/auth/me').set('Cookie', firstCookie).expect(401);
    await request(app).get('/api/v1/auth/me').set('Cookie', secondCookie).expect(200);
  });

  it('rejects a session that has exceeded its idle lifetime', async () => {
    const setup = await setupLiveSession(4, 1);
    const login = await directLogin(setup.players[0]!.email);
    const session = await prisma.authSession.findFirstOrThrow({
      where: { userId: login.userId },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.authSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });
    await request(app).get('/api/v1/auth/me').set('Cookie', login.cookie).expect(401);
  });

  it('records failed sign-ins without storing the submitted email', async () => {
    const user = await setupLiveSession(4, 1);
    const before = await prisma.auditEvent.count({ where: { action: 'user.sign_in_failed' } });
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.players[0]!.email, password: 'WrongPassword123!' })
      .expect(401);
    const events = await prisma.auditEvent.findMany({
      where: { action: 'user.sign_in_failed' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(events).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { action: 'user.sign_in_failed' } })).toBe(
      before + 1,
    );
    const rawMetadata = JSON.stringify(events[0]?.metadata);
    expect(rawMetadata).not.toContain(user.players[0]!.email);
  });

  it('consumes password-reset links once and revokes existing sessions', async () => {
    const setup = await setupLiveSession(4, 1);
    const login = await directLogin(setup.players[0]!.email);
    const resetRequest = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: setup.players[0]!.email })
      .expect(200);
    const token = resetRequest.body.data.devResetToken as string;
    expect(token).toBeTruthy();

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'NewPassword123!' })
      .expect(200);

    await request(app).get('/api/v1/auth/me').set('Cookie', login.cookie).expect(401);
    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'AnotherPassword123!' })
      .expect(400);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: setup.players[0]!.email, password: PASSWORD })
      .expect(401);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: setup.players[0]!.email, password: 'NewPassword123!' })
      .expect(200);
  });

  it('invalidates an older verification link when a newer one is issued', async () => {
    const email = `email-token.${Date.now()}@example.test`;
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Email Token', email, password: PASSWORD })
      .expect(201);
    const firstToken = registered.body.data.devVerificationToken as string;
    const csrf = registered.body.data.csrfToken as string;
    const cookie = cookieFrom(registered);

    const resent = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);
    const secondToken = resent.body.data.devVerificationToken as string;
    expect(secondToken).not.toBe(firstToken);

    await request(app).post('/api/v1/auth/verify-email').send({ token: firstToken }).expect(400);
    await request(app).post('/api/v1/auth/verify-email').send({ token: secondToken }).expect(200);
    await request(app).post('/api/v1/auth/verify-email').send({ token: secondToken }).expect(400);
  });
});

describe('membership and business-state boundaries', () => {
  it('removes a departed member from queue eligibility and future rotations', async () => {
    const setup = await setupLiveSession(8, 2);
    const target = setup.players[0]!;
    const members = await setup.owner.agent
      .get(`/api/v1/clubs/${setup.club.id}/members`)
      .expect(200);
    const membership = (members.body.data as Array<{ id: string; userId: string }>).find(
      (entry) => entry.userId === target.id,
    );
    expect(membership).toBeTruthy();

    await setup.owner.agent
      .delete(`/api/v1/clubs/${setup.club.id}/members/${membership!.id}`)
      .set('x-csrf-token', setup.owner.csrf)
      .expect(200);

    const queue = await prisma.queueEntry.findUnique({
      where: { sessionId_userId: { sessionId: setup.session.id, userId: target.id } },
    });
    expect(queue?.state).toBe('LEFT');
    const registration = await prisma.sessionRegistration.findUnique({
      where: { sessionId_userId: { sessionId: setup.session.id, userId: target.id } },
    });
    expect(registration?.status).toBe('WITHDRAWN');

    const preview = await previewRotation(setup.owner, setup.session.id);
    const assignedIds = preview.assignments.flatMap((assignment) => [
      ...assignment.teamA.map((player) => player.userId),
      ...assignment.teamB.map((player) => player.userId),
    ]);
    expect(assignedIds).not.toContain(target.id);
    expect(preview.bench.map((player) => player.userId)).not.toContain(target.id);
  });

  it('does not auto-rotate under a creator who has been demoted from administrator', async () => {
    const setup = await setupLiveSession(8, 2, { autoAssign: true });
    await prisma.clubMembership.update({
      where: {
        clubId_userId: { clubId: setup.club.id, userId: setup.owner.id },
      },
      data: { role: 'PLAYER' },
    });
    await maybeAutoRotate(setup.session.id);
    const rotations = await prisma.rotationRun.count({
      where: { sessionId: setup.session.id },
    });
    expect(rotations).toBe(0);
  });

  it('prevents status changes on a court with an active match', async () => {
    const setup = await setupLiveSession(8, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ rotationId: preview.rotationId, expectedSessionVersion: preview.sessionVersion })
      .expect(201);
    const activeCourtId = (commit.body.data.matches as Array<{ court: { id: string } }>)[0]!.court
      .id;

    await setup.owner.agent
      .patch(`/api/v1/clubs/${setup.club.id}/courts/${activeCourtId}`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ status: 'MAINTENANCE' })
      .expect(409);
  });
});

describe('real-time authorization boundaries', () => {
  it('rejects a socket connection from an unapproved origin', async () => {
    const socket = createSocket(socketUrl, {
      transports: ['polling'],
      reconnection: false,
      timeout: 3_000,
      extraHeaders: { Origin: 'https://evil.example' },
    });
    const error = await waitForSocketEvent(socket, 'connect_error');
    expect(error).toBeTruthy();
    socket.close();
  });

  it('rejects an unauthenticated session-room subscription and rate-limits repeated attempts', async () => {
    const socket = await connectClient();
    const acks: Array<{ ok: boolean; error?: string }> = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socket.emit('subscribe', { sessionId: 'not-a-real-session' }, resolve);
      });
      acks.push(ack);
    }
    expect(acks[0]?.ok).toBe(false);
    expect(acks[0]?.error).toBe('FORBIDDEN');
    expect(acks[20]?.error).toBe('RATE_LIMITED');
    socket.close();
  });

  it('disconnects an authenticated socket when its session is logged out', async () => {
    const setup = await setupLiveSession(4, 1);
    const login = await directLogin(setup.players[0]!.email);
    const socket = await connectClient(login.cookie);
    const ack = await new Promise<{ ok: boolean }>((resolve) => {
      socket.emit('subscribe', { sessionId: setup.session.id }, resolve);
    });
    expect(ack.ok).toBe(true);

    const disconnected = waitForSocketEvent(socket, 'disconnect');
    await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', login.cookie)
      .set('x-csrf-token', login.csrf)
      .send({})
      .expect(200);

    await disconnected;
    expect(socket.connected).toBe(false);
    socket.close();
  });

  it('disconnects public viewers when a session is unpublished', async () => {
    const setup = await setupLiveSession(4, 1);
    const login = await directLogin(setup.owner.email);
    const socket = await connectClient();
    const ack = await new Promise<{ ok: boolean }>((resolve) => {
      socket.emit('subscribe', { publicId: setup.session.publicId }, resolve);
    });
    expect(ack.ok).toBe(true);

    const disconnected = waitForSocketEvent(socket, 'disconnect');
    await request(app)
      .post(`/api/v1/sessions/${setup.session.id}/publish`)
      .set('Cookie', login.cookie)
      .set('x-csrf-token', login.csrf)
      .send({ published: false })
      .expect(200);

    await disconnected;
    expect(socket.connected).toBe(false);
    socket.close();
  });

  it('disconnects an active socket when the auth session expires', async () => {
    const setup = await setupLiveSession(4, 1);
    const login = await directLogin(setup.players[0]!.email);
    const socket = await connectClient(login.cookie);
    const subscribed = await new Promise<{ ok: boolean }>((resolve) => {
      socket.emit('subscribe', { sessionId: setup.session.id }, resolve);
    });
    expect(subscribed.ok).toBe(true);

    await prisma.authSession.updateMany({
      where: { userId: login.userId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await waitForSocketEvent(socket, 'disconnect', 5_000);
    expect(socket.connected).toBe(false);
    socket.close();
  });
});
