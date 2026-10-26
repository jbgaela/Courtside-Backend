import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/infrastructure/prisma.js';
import { app, createClub, createCourt, createSession, registerUser } from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

async function tokenFor(sessionId: string) {
  const session = await prisma.playSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { checkInToken: true },
  });
  return session.checkInToken;
}

describe('public QR check-in preview', () => {
  it('shows session context without authentication before check-in opens', async () => {
    const owner = await registerUser('qr-preview-owner');
    const club = await createClub(owner, 'QR Preview');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, { courtIds: [court.id] });
    const token = await tokenFor(session.id);

    const response = await request(app).get(`/api/v1/public/checkins/${token}`).expect(200);
    const data = response.body.data as {
      club: { name: string };
      session: { name: string; status: string; capacity: number };
      join: { availability: string; canCheckIn: boolean; reason: string | null };
    };
    expect(data.club.name).toBe(club.name);
    expect(data.session.name).toBe(session.name);
    expect(data.session.status).toBe('SCHEDULED');
    expect(data.join.availability).toBe('CLOSED');
    expect(data.join.canCheckIn).toBe(false);
    expect(data.join.reason).toMatch(/has not opened yet/i);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('@example.test');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain(token);
  });

  it('returns a public, identity-free preview for a live session', async () => {
    const owner = await registerUser('qr-live-owner');
    const club = await createClub(owner, 'QR Live');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, { courtIds: [court.id] });
    const token = await tokenFor(session.id);

    await owner.agent
      .post(`/api/v1/sessions/${session.id}/status`)
      .set('x-csrf-token', owner.csrf)
      .send({ status: 'CHECK_IN_OPEN' })
      .expect(200);

    const response = await request(app).get(`/api/v1/public/checkins/${token}`).expect(200);
    const data = response.body.data as {
      join: { availability: string; canCheckIn: boolean; reason: string | null };
    };
    expect(data.join.availability).toBe('OPEN');
    expect(data.join.canCheckIn).toBe(true);
    expect(data.join.reason).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain('@example.test');
  });

  it('does not reveal whether a malformed token exists', async () => {
    const response = await request(app)
      .get('/api/v1/public/checkins/not-a-real-check-in-token')
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
