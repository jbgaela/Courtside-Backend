import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/prisma.js';
import {
  PASSWORD,
  createClub,
  createCourt,
  createSession,
  createSuperAdminUser,
  joinClub,
  readJson,
  registerUser,
  type TestUser,
} from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

async function reauth(user: TestUser) {
  await user.agent
    .post('/api/v1/auth/reauth')
    .set('x-csrf-token', user.csrf)
    .send({ password: PASSWORD })
    .expect(200);
}

async function createRole(
  admin: TestUser,
  input: { name: string; permissions: string[]; description?: string },
) {
  const response = await admin.agent
    .post('/api/v1/admin/roles')
    .set('x-csrf-token', admin.csrf)
    .send(input)
    .expect(201);
  return readJson<{
    id: string;
    key: string;
    name: string;
    permissions: string[];
    version: number;
    isProtected: boolean;
    userCount: number;
  }>(response);
}

async function assignRole(admin: TestUser, userId: string, clubId: string, roleKey: string) {
  const response = await admin.agent
    .post('/api/v1/admin/roles/assign')
    .set('x-csrf-token', admin.csrf)
    .send({ userId, clubId, roleKey })
    .expect(201);
  return readJson<{
    id: string;
    role: string;
    roleName: string;
    status: string;
  }>(response);
}

async function clubFixture(label: string) {
  const owner = await registerUser(`${label}-owner`);
  const club = await createClub(owner, label);
  const court = await createCourt(owner, club.id, 'Court 1');
  const session = await createSession(owner, club.id, { courtIds: [court.id] });
  return { owner, club, court, session };
}

