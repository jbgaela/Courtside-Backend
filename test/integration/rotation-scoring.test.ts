import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/infrastructure/prisma.js';
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
  setupLiveSession,
  transition,
} from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

interface MatchBody {
  id: string;
  publicId: string;
  status: string;
  version: number;
  teamAScore: number;
  teamBScore: number;
  awaitingCompletion: boolean;
  completedAt: string | null;
  currentGame: { a: number; b: number };
  teams: { A: Array<{ userId?: string }>; B: Array<{ userId?: string }> };
}

describe('rotations, scoring and completion', () => {
  it('creates a fair rotation, commits atomically and scores a full match', async () => {
    const setup = await setupLiveSession(8, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    expect(preview.assignments).toHaveLength(2);
    const assigned = preview.assignments.flatMap((assignment) => [
      ...assignment.teamA.map((player) => player.userId),
      ...assignment.teamB.map((player) => player.userId),
    ]);
    expect(new Set(assigned).size).toBe(8);

    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', `commit-${preview.rotationId}`)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const committed = readJson<{
      matches: MatchBody[];
      sessionVersion: number;
    }>(commit);
    expect(committed.matches).toHaveLength(2);
    expect(committed.matches.every((match) => match.status === 'READY')).toBe(true);

    const duplicateCommit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(200);
    expect(duplicateCommit.body.data.alreadyCommitted).toBe(true);

    const match = committed.matches[0]!;
    const start = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/start`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({})
      .expect(200);
    const current = readJson<{ match: MatchBody; alreadyStarted: boolean }>(start);
    expect(current.alreadyStarted).toBe(false);

    // A stale version after the first point must be rejected, not overwrite.
    let version = current.match.version;
    const firstExpected = version;
    const firstPoint = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/score-events`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', `point-${match.id}-1`)
      .send({ team: 'A', expectedVersion: version })
      .expect(201);
    const afterPoint = readJson<{ match: MatchBody }>(firstPoint);
    expect(afterPoint.match.teamAScore).toBe(1);
    version = afterPoint.match.version;

    const stalePoint = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/score-events`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', `point-${match.id}-stale`)
      .send({ team: 'B', expectedVersion: afterPoint.match.version - 1 })
      .expect(409);
    expect(stalePoint.body.error.code).toBe('CONFLICT');

    // Sequential retry with the same key replays rather than scoring twice.
    const replay = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/score-events`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', `point-${match.id}-1`)
      .send({ team: 'A', expectedVersion: firstExpected })
      .expect(201);
    expect(replay.body.data.match.teamAScore).toBe(1);

    // No completion before a winning condition.
    await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/complete`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ expectedVersion: version })
      .expect(409);

    // Score to 11-0.
    for (let point = 2; point <= 11; point += 1) {
      const response = await setup.owner.agent
        .post(`/api/v1/matches/${match.id}/score-events`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `point-${match.id}-${point}`)
        .send({ team: 'A', expectedVersion: version })
        .expect(201);
      const data = readJson<{ match: MatchBody; awaitingCompletion: boolean }>(response);
      version = data.match.version;
      if (point < 11) expect(data.awaitingCompletion).toBe(false);
    }

    const awaiting = await setup.owner.agent.get(`/api/v1/matches/${match.id}`).expect(200);
    const awaitingMatch = readJson<{ version: number; awaitingCompletion: boolean }>(awaiting);
    expect(awaitingMatch.awaitingCompletion).toBe(true);
    version = awaitingMatch.version;

    const complete = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/complete`)
      .set('x-csrf-token', setup.owner.csrf)
      .set('idempotency-key', `complete-${match.id}`)
      .send({ expectedVersion: version })
      .expect(201);
    const completed = readJson<{ match: MatchBody; alreadyCompleted: boolean }>(complete);
    expect(completed.alreadyCompleted).toBe(false);
    expect(completed.match.status).toBe('COMPLETED');
    expect(completed.match.completedAt).not.toBeNull();

    const duplicateComplete = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/complete`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ expectedVersion: version })
      .expect(200);
    expect(duplicateComplete.body.data.alreadyCompleted).toBe(true);

    const matchRow = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { participants: true, result: true },
    });
    expect(await prisma.matchResult.count({ where: { matchId: match.id } })).toBe(1);
    expect(matchRow.result?.winnerTeam).toBe('A');
    for (const participant of matchRow.participants) {
      const queue = await prisma.queueEntry.findUnique({
        where: {
          sessionId_participantId: {
            sessionId: setup.session.id,
            participantId: participant.participantId,
          },
        },
      });
      expect(queue?.gamesPlayed).toBe(1);
      expect(queue?.currentMatchId).toBeNull();
      expect(['WAITING', 'PAUSED']).toContain(queue?.state);
    }
    const court = await prisma.court.findUniqueOrThrow({ where: { id: matchRow.courtId } });
    expect(court.status).toBe('AVAILABLE');

    const results = await setup.owner.agent
      .get(`/api/v1/sessions/${setup.session.id}/results`)
      .expect(200);
    expect(results.body.data).toHaveLength(1);
    expect(results.body.data[0].winnerTeam).toBe('A');

    const publicPage = await request(app)
      .get(`/api/v1/public/sessions/${setup.session.publicId}`)
      .expect(200);
    const publicRaw = JSON.stringify(publicPage.body);
    expect(publicRaw).not.toContain('@example.test');
    expect(publicPage.body.data.results).toHaveLength(1);
    expect(publicPage.body.data.results[0].teams.A[0].name).not.toContain('Player');
  });

  it('undoes an in-progress point and corrects a completed result', async () => {
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
    const match = commit.body.data.matches[0] as MatchBody;
    const start = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/start`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({})
      .expect(200);
    let version = start.body.data.match.version as number;

    for (let point = 1; point <= 2; point += 1) {
      const scored = await setup.owner.agent
        .post(`/api/v1/matches/${match.id}/score-events`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `undo-point-${match.id}-${point}`)
        .send({ team: 'B', expectedVersion: version })
        .expect(201);
      version = scored.body.data.match.version as number;
    }
    const undo = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/undo`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ expectedVersion: version })
      .expect(200);
    expect(undo.body.data.match.teamBScore).toBe(1);
    version = undo.body.data.match.version as number;

    for (let point = 2; point <= 11; point += 1) {
      const scored = await setup.owner.agent
        .post(`/api/v1/matches/${match.id}/score-events`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `correct-point-${match.id}-${point}`)
        .send({ team: 'B', expectedVersion: version })
        .expect(201);
      version = scored.body.data.match.version as number;
    }
    const complete = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/complete`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ expectedVersion: version })
      .expect(201);
    expect(complete.body.data.match.winnerTeam).toBe('B');

    const correction = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/correction`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        games: [{ a: 13, b: 11 }],
        reason: 'Scorekeeper awarded the final point to the wrong team',
        expectedVersion: complete.body.data.match.version,
      })
      .expect(200);
    expect(correction.body.data.match.winnerTeam).toBe('A');
    expect(correction.body.data.match.status).toBe('CORRECTED');
    const result = await prisma.matchResult.findUniqueOrThrow({ where: { matchId: match.id } });
    expect(result.winnerTeam).toBe('A');
    expect(result.correctionReason).toBeTruthy();
  });

  it('lets a Queue Master override a suggested player from the bench', async () => {
    const setup = await setupLiveSession(9, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    expect(preview.bench.length).toBeGreaterThan(0);
    const assignment = preview.assignments[0]!;
    const replaced = assignment.teamA[0]!;
    const replacement = preview.bench[0]!;

    const override = await setup.owner.agent
      .patch(`/api/v1/sessions/${setup.session.id}/rotations/${preview.rotationId}/players`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        playerUserId: replaced.userId,
        replacementUserId: replacement.userId,
      })
      .expect(200);
    const updated = override.body.data as {
      assignments: Array<{ teamA: Array<{ userId: string }>; teamB: Array<{ userId: string }> }>;
      bench: Array<{ userId: string }>;
    };
    const selectedIds = updated.assignments.flatMap((row) => [
      ...row.teamA.map((player) => player.userId),
      ...row.teamB.map((player) => player.userId),
    ]);
    expect(selectedIds).toContain(replacement.userId);
    expect(selectedIds).not.toContain(replaced.userId);

    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const matchIds = (commit.body.data.matches as Array<{ id: string }>).map((match) => match.id);
    const participants = await prisma.matchParticipant.findMany({
      where: { matchId: { in: matchIds } },
    });
    expect(participants.map((row) => row.userId)).toContain(replacement.userId);
    expect(participants.map((row) => row.userId)).not.toContain(replaced.userId);
  });

  it('rejects a stale preview after eligibility changes', async () => {
    const setup = await setupLiveSession(9, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    expect(preview.assignments).toHaveLength(2);

    const extra = await registerUser('late');
    await joinClub(extra, setup.club.id);
    await registerSession(extra, setup.session.id);
    await checkIn(extra, setup.session.id);

    const stale = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(409);
    expect(stale.body.error.message).toMatch(/changed|preview/i);
    expect(await prisma.match.count({ where: { sessionId: setup.session.id } })).toBe(0);
  });

  it('automatically rotates after a match completes when auto-assign is enabled', async () => {
    const setup = await setupLiveSession(8, 2, { autoAssign: true });
    const preview = await previewRotation(setup.owner, setup.session.id);
    const commit = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const match = commit.body.data.matches[0] as MatchBody;
    const start = await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/start`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({})
      .expect(200);
    let version = start.body.data.match.version as number;
    for (let point = 1; point <= 11; point += 1) {
      const scored = await setup.owner.agent
        .post(`/api/v1/matches/${match.id}/score-events`)
        .set('x-csrf-token', setup.owner.csrf)
        .set('idempotency-key', `auto-${match.id}-${point}`)
        .send({ team: 'A', expectedVersion: version })
        .expect(201);
      version = scored.body.data.match.version as number;
    }
    await setup.owner.agent
      .post(`/api/v1/matches/${match.id}/complete`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ expectedVersion: version })
      .expect(201);

    let newMatchId: string | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const matches = await prisma.match.findMany({
        where: { sessionId: setup.session.id, status: 'READY' },
      });
      if (matches.length > 0) {
        newMatchId = matches[0]!.id;
        break;
      }
    }
    expect(newMatchId).not.toBeNull();
    expect(await prisma.match.count({ where: { id: match.id, status: 'COMPLETED' } })).toBe(1);
  });

  it('rejects self-registration when the session is invite-only', async () => {
    const owner = await registerUser('inviteowner');
    const player = await registerUser('inviteplayer');
    const club = await createClub(owner, 'Invite');
    const court = await createCourt(owner, club.id, 'Court 1');
    const session = await createSession(owner, club.id, {
      courtIds: [court.id],
      registrationPolicy: 'INVITE_ONLY',
    });
    await joinClub(player, club.id);
    await transition(owner, session.id, 'CHECK_IN_OPEN');
    const blocked = await player.agent
      .post(`/api/v1/sessions/${session.id}/register`)
      .set('x-csrf-token', player.csrf)
      .send({})
      .expect(403);
    expect(blocked.body.error.code).toBe('FORBIDDEN');
  });
});
