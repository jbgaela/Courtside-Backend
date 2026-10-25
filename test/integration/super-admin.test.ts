import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/infrastructure/prisma.js';
import {
  PASSWORD,
  app,
  createSuperAdminUser,
  loginUser,
  previewRotation,
  registerPendingUser,
  registerUser,
  setupLiveSession,
  type PendingRegistration,
  type TestUser,
} from './helpers.js';
import { hashPassword } from '../../src/security/password.js';
import { totpCode } from '../../src/security/mfa.js';

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginPending(email: string) {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return {
    agent,
    csrf: response.body.data.csrfToken as string,
    status: response.body.data.status as string,
  };
}

async function listPending(admin: TestUser) {
  const response = await admin.agent
    .get('/api/v1/admin/registrations?status=PENDING&limit=50')
    .expect(200);
  return response.body.data.items as Array<{ id: string; email: string; version: number }>;
}

async function approve(admin: TestUser, registrationId: string, version: number) {
  return admin.agent
    .post(`/api/v1/admin/registrations/${registrationId}/approve`)
    .set('x-csrf-token', admin.csrf)
    .send({ expectedVersion: version })
    .expect(200);
}

async function activate(registration: { agent: ReturnType<typeof request.agent>; csrf: string }) {
  return registration.agent
    .post('/api/v1/auth/activate')
    .set('x-csrf-token', registration.csrf)
    .send({ displayName: 'Activated Player', skillRating: 3.5, acceptTerms: true })
    .expect(200);
}

async function waitForPending(
  admin: TestUser,
  pending: PendingRegistration,
): Promise<{ id: string; version: number }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const rows = await listPending(admin);
    const row = rows.find((entry) => entry.email === pending.email);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Pending registration did not appear in the directory');
}