describe('data-backed club RBAC', () => {
  it('grants exactly the configured permissions and applies a change on the next request', async () => {
    const admin = await createSuperAdminUser('rbac-admin');
    const fixture = await clubFixture('rbac-a');
    const player = await registerUser('rbac-player');
    await joinClub(player, fixture.club.id);
    await reauth(admin);

    const role = await createRole(admin, {
      name: `Role ${Date.now()} A`,
      description: 'RBAC integration role',
      permissions: ['club.view', 'sessions.manage', 'queue.manage'],
    });
    await assignRole(admin, player.id, fixture.club.id, role.key);

    const me = await player.agent.get('/api/v1/auth/me').expect(200);
    const meBody = readJson<{
      memberships: Array<{ clubId: string; role: string; roleName: string; permissions: string[] }>;
    }>(me);
    const membership = meBody.memberships.find((entry) => entry.clubId === fixture.club.id);
    expect(membership?.role).toBe(role.key);
    expect(membership?.permissions).toEqual(['club.view', 'sessions.manage', 'queue.manage']);

    // Allowed by sessions.manage.
    await player.agent.get(`/api/v1/sessions/${fixture.session.id}/public-link`).expect(200);
    // Denied because check-in and audit are not granted.
    await player.agent.get(`/api/v1/sessions/${fixture.session.id}/registrations`).expect(403);
    await player.agent.get(`/api/v1/clubs/${fixture.club.id}/audit`).expect(403);
    // Denied because the role is a club role, not platform administration.
    await player.agent.get('/api/v1/admin/roles').expect(403);
    await player.agent
      .post('/api/v1/admin/roles')
      .set('x-csrf-token', player.csrf)
      .send({ name: `Self Grant ${Date.now()}`, permissions: ['club.view'] })
      .expect(403);

    // Removing sessions.manage takes effect on the next request.
    const updated = await admin.agent
      .patch(`/api/v1/admin/roles/${role.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({
        permissions: ['club.view', 'queue.manage'],
        expectedVersion: role.version,
      });
    expect(updated.status).toBe(200);
    await player.agent.get(`/api/v1/sessions/${fixture.session.id}/public-link`).expect(403);
    await player.agent.get(`/api/v1/sessions/${fixture.session.id}`).expect(200);

    // A role in use cannot be deleted.
    await admin.agent
      .delete(`/api/v1/admin/roles/${role.id}`)
      .set('x-csrf-token', admin.csrf)
      .expect(409);

    // Reassignment frees it for deletion.
    await assignRole(admin, player.id, fixture.club.id, 'PLAYER');
    await admin.agent
      .delete(`/api/v1/admin/roles/${role.id}`)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    for (const action of [
      'role.created',
      'role.assignment_changed',
      'role.updated',
      'role.deleted',
    ]) {
      const audit = await admin.agent
        .get(`/api/v1/admin/audit-logs?action=${action}&limit=50`)
        .expect(200);
      const body = readJson<{ items: Array<{ action: string }> }>(audit);
      expect(body.items.some((event) => event.action === action)).toBe(true);
    }
  });

  it('keeps a scoped role inside its club and denies cross-club administration', async () => {
    const admin = await createSuperAdminUser('rbac-cross-admin');
    const first = await clubFixture('rbac-first');
    const second = await clubFixture('rbac-second');
    const player = await registerUser('rbac-cross-player');
    await joinClub(player, first.club.id);
    await reauth(admin);

    const role = await createRole(admin, {
      name: `Scoped ${Date.now()}`,
      permissions: ['club.view', 'sessions.manage'],
    });
    await assignRole(admin, player.id, first.club.id, role.key);

    await player.agent.get(`/api/v1/clubs/${first.club.id}/sessions`).expect(200);
    await player.agent.get(`/api/v1/clubs/${second.club.id}/sessions`).expect(403);
    await player.agent
      .patch(`/api/v1/clubs/${second.club.id}`)
      .set('x-csrf-token', player.csrf)
      .send({ expectedVersion: 1 })
      .expect(403);

    // Even a valid assignment in the second club does not grant club settings.
    await assignRole(admin, player.id, second.club.id, role.key);
    await player.agent.get(`/api/v1/clubs/${second.club.id}/sessions`).expect(200);
    await player.agent
      .patch(`/api/v1/clubs/${second.club.id}`)
      .set('x-csrf-token', player.csrf)
      .send({ expectedVersion: 1 })
      .expect(403);
  });

  it('protects system roles and rejects invalid role definitions', async () => {
    const admin = await createSuperAdminUser('rbac-protect-admin');
    await reauth(admin);

    const rolesResponse = await admin.agent.get('/api/v1/admin/roles').expect(200);
    const roles = readJson<{ items: Array<{ id: string; key: string }> }>(rolesResponse).items;
    const owner = roles.find((role) => role.key === 'OWNER');
    expect(owner).toBeTruthy();

    await admin.agent
      .patch(`/api/v1/admin/roles/${owner!.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ permissions: ['club.view'] })
      .expect(403);
    await admin.agent
      .delete(`/api/v1/admin/roles/${owner!.id}`)
      .set('x-csrf-token', admin.csrf)
      .expect(409);

    const name = `Invalid ${Date.now()}`;
    await admin.agent
      .post('/api/v1/admin/roles')
      .set('x-csrf-token', admin.csrf)
      .send({ name, permissions: ['club.view', 'not.a.permission'] })
      .expect(422);
    await admin.agent
      .post('/api/v1/admin/roles')
      .set('x-csrf-token', admin.csrf)
      .send({ name, permissions: ['sessions.manage'] })
      .expect(422);
    await createRole(admin, { name, permissions: ['club.view'] });
    await admin.agent
      .post('/api/v1/admin/roles')
      .set('x-csrf-token', admin.csrf)
      .send({ name: name.toUpperCase(), permissions: ['club.view'] })
      .expect(409);
  });

  it('does not let a player assign a role to themselves or another account', async () => {
    const admin = await createSuperAdminUser('rbac-self-admin');
    const fixture = await clubFixture('rbac-self');
    const player = await registerUser('rbac-self-player');
    await joinClub(player, fixture.club.id);
    const target = await registerUser('rbac-self-target');
    await joinClub(target, fixture.club.id);

    await player.agent
      .post('/api/v1/admin/roles/assign')
      .set('x-csrf-token', player.csrf)
      .send({ userId: target.id, clubId: fixture.club.id, roleKey: 'QUEUE_MASTER' })
      .expect(403);
    await admin.agent.get('/api/v1/admin/roles').expect(200);
  });
});
