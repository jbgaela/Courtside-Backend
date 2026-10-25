import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/prisma.js';
import { previewRotation, setupLiveSession } from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('concurrent operations', () => {
  it('allows exactly one of two simultaneous rotation commits', async () => {
    const setup = await setupLiveSession(8, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    const body = {
      rotationId: preview.rotationId,
      expectedSessionVersion: preview.sessionVersion,
    };

    const [first, second] = await Promise.all([
      setup.owner.agent
        .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `race-a-${preview.rotationId}`)
        .send(body),
      setup.owner.agent
        .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `race-b-${preview.rotationId}`)
        .send(body),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect([200, 409]).toContain(statuses.find((status) => status !== 201));

    const matches = await prisma.match.findMany({
      where: { sessionId: setup.session.id },
      include: { participants: true },
    });
    expect(matches).toHaveLength(2);
    const playerIds = matches.flatMap((match) =>
      match.participants.map((participant) => participant.userId),
    );
    expect(new Set(playerIds).size).toBe(playerIds.length);
    expect(playerIds).toHaveLength(8);
    expect(new Set(matches.map((match) => match.courtId)).size).toBe(2);
  });

  it('accepts only one of two simultaneous points with the same version', async () => {
    const setup = await setupLiveSession(8, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const matchId = commit.body.data.matches[0].id as string;
    const start = await setup.owner.agent
      .post(`/api/v1/matches/${matchId}/start`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({})
      .expect(200);
    const version = start.body.data.match.version as number;

    const [first, second] = await Promise.all([
      setup.owner.agent
        .post(`/api/v1/matches/${matchId}/score-events`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `point-race-a-${matchId}`)
        .send({ team: 'A', expectedVersion: version }),
      setup.owner.agent
        .post(`/api/v1/matches/${matchId}/score-events`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `point-race-b-${matchId}`)
        .send({ team: 'A', expectedVersion: version }),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    expect(match.teamAScore).toBe(1);
    expect(match.version).toBe(version + 1);
    const events = await prisma.scoreEvent.count({ where: { matchId, type: 'POINT' } });
    expect(events).toBe(1);
  });

  it('replays a sequential duplicate point instead of awarding it twice', async () => {
    const setup = await setupLiveSession(8, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const matchId = commit.body.data.matches[0].id as string;
    const start = await setup.owner.agent
      .post(`/api/v1/matches/${matchId}/start`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({})
      .expect(200);
    const version = start.body.data.match.version as number;
    const key = `idempotent-${matchId}`;
    const payload = { team: 'B', expectedVersion: version };

    const first = await setup.owner.agent
      .post(`/api/v1/matches/${matchId}/score-events`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', key)
      .send(payload)
      .expect(201);
    const second = await setup.owner.agent
      .post(`/api/v1/matches/${matchId}/score-events`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', key)
      .send(payload)
      .expect(201);

    expect(second.body.data.match.version).toBe(first.body.data.match.version);
    const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    expect(match.teamBScore).toBe(1);
    expect(await prisma.scoreEvent.count({ where: { matchId, type: 'POINT' } })).toBe(1);
  });

  it('allows exactly one of two simultaneous completions', async () => {
    const setup = await setupLiveSession(8, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const matchId = commit.body.data.matches[0].id as string;
    const start = await setup.owner.agent
      .post(`/api/v1/matches/${matchId}/start`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({})
      .expect(200);
    let version = start.body.data.match.version as number;
    for (let point = 1; point <= 11; point += 1) {
      const scored = await setup.owner.agent
        .post(`/api/v1/matches/${matchId}/score-events`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `complete-race-point-${matchId}-${point}`)
        .send({ team: 'A', expectedVersion: version })
        .expect(201);
      version = scored.body.data.match.version as number;
    }

    const [first, second] = await Promise.all([
      setup.owner.agent
        .post(`/api/v1/matches/${matchId}/complete`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `complete-race-a-${matchId}`)
        .send({ expectedVersion: version }),
      setup.owner.agent
        .post(`/api/v1/matches/${matchId}/complete`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `complete-race-b-${matchId}`)
        .send({ expectedVersion: version }),
    ]);
    const successCount = [first, second].filter((response) => response.status === 201).length;
    expect(successCount).toBe(1);
    expect(await prisma.matchResult.count({ where: { matchId } })).toBe(1);
    const queueCount = await prisma.queueEntry.count({
      where: { sessionId: setup.session.id, gamesPlayed: 1 },
    });
    expect(queueCount).toBe(4);
  });
});