describe('super admin registration approval and account lifecycle', () => {
  it('creates a pending account without a normal session and rejects privilege injection', async () => {
    const pending = await registerPendingUser('pending-create');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: pending.userId },
      include: { registrationReview: true },
    });
    expect(stored.accountStatus).toBe('PENDING_APPROVAL');
    expect(stored.platformRole).toBe('USER');
    expect(stored.emailVerifiedAt).toBeNull();
    expect(stored.registrationReview?.status).toBe('PENDING');

    const injection = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Role Injector',
        email: `role-injector.${Date.now()}@example.test`,
        password: PASSWORD,
        acceptTerms: true,
        platformRole: 'SUPER_ADMIN',
      })
      .expect(422);
    expect(injection.body.error.code).toBe('VALIDATION_ERROR');

    const duplicate = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: pending.name,
        email: pending.email,
        password: PASSWORD,
        acceptTerms: true,
      })
      .expect(201);
    expect(duplicate.body.data.submitted).toBe(true);
    expect(await prisma.user.count({ where: { email: pending.email } })).toBe(1);
    expect(duplicate.headers['set-cookie']).toBeUndefined();
  });

  it('gives a pending applicant a restricted status ticket and no protected access', async () => {
    const pending = await registerPendingUser('pending-login');
    const login = await loginPending(pending.email);
    expect(login.status).toBe('PENDING_APPROVAL');
    await login.agent.get('/api/v1/auth/registration-status').expect(200);
    await login.agent.get('/api/v1/auth/me').expect(401);
    await login.agent.get('/api/v1/users/me/profile').expect(401);
    await login.agent.get('/api/v1/clubs').expect(200);
    await login.agent.get('/api/v1/auth/registration-status').expect(200);
  });

  it('separates club administration from platform administration', async () => {
    const player = await registerUser('admin-player');
    const owner = await registerUser('admin-owner');
    await player.agent.get('/api/v1/admin/overview').expect(403);
    await owner.agent.get('/api/v1/admin/overview').expect(403);
    await owner.agent.get('/api/v1/admin/registrations').expect(403);
  });

  it('approves a registration, activates it once and records the audit trail', async () => {
    const admin = await createSuperAdminUser('approve');
    const pending = await registerPendingUser('approve-me');
    const directory = await waitForPending(admin, pending);
    await approve(admin, directory.id, directory.version);

    const login = await loginPending(pending.email);
    expect(login.status).toBe('APPROVED_PENDING_ACTIVATION');
    const status = await login.agent.get('/api/v1/auth/registration-status').expect(200);
    expect(status.body.data.canActivate).toBe(true);
    await activate(login);
    const me = await login.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.data.accountStatus).toBe('ACTIVE');
    expect(me.body.data.emailVerified).toBe(false);

    await login.agent
      .post('/api/v1/auth/activate')
      .set('x-csrf-token', login.csrf)
      .send({ acceptTerms: true })
      .expect(403);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: pending.userId } });
    expect(stored.accountStatus).toBe('ACTIVE');
    expect(stored.emailVerifiedAt).toBeNull();
    const audit = await admin.agent
      .get('/api/v1/admin/audit-logs?action=registration.approved')
      .expect(200);
    expect(
      (audit.body.data.items as Array<{ target: { id: string } | null }>).some(
        (event) => event.target?.id === pending.userId,
      ),
    ).toBe(true);
  });

  it('rejects an application, blocks activation, then reopens and re-decides', async () => {
    const admin = await createSuperAdminUser('reject');
    const pending = await registerPendingUser('reject-me');
    const directory = await waitForPending(admin, pending);
    const rejected = await admin.agent
      .post(`/api/v1/admin/registrations/${directory.id}/reject`)
      .set('x-csrf-token', admin.csrf)
      .send({
        expectedVersion: directory.version,
        internalReason: 'Duplicate identity evidence',
        publicReason: 'We could not verify this registration.',
      })
      .expect(200);
    expect(rejected.body.data.status).toBe('REJECTED');

    const login = await loginPending(pending.email);
    expect(login.status).toBe('REJECTED');
    const status = await login.agent.get('/api/v1/auth/registration-status').expect(200);
    expect(status.body.data.publicReason).toBe('We could not verify this registration.');
    await login.agent
      .post('/api/v1/auth/activate')
      .set('x-csrf-token', login.csrf)
      .send({ acceptTerms: true })
      .expect(409);
    await login.agent.get('/api/v1/auth/me').expect(401);

    const reopened = await admin.agent
      .post(`/api/v1/admin/registrations/${directory.id}/reopen`)
      .set('x-csrf-token', admin.csrf)
      .send({ expectedVersion: rejected.body.data.version })
      .expect(200);
    expect(reopened.body.data.status).toBe('PENDING');
    await approve(admin, directory.id, reopened.body.data.version);
  });

  it('handles concurrent conflicting review decisions with one authoritative outcome', async () => {
    const firstAdmin = await createSuperAdminUser('concurrent-a');
    const secondAdmin = await createSuperAdminUser('concurrent-b');
    const pending = await registerPendingUser('concurrent');
    const directory = await waitForPending(firstAdmin, pending);
    const [approveResponse, rejectResponse] = await Promise.all([
      firstAdmin.agent
        .post(`/api/v1/admin/registrations/${directory.id}/approve`)
        .set('x-csrf-token', firstAdmin.csrf)
        .send({ expectedVersion: directory.version }),
      secondAdmin.agent
        .post(`/api/v1/admin/registrations/${directory.id}/reject`)
        .set('x-csrf-token', secondAdmin.csrf)
        .send({ expectedVersion: directory.version, publicReason: 'Conflicting review' }),
    ]);
    expect([approveResponse.status, rejectResponse.status].sort()).toEqual([200, 409]);
    const review = await prisma.registrationReview.findUniqueOrThrow({
      where: { userId: pending.userId },
    });
    expect(['APPROVED', 'REJECTED']).toContain(review.status);
  });

  it('creates an account administratively and redeems a single-use claim', async () => {
    const admin = await createSuperAdminUser('creator');
    const email = `created.${Date.now()}@example.test`;
    const created = await admin.agent
      .post('/api/v1/admin/users')
      .set('x-csrf-token', admin.csrf)
      .send({
        name: 'Created Player',
        email,
        displayName: 'Created Player',
        skillRating: 4,
        note: 'Identity checked by club owner',
      })
      .expect(201);
    const claimToken = created.body.data.claimToken as string;
    expect(created.body.data.user.accountStatus).toBe('APPROVED_PENDING_ACTIVATION');
    expect(created.body.data.user.emailVerified).toBe(false);
    expect(JSON.stringify(created.body.data)).not.toContain('passwordHash');
    expect(JSON.stringify(created.body.data)).not.toContain('claimTokenHash');

    const agent = request.agent(app);
    await agent
      .post('/api/v1/auth/claim')
      .send({ token: claimToken, password: 'ClaimPassword123!', acceptTerms: true })
      .expect(200);
    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.data.accountStatus).toBe('ACTIVE');
    await request(app)
      .post('/api/v1/auth/claim')
      .send({ token: claimToken, password: 'ClaimPassword123!', acceptTerms: true })
      .expect(400);
  });

  it('supports directory filters and rejects privilege or protected-field updates', async () => {
    const admin = await createSuperAdminUser('directory');
    const target = await registerUser('directory-target');
    const search = await admin.agent
      .get(`/api/v1/admin/users?q=${encodeURIComponent(target.email)}`)
      .expect(200);
    const rows = search.body.data.items as Array<{ id: string; email: string }>;
    expect(rows.some((row) => row.id === target.id)).toBe(true);
    const filtered = await admin.agent.get('/api/v1/admin/users?status=ACTIVE&limit=5').expect(200);
    expect(filtered.body.data.meta.total).toBeGreaterThan(0);

    await admin.agent
      .patch(`/api/v1/admin/users/${target.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ platformRole: 'SUPER_ADMIN' })
      .expect(422);
    await admin.agent
      .patch(`/api/v1/admin/users/${target.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ passwordHash: 'not-allowed' })
      .expect(422);
    const updated = await admin.agent
      .patch(`/api/v1/admin/users/${target.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Directory Updated' })
      .expect(200);
    expect(updated.body.data.name).toBe('Directory Updated');
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(stored.name).toBe('Directory Updated');
  });

  it('suspends, blocks and reactivates an account', async () => {
    const admin = await createSuperAdminUser('suspend');
    const target = await registerUser('suspend-target');
    await target.agent.get('/api/v1/auth/me').expect(200);
    await admin.agent
      .post(`/api/v1/admin/users/${target.id}/suspend`)
      .set('x-csrf-token', admin.csrf)
      .send({ reason: 'Safety review' })
      .expect(200);
    await target.agent.get('/api/v1/auth/me').expect(401);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: PASSWORD })
      .expect(403);
    await admin.agent
      .post(`/api/v1/admin/users/${target.id}/reactivate`)
      .set('x-csrf-token', admin.csrf)
      .send({})
      .expect(200);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: PASSWORD })
      .expect(200);
    expect(login.body.data.restricted).toBe(false);
  });

  it('soft-deletes and restores without restoring old sessions or memberships', async () => {
    const admin = await createSuperAdminUser('delete');
    const target = await registerUser('delete-target');
    const oldSession = target.agent;
    await oldSession.get('/api/v1/auth/me').expect(200);
    await admin.agent
      .delete(`/api/v1/admin/users/${target.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ reason: 'Account closure request' })
      .expect(200);
    await oldSession.get('/api/v1/auth/me').expect(401);
    const deleted = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(deleted.accountStatus).toBe('DELETED');
    expect(deleted.deletedAt).toBeTruthy();
    await admin.agent
      .post(`/api/v1/admin/users/${target.id}/restore`)
      .set('x-csrf-token', admin.csrf)
      .send({})
      .expect(200);
    const restored = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(restored.accountStatus).toBe('ACTIVE');
    expect(restored.deletedAt).toBeNull();
  });

  it('preserves historical match participants when soft-deleting an account', async () => {
    const admin = await createSuperAdminUser('match-delete');
    const setup = await setupLiveSession(8, 2);
    const target = setup.players[0]!;
    const preview = await previewRotation(setup.owner, setup.session.id);
    await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const before = await prisma.matchParticipant.count({ where: { userId: target.id } });
    expect(before).toBeGreaterThan(0);
    await admin.agent
      .delete(`/api/v1/admin/users/${target.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ reason: 'Preserving match history test' })
      .expect(200);
    expect(await prisma.matchParticipant.count({ where: { userId: target.id } })).toBe(before);
    expect(await prisma.match.count({ where: { sessionId: setup.session.id } })).toBeGreaterThan(0);
  });

  it('protects the final active Super Admin from deletion', async () => {
    const first = await createSuperAdminUser('last-a');
    const second = await createSuperAdminUser('last-b');
    await first.agent
      .delete(`/api/v1/admin/users/${second.id}`)
      .set('x-csrf-token', first.csrf)
      .send({ reason: 'Remove duplicate admin' })
      .expect(200);
    // Other tests in this shared database create their own administrators.
    // Make this test deterministic by removing their active platform roles.
    await prisma.user.updateMany({
      where: { platformRole: 'SUPER_ADMIN', id: { not: first.id } },
      data: { platformRole: 'USER', accountStatus: 'DELETED', deletedAt: new Date() },
    });
    const blocked = await first.agent
      .delete(`/api/v1/admin/users/${first.id}`)
      .set('x-csrf-token', first.csrf)
      .send({ reason: 'Should be blocked' })
      .expect(409);
    expect(blocked.body.error.message).toMatch(/last active Super Admin/i);
  });

  it('issues a single-use recovery credential and revokes old sessions', async () => {
    const admin = await createSuperAdminUser('recovery');
    const target = await registerUser('recovery-target');
    const oldSession = target.agent;
    const issued = await admin.agent
      .post(`/api/v1/admin/users/${target.id}/recovery`)
      .set('x-csrf-token', admin.csrf)
      .send({})
      .expect(200);
    const token = issued.body.data.token as string;
    await request(app)
      .post('/api/v1/auth/recover')
      .send({ token, password: 'RecoveredPassword123!' })
      .expect(200);
    await oldSession.get('/api/v1/auth/me').expect(401);
    await request(app)
      .post('/api/v1/auth/recover')
      .send({ token, password: 'RecoveredPassword123!' })
      .expect(400);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: PASSWORD })
      .expect(401);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: 'RecoveredPassword123!' })
      .expect(200);
  });

  it('enrolls and verifies TOTP MFA for a Super Admin login', async () => {
    const admin = await createSuperAdminUser('mfa');
    const setup = await admin.agent
      .post('/api/v1/auth/mfa/setup')
      .set('x-csrf-token', admin.csrf)
      .send({})
      .expect(200);
    const secret = setup.body.data.secret as string;
    expect(setup.body.data.otpauthUri).toContain('otpauth://totp/');
    await admin.agent
      .post('/api/v1/auth/mfa/enable')
      .set('x-csrf-token', admin.csrf)
      .send({ code: totpCode(secret) })
      .expect(200);
    await admin.agent
      .post('/api/v1/auth/logout')
      .set('x-csrf-token', admin.csrf)
      .send({})
      .expect(200);

    const loginAgent = request.agent(app);
    const login = await loginAgent
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: PASSWORD })
      .expect(200);
    expect(login.body.data.mfaRequired).toBe(true);
    expect(login.body.data.user).toBeUndefined();
    await loginAgent.get('/api/v1/auth/me').expect(401);
    await loginAgent.post('/api/v1/auth/mfa/verify').send({ code: '000000' }).expect(401);
    const verified = await loginAgent
      .post('/api/v1/auth/mfa/verify')
      .send({ code: totpCode(secret) })
      .expect(200);
    expect(verified.body.data.user.platformRole).toBe('SUPER_ADMIN');
    await loginAgent.get('/api/v1/auth/me').expect(200);
  });

  it('keeps legacy active accounts functional outside the registration review flow', async () => {
    const email = `legacy.${Date.now()}@example.test`;
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Legacy Player',
        passwordHash: await hashPassword(PASSWORD),
        platformRole: 'USER',
        accountStatus: 'ACTIVE',
        activatedAt: new Date(),
        emailVerifiedAt: new Date(),
        profile: { create: { displayName: 'Legacy Player', skillRating: 3 } },
      },
    });
    const legacy = await loginUser(email);
    await legacy.agent.get('/api/v1/auth/me').expect(200);
    const admin = await createSuperAdminUser('legacy-admin');
    const detail = await admin.agent.get(`/api/v1/admin/users/${user.id}`).expect(200);
    expect(detail.body.data.registration).toBeNull();
    expect(detail.body.data.accountStatus).toBe('ACTIVE');
  });
});
