import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, createCourt, createSession, joinClub, registerUser } from './helpers.js';
import { prisma } from '../../src/infrastructure/prisma.js';

afterAll(async () => {
  await prisma.$disconnect();
});

interface MemberRow {
  id: string;
  userId: string;
  role: string;
  status: string;
}

describe('clubs, invitations and ownership', () => {
  it('invites, accepts, promotes, transfers and archives a club', async () => {
    const owner = await registerUser('owner');
    const invited = await registerUser('invited');
    const outsider = await registerUser('outsider');

    const clubResponse = await owner.agent
      .post('/api/v1/clubs')
      .set('x-csrf-token', owner.csrf)
      .send({
        name: `Invite Only ${Date.now()}`,
        description: 'Membership integration test',
        joinPolicy: 'INVITE_ONLY',
      })
      .expect(201);
    const club = clubResponse.body.data as { id: string; slug: string };
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, { courtIds: [court.id] });

    await invited.agent.get(`/api/v1/sessions/${session.id}`).expect(403);
    await invited.agent
      .post(`/api/v1/clubs/${club.id}/join`)
      .set('x-csrf-token', invited.csrf)
      .send({})
      .expect(403);

    const inviteResponse = await owner.agent
      .post(`/api/v1/clubs/${club.id}/invitations`)
      .set('x-csrf-token', owner.csrf)
      .send({ email: invited.email, role: 'PLAYER' })
      .expect(201);
    const invitation = inviteResponse.body.data as {
      invitation: { id: string; email: string };
      devInvitationToken: string;
    };
    expect(invitation.devInvitationToken).toBeTruthy();

    await outsider.agent
      .post('/api/v1/clubs/invitations/accept')
      .set('x-csrf-token', outsider.csrf)
      .send({ token: invitation.devInvitationToken })
      .expect(400);

    await invited.agent
      .post('/api/v1/clubs/invitations/accept')
      .set('x-csrf-token', invited.csrf)
      .send({ token: invitation.devInvitationToken })
      .expect(200);

    await invited.agent.get(`/api/v1/sessions/${session.id}`).expect(200);
    const membersResponse = await owner.agent.get(`/api/v1/clubs/${club.id}/members`).expect(200);
    const members = membersResponse.body.data as MemberRow[];
    const invitedMembership = members.find((member) => member.userId === invited.id);
    expect(invitedMembership?.status).toBe('ACTIVE');

    await owner.agent
      .patch(`/api/v1/clubs/${club.id}/members/${invitedMembership!.id}`)
      .set('x-csrf-token', owner.csrf)
      .send({ role: 'QUEUE_MASTER' })
      .expect(200);
    await invited.agent
      .post(`/api/v1/clubs/${club.id}/courts`)
      .set('x-csrf-token', invited.csrf)
      .send({ name: 'Court 2' })
      .expect(201);
    const qmCannotInviteQm = await invited.agent
      .post(`/api/v1/clubs/${club.id}/invitations`)
      .set('x-csrf-token', invited.csrf)
      .send({ email: outsider.email, role: 'QUEUE_MASTER' })
      .expect(403);
    expect(qmCannotInviteQm.body.error.code).toBe('FORBIDDEN');

    await owner.agent
      .post(`/api/v1/clubs/${club.id}/transfer`)
      .set('x-csrf-token', owner.csrf)
      .send({ userId: invited.id })
      .expect(200);

    const transferredMembers = await invited.agent
      .get(`/api/v1/clubs/${club.id}/members`)
      .expect(200);
    const roles = new Map(
      (transferredMembers.body.data as MemberRow[]).map((member) => [member.userId, member.role]),
    );
    expect(roles.get(invited.id)).toBe('OWNER');
    expect(roles.get(owner.id)).toBe('QUEUE_MASTER');

    await invited.agent
      .post(`/api/v1/clubs/${club.id}/archive`)
      .set('x-csrf-token', invited.csrf)
      .send({})
      .expect(200);

    const archivedSession = await prisma.playSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(archivedSession.status).toBe('CANCELLED');
    await request(app).get(`/api/v1/public/clubs/${club.slug}`).expect(404);
    const publicClubs = await request(app).get('/api/v1/clubs?limit=50').expect(200);
    const publicIds = (publicClubs.body.data as Array<{ id: string }>).map((entry) => entry.id);
    expect(publicIds).not.toContain(club.id);
  });

  it('supports approval-based membership without exposing pending players to the rotation', async () => {
    const owner = await registerUser('approveowner');
    const player = await registerUser('approveplayer');
    const clubResponse = await owner.agent
      .post('/api/v1/clubs')
      .set('x-csrf-token', owner.csrf)
      .send({ name: `Approval ${Date.now()}`, joinPolicy: 'APPROVAL' })
      .expect(201);
    const club = clubResponse.body.data as { id: string };

    const join = await player.agent
      .post(`/api/v1/clubs/${club.id}/join`)
      .set('x-csrf-token', player.csrf)
      .send({})
      .expect(201);
    expect(join.body.data.membership.status).toBe('PENDING');
    await player.agent.get(`/api/v1/clubs/${club.id}/courts`).expect(403);

    const members = await owner.agent.get(`/api/v1/clubs/${club.id}/members`).expect(200);
    const pending = (members.body.data as MemberRow[]).find(
      (member) => member.userId === player.id,
    );
    expect(pending?.status).toBe('PENDING');
    await owner.agent
      .patch(`/api/v1/clubs/${club.id}/members/${pending!.id}`)
      .set('x-csrf-token', owner.csrf)
      .send({ status: 'ACTIVE' })
      .expect(200);
    await player.agent.get(`/api/v1/clubs/${club.id}/courts`).expect(200);
    void joinClub;
  });
});
